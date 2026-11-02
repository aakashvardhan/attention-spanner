import { useEffect } from 'react';
import { sendMessage } from '../../shared/messages';
import { NEWTAB_PAGE_PATH } from '../../shared/constants';
import { usePapers } from '../../shared/hooks/usePapers';
import { useTheme } from '../../shared/hooks/useTheme';
import { paperOpenUrl } from '../../shared/pdf';

/**
 * The papers page: one section per alphaXiv folder. ponytail: a plain list
 * until the library shelf replaces it (step 5 of the papers-library spec).
 */
export function Papers() {
  useTheme();
  const { folders, byFolder } = usePapers();
  // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
  useEffect(() => void sendMessage({ type: 'ALPHAXIV_SYNC' }).catch(() => undefined), []);

  return (
    <div className="library grid">
      <header className="library-masthead">
        <a className="ghost-btn" href={chrome.runtime.getURL(NEWTAB_PAGE_PATH)}>
          ← Today
        </a>
        <h1>Papers</h1>
      </header>
      <section className="library-papers">
        {folders.length === 0 && <p className="library-hint">Sign in to alphaXiv in Settings to bring in your library.</p>}
        {folders.map((folder) => (
          <section key={folder.id} aria-labelledby={`folder-${folder.id}`}>
            <h2 id={`folder-${folder.id}`}>{folder.name}</h2>
            <ul>
              {(byFolder.get(folder.id) ?? []).map((paper) => (
                <li key={paper.id}>
                  <a href={paperOpenUrl(paper)}>{paper.title}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
  );
}
