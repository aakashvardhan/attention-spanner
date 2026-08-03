import {
  ANTHROPIC_API_BASE,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_MODEL,
  ANTHROPIC_VERSION,
} from '../constants';
import { getSettings } from '../storage';
import type {
  AssistantProvider,
  AssistantTurn,
  GenerateRequest,
  ProviderReply,
} from './assistantTypes';
import type { Tool } from './tools';

/**
 * Cloud provider over Anthropic's Messages API (Claude Haiku). The alternative
 * to `geminiProvider` — the user picks one in Settings. Like the others it runs
 * in extension pages, never the MV3 service worker, and is inert without the
 * user-supplied key in settings.anthropicApiKey. Raw fetch (no SDK) to match the
 * Gemini provider and keep the bundle small. Response parsing is pure/exported.
 */

const ANTHROPIC_TIMEOUT_MS = 60_000;

/** 5xx/529 Anthropic returns when overloaded — a short retry usually clears them. */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 529]);
const RETRY_BACKOFFS_MS = [500, 1500];

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Dev-only: surface prompt-cache activity so caching is observable. `read` > 0
 * on a repeated prefix means the cache is working. Stripped from production
 * builds — import.meta.env.DEV is false there, so the branch dead-code-eliminates.
 */
function logCacheUsage(usage: AnthropicUsage | undefined): void {
  if (!import.meta.env.DEV || !usage) return;
  console.debug(
    `[claude cache] read=${usage.cache_read_input_tokens ?? 0} ` +
      `write=${usage.cache_creation_input_tokens ?? 0} input=${usage.input_tokens ?? 0}`,
  );
}

/**
 * Anthropic's structured-output schema is a strict OpenAPI subset: it *requires*
 * `additionalProperties: false` on objects (the opposite of Gemini) and rejects
 * numeric/length constraints. Strip the unsupported keywords and add the
 * required flag. Pure — exported for tests.
 */
const STRIP_KEYS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'pattern',
]);

export function sanitizeAnthropicSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeAnthropicSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (STRIP_KEYS.has(key)) continue;
    out[key] = sanitizeAnthropicSchema(value);
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Deliberately NOT run through sanitizeAnthropicSchema: that strips numeric and
 * length keywords because the strict structured-output subset rejects them, but
 * `input_schema` is ordinary JSON Schema where they are both legal and useful
 * hints. The asymmetry is intentional.
 */
function toAnthropicTool(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.params,
  };
}

/**
 * One turn as an Anthropic message. A tool turn becomes a user message carrying
 * a tool_result block; an assistant turn that requested calls becomes text plus
 * tool_use blocks. Everything else keeps plain string content, so ordinary chat
 * bodies are byte-identical to what this provider sent before. Pure.
 */
export function toAnthropicMessage(t: AssistantTurn): Record<string, unknown> {
  if (t.role === 'tool') {
    const result = t.toolResult;
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: result?.id ?? '',
          content: t.text,
          ...(result && !result.ok ? { is_error: true } : {}),
        },
      ],
    };
  }
  if (t.role === 'assistant' && t.toolUses?.length) {
    const blocks: Record<string, unknown>[] = [];
    if (t.text.trim()) blocks.push({ type: 'text', text: t.text });
    for (const use of t.toolUses) {
      blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.params });
    }
    return { role: 'assistant', content: blocks };
  }
  return { role: t.role, content: t.text };
}

/**
 * Attach media to the final message, mirroring GenerateRequest's contract that
 * images ride on the last (user) turn. Claude requires images as base64 blocks
 * inside a user message, so a plain-string body is promoted to a content array
 * with its text kept first. Pure; a no-op when there are no images.
 */
export function attachImagesToLastMessage(
  messages: Record<string, unknown>[],
  images: GenerateRequest['images'],
): void {
  if (!images?.length || messages.length === 0) return;
  const last = messages[messages.length - 1];
  const blocks = Array.isArray(last.content)
    ? [...(last.content as Record<string, unknown>[])]
    : typeof last.content === 'string' && last.content
      ? [{ type: 'text', text: last.content }]
      : [];
  for (const image of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
    });
  }
  last.content = blocks;
}

/**
 * Turns to messages. Consecutive tool turns MUST fold into one user message:
 * the API pairs every tool_use block of an assistant turn with the tool_result
 * blocks of the single message that follows it, so emitting one message per
 * result would leave the later calls unanswered. Pure.
 */
export function toAnthropicMessages(turns: readonly AssistantTurn[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const turn of turns) {
    const message = toAnthropicMessage(turn);
    const previous = messages[messages.length - 1];
    if (turn.role === 'tool' && previous && Array.isArray(previous.content)) {
      const previousBlocks = previous.content as Record<string, unknown>[];
      if (previousBlocks[0]?.type === 'tool_result') {
        previousBlocks.push(...(message.content as Record<string, unknown>[]));
        continue;
      }
    }
    messages.push(message);
  }
  return messages;
}

