import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { usePapers } from '../../shared/hooks/usePapers';
import { useTheme } from '../../shared/hooks/useTheme';
import { paperOpenUrl } from '../../shared/pdf';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BrainDump } from './BrainDump';

/**
 * The new tab: the paper you were reading, the brain dump, and the reading
 * heatmap. Everything else lives on the shelf (Papers) or in Settings.
 */
export function Dashboard() {
  // initTheme() in main.tsx resolves the theme once; this keeps it live.
  useTheme();
  const { papers, lastRead } = usePapers();

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
