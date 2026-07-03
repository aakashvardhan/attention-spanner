import { useMemo } from 'react';
import { formatRelativeDate, formatWatchTime } from '../../../shared/format';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';

const MIN_PERCENT = 5;
const MAX_SHOWN = 3;

export function ContinueReading() {
  const [readingProgress] = useStorageValue('readingProgress');

  const inProgress = useMemo(
    () =>
      Object.entries(readingProgress)
        .filter(([, p]) => p.completedAt === null && p.maxPercent >= MIN_PERCENT)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SHOWN),
    [readingProgress],
  );

  if (inProgress.length === 0) return null;

  return (
    <div className="continue-reading">
      <p className="continue-label">Continue</p>
      {inProgress.map(([key, p]) => (
        <div
          key={key}
          className="continue-item"
          onClick={() =>
            void sendMessage({
              type: 'OPEN_ARTICLE',
              url: p.url,
              feedItemId: p.kind === 'video' ? null : p.feedItemId,
              resume: true,
            })
          }
        >
          <div className="continue-item-top">
            <span className="continue-title">
              {p.kind === 'video' ? '🎬 ' : ''}
              {p.title || p.url}
            </span>
            <span className="continue-percent">{p.maxPercent}%</span>
          </div>
          <div className="continue-bar">
            <div className="continue-bar-fill" style={{ width: `${p.maxPercent}%` }} />
          </div>
          <div className="continue-meta">
            <span>
              {p.kind === 'video'
                ? `${formatWatchTime(p.positionSeconds)} / ${formatWatchTime(p.durationSeconds)}${p.source ? ` · ${p.source}` : ''}`
                : p.source}
            </span>
            <span>{formatRelativeDate(new Date(p.updatedAt))}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