/**
 * Build the Messages API request body. The system prompt (and the tool list
 * that renders before it) carry a `cache_control` breakpoint so the stable
 * prefix — which repeats every turn — is served from Anthropic's prompt cache
 * at ~0.1x cost. Pure — exported for tests.
 */
export function buildAnthropicBody(req: GenerateRequest): Record<string, unknown> {
  const messages = toAnthropicMessages(req.turns);
  attachImagesToLastMessage(messages, req.images);
  const body: Record<string, unknown> = {
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages,
  };

  if (req.system) {
    // A breakpoint on the last (only) system block caches the tools + system
    // prefix together, since tools render ahead of system.
    body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  }

  if (req.tools?.length) {
    const tools = req.tools.map(toAnthropicTool);
    // With no system block to carry the breakpoint, cache the tool list itself.
    if (!req.system) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
    }
    body.tools = tools;
  }

  if (req.responseSchema) {
    body.output_config = {
      format: { type: 'json_schema', schema: sanitizeAnthropicSchema(req.responseSchema) },
    };
  }

  return body;
}

/**
 * Whether to ask for SSE (pure). Structured outputs don't combine with
 * streaming — the router/extraction paths want JSON back, the answer paths want
 * tokens. Neither do tools: a tool-calling turn is read as whole tool_use
 * blocks, and only the final tool-free answer pass needs tokens, so there is
 * never a reason to accumulate partial tool inputs from input_json_delta frames.
 */
export function shouldStream(req: GenerateRequest): boolean {
  return !!req.onToken && !req.responseSchema && !req.tools?.length;
}

/**
 * Text plus any tool_use blocks of a non-streaming response; throws on a safety
 * refusal. `stop_reason === 'tool_use'` needs no special handling — the presence
 * of the blocks is the signal.
 */
export function parseAnthropicResponse(data: unknown): ProviderReply {
  const res = data as {
    stop_reason?: string;
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  };
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer that.');
  const blocks = res.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({
      id: b.id!,
      name: b.name!,
      params: (b.input ?? {}) as Record<string, unknown>,
    }));
  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}

/** Map an error response to a user-facing message (pure). */
export function friendlyAnthropicError(status: number, body?: unknown): string {
  if (status === 401) return 'The Claude API key is invalid — check Settings.';
  if (status === 403) return 'The Claude API key lacks access — check Settings.';
  const apiMessage = ((body as { error?: { message?: string } })?.error?.message ?? '').trim();
  if (status === 429) return apiMessage || 'Claude rate limit hit — wait a minute and try again.';
  if (TRANSIENT_STATUSES.has(status)) {
    return `Claude is temporarily overloaded (HTTP ${status}) — try again in a moment.`;
  }
  return `Claude request failed (HTTP ${status}).`;
}

async function httpError(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  return new Error(friendlyAnthropicError(res.status, body));
}

function fetchAnthropic(key: string, body: string, signal?: AbortSignal): Promise<Response> {
  const attemptSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
    : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS);
  return fetch(ANTHROPIC_API_BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for requests from a browser/extension origin
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
    signal: attemptSignal,
  });
}

/** POST with a short retry on transient 5xx/529, mirroring geminiProvider. */
export async function fetchWithRetry(
  key: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchAnthropic(key, body, signal);
    if (res.ok) return res;
    if (!TRANSIENT_STATUSES.has(res.status) || attempt >= RETRY_BACKOFFS_MS.length) {
      throw await httpError(res);
    }
    await res.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFFS_MS[attempt]));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

async function getKey(): Promise<string> {
  return (await getSettings()).anthropicApiKey.trim();
}

export const anthropicProvider: AssistantProvider = {
  id: 'anthropic',

  async available() {
    return (await getKey()) !== '';
  },

  async generate(req: GenerateRequest): Promise<ProviderReply> {
    const key = await getKey();
    if (!key) throw new Error('No Claude API key configured.');

    const stream = shouldStream(req);
    const body = buildAnthropicBody(req);
    if (stream) body.stream = true;

    const res = await fetchWithRetry(key, JSON.stringify(body), req.signal);

    if (!stream) {
      const data = await res.json();
      logCacheUsage((data as { usage?: AnthropicUsage }).usage);
      return parseAnthropicResponse(data);
    }

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
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload) as {
            type?: string;
            message?: { usage?: AnthropicUsage };
            delta?: { type?: string; text?: string };
          };
          if (evt.type === 'message_start') {
            logCacheUsage(evt.message?.usage);
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            text += evt.delta.text ?? '';
            req.onToken!(text);
          }
        } catch {
          // Ignore non-JSON keepalives / partial frames
        }
      }
    }
    return { text };
  },
};

/** Validate a key with a minimal request; used by the options page. */
export async function testAnthropicKey(
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchAnthropic(
      key.trim(),
      JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    if (res.ok) return { ok: true };
    const err = await httpError(res);
    return { ok: false, error: err.message };
  } catch {
    return { ok: false, error: "Couldn't reach Claude — check your connection." };
  }
}
