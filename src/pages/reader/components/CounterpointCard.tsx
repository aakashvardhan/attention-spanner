import { useState } from 'react';
import type { HighlightTag } from '../../../shared/types';

/**
 * The reader's own reasoning, questioned once. One reply (defend or revise),
 * then the exchange stays on the card read-only: no argument loop.
 */
export function CounterpointCard({
  tag,
  question,
  gap,
  onDefend,
  onRevise,
}: {
  /** The highlight's tag, named in the kicker */
  tag: HighlightTag | null;
  question: string;
  /** The possible gap, named in a few words */
  gap: string;
  onDefend: (text: string, citedPage?: number) => void;
  onRevise: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [done, setDone] = useState<'defend' | 'revise' | null>(null);
  const trimmed = text.trim();
  const reply = (kind: 'defend' | 'revise') => {
    if (!trimmed) return;
    setDone(kind);
    if (kind === 'revise') return onRevise(trimmed);
    // "p. 4" / "page 4" in a defence is the evidence it points at.
    const cited = /\b(?:p\.?|page)\s*(\d+)/i.exec(trimmed);
    onDefend(trimmed, cited ? Number(cited[1]) : undefined);
  };
  return (
    <section className="provoke-card" role="region" aria-label="Counterpoint">
      <p className="provoke-kicker">
        <span className="provoke-dot" aria-hidden="true" />
        {tag ? `Counterpoint · to your ${tag}` : 'Counterpoint'}
      </p>
      <p className="provoke-question">{question}</p>
      <p className="provoke-gap">{gap}</p>
      {done ? (
        <p className="provoke-reply">
          <span>{done === 'defend' ? 'You defended it' : 'You revised it'}</span>
          {trimmed}
        </p>
      ) : (
        <>
          <textarea
            className="provoke-answer"
            rows={2}
            value={text}
            placeholder="Defend it with the page, or revise what you wrote"
            aria-label="Your reply"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="provoke-foot">
            <button type="button" className="ghost-btn" disabled={!trimmed} onClick={() => reply('revise')}>
              Revise
            </button>
            <button type="button" className="provoke-action" disabled={!trimmed} onClick={() => reply('defend')}>
              Defend it
            </button>
          </div>
        </>
      )}
    </section>
  );
}
