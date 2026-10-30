import { useState } from 'react';
import { annotationDocKey } from '../../../shared/annotations';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import type { Paper } from '../../../shared/types';
import { thinkingLink } from '../../../shared/thinking';
import type { PaperThinking, ThinkingItem } from '../../../shared/thinking';

const COLUMNS = [
  { key: 'claims', title: 'Claims' },
  { key: 'doubts', title: 'Doubts' },
  { key: 'open', title: 'Open questions' },
] as const;

/** A paper's thinking record: verdict, pass, what is still open, and the three columns. */
export function PaperRecord({ paper, thinking }: { paper: Paper; thinking: PaperThinking }) {
  const link = (item: ThinkingItem) => thinkingLink(paper, item.page);
  return (
    <div className="pp-record">
      <Verdict paper={paper} />
      <div className="pp-record-pills">
        <span className="pp-pill">Pass {paper.pass ?? 1}</span>
        {thinking.open.length > 0 && <span className="pp-pill">{thinking.open.length} still open</span>}
        {thinking.xp > 0 && <span className="pp-pill">+{thinking.xp} XP</span>}
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

const VERDICT_QUESTION = 'Your verdict on this paper, in one line?';

/** The verdict line, written or edited in place; Enter saves. The first one ever earns its XP. */
function Verdict({ paper }: { paper: Paper }) {
  const [provocations] = useStorageValue('provocations');
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const verdict = (draft ?? '').trim();
    setDraft(null);
    if (!verdict || verdict === paper.verdict) return;
    void sendMessage({ type: 'PAPER_UPDATE', id: paper.id, patch: { verdict } });
    if (!provocations.some((p) => p.paperId === paper.id && p.kind === 'verdict')) {
      const docKey = annotationDocKey(paper.pdf?.url ?? paper.url);
      void sendMessage({
        type: 'PROV_ADD',
        draft: { docKey, paperId: paper.id, annotationId: null, kind: 'verdict', page: 0, question: VERDICT_QUESTION, answer: verdict, status: 'answered' },
      });
    }
  };
  if (draft !== null) {
    return (
      <input
        className="pp-record-verdict-input"
        autoFocus
        value={draft}
        placeholder={VERDICT_QUESTION}
        aria-label="Your verdict"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') setDraft(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={paper.verdict ? 'pp-record-verdict' : 'pp-record-verdict pp-record-verdict-empty'}
      onClick={() => setDraft(paper.verdict ?? '')}
    >
      {paper.verdict || 'Write your verdict'}
    </button>
  );
}
