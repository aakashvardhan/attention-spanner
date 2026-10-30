/** The "Show all N" text button under a capped list; nothing when the list fits. */
export function ShowAll({
  total,
  hidden,
  expanded,
  onToggle,
}: {
  total: number;
  hidden: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!expanded && hidden === 0) return null;
  return (
    <button type="button" className="show-all" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? 'Show fewer' : `Show all ${total}`}
    </button>
  );
}
