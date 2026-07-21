import { MAX_PLAN_STEPS, NANO_INPUT_BUDGET_CHARS } from '../constants';
import type { AssistantSkill } from '../types';
import type { AssistantProvider, AssistantTurn } from './assistantTypes';
import { newTurn } from './assistantTypes';
import {
  ANSWER_CACHE_TTL_MS,
  cacheGet,
  cacheInvalidateTag,
  cacheSet,
  CONTEXT_CACHE_TTL_MS,
  hash32,
  INTENT_CACHE_TTL_MS,
  normalizeUtterance,
} from './cache';
import { gatherDataContext } from './context';
import { heuristicRoute } from './heuristics';
import { buildSkillBlock, loadSkills, selectSkills } from './skills';
import { verifyPlan } from './verifier';
import { getActivePageContent, type PageContent } from './pageContent';
import { findTool, TOOLS, validateToolCall, type Tool } from './tools';
import { stripEmoji } from './tts';

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

/** A validated, ready-to-run step of a multi-tool plan */
export interface PlannedStep {
  name: string;
  params: Record<string, unknown>;
  summary: string;
}

export type AssistantOutcome =
  | { kind: 'reply'; text: string; source: 'nano' | 'cloud' | 'local' }
  | { kind: 'confirm'; toolName: string; params: Record<string, unknown>; summary: string }
  | { kind: 'confirm-plan'; steps: PlannedStep[]; summary: string }
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
  /** false = never plan multi-tool chains (the palette wants single commands) */
  multiStep?: boolean;
  /** Pre-probed availability — skips both provider probes (wake path memoizes) */
  availability?: { nano: boolean; cloud: boolean };
  /**
   * Opt into the shared response cache (intent classifications, data context,
   * repeated question answers). Production surfaces pass true; tests with
   * scripted providers stay deterministic by leaving it off.
   */
  cache?: boolean;
  /** Injectable for tests; defaults to the stored assistantSkills */
  skills?: AssistantSkill[];
}

export const PERSONA =
  'You are the built-in assistant of an ADHD-friendly reading and productivity ' +
  'browser extension. Be blunt, direct, and concrete. Lead with the answer — ' +
  'no greetings, no pep talk, no filler, no exclamation marks, no emoji. Keep ' +
  'replies to 1-2 short sentences unless the user asks for more. Never invent ' +
  'data; say plainly when the snapshot lacks the answer.';

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
    '- "question": they are asking about their own data (tasks, streaks, reading, gym, flashcards, papers, screen time, calendar/meetings/free time, facts you remember about them)\n' +
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

/**
 * Cheap wording check for "do several things" requests. False positives are
 * harmless — a one-step plan behaves exactly like the single-tool path, it
 * just runs on the cloud provider instead of Nano.
 */
export function looksMultiStep(input: string): boolean {
  return (
    /\b(and|then|after that|also|plus)\b/i.test(input) ||
    /\b\d+\s+(tasks|things|items|cards)\b/i.test(input)
  );
}

/**
 * One schema for a whole plan: each step picks a tool (enum) and fills params
 * from the union of every tool's properties, all optional. Per-tool
 * constraints (required keys, min/max) differ across tools sharing a name, so
 * they're dropped here and re-enforced per step by validateToolCall. Too big
 * for Nano's responseConstraint — cloud only.
 */
export function buildPlanSchema(tools: readonly Tool[]): object {
  // Tools sharing a param name have different descriptions ("Minutes to
  // snooze for" vs "Focus length in minutes") — joining them keeps the model
  // from reading the wrong tool's meaning and dropping the value.
  const merged: Record<string, { description: string } & Record<string, unknown>> = {};
  for (const tool of tools) {
    for (const [key, spec] of Object.entries(tool.params.properties)) {
      const { minimum: _min, maximum: _max, maxLength: _len, ...rest } = spec;
      if (!(key in merged)) {
        merged[key] = { ...rest, description: `${tool.name}: ${spec.description}` };
      } else if (!merged[key].description.includes(spec.description)) {
        merged[key].description += ` / ${tool.name}: ${spec.description}`;
      }
    }
  }
  return {
    type: 'object',
    required: ['steps'],
    additionalProperties: false,
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PLAN_STEPS,
        items: {
          type: 'object',
          required: ['tool'],
          additionalProperties: false,
          properties: {
            tool: { type: 'string', enum: tools.map((t) => t.name) },
            params: { type: 'object', properties: merged },
          },
        },
      },
    },
  };
}

