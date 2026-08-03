import { MAX_PLAN_STEPS, NANO_INPUT_BUDGET_CHARS } from '../constants';
import type { AssistantSkill } from '../types';
import type { AssistantProvider, AssistantTurn, ProviderReply } from './assistantTypes';
import { newTurn, type TraceStep } from './assistantTypes';
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
import { gatherEvidence, type EvidenceBundle } from './evidence';
import { searchLibraryText } from './connectors/library';
import { heuristicRoute } from './heuristics';
import { buildSkillBlock, loadSkills, selectSkills } from './skills';
import { verifyPlan } from './verifier';
import { getActivePageContent, type PageContent } from './pageContent';
import { runReactLoop, type ReactResult } from './react/loop';
import { buildCitationRule, resolveCitations } from './react/citations';
import { cloudFor, providerChain, resolveRoutingEnv, type ModelRole } from './routing';
import { getActiveTabScreenshot, type Screenshot } from './screenshot';
import { findTool, TOOLS, validateToolCall, type Tool, type ToolOutput } from './tools';
import { stripEmoji } from './tts';

/**
 * The assistant orchestrator. Runs in extension pages (Nano constraint — see
 * brainDump.ts). Two-step routing: (1) classify intent with a tiny enum
 * schema, (2) if it's an action, fill THAT tool's params schema — far more
 * reliable on Nano than one giant schema. Mutating tools return a 'confirm'
 * outcome; the UI shows a chip and calls executeTool() on approval.
 */

export type AssistantIntent = 'action' | 'question' | 'page' | 'chat';
export type AssistantPhase = 'routing' | 'retrieving' | 'generating' | 'verifying';

export interface TurnDiagnostics {
  route: AssistantIntent;
  provider: AssistantProvider['id'] | 'cloud' | 'local';
  cacheHit: boolean;
  evidenceCount: number;
  durationMs: number;
  firstTokenMs?: number;
}

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

/** What the assistant did to reach an answer; only the ReAct path sets it */
export interface OutcomeTrace {
  trace?: TraceStep[];
}

export type AssistantOutcome =
  | ({
      kind: 'reply';
      text: string;
      source: 'nano' | 'cloud' | 'local';
      sources?: ToolOutput['sources'];
      grounding?: 'grounded' | 'general' | 'insufficient';
      diagnostics?: TurnDiagnostics;
    } & OutcomeTrace)
  | ({
      kind: 'confirm';
      toolName: string;
      params: Record<string, unknown>;
      summary: string;
    } & OutcomeTrace)
  | ({ kind: 'confirm-plan'; steps: PlannedStep[]; summary: string } & OutcomeTrace)
  | ({ kind: 'done'; text: string } & OutcomeTrace)
  | { kind: 'error'; text: string };

export interface AssistantDeps {
  nano: AssistantProvider;
  /** Cloud fallback for long/hard queries; absent = Nano-only */
  cloud?: AssistantProvider;
  /** Injectable for tests; defaults to the real registry */
  tools?: readonly Tool[];
  /** Injectable for tests; defaults to gatherDataContext */
  getContext?: () => Promise<string>;
  /** Query-aware evidence fast path. false preserves the legacy snapshot path. */
  getEvidence?: (() => Promise<EvidenceBundle>) | false;
  /** Injectable for tests; defaults to getActivePageContent */
  getPage?: () => Promise<PageContent | null>;
  /** Injectable for tests; false disables page vision entirely.
   *  Defaults to getActiveTabScreenshot (itself gated on the settings toggle). */
  getScreenshot?: (() => Promise<Screenshot | null>) | false;
  /** Streaming callback for question/chat answers (accumulated text) */
  onToken?: (partial: string) => void;
  /** false = never plan multi-tool chains (the palette wants single commands) */
  multiStep?: boolean;
  /** Pre-probed availability — skips every provider probe (wake path memoizes).
   *  `cloud` describes deps.cloud; the optional per-cloud flags let a caller
   *  that knows about both say so instead of leaving the other unprobed. */
  availability?: {
    nano: boolean;
    cloud: boolean;
    gemini?: boolean;
    anthropic?: boolean;
    ollama?: boolean;
  };
  /**
   * Opt into the shared response cache (intent classifications, data context,
   * repeated question answers). Production surfaces pass true; tests with
   * scripted providers stay deterministic by leaving it off.
   */
  cache?: boolean;
  /** Injectable for tests; defaults to the stored assistantSkills */
  skills?: AssistantSkill[];
  /**
   * Library keyword search for corpus-shaped questions. Defaults to the real
   * one; false disables it (tests with scripted providers).
   */
  searchLibrary?: ((query: string) => Promise<string>) | false;
  /**
   * Run the ReAct loop instead of the one-shot planner. Callers pass
   * settings.assistantReactEnabled; the loop declines on its own where it
   * cannot run (no cloud provider), so this is a preference, not a promise.
   */
  react?: boolean;
  /** Wall-clock budget for the whole loop — the wake path allows less than chat */
  deadlineMs?: number;
  /** Live progress from the ReAct loop, so a surface can show its work */
  onStep?: (step: TraceStep) => void;
  /** Coarse progress for fast single-hop turns as well as agentic ones. */
  onPhase?: (phase: AssistantPhase) => void;
  /** When cloud is configured, prefer its lower interactive latency for
   *  evidence-grounded synthesis. Offline-only installs still use Nano. */
  preferCloudForAnswers?: boolean;
}

