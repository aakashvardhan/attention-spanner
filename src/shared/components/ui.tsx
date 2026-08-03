import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './ui.css';

/**
 * The five shapes every page was hand-rolling. Keep this module small and
 * boring: a primitive earns its place by replacing repeats that already
 * exist, not by anticipating a page that might want it.
 */

type Variant = 'primary' | 'tinted' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  block = false,
  className = '',
  ...rest
}: { variant?: Variant; block?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['ui-btn', `ui-btn--${variant}`];
  if (block) classes.push('ui-btn--block');
  if (className) classes.push(className);
  return <button type="button" className={classes.join(' ')} {...rest} />;
}

/**
 * A titled card. `action` is the optional control that sits opposite the
 * title (refresh, edit); pass nothing and the heading stands alone.
 */
export function Panel({
  title,
  action,
  className = '',
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `ui-panel ${className}` : 'ui-panel'}>
      <div className="ui-panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="ui-empty">{children}</p>;
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="ui-stats">{children}</div>;
}

export function Stat({
  value,
  label,
  title,
}: {
  value: ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <div className="ui-stat" title={title}>
      <span className="ui-stat-value">{value}</span>
      <span className="ui-stat-label">{label}</span>
    </div>
  );
}

/** `percent` is clamped — callers pass raw progress numbers. */
export function ProgressBar({ percent }: { percent: number }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className="ui-bar">
      <div className="ui-bar-fill" style={{ width: `${width}%` }} />
    </div>
  );
}
