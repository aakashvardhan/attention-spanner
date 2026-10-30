import { type CSSProperties, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { buildHeatModel, heatTooltip, plural, type ActivityMetric } from '../../shared/activity';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import type { Paper } from '../../shared/types';

const METRICS: { id: ActivityMetric; label: string }[] = [
  { id: 'all', label: 'Both' },
  { id: 'papers', label: 'Papers' },
  { id: 'focus', label: 'Focus' },
];
/** Arrow keys walk the calendar: a row is a weekday, a column a week. */
const STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

/**
 * GitHub's contribution calendar for papers read and focus sessions finished,
 * compact enough for the Now column: the year's 53 weeks share its width, and
 * the ramp is the Clay heat tokens. Nothing moves.
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
    frame.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus();
  };

  const headline =
    metric === 'papers'
      ? `${plural(model.papers, 'paper')} read in the last year`
      : metric === 'focus'
        ? `${plural(model.focus, 'focus session')} finished in the last year`
        : `${plural(model.papers, 'paper')} and ${plural(model.focus, 'focus session')} in the last year`;

  return (
    <section className="heat" aria-label="Activity">
      <h2 className="label">Activity</h2>
      <div className="heat-head">
        <p className="heat-title">{headline}</p>
        <div className="heat-seg" role="radiogroup" aria-label="Count">
          {METRICS.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === metric} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="heat-frame" ref={frame}>
        <div className="heat-months" aria-hidden="true">
          {model.months.map((m) => (
            <span key={m.column} style={{ gridColumnStart: m.column + 1 }}>
              {m.label}
            </span>
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
          {days.map((day, i) =>
            day.level === null ? (
              <span key={day.date} className="heat-cell heat-cell--future" />
            ) : (
              <span
                key={day.date}
                className="heat-cell"
                data-i={i}
                data-level={day.level}
                role="img"
                aria-label={labels[i]}
                tabIndex={i === current ? 0 : -1}
                onFocus={(e) => {
                  setActive(i);
                  show(e.currentTarget);
                }}
              />
            ),
          )}
        </div>
        {tip && (
          <p className="heat-tip" aria-hidden="true" style={{ '--x': `${tip.x}px`, '--y': `${tip.y}px` } as CSSProperties}>
            {tip.text}
          </p>
        )}
      </div>
    </section>
  );
}
