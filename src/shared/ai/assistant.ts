import { NANO_INPUT_BUDGET_CHARS } from '../constants';
import type { AssistantProvider, AssistantTurn } from './assistantTypes';
import { newTurn } from './assistantTypes';
import { gatherDataContext } from './context';
import { getActivePageContent, type PageContent } from './pageContent';
import { findTool, TOOLS, validateToolCall, type Tool } from './tools';

/**
 * The assistant orchestrator. Runs in extension pages (Nano constraint — see
 * brainDump.ts). Two-step routing: (1) classify intent with a tiny enum
 * schema, (2) if it's an action, fill THAT tool's params schema — far more
 * reliable on Nano than one giant schema. Mutating tools return a 'confirm'
 * outcome; the UI shows a chip and calls executeTool() on approval.
 */

export type AssistantIntent = 'action' | 'question' | 'page' | 'chat';

export interface RoutedIntent {
  intent: AssistantIntent;
  tool: string | null;
}

export type AssistantOutcome =
  | { kind: 'reply'; text: string; source: 'nano' | 'cloud' | 'local' }
  | { kind: 'confirm'; toolName: string; params: Record<string, unknown>; summary: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string };

export interface AssistantDeps {
  nano: AssistantProvider;
  /** Cloud fallback for long/hard queries; absent = Nano-only */
  cloud?: AssistantProvider;
  /** Injectable for tests; defaults to the real registry */
  tools?: readonly Tool[];
  /** Injectable for tests; defaults to gatherDataContext */
  getContext?: () => Promise<string>;
  /** Injectable for tests; defaults to getActivePageContent */
  getPage?: () => Promise<PageContent | null>;
  /** Streaming callback for question/chat answers (accumulated text) */
  onToken?: (partial: string) => void;
}

export const PERSONA =
  'You are the built-in assistant of an ADHD-friendly reading and productivity ' +
  'browser extension. Be warm, encouraging, and concrete. Keep replies to 1-3 ' +
  'short sentences unless the user asks for more. Never invent data.';

const INTENTS: AssistantIntent[] = ['action', 'question', 'page', 'chat'];

/** How many cards a page-to-flashcards run may propose */
const MAX_PAGE_CARDS = 8;

const PAGE_CARDS_SCHEMA = {
  type: 'object',
  required: ['cards'],
  additionalProperties: false,
  properties: {
    cards: {
      type: 'array',
      maxItems: MAX_PAGE_CARDS,
      items: {
        type: 'object',
        required: ['front', 'back'],
        additionalProperties: false,
        properties: {
          front: { type: 'string', maxLength: 300 },
          back: { type: 'string', maxLength: 500 },
        },
      },
    },
  },
};

/** Pure: strip code fences and parse a JSON object, throwing on junk */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model returned non-object JSON');
  }
  return parsed as Record<string, unknown>;
}

/** Pure: tolerate junk from the router — bad intent falls back to chat, unknown tool to null */
export function parseIntentResult(raw: string, validTools: string[]): RoutedIntent {
  let obj: Record<string, unknown>;
  try {
    obj = parseJsonObject(raw);
  } catch {
    return { intent: 'chat', tool: null };
  }
  const intent = INTENTS.includes(obj.intent as AssistantIntent)
    ? (obj.intent as AssistantIntent)
    : 'chat';
  const tool =
    typeof obj.tool === 'string' && validTools.includes(obj.tool) ? obj.tool : null;
  return { intent, tool };
}

export function buildRouterSystem(tools: readonly Tool[]): string {
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return (
    'You route messages for a personal productivity assistant. Classify the ' +
    "user's message:\n" +
    '- "action": they want to DO something the tools below can do\n' +
    '- "question": they are asking about their own data (tasks, streaks, reading, gym, flashcards, papers, screen time)\n' +
    '- "page": they are asking about the web page they are currently viewing (summarize it, explain it, make cards from it)\n' +
    '- "chat": anything else\n\n' +
    'Tools:\n' +
    toolLines +
    '\n\nRespond with JSON: {"intent": ..., "tool": ...}. tool is the single best ' +
    'tool name when intent is "action", otherwise "none".'
  );
}

