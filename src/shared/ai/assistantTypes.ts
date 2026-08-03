import type { SourceRef, Tool } from './tools';

/**
 * Shared types for the Jarvis assistant. The conversation thread lives in
 * chrome.storage.session (survives popup close, shared across surfaces,
 * evaporates on browser restart, never synced to Firestore).
 */

export const MAX_THREAD_TURNS = 40;

export interface AssistantToolCall {
  name: string;
  params: Record<string, unknown>;
  status: 'pending-confirm' | 'done' | 'failed' | 'cancelled';
}

/** One step of a multi-tool plan (chat-only; the palette stays single-tool) */
export interface AssistantPlanStep {
  name: string;
  params: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'done' | 'failed' | 'skipped';
}

/**
 * One native function call the model asked for. `id` pairs the call to its
 * result: Anthropic requires tool_use.id === tool_result.tool_use_id. Gemini
 * pairs by name instead, so a synthesized id is fine there.
 */
export interface AssistantToolUse {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

/**
 * One thing the assistant did while working out an answer, as the user sees it.
 * `detail` is a count or one-line gist and NEVER raw tool output: an
 * observation can contain untrusted text from a page or an email, and the trace
 * is chrome, not content.
 */
export interface TraceStep {
  n: number;
  /** tool.summary(params) — the same human phrasing the confirm chip uses */
  label: string;
  status: 'running' | 'done' | 'failed' | 'skipped' | 'staged';
  detail?: string;
  ms?: number;
}

export interface AssistantTurn {
  id: string;
  /**
   * 'tool' turns carry ONE tool observation. They exist only inside a ReAct
   * turn's working history and are never appended to the session thread —
   * appendTurn drops them, so nothing downstream has to know about them.
   */
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: number;
  kind?: 'chat' | 'action-result' | 'briefing' | 'error';
  /** Set on assistant turns that propose (or ran) an extension action */
  toolCall?: AssistantToolCall;
  /** Set on assistant turns that propose (or ran) a multi-step plan */
  plan?: { steps: AssistantPlanStep[]; status: AssistantToolCall['status'] };
  /** Search hits to draw as cards; `text` names the first few for every other surface */
  /** Which engine produced this turn — 'local' = no model involved */
  source?: 'nano' | 'cloud' | 'local';
  /** Evidence retained with the turn so grounding is visible independently of
   *  model-written Markdown. Session-scoped with the rest of the thread. */
  sources?: SourceRef[];
  grounding?: 'grounded' | 'general' | 'insufficient';
  /** Content-free performance/quality telemetry for local evaluation. */
  diagnostics?: {
    route: 'action' | 'question' | 'page' | 'chat';
    provider: AssistantProvider['id'] | 'cloud' | 'local';
    cacheHit: boolean;
    evidenceCount: number;
    durationMs: number;
    firstTokenMs?: number;
  };
  /** What the assistant did to reach this answer. Safe to persist: the session
   *  thread is not synced, and detail carries no raw tool output. */
  trace?: TraceStep[];
  /** Native calls this assistant turn requested. Loop-only, never persisted. */
  toolUses?: AssistantToolUse[];
  /** What a 'tool' turn is the result OF. `text` is the observation itself;
   *  ok=false marks it an error so the provider can flag it as such.
   *  Loop-only, never persisted. */
  toolResult?: { id: string; name: string; ok: boolean };
}

export function newTurn(
  role: AssistantTurn['role'],
  text: string,
  extra: Partial<Omit<AssistantTurn, 'id' | 'role' | 'text' | 'createdAt'>> = {},
): AssistantTurn {
  return { id: crypto.randomUUID(), role, text, createdAt: Date.now(), ...extra };
}

/** Pure reducer: append and cap so the session thread can't grow unbounded.
 *  Tool turns are dropped rather than stored — they are a loop's working
 *  history, so "never persisted" is enforced here instead of merely documented
 *  at every call site. */
export function appendTurn(thread: AssistantTurn[], turn: AssistantTurn): AssistantTurn[] {
  if (turn.role === 'tool') return thread;
  return [...thread, turn].slice(-MAX_THREAD_TURNS);
}

export interface ProviderReply {
  text: string;
  /** Native function calls (cloud providers only; Nano routes via JSON schema) */
  toolCalls?: AssistantToolUse[];
  /** Citable sources the provider itself supplied — currently Gemini's search
   *  grounding chunks. Tool-derived sources are collected by the caller. */
  sources?: SourceRef[];
}

export interface GenerateRequest {
  system: string;
  /** Conversation so far; the LAST turn must be the user turn to answer */
  turns: AssistantTurn[];
  /** Cloud providers expose these as native function declarations; Nano ignores */
  tools?: readonly Tool[];
  /** Let the cloud model search the web (Gemini grounding); Nano ignores */
  webSearch?: boolean;
  /** JSON schema the reply must match (Nano responseConstraint / Gemini responseSchema) */
  responseSchema?: object;
  /**
   * Media attached to the LAST turn — how audio reaches a transcription call.
   * Gemini only: Nano has no multimodal input and Claude takes no audio at all,
   * which is why transcription resolves to Gemini regardless of `cloudProvider`.
   * Both ignore the field rather than failing, so a caller can pass it blindly.
   */
  audio?: { mimeType: string; dataBase64: string };
  /**
   * Images attached to the LAST turn, same contract as `audio`: read by Gemini
   * and Claude (both are multimodal); Nano ignores them rather than
   * fail. How frames and screenshots reach a vision call (shared/ai/vision.ts,
   * screenshot.ts).
   */
  images?: { mimeType: string; dataBase64: string }[];
  /** Streaming callback — receives the accumulated text so far, not deltas */
  onToken?: (partial: string) => void;
  signal?: AbortSignal;
}

export interface AssistantProvider {
  id: 'nano' | 'gemini' | 'anthropic';
  available(): Promise<boolean>;
  generate(req: GenerateRequest): Promise<ProviderReply>;
}
