import {
  OLLAMA_PROBE_TIMEOUT_MS,
  OLLAMA_TIMEOUT_MS,
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
 * A local model over the OpenAI-compatible chat API — Ollama, vLLM, llama.cpp,
 * anything exposing POST {base}/chat/completions.
 *
 * This exists because Chrome's built-in Nano is Chrome's alone. Brave ships the
 * same extension APIs and no `LanguageModel`, so every on-device call there used
 * to fall through to a paid cloud key: worse privacy and a bill, for the user
 * who picked the browser that cares most about the first one. Pointing at a
 * local server puts on-device inference back.
 *
 * Unlike nanoProvider this is fetch-only, so it also works in the MV3 service
 * worker. Nothing depends on that yet; it is why the file carries no
 * "extension pages only" restriction.
 *
 * Inert unless the user sets settings.ollamaBaseUrl — the default is empty
 * precisely so a Chrome user who never opts in never has a localhost probe.
 */

/** Transient upstream failures. A local server restarting looks like this. */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const RETRY_BACKOFFS_MS = [400, 1200];

interface OllamaConfig {
  baseUrl: string;
  model: string;
}

async function getConfig(): Promise<OllamaConfig> {
  const settings = await getSettings();
  return {
    // Trailing slashes would produce //chat/completions, which some servers 404
    baseUrl: settings.ollamaBaseUrl.trim().replace(/\/+$/, ''),
    model: settings.ollamaModel.trim(),
  };
}

/**
 * Tool params are already a JSON-Schema object ({type:'object', properties,
 * required, additionalProperties:false}), and the OpenAI function schema takes
 * exactly that — so unlike the Gemini and Anthropic providers there is nothing
 * to sanitize. Pure.
 */
export function toOpenAiTool(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.params,
    },
  };
}

/**
 * One turn as an OpenAI-format message. Tool results are their own `tool` role
 * message keyed by tool_call_id — no folding, unlike Anthropic, which pairs a
 * whole message of results against the preceding assistant turn. Pure.
 */
export function toOpenAiMessage(t: AssistantTurn): Record<string, unknown> {
  if (t.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: t.toolResult?.id ?? '',
      content: t.text,
    };
  }
  if (t.role === 'assistant' && t.toolUses?.length) {
    return {
      role: 'assistant',
      // The API requires the key even when the model said nothing but "call this"
      content: t.text ?? '',
      tool_calls: t.toolUses.map((use) => ({
        id: use.id,
        type: 'function',
        function: { name: use.name, arguments: JSON.stringify(use.params) },
      })),
    };
  }
  return { role: t.role, content: t.text };
}

/** Build the request body. Pure — exported for tests. */
export function buildOllamaBody(req: GenerateRequest, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const turn of req.turns) messages.push(toOpenAiMessage(turn));

  const body: Record<string, unknown> = { model, messages };

  if (req.tools?.length) body.tools = req.tools.map(toOpenAiTool);

  if (req.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: req.responseSchema },
    };
  }

  return body;
}

/**
 * Whether to ask for SSE (pure). Same rule as the Anthropic provider: a
 * structured-output or tool-calling turn is read whole, and only the final
 * tool-free answer pass has any use for tokens.
 */
export function shouldStreamOllama(req: GenerateRequest): boolean {
  return !!req.onToken && !req.responseSchema && !req.tools?.length;
}

/**
 * Text plus any tool calls of a non-streaming response.
 *
 * `arguments` is a JSON *string* in this API, and a small local model is a lot
 * likelier than a frontier one to emit one that doesn't parse. A call whose
 * arguments are malformed is dropped rather than thrown on: losing one call
 * degrades to a stall the ReAct loop already handles, while throwing would take
 * down a turn that may also contain a perfectly good text answer. Pure.
 */
export function parseOllamaResponse(data: unknown): ProviderReply {
  const res = data as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  const message = res.choices?.[0]?.message;
  const text = message?.content ?? '';

  const toolCalls = (message?.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name || !call.id) return [];
    try {
      const raw = call.function?.arguments;
      const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      return [{ id: call.id, name, params }];
    } catch {
      return [];
    }
  });

  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}

