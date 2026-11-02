import { useEffect } from 'react';
import { sendMessage } from '../../shared/messages';
import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { usePapers } from '../../shared/hooks/usePapers';
import { paperOpenUrl } from '../../shared/pdf';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BrainDump } from './BrainDump';

/**
 * The new tab: the paper you were reading, the brain dump, and the reading
 * heatmap. Everything else lives on the shelf (Papers) or in Settings.
 */
export function Dashboard() {
  const { papers, lastRead } = usePapers();
  // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
  useEffect(() => void sendMessage({ type: 'ALPHAXIV_SYNC' }).catch(() => undefined), []);

  return (
    <main className="edition">
      <div className="now-col">
        <BrainDump />
        <ActivityHeatmap papers={papers} />
      </div>

      <div className="read-col">
        <section className="read-section" aria-labelledby="continue-heading">
          <h2 id="continue-heading" className="label">
            Continue reading
          </h2>
          {lastRead ? (
            <a className="continue-paper" href={paperOpenUrl(lastRead)}>
              <span className="row-title">{lastRead.title}</span>
              <span className="hint">{lastRead.leftOff || `${lastRead.progressPercent}% read`}</span>
            </a>
          ) : (
            <p className="hint">Nothing open yet. Pick a paper from your shelf.</p>
          )}
        </section>
      </div>

      <footer className="edition-index">
        <a className="edition-link" href={chrome.runtime.getURL(PAPERS_PAGE_PATH)}>
          Papers
        </a>
        <button type="button" className="edition-link" onClick={() => void chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </footer>
    </main>
  );
}
