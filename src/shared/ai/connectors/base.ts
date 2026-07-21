import { sendMessage } from '../../messages';
import { getLocal } from '../../storage';
import type { Settings, Task } from '../../types';

/**
 * Tool/connector foundation. A Tool wraps an existing typed RPC message
 * (src/shared/messages.ts → background router), so the assistant is just
 * another UI caller — no new background capabilities. A Connector groups the
 * tools of one integration/feature so surfaces can advertise only what is
 * actually available (and future integrations — WhatsApp, Notion — register
 * here instead of growing a monolith).
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

/** What a connector needs to decide whether its tools should be advertised */
export interface ConnectorEnv {
  settings: Settings;
  calendarConnected: boolean;
}

export interface Connector {
  id: string;
  label: string;
  /** Whether this connector's tools should be advertised to the router */
  isAvailable(env: ConnectorEnv): boolean;
  tools: readonly Tool[];
  /** Optional extra lines for the assistant's data context */
  contextProvider?: () => Promise<string>;
}

export const NO_PARAMS: ToolParamsSchema = {
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

export type TextResolution<T> =
  | { kind: 'match'; item: T }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'none' };

export type TaskResolution =
  | { kind: 'match'; task: Task }
  | { kind: 'ambiguous'; candidates: Task[] }
  | { kind: 'none' };

/** Filler words that shouldn't count against the token-overlap ratio */
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'about', 'task', 'one']);

/**
 * Fuzzy-match a user phrase to one of `items` so the LLM never has to produce
 * ids. Pure; shared by task and memory-fact resolution.
 */
export function resolveByText<T>(
  items: T[],
  textOf: (item: T) => string,
  query: string,
): TextResolution<T> {
  const q = query.trim().toLowerCase();
  if (!q || items.length === 0) return { kind: 'none' };

  const qTokens = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const scored = items
    .map((item) => {
      const text = textOf(item).toLowerCase();
      if (text === q) return { item, score: 4 };
      if (text.includes(q) || q.includes(text)) return { item, score: 3 };
      if (qTokens.length === 0) return { item, score: 0 };
      const hit = qTokens.filter((tok) => text.includes(tok)).length;
      return { item, score: (hit / qTokens.length) * 2 };
    })
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'none' };
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return { kind: 'match', item: scored[0].item };
  }
  return { kind: 'ambiguous', candidates: scored.slice(0, 3).map((s) => s.item) };
}

/** Task-shaped wrapper over resolveByText (open tasks only) */
export function resolveTaskByText(tasks: Task[], query: string): TaskResolution {
  const res = resolveByText(
    tasks.filter((t) => t.completedAt === null),
    (t) => t.text,
    query,
  );
  if (res.kind === 'match') return { kind: 'match', task: res.item };
  if (res.kind === 'ambiguous') return { kind: 'ambiguous', candidates: res.candidates };
  return { kind: 'none' };
}

export async function resolveTaskOrThrow(query: string): Promise<Task> {
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
export async function resolveFlashDeckId(name?: string): Promise<string> {
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

export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  new URL(url); // throws on junk
  return url;
}
