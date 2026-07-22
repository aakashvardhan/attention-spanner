import { useEffect, useRef, useState } from 'react';
import { nanoProvider } from '../../../shared/ai/nanoProvider';
import { answerAboutPdf, type QaTurn } from '../../../shared/ai/pdfQa';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import '../../../shared/components/assistant.css';

const SUGGESTIONS: Record<'paper' | 'article', string[]> = {
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
}: {
  /** Stable across renders — the caller memoizes it */
  getText: () => Promise<string>;
  title: string;
  /** 1-based position in the document; the answer window is built around it */
  position: number;
  total: number;
  noun: 'paper' | 'article';
}) {
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

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

  const cloudOk = settings.geminiApiKey.trim() !== '';
  const usable = nanoOk || cloudOk;

  const send = async (raw?: string) => {
    const question = (raw ?? input).trim();
    if (!question || busy || loading || !usable) return;
    setInput('');
    setBusy(true);
    const history = turns;
    setTurns([...history, { role: 'user', text: question }]);

    try {
      const answer = await answerAboutPdf({
        title,
        fullText,
        currentPage: position,
        pageCount: total,
        question,
        history,
        nanoOk,
        cloudOk,
        onToken: setPartial,
      });
      const text = answer.partial && !cloudOk ? answer.text + NO_KEY_NOTE : answer.text;
      setTurns((prev) => [...prev, { role: 'assistant', text }]);
    } catch {
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', text: `Something went wrong reading the ${noun}. Try again?` },
      ]);
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
              <p className="as-hint">Ask about this {noun}:</p>
              {SUGGESTIONS[noun].map((s) => (
                <p key={s} className="as-suggestion">
                  {s}
                </p>
              ))}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'as-bubble user' : 'as-bubble assistant'}>
              {t.text}
            </div>
          ))}
          {partial !== null && (
            <div className="as-bubble assistant streaming">
              {partial || <span className="as-thinking">…</span>}
            </div>
          )}
          {busy && partial === null && (
            <div className="as-bubble assistant streaming as-thinking">…</div>
          )}
        </div>

        {loading && <p className="as-hint">Reading the paper…</p>}
        {checked && !usable && (
          <p className="as-hint">
            On-device AI isn’t available in this Chrome — add a Gemini API key in Settings →
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
            placeholder="Ask about this paper…"
            maxLength={1000}
            disabled={busy || loading || !usable}
          />
          <button
            type="submit"
            className="as-send"
            disabled={busy || loading || !usable || !input.trim()}
          >
            ↑
          </button>
        </form>
      </div>
    </aside>
  );
}
