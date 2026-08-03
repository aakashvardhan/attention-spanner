import { REACT_OBSERVATION_MAX_CHARS, REACT_SCRATCHPAD_MAX_CHARS } from '../../constants';
import type { PlannedStep } from '../assistant';
import { newTurn, type AssistantToolUse, type AssistantTurn } from '../assistantTypes';
import type { SourceRef } from '../tools';

/**
 * What one ReAct turn has done so far: the calls it made, what came back, the
 * mutations it staged for approval, and the sources it may cite. Every function
 * here is pure — the loop does the I/O and hands results in.
 *
 * Two things live here rather than in the loop because they are exactly the
 * parts worth testing without a provider: the truncation that keeps a runaway
 * observation from eating the context window, and the source-id minting that
 * makes a fabricated citation impossible.
 */

export type ObservationSource = 'tool' | 'staged' | 'error' | 'duplicate' | 'budget';

export interface ReactStep {
  iteration: number;
  call: AssistantToolUse;
  signature: string;
  source: ObservationSource;
  /** Truncated observation, exactly as the model will see it */
  observation: string;
  ms: number;
}

export interface Scratchpad {
  steps: ReactStep[];
  staged: PlannedStep[];
  /** Call signatures already seen — a repeat is answered from here, not re-run */
  seen: Map<string, string>;
  /** Citable sources, keyed by url so the same page found twice is one id */
  sources: Map<string, SourceRef>;
  /** Paper hits worth drawing as cards — the chat renders these, so losing
   *  them to a text-only observation would be a visible regression */
  iterations: number;
  costlyCalls: number;
  toolErrors: number;
  /** Consecutive failures per tool name; drives the drop-this-tool rule */
  toolErrorsByName: Map<string, number>;
  stallRounds: number;
  escalations: number;
  /** Explicit "do I have enough?" calls spent this turn */
  sufficiencyChecks: number;
  tierIndex: number;
  deadlineAt: number;
  startedAt: number;
}

export function beginScratchpad(deadlineAt: number, startedAt = Date.now()): Scratchpad {
  return {
    steps: [],
    staged: [],
    seen: new Map(),
    sources: new Map(),
    iterations: 0,
    costlyCalls: 0,
    toolErrors: 0,
    toolErrorsByName: new Map(),
    stallRounds: 0,
    escalations: 0,
    sufficiencyChecks: 0,
    tierIndex: 0,
    deadlineAt,
    startedAt,
  };
}

/** Cut an observation to budget, saying so rather than truncating silently */
export function truncateObservation(
  text: string,
  max = REACT_OBSERVATION_MAX_CHARS,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated — ${text.length - max} more characters]`;
}

/**
 * Register sources and hand back the ids assigned to them. Ids are minted HERE,
 * never by a tool and never by the model: they are sequential within the turn
 * and deduped by url, so citing `[S2]` can only ever mean the second distinct
 * thing this turn actually looked at.
 */
export function addSources(scratch: Scratchpad, sources: readonly SourceRef[]): string[] {
  const ids: string[] = [];
  for (const source of sources) {
    if (!source.url) continue;
    const existing = scratch.sources.get(source.url);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const id = `S${scratch.sources.size + 1}`;
    scratch.sources.set(source.url, { ...source, id });
    ids.push(id);
  }
  return ids;
}

/**
 * Wrap an observation so the model can tell tool output from instructions.
 * Everything inside is untrusted: a page, an email, or a paper abstract can
 * contain text addressed to the assistant, and the loop system prompt tells it
 * that such text is data, never a command.
 */
export function renderObservation(step: ReactStep): string {
  return `<observation tool="${step.call.name}">\n${step.observation}\n</observation>`;
}

/** The full scratchpad as evidence text, newest kept when the budget bites */
export function renderEvidence(
  scratch: Scratchpad,
  max = REACT_SCRATCHPAD_MAX_CHARS,
): string {
  const rendered = scratch.steps.map(renderObservation);
  let total = rendered.reduce((n, r) => n + r.length + 1, 0);
  // Elide from the OLDEST end: the most recent observations are the ones the
  // next decision actually turns on.
  let firstKept = 0;
  while (total > max && firstKept < rendered.length - 1) {
    total -= rendered[firstKept].length + 1;
    firstKept++;
  }
  const kept = rendered.slice(firstKept);
  if (firstKept > 0) kept.unshift(`[${firstKept} earlier observation(s) elided]`);
  return kept.join('\n');
}

/**
 * The turns that carry one iteration back to the model: the assistant turn that
 * requested the calls, then one tool turn per result. Kept separate from the
 * session thread — appendTurn drops tool turns, so these cannot leak into it.
 */
export function toTurns(text: string, steps: readonly ReactStep[]): AssistantTurn[] {
  const assistant = newTurn('assistant', text, { toolUses: steps.map((s) => s.call) });
  const results = steps.map((s) =>
    newTurn('tool', s.observation, {
      toolResult: { id: s.call.id, name: s.call.name, ok: s.source !== 'error' },
    }),
  );
  return [assistant, ...results];
}

/** Every source gathered this turn, in id order */
export function allSources(scratch: Scratchpad): SourceRef[] {
  return [...scratch.sources.values()].sort(
    (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
}
