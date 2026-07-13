import { GEMINI_API_BASE, GEMINI_MODEL } from '../constants';
import { getSettings } from '../storage';
import type { AssistantProvider, AssistantTurn, GenerateRequest, ProviderReply } from './assistantTypes';
import type { Tool } from './tools';

/**
 * Cloud fallback provider over the Gemini API (generativelanguage). Runs in
 * extension pages like Nano — the worker stays out of inference. Requires the
 * user-supplied key in settings.geminiApiKey; inert without it. All response
 * parsing is pure and exported for unit tests.
 */

const GEMINI_TIMEOUT_MS = 60_000;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
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
  const contents = req.turns.map((t: AssistantTurn) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.text }],
  }));
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
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(toFunctionDeclaration) }];
  }
  return body;
}

/** Extract text + function calls from a generateContent response (pure) */
export function parseGeminiResponse(json: unknown): ProviderReply {
  const parts = (
    json as { candidates?: { content?: { parts?: GeminiPart[] } }[] }
  )?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    const blocked = (json as { promptFeedback?: { blockReason?: string } })?.promptFeedback
      ?.blockReason;
    throw new Error(blocked ? `Request blocked (${blocked})` : 'Gemini returned no candidates');
  }
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p) => ({ name: p.functionCall!.name, params: p.functionCall!.args ?? {} }));
  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}

/** Pull the text delta out of one SSE `data:` payload (pure) */
export function parseSseData(payload: string): string {
  if (payload === '[DONE]') return '';
  try {
    return parseGeminiResponse(JSON.parse(payload)).text;
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
  return `Gemini request failed (HTTP ${status}).`;
}

async function httpError(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  return new Error(friendlyHttpError(res.status, body));
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

    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(GEMINI_TIMEOUT_MS)])
      : AbortSignal.timeout(GEMINI_TIMEOUT_MS);
    const stream = !!req.onToken && !req.responseSchema;
    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:${stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGeminiBody(req)),
      signal,
    });
    if (!res.ok) throw await httpError(res);

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
    return { text };
  },
};

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
