/** A list's first `limit` rows, or all of them once expanded; `hidden` is what "Show all" discloses. */
export function visibleRows<T>(items: readonly T[], expanded: boolean, limit = 5): { shown: T[]; hidden: number } {
  const shown = expanded ? items.slice() : items.slice(0, limit);
  return { shown, hidden: items.length - shown.length };
}
