import { useEffect, useRef, useState } from 'react';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Pass 3's pause: one question about the page just read, and a sentence of the
 * reader's own (three words or more) lets them carry on. The page above stays
 * readable and scrollable (the viewport fades what lies past it); only this
 * card takes the pointer. The question may still change (an AI one replacing
 * the fallback) until the reader types; from then on the shown one is final
 * and is the one handed back.
 */
export function PassLock({
  question,
  onContinue,
  onUnsure,
}: {
  question: string;
  onContinue: (answer: string, question: string) => void;
  onUnsure: (question: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [frozen, setFrozen] = useState<string | null>(null);
  const shown = frozen ?? question;
  const ready = words(answer) >= 3;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const submit = () => ready && onContinue(answer.trim(), shown);
  return (
    <div className="pass-lock">
      <div className="provoke-card pass-lock-card" role="dialog" aria-label="Scrolling paused">
        <p className="provoke-kicker">
          <svg className="pass-lock-icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Pass 3 · scrolling paused
        </p>
        <p className="provoke-question">{shown}</p>
        <textarea
          className="provoke-answer"
          rows={2}
          ref={field}
          value={answer}
          placeholder="Your answer, in a sentence"
          aria-label="Your answer"
          onChange={(e) => {
            if (frozen === null && e.target.value) setFrozen(question);
            setAnswer(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="provoke-foot">
          <span className="pass-lock-hint">One sentence unlocks the page.</span>
          <button type="button" className="ghost-btn" onClick={() => onUnsure(shown)}>
            I don't know yet
          </button>
          <button type="button" className="fc-primary-btn" disabled={!ready} onClick={submit}>
            Continue reading
          </button>
        </div>
      </div>
    </div>
  );
}