export function buildRouterSchema(tools: readonly Tool[]): object {
  return {
    type: 'object',
    required: ['intent', 'tool'],
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: INTENTS },
      tool: { type: 'string', enum: [...tools.map((t) => t.name), 'none'] },
    },
  };
}

function buildExtractSystem(tool: Tool, now: Date): string {
  return (
    `Extract the parameters for the "${tool.name}" tool (${tool.description}) ` +
    `from the user's message. Today is ${now.toDateString()}. Use only values ` +
    'stated or clearly implied by the message — never invent. Omit optional ' +
    'parameters the message does not mention. Respond with JSON only.'
  );
}

/** Recent conversational turns to carry as history (drop errors, cap length) */
function recentHistory(thread: AssistantTurn[]): AssistantTurn[] {
  return thread.filter((t) => t.kind !== 'error' && t.text.trim() !== '').slice(-8);
}

/** Look up, validate, and run a tool call. Throws Error with a friendly message. */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  tools: readonly Tool[] = TOOLS,
): Promise<string> {
  const tool = tools.find((t) => t.name === name) ?? findTool(name);
  if (!tool) throw new Error(`Unknown tool "${name}"`);
  const valid = validateToolCall(tool, params);
  if (!valid.ok) throw new Error(`That didn't quite work (${valid.error}).`);
  return tool.run(valid.params);
}

