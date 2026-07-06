import { renderCloze } from '../../../shared/cloze';
import type { FlashCard, FlashNote } from '../../../shared/types';

/**
 * Renders one side of a card. Basic variant 1 swaps front/back (reversed);
 * cloze cards blank/reveal their variant's deletions.
 */
export function CardFace({
  note,
  card,
  side,
}: {
  note: FlashNote;
  card: FlashCard;
  side: 'front' | 'back';
}) {
  if (note.type === 'cloze') {
    const segments = renderCloze(note.front, card.variant, side);
    return (
      <div className="fc-face">
        <p className="fc-face-text">
          {segments.map((seg, i) =>
            seg.cloze?.active ? (
              <mark key={i} className="fc-cloze">
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
        {side === 'back' && note.back && <p className="fc-face-extra">{note.back}</p>}
      </div>
    );
  }

  const reversed = card.variant === 1;
  const text = (side === 'front') !== reversed ? note.front : note.back;
  return (
    <div className="fc-face">
      <p className="fc-face-text">{text}</p>
    </div>
  );
}
