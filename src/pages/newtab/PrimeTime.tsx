import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../shared/components/ui';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { activityLevel, weekdayIndex } from '../../shared/activity';
import { buildPrimeTime } from '../../shared/primeTime';
import { DEFAULT_SETTINGS } from '../../shared/storage';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
/** Axis ticks every three hours, matching the graph's 24 columns */
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

function tickLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'a' : 'p'}`;
}

/**
 * '9-10pm — 3 activities' for the pooled view. Same shape as the grid's
 * per-cell copy (primeTime.ts) minus the weekday prefix — the "All" bars are
 * summed across every day, so no single weekday belongs on the label.
 */
function pooledTooltip(hour: number, points: number): string {
  const start = hour % 12 === 0 ? 12 : hour % 12;
  const endHour = hour + 1;
  const end = endHour % 12 === 0 ? 12 : endHour % 12;
  const meridiem = endHour % 24 < 12 ? 'am' : 'pm';
  const span = `${start}-${end}${meridiem}`;
  if (points <= 0) return `${span} — Nothing`;
  const rounded = Math.round(points);
  return `${span} — ${rounded === 1 ? '1 activity' : `${rounded} activities`}`;
}

/** When in the day activity actually lands — the calendar's "when", next to its "whether" */
export const PrimeTime = memo(function PrimeTime() {
  const [streaks] = useStorageValue('streaks');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const focus = useFocusSession();
  const stripRef = useRef<HTMLElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  // 'all' pools every weekday into one profile; a number filters to that weekday
  const [view, setView] = useState<'all' | number>('all');

  // The headline and the "now" column are hour-dependent; re-render on the turn
  // of the hour, not every minute
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const model = useMemo(() => buildPrimeTime(streaks.daily, new Date()), [streaks, hour]);
  const today = weekdayIndex(new Date());

  // The peak window is a pooled claim, so it stays put under the weekday filter —
  // drawn as a band behind those columns. Three hours, wrapping past midnight.
  const peakHours = useMemo(() => {
    const set = new Set<number>();
    if (model.peak) for (let h = model.peak.startHour; h < model.peak.endHour; h++) set.add(h % 24);
    return set;
  }, [model.peak]);

  // 24 bars for the selected view, each scaled to that view's own max so the
  // shape of the day reads whether the day was busy or quiet.
  const bars = useMemo(() => {
    const series = view === 'all' ? model.hourProfile : model.grid[view].map((cell) => cell.points);
    const max = Math.max(1, ...series);
    return series.map((value, hr) => ({
      hour: hr,
      // a nonzero hour keeps a visible stub even when it's a sliver of the max
      heightPct: value <= 0 ? 0 : Math.max(6, (value / max) * 100),
      level: activityLevel(value, max),
      now: hr === hour,
      inPeak: peakHours.has(hr),
      tooltip: view === 'all' ? pooledTooltip(hr, value) : model.grid[view][hr].tooltip,
    }));
  }, [model, view, hour, peakHours]);

  // Delegated hover: one listener for all 24 columns (same pattern as ActivityCalendar)
  const onMouseOver = (e: React.MouseEvent) => {
    const col = (e.target as HTMLElement).closest<HTMLElement>('.pt-col[data-tip]');
    if (!col || !stripRef.current) {
      setTip(null);
      return;
    }
    const strip = stripRef.current.getBoundingClientRect();
    const rect = col.getBoundingClientRect();
    const x = rect.left - strip.left + rect.width / 2;
    setTip({
      text: col.dataset.tip!,
      x: Math.max(120, Math.min(x, strip.width - 120)),
      y: rect.top - strip.top,
    });
  };

  return (
    <section
      className="ui-panel prime-time"
      ref={stripRef}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setTip(null)}
    >
      <div className="ui-panel-head">
        <h2>Prime time</h2>
        <div className="pt-filter" role="group" aria-label="Filter by weekday">
          <button
            type="button"
            className={'pt-chip' + (view === 'all' ? ' active' : '')}
            aria-pressed={view === 'all'}
            onClick={() => setView('all')}
          >
            All
          </button>
          {DAY_LABELS.map((label, weekday) => (
            <button
              type="button"
              key={label}
              className={
                'pt-chip' + (view === weekday ? ' active' : '') + (weekday === today ? ' is-today' : '')
              }
              aria-pressed={view === weekday}
              onClick={() => setView(weekday)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Graph left at the calendar's cell size, the read-out in the width left
          over — 24 GitHub-sized bars can't span the panel on their own */}
      <div className="pt-main">
        <div className="pt-scroll">
          <div className="pt-inner">
            <div className="pt-bars">
              {bars.map((bar) => (
                <div
                  className={'pt-col' + (bar.now ? ' now' : '') + (bar.inPeak ? ' in-peak' : '')}
                  data-tip={bar.tooltip}
                  key={bar.hour}
                >
                  <div className="pt-bar" data-level={bar.level} style={{ height: `${bar.heightPct}%` }} />
                </div>
              ))}
            </div>
            <div className="pt-axis">
              {HOUR_TICKS.map((tick) => (
                <span key={tick} style={{ gridColumnStart: tick + 1 }}>
                  {tickLabel(tick)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="pt-side">
          {model.peak && model.dead && (
            <dl className="pt-windows">
              <div>
                <dt>Peak</dt>
                <dd>{model.peak.label}</dd>
              </div>
              <div>
                <dt>Dead</dt>
                <dd>{model.dead.label}</dd>
              </div>
            </dl>
          )}
          <p className="pt-headline">{model.headline}</p>
          {model.nowInPeak && !focus.active && (
            <Button
              onClick={() =>
                void focus.start({
                  mode: 'oneshot',
                  focusMinutes: settings.focusMinutes,
                  breakMinutes: 0,
                })
              }
            >
              Start focus
            </Button>
          )}
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
