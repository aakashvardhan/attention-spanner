import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useSettings } from '../../shared/hooks/useSettings';
import { BookmarksPanel } from './BookmarksPanel';

/** Favorites, Papers, Settings and focus: the tools along the foot of either view. */
export function EditionIndex() {
  const [settings] = useSettings();
  const focus = useFocusSession();
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
        {focus.active ? (
          <span className="edition-focus-live">
            Focus <strong>{focus.countdown}</strong>
            <button className="edition-pill" onClick={() => void focus.stop(true)}>
              Stop
            </button>
          </span>
        ) : (
          <button className="edition-pill" onClick={() => void focus.start(settings.focusMinutes)}>
            Start {settings.focusMinutes}-minute focus
          </button>
        )}
      </div>
    </footer>
  );
}
