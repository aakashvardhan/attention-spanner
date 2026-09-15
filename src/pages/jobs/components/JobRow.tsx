import type { Job, JobStatus } from '../../../shared/types';

/**
 * One posting on the board. Modelled on PaperRow: title link, a dot-joined
 * metadata line, a status pill, and ghost actions in the footer.
 *
 * The score is a heat cell using the same `data-level` + `--heat-*` idiom the
 * activity calendar uses, so "how good is this" reads at a glance without a
 * legend. A blocked job keeps its score and gets a reason strip — greyed, not
 * gone, because the blockers are regexes over prose someone wrote in a hurry.
 */

/** 0–100 into the five heat steps the theme defines. */
export function heatLevel(total: number): 0 | 1 | 2 | 3 | 4 {
  if (total >= 80) return 4;
  if (total >= 60) return 3;
  if (total >= 40) return 2;
  if (total >= 20) return 1;
  return 0;
}

const NEXT_STATUS: Partial<Record<JobStatus, { label: string; to: JobStatus }>> = {
  new: { label: 'Shortlist', to: 'shortlist' },
  shortlist: { label: 'Mark applied', to: 'applied' },
};

export function JobRow({
  job,
  expanded,
  onToggle,
  onStatus,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (status: JobStatus) => void;
}) {
  const score = job.score;
  const blocked = (score?.blockers.length ?? 0) > 0;
  const meta = [job.company, job.locations.join(' / '), job.kind].filter(Boolean);
  const advance = NEXT_STATUS[job.status];

  return (
    <li className={blocked ? 'job-row job-row--blocked' : 'job-row'}>
      <div className="job-row-main">
        <span className="job-score" data-level={heatLevel(score?.total ?? 0)} title="Match score">
          {score?.total ?? '—'}
        </span>
        <div className="job-row-body">
          <a className="job-title" href={job.url} target="_blank" rel="noreferrer">
            {job.title}
          </a>
          <p className="job-meta">{meta.join(' · ')}</p>
          {blocked && <p className="job-blockers">{score?.blockers.join(' · ')}</p>}
        </div>
        <span className={`fc-chip job-status job-status-${job.status}`}>{job.status}</span>
      </div>

      <div className="job-row-actions">
        <button className="ghost-btn" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Hide why' : 'Why this score'}
        </button>
        {advance && (
          <button className="ghost-btn" onClick={() => onStatus(advance.to)}>
            {advance.label}
          </button>
        )}
        {job.status !== 'dismissed' && (
          <button className="ghost-btn" onClick={() => onStatus('dismissed')}>
            Dismiss
          </button>
        )}
        <a className="ghost-btn" href={job.applyUrl} target="_blank" rel="noreferrer">
          Apply
        </a>
      </div>

      {expanded && score && (
        <div className="job-detail">
          <table className="job-parts">
            <tbody>
              {score.parts.map((part) => (
                <tr key={part.label}>
                  <th scope="row">{part.label}</th>
                  <td className="job-part-points">
                    {part.points}/{part.max}
                  </td>
                  <td className="job-part-why">{part.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.description && <p className="job-description">{job.description}</p>}
        </div>
      )}
    </li>
  );
}