export function buildPlanSystem(tools: readonly Tool[], now: Date): string {
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return (
    `Break the user's request into tool steps in execution order (1-${MAX_PLAN_STEPS} steps; ` +
    'most requests need just one). Each step picks one tool and fills only parameters that ' +
    `tool understands, using only values stated or clearly implied — never invent. Today is ${now.toDateString()}.\n\n` +
    'Tools:\n' +
    toolLines +
    '\n\nRespond with JSON only: {"steps":[{"tool": ..., "params": {...}}]}'
  );
}

/** Parse + validate a plan reply. Throws on any invalid step — callers degrade to single-tool extraction. */
export function parsePlan(raw: string, tools: readonly Tool[]): PlannedStep[] {
  const obj = parseJsonObject(raw);
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  if (rawSteps.length === 0) throw new Error('empty plan');

  const steps: PlannedStep[] = [];
  for (const rawStep of rawSteps.slice(0, MAX_PLAN_STEPS)) {
    const name = (rawStep as { tool?: unknown })?.tool;
    const tool = typeof name === 'string' ? tools.find((t) => t.name === name) : undefined;
    if (!tool) throw new Error(`plan used unknown tool "${String(name)}"`);
    const valid = validateToolCall(tool, (rawStep as { params?: unknown }).params ?? {});
    if (!valid.ok) throw new Error(`step ${tool.name}: ${valid.error}`);
    steps.push({ name: tool.name, params: valid.params, summary: tool.summary(valid.params) });
  }
  return steps;
}

export interface PlanStepOutcome {
  status: 'done' | 'failed' | 'skipped';
  detail: string;
}

/**
 * Run a plan sequentially, stopping at the first failure (later steps are
 * marked skipped — the tools have no undo, so no rollback). Returns the
 * combined human-readable transcript.
 */
