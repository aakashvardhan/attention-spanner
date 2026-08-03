import { useEffect, useRef, useState } from 'react';
import { alphaxivPaperRef, formatPageExcerpts, pagesToContext, parsePagesXml } from '../../../shared/alphaxiv';
import { cloudProviderFor, hasCloudKey } from '../../../shared/ai/cloud';
import { nanoProvider } from '../../../shared/ai/nanoProvider';
import { answerAboutPdf, type QaTurn } from '../../../shared/ai/pdfQa';
import { sendMessage } from '../../../shared/messages';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { Markdown } from '../../../shared/components/Markdown';
import '../../../shared/components/assistant.css';

type DocNoun = 'paper' | 'article' | 'transcript';

const SUGGESTIONS: Record<DocNoun, string[]> = {
  paper: [
    '“Summarize this paper”',
    '“What problem does it solve?”',
    '“Explain the method in plain terms”',
  ],
  article: [
    '“Summarize this in three points”',
    '“What is the main claim?”',
    '“What should I remember from this?”',
  ],
  transcript: [
    '“What were the action items?”',
    '“What did I commit to?”',
    '“Explain the part about…”',
  ],
};

const NO_KEY_NOTE =
  '\n\n(Answered from the section you’re on — the document is too big for the on-device model. Add a Gemini API key in Settings → Assistant for whole-document answers.)';

/**
 * Pull the document's text through the caller's provider. PDFs hand over
 * getPdfText (cached, shared with the bibliography indexer); articles hand
 * over their already-extracted blocks.
 */
