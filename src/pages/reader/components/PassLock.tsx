import { useEffect, useRef, useState } from 'react';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Pass 3's pause: the page fades out under one question, and a sentence of
 * the reader's own (three words or more) lets them carry on.
 */
export function PassLock({
  question,
  onContinue,
  onUnsure,
}: {
  question: string;
  onContinue: (answer: string) => void;
  onUnsure: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const ready = words(answer) >= 3;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const submit = () => ready && onContinue(answer.trim());
  return (
    <div className="pass-lock">
      <div className="pass-lock-fade" aria-hidden="true" />
      <div className="provoke-card pass-lock-card" role="dialog" aria-modal="true" aria-label="Scrolling paused">
        <p className="provoke-kicker">
          <svg className="pass-lock-icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Pass 3 · scrolling paused
        </p>
        <p className="provoke-question">{question}</p>
        <textarea
          className="provoke-answer"
          rows={2}
          ref={field}
          value={answer}
          placeholder="Your answer, in a sentence"
          aria-label="Your answer"
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="provoke-foot">
          <span className="pass-lock-hint">One sentence unlocks the page.</span>
          <button type="button" className="ghost-btn" onClick={onUnsure}>
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