/**
 * Map a failure to something a user can act on (pure).
 *
 * The 403 case is the one that actually bites: Ollama checks the Origin header,
 * and an extension sends `chrome-extension://<id>`, which is not in its default
 * allowlist. Naming the fix here is the difference between a two-minute fix and
 * an evening — so it is in the error text, not only in the docs.
 */
export function friendlyOllamaError(status: number, body?: unknown): string {
  if (status === 403) {
    return 'The local model server refused the extension\'s origin. Restart it with ' +
      'OLLAMA_ORIGINS=chrome-extension://* and try again.';
  }
  if (status === 404) {
    return 'The local server has no such model — check the model name in Settings, ' +
      'or pull it first.';
  }
  const apiMessage = ((body as { error?: { message?: string } | string })?.error ?? '') as
    | { message?: string }
    | string;
  const detail = (typeof apiMessage === 'string' ? apiMessage : apiMessage?.message ?? '').trim();
  if (TRANSIENT_STATUSES.has(status)) {
    return `The local model server errored (HTTP ${status})${detail ? `: ${detail}` : ''}.`;
  }
  return `Local model request failed (HTTP ${status})${detail ? `: ${detail}` : ''}.`;
}

async function httpError(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  return new Error(friendlyOllamaError(res.status, body));
}

function fetchOllama(
  baseUrl: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  const attemptSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)])
    : AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: attemptSignal,
  });
}

/** POST with a short retry on transient 5xx, mirroring the other providers. */
async function fetchWithRetry(
  baseUrl: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchOllama(baseUrl, body, signal);
    if (res.ok) return res;
    if (!TRANSIENT_STATUSES.has(res.status) || attempt >= RETRY_BACKOFFS_MS.length) {
      throw await httpError(res);
    }
    await res.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFFS_MS[attempt]));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

export const ollamaProvider: AssistantProvider = {
  id: 'ollama',

  /**
   * A real request, not a settings read.
   *
   * "Configured" and "running" come apart constantly here in a way they never
   * do for a cloud key — the server is a process on the user's machine that
   * they close. Reporting available:true for a dead port would hand the turn to
   * a provider that cannot answer it, and the fallback chain would never be
   * consulted. Same reasoning as probeWasm(): the cheap check lies, so ask the
   * question properly and cap it tight enough not to cost anything.
   */
  async available() {
    const { baseUrl, model } = await getConfig();
    if (!baseUrl || !model) return false;
    try {
      const res = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async generate(req: GenerateRequest): Promise<ProviderReply> {
    const { baseUrl, model } = await getConfig();
    if (!baseUrl || !model) throw new Error('No local model configured.');

    const stream = shouldStreamOllama(req);
    const body = buildOllamaBody(req, model);
    if (stream) body.stream = true;

    const res = await fetchWithRetry(baseUrl, JSON.stringify(body), req.signal);

    if (!stream) return parseOllamaResponse(await res.json());

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
            choices?: { delta?: { content?: string } }[];
          };
          const delta = evt.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            // Accumulated, not the delta — the contract every provider follows.
            req.onToken!(text);
          }
        } catch {
          // Ignore keepalives and partial frames
        }
      }
    }
    // Trim once at the end. Trimming each delta would concatenate words wrong.
    return { text: text.trim() };
  },
};

/**
 * Check a local endpoint end to end; used by the options page. Verifies the
 * server answers AND that it knows the model, because "server up, model not
 * pulled" is the second most common way this is broken after the origin check.
 */
export async function testOllama(
  baseUrl: string,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const name = model.trim();
  if (!base) return { ok: false, error: 'Enter the server URL first.' };
  if (!name) return { ok: false, error: 'Enter a model name first.' };

  try {
    const res = await fetchOllama(
      base,
      JSON.stringify({ model: name, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    );
    if (res.ok) return { ok: true };
    const err = await httpError(res);
    return { ok: false, error: err.message };
  } catch {
    return {
      ok: false,
      error: `Couldn't reach ${base}. Is the server running?`,
    };
  }
}