function useDocText(getText: () => Promise<string>): { text: string; loading: boolean } {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getText()
      .then((t) => {
        if (alive) setText(t);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [getText]);
  return { text, loading };
}

export function AskPanel({
  getText,
  title,
  position,
  total,
  noun,
  src,
}: {
  /** Stable across renders — the caller memoizes it */
  getText: () => Promise<string>;
  title: string;
  /** 1-based position in the document; the answer window is built around it */
  position: number;
  total: number;
  noun: DocNoun;
  /** The document's URL. Enables the alphaXiv source when the server can fetch it. */
  src?: string;
}) {
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [alphaxiv] = useStorageValue('alphaxiv');

  const { text: fullText, loading } = useDocText(getText);
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const [nanoOk, setNanoOk] = useState(false);
  const [checked, setChecked] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void nanoProvider.available().then((ok) => {
      setNanoOk(ok);
      setChecked(true);
    });
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, partial]);

  const cloudOk = hasCloudKey(settings);
  const modelOk = nanoOk || cloudOk;
  // alphaXiv only resolves papers it can fetch — an arXiv id, or some public URL
  const alphaxivOk = alphaxiv.connected && Boolean(src && alphaxivPaperRef(src));
  // One assistant: alphaXiv retrieval when it's reachable (it needs no local
  // model of its own), otherwise the on-device/cloud answer over the local text.
  const usable = alphaxivOk || modelOk;
  // Only the local path waits on text extraction; alphaXiv answers straight away.
  const waiting = loading && !alphaxivOk;

  const push = (turn: QaTurn) => setTurns((prev) => [...prev, turn]);

  /** Answer from the extracted document text — Nano first, cloud when it's too big. */
  const askLocal = async (question: string, history: QaTurn[]): Promise<QaTurn> => {
    const answer = await answerAboutPdf({
      title,
      fullText,
      currentPage: position,
      pageCount: total,
      question,
      history,
      nanoOk,
      cloudOk,
      transcript: noun === 'transcript',
      cloudProvider: cloudProviderFor(settings),
      onToken: setPartial,
    });
    const text = answer.partial && !cloudOk ? answer.text + NO_KEY_NOTE : answer.text;
    return { role: 'assistant', text };
  };

  /** Retrieve the relevant pages from alphaXiv, then compose locally from them. */
  const askAlphaxiv = async (question: string, history: QaTurn[]): Promise<QaTurn> => {
    const res = await sendMessage({ type: 'AX_ASK_PDF', paper: src!, queries: [question] });
    // A retrieval hiccup shouldn't dead-end the one assistant — fall back to the
    // local text when there's a model to compose it.
    if (!res.ok) {
      if (modelOk) return askLocal(question, history);
      throw new Error(res.error ?? 'alphaXiv could not read this paper.');
    }

    const parsed = parsePagesXml(res.text ?? '');
    if (!parsed.pages.length) {
      if (modelOk) return askLocal(question, history);
      return { role: 'assistant', text: (res.text ?? '').trim() || 'alphaXiv found nothing on that.' };
    }
    const pages = parsed.pages.map((p) => p.num);
    // No local model: the excerpts are the answer, which is still a real one.
    if (!modelOk) return { role: 'assistant', text: formatPageExcerpts(parsed), pages };

    const answer = await answerAboutPdf({
      title,
      fullText: pagesToContext(parsed),
      // The context is already only the relevant pages — no windowing to do
      currentPage: 1,
      pageCount: 1,
      question,
      history,
      nanoOk,
      cloudOk,
      transcript: noun === 'transcript',
      cloudProvider: cloudProviderFor(settings),
      onToken: setPartial,
    });
    return { role: 'assistant', text: answer.text, pages };
  };

  const send = async (raw?: string) => {
    const question = (raw ?? input).trim();
    if (!question || busy || waiting || !usable) return;
    setInput('');
    setBusy(true);
    const history = turns;
    push({ role: 'user', text: question });

    try {
      push(alphaxivOk ? await askAlphaxiv(question, history) : await askLocal(question, history));
    } catch (err) {
      push({
        role: 'assistant',
        text: (err as Error).message || `Something went wrong reading the ${noun}. Try again?`,
      });
    } finally {
      setPartial(null);
      setBusy(false);
    }
  };

  if (!settings.assistantEnabled) {
    return (
      <aside className="reader-ask">
        <p className="as-hint">The assistant is turned off — enable it in Settings → Assistant.</p>
      </aside>
    );
  }

  return (
    <aside className="reader-ask">
      <div className="as-chat">
        <div className="as-log" ref={logRef}>
          {turns.length === 0 && partial === null && (
            <div className="as-empty">
              <p className="as-hint">
                {alphaxivOk
                  ? `Ask about this ${noun} — answers cite the pages they came from:`
                  : `Ask about this ${noun}:`}
              </p>
              {SUGGESTIONS[noun].map((s) => (
                <button
                  key={s}
                  type="button"
                  className="as-suggestion"
                  disabled={busy || waiting || !usable}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'as-bubble user' : 'as-bubble assistant'}>
              {t.role === 'assistant' ? <Markdown text={t.text} /> : t.text}
              {t.pages?.length ? (
                <span className="as-pages">
                  Page{t.pages.length > 1 ? 's' : ''} {t.pages.join(', ')}
                </span>
              ) : null}
            </div>
          ))}
          {partial !== null && (
            <div className="as-bubble assistant streaming">
              {/* Keep streamed answers in the same Markdown + KaTeX path as
                  completed ones, so equations do not briefly appear as raw
                  `$...$` text inside the PDF reader. */}
              {partial ? <Markdown text={partial} /> : <span className="as-thinking">…</span>}
            </div>
          )}
          {busy && partial === null && (
            <div className="as-bubble assistant streaming as-thinking">…</div>
          )}
        </div>

        {waiting && <p className="as-hint">Reading the {noun}…</p>}
        {checked && !usable && (
          <p className="as-hint">
            On-device AI isn’t available in this browser — add a Gemini API key in Settings →
            Assistant to ask via the cloud.
          </p>
        )}

        <form
          className="as-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="text"
            className="as-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about this ${noun}…`}
            maxLength={1000}
            disabled={busy || waiting || !usable}
          />
          <button
            type="submit"
            className="as-send"
            disabled={busy || waiting || !usable || !input.trim()}
          >
            ↑
          </button>
        </form>
      </div>
    </aside>
  );
}
