/**
 * The new tab's icon set: 24-unit grid, 1.75 stroke, round caps — the same
 * drawing rules as the reader toolbar's icons, so the two pages read as one
 * family. Paths are hand-drawn rather than pulled from a package; nine icons
 * do not justify a dependency.
 */
const PATHS = {
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  papers: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h4',
  settings:
    'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16Z',
  play: 'M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5Z',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4',
  chevron: 'm9 6 6 6-6 6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'relay-icon' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A section title with its icon on a tinted plate, Figma-sidebar style. */
export function CardTitle({ id, icon, children }: { id: string; icon: IconName; children: string }) {
  return (
    <h2 id={id} className="relay-card-title">
      <span className="relay-card-glyph">
        <Icon name={icon} />
      </span>
      {children}
    </h2>
  );
}