export async function executePlan(
  steps: PlannedStep[],
  tools: readonly Tool[] = TOOLS,
  onStep?: (index: number, outcome: PlanStepOutcome) => void | Promise<void>,
): Promise<{ ok: boolean; text: string }> {
  const lines: string[] = [];
  let failed = false;
  for (const [i, step] of steps.entries()) {
    if (failed) {
      lines.push(`Skipped: ${step.summary}`);
      await onStep?.(i, { status: 'skipped', detail: '' });
      continue;
    }
    try {
      const result = await executeTool(step.name, step.params, tools);
      lines.push(`Done: ${result}`);
      await onStep?.(i, { status: 'done', detail: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That step failed.';
      lines.push(`Failed: ${message}`);
      await onStep?.(i, { status: 'failed', detail: message });
      failed = true;
    }
  }
  return { ok: !failed, text: lines.join('\n') };
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

/** Data snapshot with a short shared cache — bounds one gather per question burst */
async function cachedDataContext(useCache: boolean): Promise<string> {
  if (!useCache) return gatherDataContext();
  const hit = await cacheGet<string>('ctx:data');
  if (hit !== undefined) return hit;
  const context = await gatherDataContext();
  void cacheSet('ctx:data', context, CONTEXT_CACHE_TTL_MS, 'data');
  return context;
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
  const result = await tool.run(valid.params);
  // Any tool run may have touched user data — cached answers/context are void
  void cacheInvalidateTag('data');
  return result;
}

export async function runAssistantTurn(
  input: string,
  thread: AssistantTurn[],
  deps: AssistantDeps,
): Promise<AssistantOutcome> {
  const tools = deps.tools ?? TOOLS;
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'error', text: 'Say something first.' };

  let availability = deps.availability;
  if (!availability) {
    const [nano, cloud] = await Promise.all([
      deps.nano.available(),
      deps.cloud ? deps.cloud.available() : Promise.resolve(false),
    ]);
    availability = { nano, cloud };
  }
  const { nano: nanoOk, cloud: cloudOk } = availability;
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

  // Step 1 — classify. Deterministic prefix rules first (no LLM call), then
  // the intent cache, then the model. Router failure degrades to chat.
  const useCache = deps.cache === true;
  const intentKey = `intent:${normalizeUtterance(trimmed)}`;
  let routed: RoutedIntent | null = heuristicRoute(trimmed, tools);
  if (!routed && useCache) routed = (await cacheGet<RoutedIntent>(intentKey)) ?? null;
  if (!routed) {
    try {
      const reply = await router.generate({
        system: buildRouterSystem(tools),
        turns: [userTurn],
        responseSchema: buildRouterSchema(tools),
      });
      routed = parseIntentResult(reply.text, tools.map((t) => t.name));
      // Classification depends only on the utterance — safe to keep for a day
      if (useCache) void cacheSet(intentKey, routed, INTENT_CACHE_TTL_MS, 'intent');
    } catch {
      routed = { intent: 'chat', tool: null };
    }
  }

  // User-written skills: written-down knowledge beats guessing. Selected by
  // keyword/tool relevance, injected into extraction and answer prompts.
  const skills = deps.skills ?? (await loadSkills());
  const skillBlock = buildSkillBlock(
    selectSkills(trimmed, routed.intent === 'action' ? routed.tool : null, skills),
  );

  // Step 2a — action: fill the one tool's schema, validate, confirm/run
  if (routed.intent === 'action' && routed.tool) {
    const tool = tools.find((t) => t.name === routed.tool)!;

    // Multi-step chains: cloud only (the merged plan schema is beyond Nano),
    // and only when the wording suggests several things. A bad plan degrades
    // to the single-tool extraction below with the router's picked tool.
    if ((deps.multiStep ?? true) && cloudOk && looksMultiStep(trimmed)) {
      try {
        const reply = await deps.cloud!.generate({
          system: buildPlanSystem(tools, new Date()),
          turns: [userTurn],
          responseSchema: buildPlanSchema(tools),
        });
        let steps = parsePlan(reply.text, tools);
        if (steps.length === 1) {
          // One-step plan ≡ today's single-tool flow
          const only = steps[0];
          const onlyTool = tools.find((t) => t.name === only.name)!;
          if (onlyTool.confirm) {
            return { kind: 'confirm', toolName: only.name, params: only.params, summary: only.summary };
          }
          return { kind: 'done', text: await executeTool(only.name, only.params, tools) };
        }
        if (steps.some((s) => tools.find((t) => t.name === s.name)?.confirm)) {
          // Sub-agent critic: a second pass checks the plan against the data
          // before confirm chips appear. Failures never block (verifyPlan
          // swallows them); a revision replaces the steps, issues surface as
          // "Check:" lines above the plan.
          const verified = await verifyPlan(
            trimmed,
            steps,
            tools,
            deps.cloud!,
            () => (deps.getContext ? deps.getContext() : cachedDataContext(useCache)),
          );
          if (verified.steps) steps = verified.steps;
          const checkLines = verified.issues.map((issue) => `Check: ${issue}`);
          return {
            kind: 'confirm-plan',
            steps,
            summary: [...checkLines, ...steps.map((s, i) => `${i + 1}. ${s.summary}`)].join('\n'),
          };
        }
        // Nothing mutating — run the whole chain immediately
        const run = await executePlan(steps, tools);
        return run.ok ? { kind: 'done', text: run.text } : { kind: 'error', text: run.text };
      } catch {
        // fall through to single-tool extraction
      }
    }

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
            system: buildExtractSystem(tool, new Date()) + skillBlock,
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
          text: `Got the intent (${tool.summary({}).toLowerCase()}) but not the details (${lastError}). Rephrase.`,
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
      return {
        kind: 'reply',
        text: stripEmoji(reply.text.trim()),
        source: provider.id === 'nano' ? 'nano' : 'cloud',
      };
    } catch {
      return { kind: 'error', text: 'Reading the page failed. Try again.' };
    }
  }

  // Step 2b/2d — question (with data snapshot) or plain chat
  const history = recentHistory(thread);
  let system = PERSONA + skillBlock;
  let answerKey: string | null = null;
  if (routed.intent === 'question') {
    // Injected getContext (tests, custom surfaces) bypasses the cache
    const context = deps.getContext
      ? await deps.getContext()
      : await cachedDataContext(useCache);
    system =
      PERSONA +
      skillBlock +
      '\n\nAnswer using ONLY this snapshot of the user\'s data (say so if it lacks the answer):\n' +
      context;
    if (useCache) {
      const historyText = history.map((t) => t.text).join('\n');
      // skillBlock in the key: editing a skill must miss, not serve stale
      answerKey = `answer:${normalizeUtterance(trimmed)}#${hash32(context)}#${hash32(historyText)}#${hash32(skillBlock)}`;
      const cached = await cacheGet<{ text: string; source: 'nano' | 'cloud' }>(answerKey);
      if (cached) {
        // Streamed surfaces still get their token callback — instant reply
        deps.onToken?.(cached.text);
        return { kind: 'reply', text: cached.text, source: cached.source };
      }
    }
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
    const text = stripEmoji(reply.text.trim());
    const source = provider.id === 'nano' ? ('nano' as const) : ('cloud' as const);
    if (answerKey) void cacheSet(answerKey, { text, source }, ANSWER_CACHE_TTL_MS, 'data');
    return { kind: 'reply', text, source };
  } catch (err) {
    return {
      kind: 'error',
      text:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'That took too long on the on-device model — ask a shorter question.'
          : 'Reply generation failed. Try again.',
    };
  }
}
