import { memo, useMemo, useRef, useState } from 'react';
import { buildActivityDays } from '../../shared/activity';
import { localDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';

const DAY_LABELS = ['Mon', 'Wed', 'Fri'] as const; // rows 0, 2, 4

/** GitHub-style year contribution calendar, pinned above the card grid */
export const ActivityCalendar = memo(function ActivityCalendar() {
  const [streaks] = useStorageValue('streaks');
  const [gym] = useStorageValue('gym');
  const [srsDaily] = useStorageValue('srsDaily');
  const stripRef = useRef<HTMLElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const model = useMemo(
    () => buildActivityDays(streaks.daily, gym.checkins, srsDaily, localDate()),
    [streaks, gym, srsDaily],
  );

  // Delegated hover: one listener for all 371 cells
  const onMouseOver = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.act-cell[data-tip]');
    if (!cell || !stripRef.current) {
      setTip(null);
      return;
    }
    const strip = stripRef.current.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const x = rect.left - strip.left + rect.width / 2;
    setTip({
      text: cell.dataset.tip!,
      // Clamp so the tooltip stays inside the strip near its edges
      x: Math.max(140, Math.min(x, strip.width - 140)),
      y: rect.top - strip.top,
    });
  };

  return (
    <section
      className="panel activity-strip"
      ref={stripRef}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setTip(null)}
    >
      <p className="act-headline">
        {model.totalActivities > 0
          ? `${model.totalActivities} activities in the last year`
          : 'No activity yet — finish a task, read, or hit the gym to light up your year'}
      </p>
      <div className="act-scroll">
        <div className="act-inner">
          <div className="act-months">
          {model.monthLabels.map(({ columnIndex, label }) => (
            <span key={columnIndex} style={{ gridColumnStart: columnIndex + 1 }}>
              {label}
            </span>
          ))}
        </div>
        <div className="act-body">
          <div className="act-day-labels">
            {DAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className="act-grid">
            {model.weeks.map((week) => (
              <div className="act-week" key={week[0].date}>
                {week.map((day) =>
                  day.future ? (
                    <div className="act-cell future" key={day.date} />
                  ) : (
                    <div className="act-cell" data-level={day.level} data-tip={day.tooltip} key={day.date} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
          <div className="act-legend">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map((level) => (
              <div className="act-cell" data-level={level} key={level} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
      {tip && (
        <div className="act-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </section>
  );
});