export async function runAssistantTurn(
  input: string,
  thread: AssistantTurn[],
  deps: AssistantDeps,
): Promise<AssistantOutcome> {
  const tools = deps.tools ?? TOOLS;
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'error', text: 'Say something first. 🙂' };

  const nanoOk = await deps.nano.available();
  const cloudOk = deps.cloud ? await deps.cloud.available() : false;
  if (!nanoOk && !cloudOk) {
    return {
      kind: 'error',
      text: "No AI model is available — this Chrome lacks the built-in Gemini Nano model. Add a Gemini API key in Settings → Assistant to use the cloud instead.",
    };
  }
  // Nano first (free, private); cloud when Nano is missing or the input is too big
  const pick = (inputChars: number): AssistantProvider =>
    nanoOk && (inputChars <= NANO_INPUT_BUDGET_CHARS || !cloudOk) ? deps.nano : deps.cloud!;

  const router = pick(trimmed.length);
  const userTurn = newTurn('user', trimmed);

  // Step 1 — classify. A router failure degrades to plain chat, never an error.
  let routed: RoutedIntent;
  try {
    const reply = await router.generate({
      system: buildRouterSystem(tools),
      turns: [userTurn],
      responseSchema: buildRouterSchema(tools),
    });
    routed = parseIntentResult(reply.text, tools.map((t) => t.name));
  } catch {
    routed = { intent: 'chat', tool: null };
  }

  // Step 2a — action: fill the one tool's schema, validate, confirm/run
  if (routed.intent === 'action' && routed.tool) {
    const tool = tools.find((t) => t.name === routed.tool)!;
    let params: Record<string, unknown> = {};

    if (Object.keys(tool.params.properties).length > 0) {
      let lastError = '';
      let extracted = false;
      // Retry on the router provider, then escalate once to the other one
      const attempts: AssistantProvider[] = [router, router];
      if (cloudOk && router.id !== deps.cloud!.id) attempts.push(deps.cloud!);
      for (const provider of attempts) {
        try {
          const reply = await provider.generate({
            system: buildExtractSystem(tool, new Date()),
            turns: [userTurn],
            responseSchema: tool.params,
          });
          const valid = validateToolCall(tool, parseJsonObject(reply.text));
          if (valid.ok) {
            params = valid.params;
            extracted = true;
            break;
          }
          lastError = valid.error;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!extracted) {
        return {
          kind: 'error',
          text: `I understood you want to ${tool.summary({}).toLowerCase()}, but couldn't work out the details (${lastError}). Could you rephrase?`,
        };
      }
    }

    if (tool.confirm) {
      return { kind: 'confirm', toolName: tool.name, params, summary: tool.summary(params) };
    }
    try {
      return { kind: 'done', text: await executeTool(tool.name, params, tools) };
    } catch (err) {
      return { kind: 'error', text: err instanceof Error ? err.message : 'That action failed.' };
    }
  }

  // Step 2c — page-aware help: summarize/explain, or turn the page into cards
  if (routed.intent === 'page') {
    const page = await (deps.getPage ?? getActivePageContent)();
    if (!page) {
      return {
        kind: 'reply',
        source: 'local',
        text: "I can't read this tab — open the article you mean and ask from the extension popup.",
      };
    }
    const provider = pick(page.text.length + trimmed.length);
    const pageText =
      provider.id === 'nano' ? page.text.slice(0, NANO_INPUT_BUDGET_CHARS) : page.text;
    const pageBlock = `The user is viewing “${page.title}” (${page.url}). Page content:\n${pageText}`;

    if (/flash\s*cards?|anki/i.test(trimmed)) {
      try {
        const reply = await provider.generate({
          system:
            `You create study flashcards from a web page. Make up to ${MAX_PAGE_CARDS} basic ` +
            'question/answer cards covering the key facts and ideas. Questions short and specific; ' +
            'answers under 40 words. Respond with JSON only.\n\n' +
            pageBlock,
          turns: [userTurn],
          responseSchema: PAGE_CARDS_SCHEMA,
        });
        const obj = parseJsonObject(reply.text);
        const cards = (Array.isArray(obj.cards) ? obj.cards : []).filter(
          (c): c is { front: string; back: string } =>
            typeof (c as { front?: unknown })?.front === 'string' &&
            typeof (c as { back?: unknown })?.back === 'string',
        );
        if (cards.length === 0) throw new Error('no cards');
        const preview = cards.map((c, i) => `${i + 1}. ${c.front}`).join('\n');
        return {
          kind: 'confirm',
          toolName: 'save_flashcards',
          params: { cards },
          summary: `From “${page.title}”:\n${preview}\n\nSave ${cards.length} flashcard${cards.length === 1 ? '' : 's'}?`,
        };
      } catch {
        return { kind: 'error', text: "I couldn't get usable flashcards out of this page — try a more focused article." };
      }
    }

    try {
      const reply = await provider.generate({
        system: PERSONA + '\n\n' + pageBlock + '\n\nAnswer about this page; quote it rather than inventing.',
        turns: [userTurn],
        onToken: deps.onToken,
      });
      return { kind: 'reply', text: reply.text.trim(), source: provider.id === 'nano' ? 'nano' : 'cloud' };
    } catch {
      return { kind: 'error', text: 'Reading the page failed. Try again?' };
    }
  }

  // Step 2b/2d — question (with data snapshot) or plain chat
  const history = recentHistory(thread);
  let system = PERSONA;
  if (routed.intent === 'question') {
    const context = await (deps.getContext ?? gatherDataContext)();
    system =
      PERSONA +
      '\n\nAnswer using ONLY this snapshot of the user\'s data (say so if it lacks the answer):\n' +
      context;
  }

  const provider = pick(
    system.length + history.reduce((n, t) => n + t.text.length, 0) + trimmed.length,
  );
  try {
    const reply = await provider.generate({
      system,
      turns: [...history, userTurn],
      onToken: deps.onToken,
    });
    return {
      kind: 'reply',
      text: reply.text.trim(),
      source: provider.id === 'nano' ? 'nano' : 'cloud',
    };
  } catch (err) {
    return {
      kind: 'error',
      text:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'That took too long on the on-device model — try a shorter question.'
          : 'Something went wrong generating a reply. Try again?',
    };
  }
}
