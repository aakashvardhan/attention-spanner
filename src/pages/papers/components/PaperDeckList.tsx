import { useState } from 'react';
import { usePapers } from '../../../shared/hooks/usePapers';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';

export function PaperDeckList({ onOpen }: { onOpen: (deckId: string) => void }) {
  const [decks] = useStorageValue('decks');
  const { byDeck } = usePapers();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const paperDecks = decks.filter((d) => d.kind === 'papers');

  const addDeck = async () => {
    try {
      const res = await sendMessage({ type: 'FLASH_ADD_DECK', name, kind: 'papers' });
      if (!res?.ok) {
        setError(res?.error ?? 'Could not create deck.');
        return;
      }
      setName('');
      setError(null);
    } catch {
      setError('Lost connection to the extension — close and reopen this tab.');
    }
  };

  const deleteDeck = async (id: string, deckName: string) => {
    if (!window.confirm(`Delete "${deckName}" and all its papers?`)) return;
    await sendMessage({ type: 'FLASH_DELETE_DECK', id });
  };

  return (
    <main className="fc-main">
      {paperDecks.length === 0 && (
        <div className="panel fc-empty">
          <p>
            No paper decks yet. Create one below, then open it to add papers — each paper tracks its
            authors, venue, citations, and how far you've read.
          </p>
        </div>
      )}

      <div className="fc-deck-list">
        {paperDecks.map((deck) => {
          const papers = byDeck.get(deck.id) ?? [];
          const reading = papers.filter((p) => p.status === 'reading').length;
          const toRead = papers.filter((p) => p.status === 'to-read').length;
          return (
            <div className="panel fc-deck-row" key={deck.id}>
              <button className="fc-deck-name" onClick={() => onOpen(deck.id)}>
                {deck.name}
              </button>
              <div className="fc-deck-counts">
                <span className="fc-chip fc-chip-review" title="Papers in this deck">
                  {papers.length} 📄
                </span>
                {reading > 0 && (
                  <span className="fc-chip fc-chip-learning" title="Currently reading">
                    {reading} reading
                  </span>
                )}
                {toRead > 0 && (
                  <span className="fc-chip fc-chip-new" title="To read">
                    {toRead} to read
                  </span>
                )}
              </div>
              <div className="fc-deck-actions">
                <button className="fc-study-btn" onClick={() => onOpen(deck.id)}>
                  Open
                </button>
                <button
                  className="ghost-btn"
                  title="Delete deck"
                  onClick={() => void deleteDeck(deck.id, deck.name)}
                >
                  ✕
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
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New deck name…" />
        <button type="submit" className="fc-primary-btn" disabled={!name.trim()}>
          Add deck
        </button>
      </form>
      {error && <p className="fc-error">{error}</p>}
    </main>
  );
}
