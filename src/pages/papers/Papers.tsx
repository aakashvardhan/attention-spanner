import { useEffect, useState } from 'react';
import { NEWTAB_PAGE_PATH } from '../../shared/constants';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { PaperDeckList } from './components/PaperDeckList';
import { PaperDeckView } from './components/PaperDeckView';
import { RecallSearch } from './components/RecallSearch';

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
    <div className="library grid">
      <header className="library-masthead">
        <button
          className="ghost-btn"
          onClick={() => {
            location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
          }}
        >
          ← Today
        </button>
        <h1>Papers</h1>
        <button
          className="ghost-btn"
          title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          {theme.resolved === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      {/* The deck list stays beside the papers, so switching decks is one click
          and there is no "back to decks" screen to find your way out of. */}
      <aside className="library-decks" aria-label="Decks">
        <PaperDeckList selectedId={deck?.id} onOpen={(deckId) => setScreen({ name: 'deck', deckId })} />
      </aside>

      <section className="library-papers">
        <RecallSearch />
        {deck ? <PaperDeckView deck={deck} /> : <p className="library-hint">Pick a deck to see its papers.</p>}
      </section>
    </div>
  );
}
