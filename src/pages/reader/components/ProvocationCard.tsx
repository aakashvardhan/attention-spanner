import { useState, type ReactNode } from 'react';
import type { HighlightTag } from '../../../shared/types';

export const TAGS: { tag: HighlightTag; label: string }[] = [
  { tag: 'claim', label: 'Claim' },
  { tag: 'evidence', label: 'Evidence' },
  { tag: 'doubt', label: 'Doubt' },
];

/**
 * A question in the margin, answered in the reader's own words. Skipping is
 * not losing it: the caller files it under Open questions.
 */
export function ProvocationCard({
  kicker,
  question,
  tags = false,
  placeholder,
  actionLabel,
  onCommit,
  onSkip,
  children,
}: {
  kicker: string;
  question: string;
  /** Show the Claim / Evidence / Doubt chips */
  tags?: boolean;
  placeholder: string;
  actionLabel: string;
  onCommit: (answer: string, tag?: HighlightTag) => void;
  onSkip: () => void;
  /** Extra content between the question and the answer (an equation, a breakdown) */
  children?: ReactNode;
}) {
  const [answer, setAnswer] = useState('');
  const [tag, setTag] = useState<HighlightTag | undefined>();
  const commit = () => {
    if (answer.trim()) onCommit(answer.trim(), tag);
  };
  return (
    <section className="provoke-card" role="region" aria-label={kicker}>
      <p className="provoke-kicker">
        <span className="provoke-dot" aria-hidden="true" />
        {kicker}
      </p>
      <p className="provoke-question">{question}</p>
      {children}
      {tags && (
        <div className="provoke-tags" role="radiogroup" aria-label="Tag this highlight">
          {TAGS.map((t) => (
            <button
              key={t.tag}
              type="button"
              role="radio"
              aria-checked={tag === t.tag}
              className="provoke-tag"
              onClick={() => setTag(tag === t.tag ? undefined : t.tag)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="provoke-answer"
        rows={2}
        value={answer}
        placeholder={placeholder}
        aria-label="Your answer"
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
      />
      <div className="provoke-foot">
        <button type="button" className="provoke-skip" onClick={onSkip}>
          Skip · stays in Open questions
        </button>
        <button type="button" className="provoke-action" disabled={!answer.trim()} onClick={commit}>
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
