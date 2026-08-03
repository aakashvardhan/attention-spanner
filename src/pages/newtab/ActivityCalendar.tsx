import { memo, useMemo, useState } from 'react';
import { buildActivityDays, weekdayIndex, type ActivityDay } from '../../shared/activity';
import { localDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { buildPrimeTime } from '../../shared/primeTime';

const DAY_LABELS = ['Mon', 'Wed', 'Fri'] as const; // rows 0, 2, 4
const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const HOUR_TICKS = [0, 6, 12, 18] as const;

function hourLabel(hour: number): string {
  const h = hour % 12 || 12;
  return `${h}${hour < 12 ? 'a' : 'p'}`;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Rolling 53-week contribution calendar ending in the current week. */
export const ActivityCalendar = memo(function ActivityCalendar() {
  const [streaks] = useStorageValue('streaks');
  const [gym] = useStorageValue('gym');
  const [srsDaily] = useStorageValue('srsDaily');
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);

  const todayKey = localDate();
  const model = useMemo(
    () => buildActivityDays(streaks.daily, gym.checkins, srsDaily, todayKey),
    [streaks, gym, srsDaily, todayKey],
  );
  const prime = useMemo(() => buildPrimeTime(streaks.daily, new Date()), [streaks]);
  const monthPrefix = todayKey.slice(0, 7);
  const thisMonthActivities = model.weeks
    .flat()
    .filter((day) => day.date.startsWith(monthPrefix))
    .reduce((total, day) => total + day.score, 0);

  const cols = model.weeks.length;
  // Columns stretch from --act-cell up to the cap on .act-inner; cells stay
  // square via aspect-ratio (see --act-cell / --act-cell-max)
  const gridCols = `repeat(${cols}, minmax(var(--act-cell), 1fr))`;

  // One delegated handler keeps the large calendar light while giving each
  // past day an immediate, contextual detail view.
  const onMouseOver = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.act-cell[data-tip]');
    const date = cell?.dataset.date;
    if (!date) return;
    const day = model.weeks.flat().find((entry) => entry.date === date);
    if (day) setSelectedDay(day);
  };

  const selectedDate = selectedDay ? dateFromKey(selectedDay.date) : null;
  const selectedWeekday = selectedDate ? weekdayIndex(selectedDate) : 0;
  const bars = selectedDay ? prime.grid[selectedWeekday] : [];
  const maxBar = Math.max(1, ...bars.map((bar) => bar.points));

  return (
    <section
      className={'ui-panel activity-strip' + (selectedDay ? ' has-detail' : '')}
      style={{ '--act-cols': cols } as React.CSSProperties}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setSelectedDay(null)}
    >
      <p className="act-headline">
        {thisMonthActivities > 0
          ? `${thisMonthActivities} activities this month`
          : 'No activity yet — finish a task, read, or hit the gym to light up the month'}
      </p>
      <div className="act-scroll">
        <div className="act-inner">
          <div className="act-months" style={{ gridTemplateColumns: gridCols }}>
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
          <div className="act-grid" style={{ gridTemplateColumns: gridCols }}>
            {model.weeks.map((week) => (
              <div className="act-week" key={week[0].date}>
                {week.map((day) =>
                  day.future ? (
                    <div className="act-cell future" key={day.date} />
                  ) : (
                    <div
                      className={day.date === todayKey ? 'act-cell today' : 'act-cell'}
                      data-level={day.level}
                      data-tip={day.tooltip}
                      data-date={day.date}
                      key={day.date}
                      role="button"
                      tabIndex={0}
                      aria-label={`${day.tooltip}. Show timing details.`}
                      onFocus={() => setSelectedDay(day)}
                    />
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
      {selectedDay && selectedDate && (
        <aside className="act-detail" aria-live="polite" aria-label={`Activity details for ${selectedDay.date}`}>
          <div className="act-detail-head">
            <div>
              <p className="act-detail-eyebrow">{selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
              <h2>{WEEKDAY_LABELS[selectedWeekday]} rhythm</h2>
            </div>
            <span className="act-detail-score">{selectedDay.score} <small>{selectedDay.score === 1 ? 'activity' : 'activities'}</small></span>
          </div>
          <p className="act-detail-summary">{selectedDay.tooltip}</p>
          <div className="act-detail-chart" aria-label={`Typical ${WEEKDAY_LABELS[selectedWeekday]} activity by hour`}>
            <div className="act-detail-bars">
              {bars.map((bar) => (
                <div className="act-detail-column" title={bar.tooltip} key={bar.hour}>
                  <div
                    className="act-detail-bar"
                    data-level={bar.level}
                    style={{ height: bar.points ? `${Math.max(8, (bar.points / maxBar) * 100)}%` : '0%' }}
                  />
                </div>
              ))}
            </div>
            <div className="act-detail-axis">
              {HOUR_TICKS.map((hour) => <span key={hour} style={{ gridColumnStart: hour + 1 }}>{hourLabel(hour)}</span>)}
            </div>
          </div>
          <div className="act-detail-stats">
            <span><small>Peak</small><strong>{prime.peak?.label ?? 'Learning'}</strong></span>
            <span><small>Recorded</small><strong>{Math.round(prime.totalPoints)} signals</strong></span>
          </div>
        </aside>
      )}
    </section>
  );
});
