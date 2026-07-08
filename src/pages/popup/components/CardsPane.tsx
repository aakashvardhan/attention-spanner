import { FLASHCARDS_PAGE_PATH } from '../../../shared/constants';
import { localDate } from '../../../shared/format';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { dueCounts, newIntroducedToday } from '../../../shared/srs';

export function CardsPane() {
  const [decks] = useStorageValue('decks');
  const [flashCards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');
  const counts = dueCounts(flashCards, Date.now(), newIntroducedToday(srsDaily, localDate()));

  // Only flashcard decks belong here — paper decks live on the Papers page
  const flashDecks = decks.filter((d) => (d.kind ?? 'flashcards') === 'flashcards');

  const open = (hash = '') => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(FLASHCARDS_PAGE_PATH) + hash });
    window.close();
  };

  return (
    <main>
      {flashDecks.length === 0 ? (
        <div className="no-results">No decks yet — open Flashcards to create one.</div>
      ) : (
        <div className="cards-deck-list">
          {flashDecks.map((deck) => {
            const c = counts[deck.id];
            const due = c ? c.newCount + c.learningCount + c.reviewCount : 0;
            return (
              <button
                className="cards-deck-row"
                key={deck.id}
                onClick={() => open(due > 0 ? `#review=${deck.id}` : `#deck=${deck.id}`)}
              >
                <span className="cards-deck-name">{deck.name}</span>
                <span className={due > 0 ? 'cards-deck-due' : 'cards-deck-due zero'}>
                  {due} due
                </span>
              </button>
            );
          })}
        </div>
      )}
      <button className="cards-open-btn" onClick={() => open()}>
        Open Flashcards
      </button>
    </main>
  );
}
