import {
  FLASHCARDS_PAGE_PATH,
  NEWTAB_PAGE_PATH,
  PAPERS_PAGE_PATH,
} from '../constants';
import { sendMessage } from '../messages';
import { getLocal, getSettings } from '../storage';
import type { Task } from '../types';

/**
 * The assistant's action layer: each tool wraps an existing typed RPC message
 * (src/shared/messages.ts → background router), so the assistant is just
 * another UI caller — no new background capabilities. The same params schema
 * drives Nano's responseConstraint and (later) Gemini functionDeclarations.
 */

export interface ToolParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  /** Item schema for array params — items validate inside the tool's run() */
  items?: object;
}

export interface ToolParamsSchema {
  type: 'object';
  required: string[];
  additionalProperties: false;
  properties: Record<string, ToolParamSpec>;
}

export interface Tool {
  name: string;
  /** Shown to the LLM when routing/extracting — write for the model */
  description: string;
  params: ToolParamsSchema;
  /** Mutating tools require a confirm chip before run() */
  confirm?: boolean;
  /** Command-palette entry (Phase C); tools without it are chat-only */
  palette?: { label: string; keywords: string[]; argPlaceholder?: string };
  /** One-line human phrasing of the pending call, for the confirm chip */
  summary(params: Record<string, unknown>): string;
  /** Executes the action; resolves to a human-readable result line */
  run(params: Record<string, unknown>): Promise<string>;
}

const NO_PARAMS: ToolParamsSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {},
};

/**
 * Validate (and gently coerce) LLM-produced params against a tool's schema:
 * unknown keys are stripped, "25" becomes 25 where a number is expected,
 * missing required keys or enum violations fail.
 */
export function validateToolCall(
  tool: Tool,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'params is not an object' };
  }
  const input = raw as Record<string, unknown>;
  const params: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(tool.params.properties)) {
    let value = input[key];
    if (value == null || value === '') continue;

    if (spec.type === 'number' && typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (!Number.isNaN(n)) value = n;
    }
    if (spec.type === 'boolean' && (value === 'true' || value === 'false')) {
      value = value === 'true';
    }
    if (spec.type === 'array' ? !Array.isArray(value) : typeof value !== spec.type) {
      return { ok: false, error: `${key} should be a ${spec.type}` };
    }
    if (spec.enum && !spec.enum.includes(value as string)) {
      return { ok: false, error: `${key} must be one of: ${spec.enum.join(', ')}` };
    }
    if (spec.type === 'number') {
      const n = value as number;
      if (spec.minimum !== undefined && n < spec.minimum) {
        return { ok: false, error: `${key} must be ≥ ${spec.minimum}` };
      }
      if (spec.maximum !== undefined && n > spec.maximum) {
        return { ok: false, error: `${key} must be ≤ ${spec.maximum}` };
      }
    }
    if (spec.type === 'string' && spec.maxLength) {
      value = (value as string).slice(0, spec.maxLength);
    }
    params[key] = value;
  }

  for (const key of tool.params.required) {
    if (params[key] === undefined) {
      return { ok: false, error: `missing required ${key}` };
    }
  }
  return { ok: true, params };
}

export type TaskResolution =
  | { kind: 'match'; task: Task }
  | { kind: 'ambiguous'; candidates: Task[] }
  | { kind: 'none' };

/** Filler words that shouldn't count against the token-overlap ratio */
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'about', 'task', 'one']);

/**
 * Fuzzy-match a user phrase to an open task so the LLM never has to produce
 * ids. Pure — takes the task list — for unit testing.
 */
