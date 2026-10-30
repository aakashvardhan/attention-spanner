import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { BookmarksPanel } from './BookmarksPanel';

/** Favorites, Papers and Settings: the tools along the foot of either view. The Pomodoro is FocusTimer. */
export function EditionIndex() {
  return (
    <footer className="edition-index">
      <BookmarksPanel />
      <div className="edition-actions">
        <button
          className="edition-link"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) })}
        >
          Papers
        </button>
        <button className="edition-link" onClick={() => void chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    </footer>
  );
}
