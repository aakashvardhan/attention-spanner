import {
  ALPHAXIV_MCP_PROTOCOL,
  ALPHAXIV_MCP_URL,
  ALPHAXIV_TOOL_TIMEOUT_MS,
} from '../shared/constants';
import { AUTH_ERROR_HINT, getAccessToken, markDisconnected, refreshAccessToken } from './alphaxivAuth';

/**
 * A minimal MCP client for alphaXiv's Streamable HTTP transport — just enough
 * to call tools: initialize once, keep the session id, POST tools/call.
 *
 * This lives in the service worker on purpose. Extension background fetches
 * run under the manifest's host permissions, so they skip CORS entirely — which
 * is why this works even though alphaXiv's docs say browser-hosted MCP clients
 * are unsupported. It also keeps the tokens out of page contexts.
 */

/** Handshake state for this worker generation; reset when the worker restarts. */
let sessionId: string | null = null;
let handshake: Promise<void> | null = null;
let nextId = 1;

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Read one JSON-RPC response out of a fetch. The transport may answer a POST
 * with either a plain JSON body or an SSE stream carrying the same envelope in
 * a `data:` frame, and the spec lets the server pick — so handle both.
 */
async function readEnvelope(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const body = await res.text();
  if (!body.trim()) return null;

  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        if (frame.id === id) return frame;
      } catch {
        // Keep-alive comments and partial frames are not our answer
      }
    }
    return null;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

/** One JSON-RPC round trip. `id: null` sends a notification (no response read). */
async function rpc(
  token: string,
  method: string,
  params: unknown,
  notify = false,
): Promise<{ res: Response; envelope: JsonRpcResponse | null }> {
  const id = nextId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALPHAXIV_TOOL_TIMEOUT_MS);
  try {
    const res = await fetch(ALPHAXIV_MCP_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': ALPHAXIV_MCP_PROTOCOL,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notify ? {} : { id }),
      }),
    });
    const captured = res.headers.get('mcp-session-id');
    if (captured) sessionId = captured;
    return { res, envelope: notify || !res.ok ? null : await readEnvelope(res, id) };
  } finally {
    clearTimeout(timer);
  }
}

/** initialize + notifications/initialized, once per worker generation. */
async function ensureHandshake(token: string): Promise<void> {
  if (!handshake) {
    handshake = (async () => {
      const { res, envelope } = await rpc(token, 'initialize', {
        protocolVersion: ALPHAXIV_MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'reader-extension', version: '1.0.0' },
      });
      if (res.status === 401 || res.status === 403) throw new Error('unauthorized');
      if (!res.ok) throw new Error(`alphaXiv is unavailable (HTTP ${res.status}).`);
      if (envelope?.error) throw new Error(envelope.error.message);
      await rpc(token, 'notifications/initialized', {}, true);
    })().catch((err) => {
      handshake = null; // a failed handshake must not poison later calls
      sessionId = null;
      throw err;
    });
  }
  return handshake;
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** Flatten an MCP tool result to the text an assistant or a UI can use. */
function textOf(result: unknown): string {
  const { content } = (result ?? {}) as ToolResult;
  return (content ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function attempt(token: string, name: string, args: Record<string, unknown>) {
  await ensureHandshake(token);
  return rpc(token, 'tools/call', { name, arguments: args });
}

/**
 * Call an alphaXiv tool and return its text. Throws with a message meant for
 * the user: expired credentials become the reconnect hint, a tool-level failure
 * becomes whatever the server said went wrong.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  let token = await getAccessToken();
  let { res, envelope } = await attempt(token, name, args);

  // Expired or revoked mid-flight: one silent refresh, one retry, then give up.
  if (res.status === 401 || res.status === 403) {
    sessionId = null;
    handshake = null;
    token = await refreshAccessToken();
    ({ res, envelope } = await attempt(token, name, args));
  }
  if (res.status === 401 || res.status === 403) {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  if (res.status === 429) {
    throw new Error("alphaXiv is rate-limiting this account — that's their quota, try again later.");
  }
  if (!res.ok) throw new Error(`alphaXiv returned an error (HTTP ${res.status}).`);
  if (envelope?.error) throw new Error(`alphaXiv couldn't do that (${envelope.error.message}).`);

  const text = textOf(envelope?.result);
  if ((envelope?.result as ToolResult | undefined)?.isError) {
    throw new Error(text || 'alphaXiv could not complete that request.');
  }
  return text;
}

/** Drop the cached handshake — used after disconnecting so a reconnect is clean. */
export function resetSession(): void {
  sessionId = null;
  handshake = null;
}
