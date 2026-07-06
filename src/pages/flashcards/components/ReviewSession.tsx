import { useEffect, useMemo, useState } from 'react';
import { localDate } from '../../../shared/format';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import { buildQueue, formatInterval, previewIntervals } from '../../../shared/srs';
import type { Deck, Rating } from '../../../shared/types';
import { CardFace } from './CardFace';

const RATINGS: { rating: Rating; label: string; key: string }[] = [
  { rating: 'again', label: 'Again', key: '1' },
  { rating: 'hard', label: 'Hard', key: '2' },
  { rating: 'good', label: 'Good', key: '3' },
  { rating: 'easy', label: 'Easy', key: '4' },
];

export function ReviewSession({ deck, onExit }: { deck: Deck; onExit: () => void }) {
  const [cards] = useStorageValue('flashCards');
  const [notes] = useStorageValue('flashNotes');
  const [srsDaily] = useStorageValue('srsDaily');
  const [showBack, setShowBack] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [tally, setTally] = useState<Record<Rating, number>>({ again: 0, hard: 0, good: 0, easy: 0 });
  // 30s tick so 1m/10m learning re-serves surface without a reload
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const newToday = srsDaily[localDate()]?.newIntroduced[deck.id] ?? 0;
  const queue = useMemo(
    () => buildQueue(cards, deck.id, now, newToday),
    [cards, deck.id, now, newToday],
  );
  const card = queue[0];
  const note = card ? notes.find((n) => n.id === card.noteId) : undefined;
  const previews = card ? previewIntervals(card, now) : null;
  const answered = tally.again + tally.hard + tally.good + tally.easy;

  const answer = async (rating: Rating) => {
    if (!card || answering) return;
    setAnswering(true);
    try {
      await sendMessage({ type: 'FLASH_ANSWER_CARD', cardId: card.id, rating });
      setTally((t) => ({ ...t, [rating]: t[rating] + 1 }));
      setShowBack(false);
      setNow(Date.now());
    } finally {
      // Without this, a failed send would leave every rating button disabled
      setAnswering(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onExit();
      if (!card) return;
      if ((e.key === ' ' || e.key === 'Enter') && !showBack) {
        e.preventDefault();
        setShowBack(true);
        return;
      }
      if (showBack) {
        const match = RATINGS.find((r) => r.key === e.key);
        if (match) void answer(match.rating);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!card) {
    // Nothing due (even with learn-ahead): find how long until the next learning card
    const nextLearning = cards
      .filter((c) => c.deckId === deck.id && (c.phase === 'learning' || c.phase === 'relearning'))
      .sort((a, b) => a.dueAt - b.dueAt)[0];
    return (
      <main className="fc-main">
        <div className="panel fc-done">
          <p className="fc-done-title">
            {answered > 0 ? '🎉 Session complete' : '✨ All caught up'}
          </p>
          {answered > 0 && (
            <p className="fc-done-tally">
              {RATINGS.filter((r) => tally[r.rating] > 0)
                .map((r) => `${r.label} ${tally[r.rating]}`)
                .join(' · ')}
            </p>
          )}
          {nextLearning && (
            <p className="fc-hint">
              Next card in {formatInterval(Math.max(60_000, nextLearning.dueAt - now))}
            </p>
          )}
          <button className="fc-primary-btn" onClick={onExit}>
            Back to deck
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="fc-main">
      <p className="fc-review-progress">
        {queue.length} card{queue.length === 1 ? '' : 's'} left · {answered} done
      </p>

      <div className="panel fc-card" onClick={() => !showBack && setShowBack(true)}>
        {note ? (
          <>
            <CardFace note={note} card={card} side="front" />
            {showBack && (
              <>
                <hr className="fc-divider" />
                <CardFace note={note} card={card} side="back" />
              </>
            )}
          </>
        ) : (
          <p className="fc-hint">This card's note was deleted.</p>
        )}
      </div>

      {showBack && previews ? (
        <div className="fc-ratings">
          {RATINGS.map(({ rating, label, key }) => (
            <button
              key={rating}
              className={`fc-rating fc-rating-${rating}`}
              disabled={answering}
              onClick={() => void answer(rating)}
            >
              <span className="fc-rating-label">{label}</span>
              <span className="fc-rating-interval">{previews[rating]}</span>
              <span className="fc-rating-key">{key}</span>
            </button>
          ))}
        </div>
      ) : (
        <button className="fc-primary-btn fc-flip" onClick={() => setShowBack(true)}>
          Show answer <span className="fc-rating-key">space</span>
        </button>
      )}
    </main>
  );
}
