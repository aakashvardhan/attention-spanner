/**
 * Accessibility violations that exist today and are accepted for now, per page.
 * expectA11y fails on anything not listed here AND on anything listed that no
 * longer occurs, so this list can only shrink. Every entry needs a reason.
 */
export const A11Y_BASELINE: Record<string, { rule: string; reason: string }[]> = {};