export const PERSONA =
  'You are the built-in assistant of an ADHD-friendly reading and productivity ' +
  'browser extension. Be blunt, direct, and concrete. Lead with the answer — ' +
  'no greetings, no pep talk, no filler, no exclamation marks, no emoji. Keep ' +
  'replies to 1-2 short sentences unless the user asks for more or the question ' +
  'needs an explanation. When an answer runs longer than that, format it for fast ' +
  'scanning with Markdown: "## " section labels, "- " bullets, **bold** for key ' +
  'terms, `code` for identifiers, and a blank line between sections. Write all ' +
  'mathematics as LaTeX — inline as $…$ and displayed equations as $$…$$ (this ' +
  'surface renders both). A one-line answer stays one plain line: no heading, no ' +
  'single-item bullet list. Never invent data, and never ' +
  'fabricate paper titles, authors, years, URLs, or citations — if you cannot ' +
  'verify something, say so plainly rather than guessing. To search for real ' +
  'papers, the user connects alphaXiv in Settings.';

const INTENTS: AssistantIntent[] = ['action', 'question', 'page', 'chat'];

/** How many cards a page-to-flashcards run may propose */
const MAX_PAGE_CARDS = 8;

/** Questions about what's visibly on screen — the cue that a screenshot would
 *  answer better than extracted text (charts, slides, video frames, layout). */
const VISUAL_CUE_RE =
  /\b(see|look|screen|slide|diagram|chart|graph|figure|image|picture|video|visual)/i;

/** Cloud providers that can answer from an attached screenshot. A screenshot-
 *  only turn (page text unextractable) may fall back only within this set —
 *  a text-only model cannot read pixels. Gemini leads; Claude Haiku follows. */
const VISION_PROVIDER_IDS = new Set<AssistantProvider['id']>(['gemini', 'anthropic']);

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

/**
 * Last-resort page answer when every model is unavailable. It deliberately
 * stays extractive: quoting a few early, substantial article sentences is
 * less polished than a generated summary, but remains useful and cannot
 * invent claims while a cloud provider is down.
 */
export function extractivePageFallback(page: PageContent): string {
  const candidates = page.text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length >= 45 &&
        sentence.length <= 360 &&
        sentence.split(/\s+/).length >= 8 &&
        !/^(cookie|privacy|subscribe|sign in|skip to|accept all)\b/i.test(sentence),
    );
  const excerpts: string[] = [];
  for (const sentence of candidates) {
    const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (
      excerpts.some((prior) => {
        const priorKey = prior.toLowerCase().replace(/[^a-z0-9 ]/g, '');
        return priorKey.includes(key.slice(0, 60)) || key.includes(priorKey.slice(0, 60));
      })
    ) {
      continue;
    }
    excerpts.push(sentence);
    if (excerpts.length === 3) break;
  }
  if (excerpts.length === 0) {
    const excerpt = page.text.replace(/\s+/g, ' ').trim().slice(0, 600);
    return `## Quick local summary\n\n${excerpt}${page.text.length > excerpt.length ? '…' : ''}`;
  }
  return `## Quick local summary\n\n${excerpts.map((sentence) => `- ${sentence}`).join('\n')}`;
}

