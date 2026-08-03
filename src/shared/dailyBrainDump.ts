import {
  DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS,
  DAILY_GATE_ALLOW_DNR_ID,
  DAILY_GATE_ALLOW_PRIORITY,
  DAILY_GATE_DNR_ID,
  DAILY_GATE_REDIRECT_PRIORITY,
} from './constants';
import { localDate } from './format';
import type { BrainDumpNote, DailyBrainDumpGateState } from './types';

export function visibleCharacterCount(text: string): number {
  return Array.from(text).filter((char) => !/\s/u.test(char)).length;
}

export function qualifiesDailyBrainDump(text: string): boolean {
  return visibleCharacterCount(text) >= DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS;
}

/** Offline fallback so the daily review still has a scannable outline when no
 * AI engine is available. AI output replaces this whenever possible. */
export function basicBrainDumpBullets(text: string): string[] {
  const input = text.trim();
  if (!input) return [];
  const lines = input
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  const candidates =
    lines.length > 1
      ? lines
      : input
          .split(/(?<=[.!?])\s+|;\s+/)
          .map((part) => part.trim())
          .filter(Boolean);
  return [...new Set(candidates)].slice(0, 3);
}

export function isDailyBrainDumpComplete(
  state: DailyBrainDumpGateState,
  date = localDate(),
): boolean {
  return state.date === date && state.completedAt !== null && state.noteId !== null;
}

export function noteLocalDate(note: BrainDumpNote): string {
  return localDate(new Date(note.createdAt));
}

/**
 * Resolve a stale/missing gate state for the current local date. Existing
 * encrypted notes are grandfathered because their plaintext length is
 * intentionally unavailable without unlocking the vault.
 */
export function gateStateForDate(
  state: DailyBrainDumpGateState,
  notes: readonly BrainDumpNote[],
  date = localDate(),
): DailyBrainDumpGateState {
  if (isDailyBrainDumpComplete(state, date)) return state;
  const existing = notes.find(
    (note) =>
      noteLocalDate(note) === date &&
      (note.encRaw !== undefined || qualifiesDailyBrainDump(note.rawText)),
  );
  return existing
    ? { date, completedAt: existing.createdAt, noteId: existing.id }
    : state.date === date
      ? state
      : { date, completedAt: null, noteId: null };
}

export function nextLocalMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

export function buildDailyGateRedirectRule(
  redirectBase: string,
): chrome.declarativeNetRequest.Rule {
  return {
    id: DAILY_GATE_DNR_ID,
    priority: DAILY_GATE_REDIRECT_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `${redirectBase}#\\0` },
    },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

export function buildDailyGateAllowRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: DAILY_GATE_ALLOW_DNR_ID,
    priority: DAILY_GATE_ALLOW_PRIORITY,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

export function safeOriginalUrl(hash: string): URL | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
