import { useState } from 'react';
import { localDate } from '../../../shared/format';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import { dueCounts, newIntroducedToday } from '../../../shared/srs';

export function DeckList({
  onOpen,
  onStudy,
}: {
  onOpen: (deckId: string) => void;
  onStudy: (deckId: string) => void;
}) {
  const [decks] = useStorageValue('decks');
  const [cards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const counts = dueCounts(cards, Date.now(), newIntroducedToday(srsDaily, localDate()));

  const flashDecks = decks.filter((d) => (d.kind ?? 'flashcards') === 'flashcards');

  const addDeck = async () => {
    try {
      const res = await sendMessage({ type: 'FLASH_ADD_DECK', name, kind: 'flashcards' });
      if (!res?.ok) {
        setError(res?.error ?? 'Could not create deck.');
        return;
      }
      setName('');
      setError(null);
    } catch {
      // Thrown when the extension was reloaded under this tab
      setError('Lost connection to the extension — close and reopen this tab.');
    }
  };

  const deleteDeck = async (id: string, deckName: string) => {
    if (!window.confirm(`Delete "${deckName}" and all its cards?`)) return;
    await sendMessage({ type: 'FLASH_DELETE_DECK', id });
  };

  const commitRename = async (id: string) => {
    if (renameText.trim()) {
      await sendMessage({ type: 'FLASH_RENAME_DECK', id, name: renameText });
    }
    setRenaming(null);
  };

  return (
    <main className="fc-main">
      {flashDecks.length === 0 && (
        <div className="panel fc-empty">
          <p>
            No decks yet. Create one below, add cards, and review them daily — cards you find hard
            come back sooner, easy ones stretch out over months.
          </p>
        </div>
      )}

      <div className="fc-deck-list">
        {flashDecks.map((deck) => {
          const c = counts[deck.id] ?? { newCount: 0, learningCount: 0, reviewCount: 0 };
          const due = c.newCount + c.learningCount + c.reviewCount;
          const hasCards = cards.some((card) => card.deckId === deck.id);
          return (
            <div className="panel fc-deck-row" key={deck.id}>
              {renaming === deck.id ? (
                <input
                  className="fc-rename-input"
                  value={renameText}
                  autoFocus
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => void commitRename(deck.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(deck.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button className="fc-deck-name" onClick={() => onOpen(deck.id)}>
                  {deck.name}
                </button>
              )}
              <div className="fc-deck-counts">
                <span className="fc-chip fc-chip-new" title="New cards">
                  {c.newCount}
                </span>
                <span className="fc-chip fc-chip-learning" title="Learning cards due">
                  {c.learningCount}
                </span>
                <span className="fc-chip fc-chip-review" title="Reviews due">
                  {c.reviewCount}
                </span>
              </div>
              <div className="fc-deck-actions">
                <button
                  className="ghost-btn"
                  title="Rename deck"
                  onClick={() => {
                    setRenaming(deck.id);
                    setRenameText(deck.name);
                  }}
                >
                  ✎
                </button>
                <button
                  className="ghost-btn"
                  title="Delete deck"
                  onClick={() => void deleteDeck(deck.id, deck.name)}
                >
                  ✕
                </button>
                <button
                  className="fc-study-btn"
                  disabled={due === 0}
                  title={
                    due > 0
                      ? 'Start reviewing'
                      : hasCards
                        ? 'All caught up — nothing due right now'
                        : 'Add notes to this deck first'
                  }
                  onClick={() => onStudy(deck.id)}
                >
                  Study
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="fc-add-deck"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void addDeck();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New deck name…"
        />
        <button type="submit" className="fc-primary-btn" disabled={!name.trim()}>
          Add deck
        </button>
      </form>
      {error && <p className="fc-error">{error}</p>}
    </main>
  );
}
