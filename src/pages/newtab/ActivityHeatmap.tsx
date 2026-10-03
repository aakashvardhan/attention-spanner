import { type CSSProperties, type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildHeatModel, heatTooltip, plural, type ActivityMetric } from '../../shared/activity';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import type { Paper } from '../../shared/types';

const METRICS: { id: ActivityMetric; label: string }[] = [
  { id: 'all', label: 'Both' },
  { id: 'papers', label: 'Papers' },
  { id: 'focus', label: 'Focus' },
];
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
/** Arrow keys walk the calendar: a row is a weekday, a column a week. */
const STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

/**
 * GitHub's contribution calendar for papers read and focus sessions finished,
 * set as a section of the edition. Cells pop in as a wave on load and the
 * colour sweeps across the weeks when the metric changes.
 */
export function ActivityHeatmap({ papers }: { papers: Paper[] }) {
  const [log] = useStorageValue('activity');
  const [metric, setMetric] = useState<ActivityMetric>('all');
  const model = useMemo(() => buildHeatModel(log, papers, metric, new Date()), [log, papers, metric]);
  const days = useMemo(() => model.weeks.flat(), [model]);
  const labels = useMemo(() => days.map(heatTooltip), [days]);
  // Future days only trail the last column, so today is the last past one.
  const today = days.filter((day) => day.level !== null).length - 1;

  // Roving tabindex: one stop for the whole calendar, starting on today.
  const [active, setActive] = useState(-1);
  const current = active < 0 ? today : active;
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // On a narrow window the year scrolls; open on the newest weeks, as GitHub does.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, []);

  const show = (cell: HTMLElement) => {
    const host = frame.current?.getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    if (!host) return;
    setTip({ text: labels[Number(cell.dataset.i)], x: box.left + box.width / 2 - host.left, y: box.top - host.top });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(today, Math.max(0, current + step));
    setActive(next);
    scroller.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus();
  };

  const headline =
    metric === 'papers'
      ? `${plural(model.papers, 'paper')} read in the last year`
      : metric === 'focus'
        ? `${plural(model.focus, 'focus session')} finished in the last year`
        : `${plural(model.papers, 'paper')} and ${plural(model.focus, 'focus session')} in the last year`;

  return (
    <section className="heat" aria-labelledby="heat-title">
      <header className="heat-head">
        <div>
          <p className="edition-kicker">The record</p>
          <h2 id="heat-title" className="heat-title">
            {headline}
          </h2>
        </div>
        <div
          className="heat-seg"
          role="radiogroup"
          aria-label="Count"
          style={{ '--i': METRICS.findIndex((m) => m.id === metric) } as CSSProperties}
        >
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === metric}
              onClick={() => setMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      <div className="heat-frame" ref={frame}>
        <div className="heat-scroll" ref={scroller} onScroll={() => setTip(null)}>
          <div className="heat-table">
            <div className="heat-months" aria-hidden="true">
              {model.months.map((m) => (
                <span key={m.column} style={{ gridColumnStart: m.column + 1 }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="heat-days" aria-hidden="true">
              {DAY_LABELS.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>
            <div
              className="heat-grid"
              role="group"
              aria-label="Daily papers and focus sessions, last 53 weeks"
              onKeyDown={onKeyDown}
              onMouseOver={(e) => {
                const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
                if (cell) show(cell);
              }}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
            >
              {days.map((day, i) => {
                const style = { '--w': Math.floor(i / 7), '--d': i % 7 } as CSSProperties;
                return day.level === null ? (
                  <span key={day.date} className="heat-cell heat-cell--future" />
                ) : (
                  <span
                    key={day.date}
                    className="heat-cell"
                    data-i={i}
                    data-level={day.level}
                    style={style}
                    role="img"
                    aria-label={labels[i]}
                    tabIndex={i === current ? 0 : -1}
                    onFocus={(e) => {
                      setActive(i);
                      show(e.currentTarget);
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
        {tip && (
          <p className="heat-tip" aria-hidden="true" style={{ '--x': `${tip.x}px`, '--y': `${tip.y}px` } as CSSProperties}>
            {tip.text}
          </p>
        )}
      </div>

      <footer className="heat-foot">
        <p className="heat-note">A paper counts once a day; a focus session counts when it runs to the end.</p>
        <div className="heat-legend" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="heat-cell heat-cell--key" data-level={level} />
          ))}
          <span>More</span>
        </div>
      </footer>
    </section>
  );
}