export function resolveTaskByText(tasks: Task[], query: string): TaskResolution {
  const open = tasks.filter((t) => t.completedAt === null);
  const q = query.trim().toLowerCase();
  if (!q || open.length === 0) return { kind: 'none' };

  const qTokens = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const scored = open
    .map((task) => {
      const text = task.text.toLowerCase();
      if (text === q) return { task, score: 4 };
      if (text.includes(q) || q.includes(text)) return { task, score: 3 };
      if (qTokens.length === 0) return { task, score: 0 };
      const hit = qTokens.filter((tok) => text.includes(tok)).length;
      return { task, score: (hit / qTokens.length) * 2 };
    })
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'none' };
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return { kind: 'match', task: scored[0].task };
  }
  return { kind: 'ambiguous', candidates: scored.slice(0, 3).map((s) => s.task) };
}

async function resolveTaskOrThrow(query: string): Promise<Task> {
  const { tasks } = await getLocal('tasks');
  const res = resolveTaskByText(tasks, query);
  if (res.kind === 'match') return res.task;
  if (res.kind === 'ambiguous') {
    const names = res.candidates.map((t) => `“${t.text}”`).join(', ');
    throw new Error(`A few tasks match — did you mean ${names}? Say it more specifically.`);
  }
  throw new Error(`I couldn't find an open task matching “${query}”.`);
}

/** First matching flashcards deck by name, else the first flashcards deck, else create one */
async function resolveFlashDeckId(name?: string): Promise<string> {
  const { decks } = await getLocal('decks');
  const flashDecks = decks.filter((d) => (d.kind ?? 'flashcards') === 'flashcards');
  if (name) {
    const q = name.trim().toLowerCase();
    const hit = flashDecks.find((d) => d.name.toLowerCase().includes(q));
    if (hit) return hit.id;
  }
  if (flashDecks[0]) return flashDecks[0].id;
  const res = await sendMessage({ type: 'FLASH_ADD_DECK', name: 'Inbox', kind: 'flashcards' });
  if (!res.ok || !res.deck) throw new Error(res.error ?? 'Could not create a deck');
  return res.deck.id;
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  new URL(url); // throws on junk
  return url;
}

