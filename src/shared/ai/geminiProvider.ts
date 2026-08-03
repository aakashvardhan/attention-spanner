import { GEMINI_API_BASE, GEMINI_MODEL } from '../constants';
import { getSettings } from '../storage';
import type { AssistantProvider, AssistantTurn, GenerateRequest, ProviderReply } from './assistantTypes';
import type { SourceRef, Tool } from './tools';

/**
 * Cloud fallback provider over the Gemini API (generativelanguage). Runs in
 * extension pages like Nano — the worker stays out of inference. Requires the
 * user-supplied key in settings.geminiApiKey; inert without it. All response
 * parsing is pure and exported for unit tests.
 */

const GEMINI_TIMEOUT_MS = 60_000;

/** 5xx statuses Gemini returns when its backend is momentarily overloaded — a
 * short retry usually clears them, so we don't surface the first failure. */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
/** Backoff before each retry; the length also caps the number of retries.
 * Jitter is applied at runtime so many clients do not retry in lockstep. */
const RETRY_BACKOFFS_MS = [400, 1200];
/** A realtime chat should not disappear for a server-requested minute-long
 * delay. Honor Retry-After, but cap it and let the provider fallback take over. */
const MAX_RETRY_AFTER_MS = 3000;

export interface GeminiRetryOptions {
  backoffsMs?: readonly number[];
  maxRetryAfterMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

/** Map a tool's params schema to Gemini's OpenAPI-subset Schema (pure) */
export function toFunctionDeclaration(tool: Tool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.params.properties)) {
    properties[key] = {
      type: spec.type,
      description: spec.description,
      ...(spec.enum ? { enum: spec.enum } : {}),
      ...(spec.items ? { items: spec.items } : {}),
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', properties, required: tool.params.required },
  };
}

/**
 * Gemini's responseSchema is an OpenAPI subset that 400s on unknown fields —
 * notably `additionalProperties`, which our schemas carry for Nano's stricter
 * responseConstraint. Strip it recursively (pure).
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/** Build the generateContent request body (pure) */
export function buildGeminiBody(req: GenerateRequest): Record<string, unknown> {
  // A tool turn is an observation going back to the model; an assistant turn
  // that requested calls has to echo them, or the functionResponse below has
  // nothing to answer. Gemini pairs the two by name, not by id.
  const contents = req.turns.map((t: AssistantTurn) => {
    if (t.role === 'tool') {
      return {
        role: 'user',
        parts: [
          { functionResponse: { name: t.toolResult?.name ?? '', response: { result: t.text } } },
        ] as GeminiPart[],
      };
    }
    const parts: GeminiPart[] = t.text ? [{ text: t.text }] : [];
    for (const use of t.toolUses ?? []) {
      parts.push({ functionCall: { name: use.name, args: use.params } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  // Media rides on the last turn — the one being answered. Text stays first so
  // the instruction is read before the audio or images it applies to.
  const lastTurn = contents[contents.length - 1];
  if (req.audio && lastTurn) {
    lastTurn.parts.push({
      inlineData: { mimeType: req.audio.mimeType, data: req.audio.dataBase64 },
    });
  }
  if (lastTurn) {
    for (const image of req.images ?? []) {
      lastTurn.parts.push({
        inlineData: { mimeType: image.mimeType, data: image.dataBase64 },
      });
    }
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
  };
  if (req.responseSchema) {
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: sanitizeGeminiSchema(req.responseSchema),
    };
  }
  const tools: Record<string, unknown>[] = [];
  if (req.tools?.length) tools.push({ functionDeclarations: req.tools.map(toFunctionDeclaration) });
  // Google Search grounding — the model calls it only when it needs a fact it
  // doesn't hold (e.g. defining an unfamiliar term), so leaving it available is
  // cheap for questions that don't need it.
  if (req.webSearch) tools.push({ google_search: {} });
  if (tools.length) body.tools = tools;
  return body;
}

/** The candidate's parts, or a throw naming why there are none (pure) */
function geminiParts(json: unknown): GeminiPart[] {
  const parts = (
    json as { candidates?: { content?: { parts?: GeminiPart[] } }[] }
  )?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    const blocked = (json as { promptFeedback?: { blockReason?: string } })?.promptFeedback
      ?.blockReason;
    throw new Error(blocked ? `Request blocked (${blocked})` : 'Gemini returned no candidates');
  }
  return parts;
}

/**
 * The web pages a grounded answer actually rested on (pure). Without this the
 * model would have to recite URLs from memory, which is exactly how fabricated
 * citations happen — the real ones are right here in the response.
 *
 * `id` is left empty: the caller assigns turn-stable ids across every source it
 * collects, so a provider must not guess at numbering.
 */
export function groundingSources(json: unknown): SourceRef[] {
  const chunks = (
    json as {
      candidates?: { groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
    }
  )?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const sources: SourceRef[] = [];
  for (const chunk of chunks) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ id: '', kind: 'web', title: chunk.web?.title ?? url, url });
  }
  return sources;
}

/** Extract text + function calls + grounded sources from a response (pure) */
export function parseGeminiResponse(json: unknown): ProviderReply {
  const parts = geminiParts(json);
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  // Gemini sends no call ids; index is enough, since ids only have to be unique
  // within one request/response pair and functionResponse pairs by name anyway.
  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `gemini-${i}`,
      name: p.functionCall!.name,
      params: p.functionCall!.args ?? {},
    }));
  const sources = groundingSources(json);
  return {
    text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

/**
 * Pull the text delta out of one SSE `data:` payload (pure). Deliberately
 * untrimmed: a chunk's leading space is the space between it and the previous
 * chunk, so trimming each delta concatenates "This slide" and " explains" into
 * "This slideexplains". The whole answer is trimmed once, at the end.
 */
export function parseSseData(payload: string): string {
  if (payload === '[DONE]') return '';
  try {
    return geminiParts(JSON.parse(payload))
      .map((p) => p.text ?? '')
      .join('');
  } catch {
    return '';
  }
}

/** Map an error response to a user-facing message (pure). 429 means rate
 * limit OR depleted billing credits — the API's own message says which, so
 * pass it through rather than guessing. */
export function friendlyHttpError(status: number, body?: unknown): string {
  if (status === 400 || status === 403) return 'The Gemini API key looks invalid — check Settings.';
  const apiMessage = ((body as { error?: { message?: string } })?.error?.message ?? '').trim();
  if (status === 429) return apiMessage || 'Gemini rate limit hit — wait a minute and try again.';
  if (status >= 500 && status < 600) {
    return `Gemini is temporarily overloaded (HTTP ${status}) — try again in a moment.`;
  }
  return `Gemini request failed (HTTP ${status}).`;
}

/** Carries the HTTP status so callers can react to specific codes (e.g. drop an
 * unsupported grounding tool on 400) while still showing the friendly message. */
class GeminiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function httpError(res: Response): Promise<GeminiHttpError> {
  const body: unknown = await res.json().catch(() => undefined);
  return new GeminiHttpError(friendlyHttpError(res.status, body), res.status);
}

/** One POST attempt: the caller's signal cancels it, and it has its own timeout. */
function fetchGemini(url: string, body: string, signal?: AbortSignal): Promise<Response> {
  const attemptSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(GEMINI_TIMEOUT_MS)])
    : AbortSignal.timeout(GEMINI_TIMEOUT_MS);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: attemptSignal,
  });
}