/**
 * Shown when a provider gives up after its own retries on a transient 5xx /
 * overload. A single actionable line beats leaking the raw provider string,
 * and keeps every turn (chat, question, page, screenshot-only vision)
 * consistent about how a temporary outage reads to the user.
 */
export const ASSISTANT_OVERLOADED_MESSAGE =
  'The assistant service is temporarily overloaded after a few retries. Try again shortly.';

/**
 * True when a provider error is the transient overload it reports after
 * exhausting its retries (see geminiProvider.friendlyHttpError). Accepts the
 * message string so it works whether the caller kept the Error or only its
 * `.message`.
 */
export function isTransientOverload(message: string): boolean {
  return /temporarily overloaded|HTTP 503/i.test(message);
}

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
 * Does this question want the user's own reading, rather than their counts?
 * The data snapshot holds titles and totals; only the library holds what they
 * actually highlighted or wrote. False positives cost one keyword search.
 */
export function looksLikeLibraryQuestion(input: string): boolean {
  return /\b(highlight(ed|s)?|note(s|d)?|wrote|written|read(ing)?|saved|marked|annotat\w*|quote[sd]?)\b/i.test(
    input,
  );
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
      const { text } = await executeTool(step.name, step.params, tools);
      lines.push(`Done: ${text}`);
      await onStep?.(i, { status: 'done', detail: text });
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

/**
 * Keep the immediate conversational thread plus up to two older turns that
 * share meaningful words with the current question. This improves references
 * such as "what did we decide about my advisor?" without paying to resend all
 * 40 session turns on every request.
 */
export function relevantHistory(thread: AssistantTurn[], query: string): AssistantTurn[] {
  const eligible = thread.filter((turn) => turn.kind !== 'error' && turn.text.trim() !== '');
  const recent = eligible.slice(-6);
  const recentIds = new Set(recent.map((turn) => turn.id));
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  if (terms.size === 0) return recent;

  const older = eligible
    .slice(0, -6)
    .map((turn) => {
      const words = new Set(turn.text.toLowerCase().split(/[^a-z0-9]+/));
      return { turn, score: [...terms].filter((term) => words.has(term)).length };
    })
    .filter(({ turn, score }) => score > 0 && !recentIds.has(turn.id))
    .sort((a, b) => b.score - a.score || b.turn.createdAt - a.turn.createdAt)
    .slice(0, 2)
    .map(({ turn }) => turn);
  return [...older.sort((a, b) => a.createdAt - b.createdAt), ...recent];
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
): Promise<ToolOutput> {
  const tool = tools.find((t) => t.name === name) ?? findTool(name);
  if (!tool) throw new Error(`Unknown tool "${name}"`);
  const valid = validateToolCall(tool, params);
  if (!valid.ok) throw new Error(`That didn't quite work (${valid.error}).`);
  const result = await tool.run(valid.params);
  // Any tool run may have touched user data — cached answers/context are void
  void cacheInvalidateTag('data');
  return typeof result === 'string' ? { text: result } : result;
}

/**
 * Map a finished loop onto the outcome kinds the surfaces already render.
 *
 * The loop's prose is folded into the chip summary rather than added as a new
 * outcome field: `summary` is already multi-line (it carries "Check:" lines
 * today), so this keeps every consumer's narrowing untouched — notably the
 * command palette, whose else-branch reads `outcome.text`.
 */
function loopOutcome(loop: Extract<ReactResult, { kind: 'answered' }>): AssistantOutcome {
  const prose = loop.text.trim();
  const withProse = (summary: string) => (prose ? `${prose}\n\n${summary}` : summary);
  const trace = loop.trace.length > 0 ? loop.trace : undefined;

  if (loop.staged.length === 1) {
    const only = loop.staged[0];
    return {
      kind: 'confirm',
      toolName: only.name,
      params: only.params,
      summary: withProse(only.summary),
      trace,
    };
  }
  if (loop.staged.length > 1) {
    return {
      kind: 'confirm-plan',
      steps: loop.staged,
      summary: withProse(loop.staged.map((s, i) => `${i + 1}. ${s.summary}`).join('\n')),
      trace,
    };
  }
  return { kind: 'reply', text: stripEmoji(prose), source: 'cloud', trace };
}

export async function runAssistantTurn(
  input: string,
  thread: AssistantTurn[],
  deps: AssistantDeps,
): Promise<AssistantOutcome> {
  const startedAt = Date.now();
  const tools = deps.tools ?? TOOLS;
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'error', text: 'Say something first.' };

  // One routing env per turn — never module-cached, or a freshly pasted key
  // would stay invisible. `preferred` comes from deps.cloud's id rather than a
  // settings read: deps.cloud IS cloudProviderFor(settings), so its id already
  // is settings.cloudProvider.
  deps.onPhase?.('routing');
  const routingEnv = await resolveRoutingEnv({
    nano: deps.nano,
    cloud: deps.cloud,
    availability: deps.availability,
    preferred: deps.cloud?.id === 'anthropic' ? 'anthropic' : 'gemini',
  });
  const nanoOk = routingEnv.available.nano;
  // cloudOk keeps its old meaning — "the cloud this caller configured is
  // usable" — so the size-based escalation below behaves exactly as it did.
  const cloudOk = deps.cloud ? routingEnv.available[deps.cloud.id] : false;
  if (!nanoOk && !cloudOk) {
    return {
      kind: 'error',
      text: "No AI model is available — this browser has no built-in Gemini Nano model. Add a Gemini API key in Settings → Assistant to use the cloud instead.",
    };
  }
  /**
   * Nano first (free, private); cloud when Nano is missing or the input is too
   * big. The size rule is unchanged — routing decides only WHICH cloud serves
   * this role, so a user with at most one cloud key sees identical behavior.
   */
  const pick = (role: ModelRole, inputChars: number): AssistantProvider =>
    nanoOk && (inputChars <= NANO_INPUT_BUDGET_CHARS || !cloudOk)
      ? deps.nano
      : (cloudFor(role, routingEnv) ?? deps.cloud!);

  const router = pick('classify', trimmed.length);
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

  /**
   * Common dashboard questions do not need an agent loop. Retrieve the one
   * relevant local domain, answer exact state deterministically where possible,
   * otherwise make one streaming synthesis call over evidence whose identity is
   * part of the cache key. Injected getContext keeps tests/custom surfaces on
   * the legacy contract unless they explicitly inject getEvidence too.
   */
  if (routed.intent === 'question' && !deps.getContext && deps.getEvidence !== false) {
    deps.onPhase?.('retrieving');
    const evidence = await (deps.getEvidence ?? (() => gatherEvidence(trimmed)))();

    if (evidence.domains.length > 0) {
      if (!evidence.complete) {
        const text =
          evidence.domains[0] === 'library'
            ? "I couldn't find anything in your library that supports an answer."
            : "I don't have saved evidence for that yet.";
        deps.onToken?.(text);
        return {
          kind: 'reply',
          text,
          source: 'local',
          sources: evidence.sources,
          grounding: 'insufficient',
          diagnostics: {
            route: routed.intent,
            provider: 'local',
            cacheHit: false,
            evidenceCount: evidence.items.length,
            durationMs: Date.now() - startedAt,
          },
        };
      }

      if (evidence.exactAnswer) {
        const exactSources = evidence.sources.filter((source) => source.kind !== 'profile');
        deps.onToken?.(evidence.exactAnswer);
        return {
          kind: 'reply',
          text: evidence.exactAnswer,
          source: 'local',
          sources: exactSources.length > 0 ? exactSources : evidence.sources,
          grounding: 'grounded',
          diagnostics: {
            route: routed.intent,
            provider: 'local',
            cacheHit: false,
            evidenceCount: evidence.items.length,
            durationMs: Date.now() - startedAt,
            firstTokenMs: Date.now() - startedAt,
          },
        };
      }

      const history = relevantHistory(thread, trimmed);
      const historyText = history.map((turn) => turn.text).join('\n');
      const evidenceKey =
        `answer:v2:${normalizeUtterance(trimmed)}#${evidence.versionHash}` +
        `#${hash32(historyText)}#${hash32(skillBlock)}`;
      if (useCache) {
        const cached = await cacheGet<{
          text: string;
          source: 'nano' | 'cloud';
          sources: ToolOutput['sources'];
        }>(evidenceKey);
        if (cached) {
          deps.onToken?.(cached.text);
          return {
            kind: 'reply',
            ...cached,
            grounding: 'grounded',
            diagnostics: {
              route: routed.intent,
              provider: cached.source,
              cacheHit: true,
              evidenceCount: evidence.items.length,
              durationMs: Date.now() - startedAt,
              firstTokenMs: Date.now() - startedAt,
            },
          };
        }
      }

      deps.onPhase?.('generating');
      const provider =
        deps.preferCloudForAnswers && cloudOk
          ? (cloudFor('chat', routingEnv) ?? deps.cloud!)
          : pick(
              'chat',
              PERSONA.length +
                skillBlock.length +
                evidence.context.length +
                historyText.length +
                trimmed.length,
            );
      let firstTokenMs: number | undefined;
      const onToken = (partial: string) => {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
        deps.onToken?.(partial);
      };
      const candidates = [
        provider,
        ...providerChain('chat', routingEnv),
        ...(nanoOk ? [deps.nano] : []),
      ].filter(
        (candidate, index, all) =>
          all.findIndex((other) => other.id === candidate.id) === index,
      );
      let reply: ProviderReply | null = null;
      let providerUsed = provider;
      for (const candidate of candidates) {
        try {
          reply = await candidate.generate({
            system:
              PERSONA +
              skillBlock +
              '\n\nAnswer using ONLY the evidence below. If it does not contain the answer, say so.' +
              buildCitationRule(evidence.sources) +
              `\n\nEvidence:\n${evidence.context}`,
            turns: [...history, userTurn],
            onToken,
          });
          providerUsed = candidate;
          break;
        } catch {
          // A provider that remains overloaded after its own bounded retry
          // costs one fallback, not the grounded answer.
        }
      }
      if (!reply) {
        const fallback = evidence.items
          .filter((item) => item.source.kind !== 'profile')
          .slice(0, 5)
          .map((item) => `- ${item.text}`)
          .join('\n');
        return {
          kind: 'reply',
          text: fallback || "I couldn't produce an answer from the available evidence.",
          source: 'local',
          sources: evidence.sources,
          grounding: fallback ? 'grounded' : 'insufficient',
          diagnostics: {
            route: routed.intent,
            provider: 'local',
            cacheHit: false,
            evidenceCount: evidence.items.length,
            durationMs: Date.now() - startedAt,
          },
        };
      }

      deps.onPhase?.('verifying');
      const supportingSources = evidence.sources.filter((source) => source.kind !== 'profile');
      let rawText = stripEmoji(reply.text.trim());
      // One-source answers have an unambiguous provenance even when a small
      // local model forgets the marker. Multi-source prose never gets this
      // repair: attaching the wrong source to a claim would look grounded
      // while being less faithful than an extractive fallback.
      if (supportingSources.length === 1 && !/\[S\d+\]/.test(rawText)) {
        rawText += ` [${supportingSources[0].id}]`;
      }
      const resolved = resolveCitations(rawText, evidence.sources);
      if (supportingSources.length > 1 && resolved.cited.length === 0) {
        const fallback = evidence.items
          .filter((item) => item.source.kind !== 'profile')
          .slice(0, 5)
          .map((item) => `- ${item.text}`)
          .join('\n');
        return {
          kind: 'reply',
          text: fallback,
          source: 'local',
          sources: supportingSources,
          grounding: 'grounded',
          diagnostics: {
            route: routed.intent,
            provider: 'local',
            cacheHit: false,
            evidenceCount: evidence.items.length,
            durationMs: Date.now() - startedAt,
            ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
          },
        };
      }
      const text = resolved.text;
      const source = providerUsed.id === 'nano' ? ('nano' as const) : ('cloud' as const);
      const sources = resolved.cited.length > 0 ? resolved.cited : evidence.sources;
      if (useCache) {
        void cacheSet(
          evidenceKey,
          { text, source, sources },
          ANSWER_CACHE_TTL_MS,
          `evidence:${evidence.domains.join('+')}`,
        );
      }
      return {
        kind: 'reply',
        text,
        source,
        sources,
        grounding: 'grounded',
        diagnostics: {
          route: routed.intent,
          provider: providerUsed.id,
          cacheHit: false,
          evidenceCount: evidence.items.length,
          durationMs: Date.now() - startedAt,
          ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
        },
      };
    }
  }

  // Step 2 (ReAct) — one loop that calls a tool, reads what came back, and
  // decides what to do next. It declines on installs where it cannot run (no
  // cloud provider), so everything below stays a live fallback rather than
  // dead code. Page and chat intents keep their own branches: neither is a
  // lookup problem, so a loop would only add latency.
  if (deps.react && (routed.intent === 'action' || routed.intent === 'question')) {
    const context = deps.getContext ? await deps.getContext() : await cachedDataContext(useCache);
    const loop = await runReactLoop([...recentHistory(thread), userTurn], {
      chain: providerChain('loop', routingEnv),
      tools,
      system: `${PERSONA}${skillBlock}\n\nA snapshot of the user's data:\n${context}`,
      runTool: (name, params, offered) => executeTool(name, params, offered),
      // Claude leads the critic tier; a second opinion from the model that just
      // wrote the draft is worth much less than one from a different seat.
      criticChain: providerChain('critic', routingEnv),
      question: trimmed,
      deadlineMs: deps.deadlineMs,
      onToken: deps.onToken,
      onStep: deps.onStep,
    });
    if (loop.kind === 'error') return { kind: 'error', text: loop.text };
    if (loop.kind === 'answered') return loopOutcome(loop);
    // 'unsupported' — fall through to the two-step JSON path below
  }

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
          return { kind: 'done', ...(await executeTool(only.name, only.params, tools)) };
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
      // Retry on the router provider, then escalate once to the cloud this
      // role prefers (nano -> gemini -> anthropic).
      const attempts: AssistantProvider[] = [router, router];
      const escalation = cloudFor('extract', routingEnv) ?? deps.cloud;
      if (cloudOk && escalation && router.id !== escalation.id) attempts.push(escalation);
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
      return { kind: 'done', ...(await executeTool(tool.name, params, tools)) };
    } catch (err) {
      return { kind: 'error', text: err instanceof Error ? err.message : 'That action failed.' };
    }
  }

  // Step 2c — page-aware help: summarize/explain, or turn the page into cards
  if (routed.intent === 'page') {
    let page: PageContent | null = null;
    try {
      page = await (deps.getPage ?? getActivePageContent)();
    } catch {
      // Treat an extraction race like an unreadable tab. Screenshot vision may
      // still answer it, and the local message below remains more useful than
      // letting a rejected extractor take down the whole assistant turn.
    }

    // Vision: a question about what's ON the screen ("this chart", "this
    // slide"), or a page whose text can't be extracted at all, earns a
    // screenshot. Gemini leads image turns; Claude Haiku is the multimodal
    // fallback when Gemini is missing or overloaded. With neither cloud, the
    // turn degrades to text-only.
    const wantsVisual = VISUAL_CUE_RE.test(trimmed);
    let shot: Screenshot | null = null;
    let visionProvider: AssistantProvider | null = null;
    if (deps.getScreenshot !== false && (wantsVisual || !page)) {
      shot = await (deps.getScreenshot ?? getActiveTabScreenshot)();
      if (shot) {
        // Vision-capable clouds only, in tier order (Gemini, then Claude Haiku).
        // With neither configured the shot is dropped and the turn goes text-only.
        visionProvider = providerChain('vision', routingEnv)[0] ?? null;
        if (!visionProvider) shot = null;
      }
    }

    if (!page && !shot) {
      return {
        kind: 'reply',
        source: 'local',
        text: "I can't read this tab — open the article you mean and ask from the extension popup.",
      };
    }

    const provider = visionProvider ?? pick('chat', (page?.text.length ?? 0) + trimmed.length);
    const pageBlockFor = (candidate: AssistantProvider): string => {
      const prefix = page
        ? `The user is viewing “${page.title}” (${page.url}). Page content:\n`
        : '';
      const suffix =
        shot && VISION_PROVIDER_IDS.has(candidate.id)
          ? '\n\nA screenshot of the page as currently shown is attached.'
          : '';
      // NANO_INPUT_BUDGET_CHARS covers the whole request, not just article
      // text. Reserve room for persona/instructions/title and the user turn.
      const nanoTextBudget = Math.max(
        0,
        NANO_INPUT_BUDGET_CHARS -
          PERSONA.length -
          prefix.length -
          suffix.length -
          trimmed.length -
          96,
      );
      const pageText =
        candidate.id === 'nano'
          ? (page?.text ?? '').slice(0, nanoTextBudget)
          : (page?.text ?? '');
      return page
        ? prefix + pageText + suffix
        : 'The user is viewing a page whose text could not be extracted. A screenshot of it ' +
            'is attached — answer from what the screenshot shows, and say so when something ' +
            'is not visible in it.';
    };
    const pageBlock = pageBlockFor(provider);

    if (/flash\s*cards?|anki/i.test(trimmed)) {
      // Cards need extractable text — a screenshot alone isn't a study source.
      if (!page) {
        return {
          kind: 'reply',
          source: 'local',
          text: "I can't read this tab's text to make cards — open the article you mean.",
        };
      }
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

    // A page summary should not die just because the preferred cloud has a
    // transient failure. Walk the available chat providers, then fall back to
    // Nano with a bounded excerpt. Screenshot-only turns stay within the
    // vision-capable clouds (Gemini, then Claude Haiku): a text-only provider
    // cannot answer from pixels it cannot inspect.
    const candidates = [
      provider,
      ...providerChain('chat', routingEnv),
      ...(page && nanoOk ? [deps.nano] : []),
    ].filter(
      (candidate, index, all) =>
        (page || VISION_PROVIDER_IDS.has(candidate.id)) &&
        all.findIndex((other) => other.id === candidate.id) === index,
    );
    let firstError = '';
    for (const candidate of candidates) {
      try {
        const reply = await candidate.generate({
          system:
            PERSONA +
            '\n\n' +
            pageBlockFor(candidate) +
            '\n\nAnswer about this page; quote it rather than inventing.',
          turns: [userTurn],
          ...(shot && VISION_PROVIDER_IDS.has(candidate.id) ? { images: [shot] } : {}),
          onToken: deps.onToken,
        });
        const text = stripEmoji(reply.text.trim());
        if (!text) throw new Error('Model returned an empty response');
        return {
          kind: 'reply',
          text,
          source: candidate.id === 'nano' ? 'nano' : 'cloud',
        };
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    if (page) {
      return { kind: 'reply', text: extractivePageFallback(page), source: 'local' };
    }
    return {
      kind: 'error',
      text: isTransientOverload(firstError)
        ? ASSISTANT_OVERLOADED_MESSAGE
        : firstError
          ? `Reading the page failed: ${firstError}`
          : 'Reading the page failed. Try again.',
    };
  }

  // Step 2b/2d — question (with data snapshot) or plain chat
  const history = relevantHistory(thread, trimmed);
  let system = PERSONA + skillBlock;
  let answerKey: string | null = null;
  if (routed.intent === 'question') {
    // Injected getContext (tests, custom surfaces) bypasses the cache
    const context = deps.getContext
      ? await deps.getContext()
      : await cachedDataContext(useCache);
    // A snapshot of counts can't answer "what did I highlight about X" — pull
    // the matching passages out of the library and hand those over too.
    let library = '';
    if (deps.searchLibrary !== false && looksLikeLibraryQuestion(trimmed)) {
      try {
        library = await (deps.searchLibrary ?? searchLibraryText)(trimmed);
      } catch {
        // Search is an enhancement; a failure just means answering without it
      }
    }
    system =
      PERSONA +
      skillBlock +
      '\n\nAnswer using ONLY this snapshot of the user\'s data (say so if it lacks the answer):\n' +
      context +
      (library ? `\n\nMatching passages from their library:\n${library}` : '');
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
    'chat',
    system.length + history.reduce((n, t) => n + t.text.length, 0) + trimmed.length,
  );
  const candidates = [
    provider,
    ...providerChain('chat', routingEnv),
    ...(nanoOk ? [deps.nano] : []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.id === candidate.id) === index,
  );
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      const reply = await candidate.generate({
        system,
        turns: [...history, userTurn],
        onToken: deps.onToken,
      });
      const text = stripEmoji(reply.text.trim());
      const source = candidate.id === 'nano' ? ('nano' as const) : ('cloud' as const);
      if (answerKey) void cacheSet(answerKey, { text, source }, ANSWER_CACHE_TTL_MS, 'data');
      return { kind: 'reply', text, source };
    } catch (err) {
      firstError ??= err;
    }
  }
  return {
    kind: 'error',
    text:
      firstError instanceof Error && firstError.name === 'TimeoutError'
        ? 'That took too long on the on-device model — ask a shorter question.'
        : firstError instanceof Error && isTransientOverload(firstError.message)
          ? ASSISTANT_OVERLOADED_MESSAGE
          : 'Reply generation failed. Try again.',
  };
}
