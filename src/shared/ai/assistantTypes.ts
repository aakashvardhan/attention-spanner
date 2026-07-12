import type { Tool } from './tools';

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

export interface AssistantTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  kind?: 'chat' | 'action-result' | 'briefing' | 'error';
  /** Set on assistant turns that propose (or ran) an extension action */
  toolCall?: AssistantToolCall;
  /** Which engine produced this turn — 'local' = no model involved */
  source?: 'nano' | 'cloud' | 'local';
}

export function newTurn(
  role: AssistantTurn['role'],
  text: string,
  extra: Partial<Omit<AssistantTurn, 'id' | 'role' | 'text' | 'createdAt'>> = {},
): AssistantTurn {
  return { id: crypto.randomUUID(), role, text, createdAt: Date.now(), ...extra };
}

/** Pure reducer: append and cap so the session thread can't grow unbounded */
export function appendTurn(thread: AssistantTurn[], turn: AssistantTurn): AssistantTurn[] {
  return [...thread, turn].slice(-MAX_THREAD_TURNS);
}

export interface ProviderReply {
  text: string;
  /** Native function calls (cloud providers only; Nano routes via JSON schema) */
  toolCalls?: { name: string; params: Record<string, unknown> }[];
}

export interface GenerateRequest {
  system: string;
  /** Conversation so far; the LAST turn must be the user turn to answer */
  turns: AssistantTurn[];
  /** Cloud providers expose these as native function declarations; Nano ignores */
  tools?: Tool[];
  /** JSON schema the reply must match (Nano responseConstraint / Gemini responseSchema) */
  responseSchema?: object;
  /** Streaming callback — receives the accumulated text so far, not deltas */
  onToken?: (partial: string) => void;
  signal?: AbortSignal;
}

export interface AssistantProvider {
  id: 'nano' | 'gemini';
  available(): Promise<boolean>;
  generate(req: GenerateRequest): Promise<ProviderReply>;
}
