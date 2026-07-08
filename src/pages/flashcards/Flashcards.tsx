import { useEffect, useState } from 'react';
import { NEWTAB_PAGE_PATH } from '../../shared/constants';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { DeckList } from './components/DeckList';
import { DeckView } from './components/DeckView';
import { ReviewSession } from './components/ReviewSession';

export type Screen =
  | { name: 'decks' }
  | { name: 'deck'; deckId: string }
  | { name: 'review'; deckId: string };

/** #deck=<id> / #review=<id> deep links (dashboard/popup Study buttons) */
function screenFromHash(): Screen {
  const hash = location.hash.slice(1);
  const [key, id] = hash.split('=');
  if (key === 'deck' && id) return { name: 'deck', deckId: id };
  if (key === 'review' && id) return { name: 'review', deckId: id };
  return { name: 'decks' };
}

export function Flashcards() {
  const theme = useTheme();
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [decks, decksLoaded] = useStorageValue('decks');

  // If a deep-linked deck was deleted elsewhere, fall back to the deck list
  useEffect(() => {
    if (screen.name !== 'decks' && decksLoaded && !decks.some((d) => d.id === screen.deckId)) {
      setScreen({ name: 'decks' });
    }
  }, [screen, decks, decksLoaded]);

  const deck = screen.name === 'decks' ? null : decks.find((d) => d.id === screen.deckId);

  return (
    <div className="fc-page">
      <header className="fc-header">
        <div className="fc-header-left">
          {screen.name === 'decks' ? (
            <button
              className="ghost-btn fc-back"
              onClick={() => {
                location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
              }}
            >
              ← Dashboard
            </button>
          ) : (
            <button
              className="ghost-btn fc-back"
              onClick={() =>
                setScreen(
                  screen.name === 'review'
                    ? { name: 'deck', deckId: screen.deckId }
                    : { name: 'decks' },
                )
              }
            >
              ← {screen.name === 'review' ? deck?.name : 'Decks'}
            </button>
          )}
          <h1>🃏 {screen.name === 'decks' ? 'Flashcards' : deck?.name}</h1>
        </div>
        <button
          className="ghost-btn fc-theme-toggle"
          title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          {theme.resolved === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {screen.name === 'decks' && (
        <DeckList
          onOpen={(deckId) => setScreen({ name: 'deck', deckId })}
          onStudy={(deckId) => setScreen({ name: 'review', deckId })}
        />
      )}
      {screen.name === 'deck' && deck && (
        <DeckView deck={deck} onStudy={() => setScreen({ name: 'review', deckId: deck.id })} />
      )}
      {screen.name === 'review' && deck && (
        <ReviewSession deck={deck} onExit={() => setScreen({ name: 'deck', deckId: deck.id })} />
      )}
    </div>
  );
}
