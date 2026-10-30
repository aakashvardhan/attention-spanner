import { PAPERS_PAGE_PATH } from '../../shared/constants';

/** The foot of the new tab: two quiet links, Papers and Settings. */
export function EditionIndex() {
  return (
    <footer className="edition-index">
      <button
        className="edition-link"
        onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) })}
      >
        Papers
      </button>
      <button className="edition-link" onClick={() => void chrome.runtime.openOptionsPage()}>
        Settings
      </button>
    </footer>
  );
}
