import { OLLAMA_NUM_CTX } from '../constants';

/**
 * On-device inference over Ollama's native API (localhost:11434).
 *
 * Called from extension pages, not the service worker: a stream renders where
 * it is read, and a page is not subject to the worker's idle kill. Plain fetch
 * also works in the worker if that ever matters.
 *
 * The one setup trap: Ollama rejects origins it does not know with a 403, and
 * `chrome-extension://` is not on its default list. `health()` reports that as
 * 'forbidden' so Settings can show the exact OLLAMA_ORIGINS fix.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type OllamaErrorKind = 'forbidden' | 'offline' | 'model' | 'http';

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type Health = { ok: true; models: string[] } | { ok: false; kind: OllamaErrorKind };

const base = (url: string) => url.replace(/\/+$/, '');

/**
 * Chrome sends no Origin header on an extension page's GET to a host it has
 * permission for, but does send `chrome-extension://…` on a POST — so the GET
 * listing models succeeds even when Ollama will refuse every generation. The
 * POST to /api/show is the real origin check: Ollama's CORS layer answers 403
 * before any handler runs, and anything else means this extension is allowed.
 * It asks about an installed model so the answer is a 200, not a 404 that
 * Chrome would log on every new tab.
 */
export async function health(url: string): Promise<Health> {
  try {
    const signal = AbortSignal.timeout(3000);
    const res = await fetch(`${base(url)}/api/tags`, { signal });
    if (res.status === 403) return { ok: false, kind: 'forbidden' };
    if (!res.ok) return { ok: false, kind: 'http' };
    const body = (await res.json()) as { models?: { name: string }[] };
    const models = (body.models ?? []).map((m) => m.name);
    const probe = await fetch(`${base(url)}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0] ?? '' }),
      signal,
    });
    if (probe.status === 403) return { ok: false, kind: 'forbidden' };
    return { ok: true, models };
  } catch {
    return { ok: false, kind: 'offline' };
  }
}

async function post(url: string, path: string, body: unknown, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`${base(url)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OllamaError('offline', 'Ollama is not reachable.');
  }
  if (res.status === 403) throw new OllamaError('forbidden', 'Ollama refused this extension.');
  if (res.status === 404) throw new OllamaError('model', 'That model is not installed in Ollama.');
  if (!res.ok) throw new OllamaError('http', `Ollama answered ${res.status}.`);
  return res;
}

/** Streams the reply; `onText` gets the whole text so far, not the delta. */
export async function chat(opts: {
  url: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<string> {
  const res = await post(
    opts.url,
    '/api/chat',
    {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      options: { num_ctx: OLLAMA_NUM_CTX },
    },
    opts.signal,
  );
  if (!res.body) throw new OllamaError('http', 'Ollama sent no body.');

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += value ?? '';
    // On the last read, flush whatever is left even without a trailing newline.
    const { lines, rest } = takeLines(done ? `${buffer}\n` : buffer);
    buffer = rest;
    for (const line of lines) {
      text += parseChatLine(line);
      opts.onText?.(text);
    }
    if (done) return text;
  }
}

export async function embed(opts: {
  url: string;
  model: string;
  input: string[];
  signal?: AbortSignal;
}): Promise<number[][]> {
  if (opts.input.length === 0) return [];
  const res = await post(opts.url, '/api/embed', { model: opts.model, input: opts.input }, opts.signal);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (body.embeddings?.length !== opts.input.length) {
    throw new OllamaError('http', 'Ollama returned the wrong number of embeddings.');
  }
  return body.embeddings;
}

/** Split complete NDJSON lines off a buffer; a partial last line is kept. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim() !== ''), rest };
}

/** One /api/chat stream line → the text it adds. Ollama reports failures in-band. */
export function parseChatLine(line: string): string {
  const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
  if (chunk.error) throw new OllamaError('http', chunk.error);
  return chunk.message?.content ?? '';
}