/** Retry-After accepts either seconds or an HTTP date. Invalid values are ignored. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Exponential schedule plus ±20% jitter, raised to Retry-After when supplied. */
export function retryDelayMs(
  res: Response,
  attempt: number,
  options: GeminiRetryOptions = {},
): number {
  const backoffs = options.backoffsMs ?? RETRY_BACKOFFS_MS;
  const base = backoffs[attempt] ?? backoffs[backoffs.length - 1] ?? 0;
  const random = options.random?.() ?? Math.random();
  const jittered = Math.round(base * (0.8 + 0.4 * random));
  const server = parseRetryAfterMs(res.headers.get('retry-after'), options.now?.() ?? Date.now());
  return Math.min(
    options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS,
    Math.max(jittered, server ?? 0),
  );
}

/** A backoff wait that aborts immediately when the user cancels the turn. */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST to Gemini, retrying transient 5xx with a short backoff. A non-OK
 * response that isn't transient — or a final exhausted retry — throws a
 * friendly error. A timeout or an abort propagates immediately (not retried,
 * since those aren't a returned 5xx response).
 */
export async function fetchWithRetry(
  url: string,
  body: string,
  signal?: AbortSignal,
  options: GeminiRetryOptions = {},
): Promise<Response> {
  const backoffs = options.backoffsMs ?? RETRY_BACKOFFS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchGemini(url, body, signal);
    if (res.ok) return res;
    if (!TRANSIENT_STATUSES.has(res.status) || attempt >= backoffs.length) {
      throw await httpError(res);
    }
    // Free the failed body so the connection can be reused, then back off.
    const delay = retryDelayMs(res, attempt, { ...options, backoffsMs: backoffs });
    await res.body?.cancel().catch(() => {});
    await sleep(delay, signal);
  }
}

async function getKey(): Promise<string> {
  return (await getSettings()).geminiApiKey.trim();
}

export const geminiProvider: AssistantProvider = {
  id: 'gemini',

  async available() {
    return (await getKey()) !== '';
  },

  async generate(req: GenerateRequest): Promise<ProviderReply> {
    const key = await getKey();
    if (!key) throw new Error('No Gemini API key configured.');
    try {
      return await runGemini(req, key);
    } catch (err) {
      // If the configured model rejects the grounding tool, a plain retry still
      // answers — just without the web lookup — rather than failing the turn.
      if (req.webSearch && err instanceof GeminiHttpError && err.status === 400) {
        return await runGemini({ ...req, webSearch: false }, key);
      }
      throw err;
    }
  },
};

/** One generateContent call (streaming when a token callback is given). */
async function runGemini(req: GenerateRequest, key: string): Promise<ProviderReply> {
  const stream = !!req.onToken && !req.responseSchema;
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:${stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${encodeURIComponent(key)}`;

  const res = await fetchWithRetry(url, JSON.stringify(buildGeminiBody(req)), req.signal);

  if (!stream) return parseGeminiResponse(await res.json());

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const delta = parseSseData(line.slice(5).trim());
      if (delta) {
        text += delta;
        req.onToken!(text);
      }
    }
  }
  // Trimmed once here, matching the non-streaming path.
  return { text: text.trim() };
}

/** One tiny request to validate a key from the options page */
export async function testGeminiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key.trim())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return { ok: false, error: (await httpError(res)).message };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the Gemini API — check your connection.' };
  }
}
