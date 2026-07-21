/**
 * Deterministic command grammar — instant, free, and predictable for
 * destructive operations typed on a phone. Anything that doesn't parse gets
 * the help text back. (A Gemini structured-output fallback for natural
 * phrasing can slot in behind `unknown` later without touching the grammar.)
 */

export type Command =
  | { kind: 'help' }
  | { kind: 'task-add'; text: string }
  | { kind: 'task-list' }
  | { kind: 'task-done'; ref: string }
  | { kind: 'task-del'; ref: string }
  | { kind: 'task-edit'; ref: string; text: string }
  | { kind: 'card-add'; deck: string | null; front: string; back: string }
  | { kind: 'paper-add'; ref: string }
  | { kind: 'paper-list' }
  | { kind: 'paper-del'; ref: string }
  | { kind: 'event-add'; date: string | null; time: string; title: string }
  | { kind: 'unknown'; input: string };

export const HELP_TEXT = [
  'Commands:',
  'task add <text>',
  'task list',
  'task done <n or words>',
  'task del <n or words>',
  'task edit <n or words>: <new text>',
  'card add [deck:] <front> | <back>',
  'paper add <url or title>',
  'paper list',
  'paper del <words>',
  'event add [YYYY-MM-DD] <HH:MM> <title>',
].join('\n');

export function parseCommand(raw: string): Command {
  const input = raw.trim().replace(/\s+/g, ' ');
  const lower = input.toLowerCase();

  if (lower === 'help' || lower === '?') return { kind: 'help' };

  let m = /^task add (.+)$/i.exec(input);
  if (m) return { kind: 'task-add', text: m[1] };
  if (/^task list$/i.test(input)) return { kind: 'task-list' };
  m = /^task done (.+)$/i.exec(input);
  if (m) return { kind: 'task-done', ref: m[1] };
  m = /^task del(?:ete)? (.+)$/i.exec(input);
  if (m) return { kind: 'task-del', ref: m[1] };
  m = /^task edit (.+?):\s*(.+)$/i.exec(input);
  if (m) return { kind: 'task-edit', ref: m[1], text: m[2] };

  m = /^card add (?:([^:|]+):\s*)?(.+?)\s*\|\s*(.+)$/i.exec(input);
  if (m) return { kind: 'card-add', deck: m[1]?.trim() ?? null, front: m[2], back: m[3] };

  m = /^paper add (.+)$/i.exec(input);
  if (m) return { kind: 'paper-add', ref: m[1] };
  if (/^paper list$/i.test(input)) return { kind: 'paper-list' };
  m = /^paper del(?:ete)? (.+)$/i.exec(input);
  if (m) return { kind: 'paper-del', ref: m[1] };

  m = /^event add (?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}:\d{2}) (.+)$/i.exec(input);
  if (m) return { kind: 'event-add', date: m[1] ?? null, time: m[2], title: m[3] };

  return { kind: 'unknown', input };
}

/** "2" → index 1; otherwise null (caller falls back to fuzzy text match) */
export function parseIndexRef(ref: string): number | null {
  const n = Number(ref.trim());
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}
