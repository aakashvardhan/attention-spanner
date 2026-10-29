import { readerPageUrl } from '../../../shared/pdf';
import type { Paper } from '../../../shared/types';
import type { PaperThinking, ThinkingItem } from '../../../shared/thinking';

const COLUMNS = [
  { key: 'claims', title: 'Claims' },
  { key: 'doubts', title: 'Doubts' },
  { key: 'open', title: 'Open questions' },
] as const;

/** A paper's thinking record: verdict, pass, what is still open, and the three columns. */
export function PaperRecord({ paper, thinking }: { paper: Paper; thinking: PaperThinking }) {
  const base = readerPageUrl(paper.pdf?.url ?? paper.url);
  const link = (item: ThinkingItem) => (item.page > 0 ? `${base}#page=${item.page}` : base);
  return (
    <div className="pp-record">
      <p className="pp-record-verdict">{paper.verdict || 'No verdict yet.'}</p>
      <div className="pp-record-pills">
        <span className="pp-pill">Pass {paper.pass ?? 1}</span>
        {thinking.open.length > 0 && <span className="pp-pill">{thinking.open.length} still open</span>}
        <span className="pp-pill">+{thinking.xp} XP</span>
      </div>
      <div className="pp-record-cols">
        {COLUMNS.map(({ key, title }) => (
          <section key={key} className={`pp-record-col pp-record-col-${key}`}>
            <h3>{title}</h3>
            {thinking[key].length === 0 && <p className="pp-record-none">Nothing yet.</p>}
            {thinking[key].map((item) => (
              <a key={item.id} className="pp-record-item" href={link(item)} target="_blank" rel="noreferrer">
                <span className="pp-record-text">{item.text || item.note}</span>
                <span className="pp-record-meta">
                  {[item.page > 0 ? `p. ${item.page}` : '', item.text ? item.note : ''].filter(Boolean).join(' · ')}
                </span>
              </a>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