export const TOOLS: readonly Tool[] = [
  {
    name: 'add_task',
    description: 'Add a new to-do task to the task list.',
    params: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The task text, imperative, short', maxLength: 300 },
      },
    },
    confirm: true,
    palette: { label: 'Add task', keywords: ['todo', 'task', 'new'], argPlaceholder: 'task text' },
    summary: (p) => `Add task “${p.text as string}”`,
    run: async (p) => {
      const res = await sendMessage({ type: 'ADD_TASK', text: p.text as string, source: 'newtab' });
      return `Added task “${res.task.text}”.`;
    },
  },
  {
    name: 'complete_task',
    description: 'Mark an existing open task as done. Takes the task wording, not an id.',
    params: {
      type: 'object',
      required: ['task'],
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Words identifying the task to complete', maxLength: 300 },
      },
    },
    confirm: true,
    summary: (p) => `Mark “${p.task as string}” as done`,
    run: async (p) => {
      const task = await resolveTaskOrThrow(p.task as string);
      await sendMessage({ type: 'TOGGLE_TASK', id: task.id });
      return `Marked “${task.text}” as done. 🎉`;
    },
  },
  {
    name: 'snooze_task',
    description: 'Snooze reminders for an open task for some minutes (default 60).',
    params: {
      type: 'object',
      required: ['task'],
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Words identifying the task to snooze', maxLength: 300 },
        minutes: { type: 'number', description: 'Minutes to snooze for', minimum: 5, maximum: 1440 },
      },
    },
    confirm: true,
    summary: (p) => `Snooze “${p.task as string}” for ${(p.minutes as number) ?? 60} min`,
    run: async (p) => {
      const task = await resolveTaskOrThrow(p.task as string);
      const minutes = (p.minutes as number) ?? 60;
      await sendMessage({ type: 'SNOOZE_TASK', id: task.id, minutes });
      return `Snoozed “${task.text}” for ${minutes} minutes.`;
    },
  },
  {
    name: 'start_focus',
    description:
      'Start a focus session that blocks distracting sites. Optional length in minutes; pomodoro=true for repeating focus/break cycles.',
    params: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        minutes: { type: 'number', description: 'Focus length in minutes', minimum: 5, maximum: 240 },
        pomodoro: { type: 'boolean', description: 'true for pomodoro focus/break cycles' },
      },
    },
    confirm: true,
    palette: { label: 'Start focus session', keywords: ['focus', 'block', 'pomodoro'] },
    summary: (p) =>
      p.pomodoro
        ? 'Start a pomodoro focus session'
        : `Start a ${p.minutes ? `${p.minutes as number}-minute ` : ''}focus session`,
    run: async (p) => {
      const settings = await getSettings();
      const pomodoro = p.pomodoro === true;
      const focusMinutes = (p.minutes as number) ?? settings.focusMinutes;
      await sendMessage({
        type: 'START_FOCUS',
        mode: pomodoro ? 'pomodoro' : 'oneshot',
        focusMinutes,
        breakMinutes: pomodoro ? settings.focusBreakMinutes : 0,
      });
      return pomodoro
        ? `Pomodoro started — ${focusMinutes} min focus / ${settings.focusBreakMinutes} min break. Sites blocked. 🎯`
        : `Focus started for ${focusMinutes} minutes — ${settings.focusBlocklist.length} sites blocked. 🎯`;
    },
  },
  {
    name: 'stop_focus',
    description: 'End the current focus session early.',
    params: NO_PARAMS,
    confirm: true,
    palette: { label: 'End focus session', keywords: ['stop', 'focus', 'end'] },
    summary: () => 'End the focus session early',
    run: async () => {
      await sendMessage({ type: 'STOP_FOCUS', early: true });
      return 'Focus session ended.';
    },
  },
  {
    name: 'start_sprint',
    description: 'Start a short committed reading sprint (counts toward the reading streak).',
    params: NO_PARAMS,
    confirm: true,
    palette: { label: 'Start reading sprint', keywords: ['sprint', 'read'] },
    summary: () => 'Start a reading sprint',
    run: async () => {
      await sendMessage({ type: 'START_SPRINT' });
      return 'Reading sprint started — stay with it. 📖';
    },
  },
  {
    name: 'gym_checkin',
    description: 'Log a gym check-in for today (one per day, counts toward the weekly gym streak).',
    params: NO_PARAMS,
    confirm: true,
    palette: { label: 'Gym check-in', keywords: ['gym', 'workout', 'exercise'] },
    summary: () => 'Log a gym check-in for today',
    run: async () => {
      await sendMessage({ type: 'GYM_CHECKIN' });
      return 'Gym check-in logged. 💪';
    },
  },
  {
    name: 'add_bookmark',
    description: 'Save a link/bookmark to the dashboard links panel.',
    params: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL to save', maxLength: 2000 },
        title: { type: 'string', description: 'Short display name for the link', maxLength: 100 },
      },
    },
    confirm: true,
    summary: (p) => `Save bookmark ${p.url as string}`,
    run: async (p) => {
      const url = normalizeUrl(p.url as string);
      const res = await sendMessage({
        type: 'ADD_BOOKMARK',
        url,
        title: (p.title as string) ?? '',
        groupId: null,
      });
      return `Saved “${res.bookmark.title || url}” to your links.`;
    },
  },
  {
    name: 'create_flashcard',
    description: 'Create a basic front/back flashcard for spaced-repetition study.',
    params: {
      type: 'object',
      required: ['front', 'back'],
      additionalProperties: false,
      properties: {
        front: { type: 'string', description: 'Question / front of the card', maxLength: 500 },
        back: { type: 'string', description: 'Answer / back of the card', maxLength: 500 },
        deck: { type: 'string', description: 'Deck name to add to (optional)', maxLength: 100 },
      },
    },
    confirm: true,
    summary: (p) => `Create flashcard “${p.front as string}”`,
    run: async (p) => {
      const deckId = await resolveFlashDeckId(p.deck as string | undefined);
      const res = await sendMessage({
        type: 'FLASH_ADD_NOTE',
        deckId,
        noteType: 'basic',
        front: p.front as string,
        back: p.back as string,
        reversed: false,
      });
      if (!res.ok) throw new Error(res.error ?? 'Could not create the card');
      return `Flashcard created: “${p.front as string}”. 🃏`;
    },
  },
  {
    name: 'save_flashcards',
    description:
      'Save several front/back flashcards at once (used after generating cards from a page).',
    params: {
      type: 'object',
      required: ['cards'],
      additionalProperties: false,
      properties: {
        cards: {
          type: 'array',
          description: 'The cards to save',
          items: {
            type: 'object',
            required: ['front', 'back'],
            properties: {
              front: { type: 'string', maxLength: 500 },
              back: { type: 'string', maxLength: 500 },
            },
          },
        },
        deck: { type: 'string', description: 'Deck name to add to (optional)', maxLength: 100 },
      },
    },
    confirm: true,
    summary: (p) => {
      const n = Array.isArray(p.cards) ? p.cards.length : 0;
      return `Save ${n} flashcard${n === 1 ? '' : 's'}`;
    },
    run: async (p) => {
      const cards = (Array.isArray(p.cards) ? p.cards : []).filter(
        (c): c is { front: string; back: string } =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as { front?: unknown }).front === 'string' &&
          typeof (c as { back?: unknown }).back === 'string',
      );
      if (cards.length === 0) throw new Error('No usable cards to save.');
      const deckId = await resolveFlashDeckId(p.deck as string | undefined);
      let saved = 0;
      for (const card of cards.slice(0, 12)) {
        const res = await sendMessage({
          type: 'FLASH_ADD_NOTE',
          deckId,
          noteType: 'basic',
          front: card.front.slice(0, 500),
          back: card.back.slice(0, 500),
          reversed: false,
        });
        if (res.ok) saved += 1;
      }
      if (saved === 0) throw new Error('Could not save the cards.');
      return `Saved ${saved} flashcard${saved === 1 ? '' : 's'}. 🃏`;
    },
  },
  {
    name: 'mark_all_read',
    description: 'Mark every RSS feed item as read.',
    params: NO_PARAMS,
    confirm: true,
    palette: { label: 'Mark all feeds read', keywords: ['feeds', 'read', 'clear'] },
    summary: () => 'Mark all feed items as read',
    run: async () => {
      const res = await sendMessage({ type: 'MARK_ALL_READ' });
      return `Marked ${res.count} items as read.`;
    },
  },
  {
    name: 'refresh_feeds',
    description: 'Refresh the RSS feeds now.',
    params: NO_PARAMS,
    palette: { label: 'Refresh feeds', keywords: ['rss', 'refresh', 'reload'] },
    summary: () => 'Refresh the feeds',
    run: async () => {
      const res = await sendMessage({ type: 'REFRESH_FEEDS' });
      return res.ok ? `Feeds refreshed — ${res.itemCount} items.` : 'Feed refresh failed.';
    },
  },
  {
    name: 'open_page',
    description: 'Open one of the extension pages: dashboard, flashcards, papers, or settings.',
    params: {
      type: 'object',
      required: ['page'],
      additionalProperties: false,
      properties: {
        page: {
          type: 'string',
          description: 'Which page to open',
          enum: ['dashboard', 'flashcards', 'papers', 'settings'],
        },
      },
    },
    palette: { label: 'Open page…', keywords: ['open', 'go', 'flashcards', 'papers', 'settings'] },
    summary: (p) => `Open the ${p.page as string} page`,
    run: async (p) => {
      const page = p.page as string;
      if (page === 'settings') {
        await chrome.runtime.openOptionsPage();
      } else {
        const path =
          page === 'flashcards'
            ? FLASHCARDS_PAGE_PATH
            : page === 'papers'
              ? PAPERS_PAGE_PATH
              : NEWTAB_PAGE_PATH;
        await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
      }
      return `Opened ${page}.`;
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
