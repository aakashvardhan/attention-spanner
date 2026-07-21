import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { nanoProvider } from '../../../shared/ai/nanoProvider';
import { answerAboutPdf, type QaTurn } from '../../../shared/ai/pdfQa';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { getPdfText } from '../references';
import '../../../shared/components/assistant.css';

const SUGGESTIONS = [
  '“Summarize this paper”',
  '“What problem does it solve?”',
  '“Explain the method in plain terms”',
];

const NO_KEY_NOTE =
  '\n\n(Answered from the section you’re on — the paper is too big for the on-device model. Add a Gemini API key in Settings → Assistant for whole-paper answers.)';

/** Pull the document's text (getPdfText caches it, so re-opening the panel or
 * sharing with the bibliography indexer never re-walks the pages). */
function usePdfText(doc: PDFDocumentProxy): { text: string; loading: boolean } {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getPdfText(doc)
      .then((t) => {
        if (alive) setText(t);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [doc]);
  return { text, loading };
}

export function AskPanel({
  doc,
  title,
  currentPage,
  pageCount,
}: {
  doc: PDFDocumentProxy;
  title: string;
  currentPage: number;
  pageCount: number;
}) {
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const { text: fullText, loading } = usePdfText(doc);
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
        currentPage,
        pageCount,
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
        { role: 'assistant', text: 'Something went wrong reading the paper. Try again?' },
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
              <p className="as-hint">Ask about this paper:</p>
              {SUGGESTIONS.map((s) => (
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
