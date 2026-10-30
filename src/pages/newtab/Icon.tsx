/**
 * The new tab's icon set: 24-unit grid, 1.75 stroke, round caps — the same
 * drawing rules as the reader toolbar's icons, so the two pages read as one
 * family. Paths are hand-drawn rather than pulled from a package; two icons
 * do not justify a dependency.
 */
const PATHS = {
  close: 'M6 6l12 12M18 6 6 18',
  lock: 'M8 11V8a4 4 0 0 1 8 0v3M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className: string }) {
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
