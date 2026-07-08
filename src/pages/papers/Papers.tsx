import { useEffect, useState } from 'react';
import { NEWTAB_PAGE_PATH } from '../../shared/constants';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { PaperDeckList } from './components/PaperDeckList';
import { PaperDeckView } from './components/PaperDeckView';

type Screen = { name: 'decks' } | { name: 'deck'; deckId: string };

/** #deck=<id> deep link (dashboard "open in deck") */
function screenFromHash(): Screen {
  const [key, id] = location.hash.slice(1).split('=');
  if (key === 'deck' && id) return { name: 'deck', deckId: id };
  return { name: 'decks' };
}

export function Papers() {
  const theme = useTheme();
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [decks, decksLoaded] = useStorageValue('decks');

  // If a deep-linked deck was deleted elsewhere, fall back to the deck list
  useEffect(() => {
    if (screen.name === 'deck' && decksLoaded && !decks.some((d) => d.id === screen.deckId)) {
      setScreen({ name: 'decks' });
    }
  }, [screen, decks, decksLoaded]);

  const deck = screen.name === 'deck' ? decks.find((d) => d.id === screen.deckId) : null;

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
            <button className="ghost-btn fc-back" onClick={() => setScreen({ name: 'decks' })}>
              ← Decks
            </button>
          )}
          <h1>📄 {screen.name === 'decks' ? 'Papers' : deck?.name}</h1>
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
        <PaperDeckList onOpen={(deckId) => setScreen({ name: 'deck', deckId })} />
      )}
      {screen.name === 'deck' && deck && <PaperDeckView deck={deck} />}
    </div>
  );
}
