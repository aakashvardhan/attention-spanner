import {
  REACT_MAX_COSTLY_CALLS,
  REACT_MAX_ESCALATIONS,
  REACT_MAX_ITERATIONS,
  REACT_MAX_STAGED_MUTATIONS,
  REACT_MAX_TOOL_CALLS,
  REACT_MAX_TOOL_ERRORS,
  REACT_STALL_LIMIT,
} from '../../constants';
import type { Tool } from '../tools';
import type { Scratchpad } from './scratchpad';

/**
 * The limits on what one ReAct turn may do. Every function here is pure, so the
 * question "could this loop run away?" is answerable by a unit test rather than
 * by reading the loop.
 *
 * Two separable jobs: how MUCH the loop may do (budgets, stall detection) and
 * WHICH tools it may run unattended (classifyToolUse). The second fails closed —
 * an unannotated tool is staged for human approval, never auto-run — so adding
 * a connector cannot silently hand the loop a new side effect.
 */

export type ToolUseClass = 'auto' | 'costly' | 'stage';

/**
 * How the loop may use a tool. `confirm: true` always means stage, whatever the
 * annotation says; an unannotated tool also stages, which is the fail-closed
 * default that keeps a central allowlist from drifting open.
 */
export function classifyToolUse(tool: Tool): ToolUseClass {
  if (tool.confirm) return 'stage';
  return tool.loop ?? 'stage';
}

/**
 * Stable signature of a tool call. Keys are sorted so {a,b} and {b,a} collide —
 * otherwise a model could "vary" a call by reordering its params and defeat
 * duplicate detection.
 */
export function callSignature(name: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`);
  return `${name}(${sorted.join(',')})`;
}

export type StopReason =
  | 'iterations'
  | 'tool-calls'
  | 'costly-calls'
  | 'staged'
  | 'tool-errors'
  | 'deadline';

export interface Budgets {
  maxIterations: number;
  maxToolCalls: number;
  maxCostlyCalls: number;
  maxStaged: number;
  maxToolErrors: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxIterations: REACT_MAX_ITERATIONS,
  maxToolCalls: REACT_MAX_TOOL_CALLS,
  maxCostlyCalls: REACT_MAX_COSTLY_CALLS,
  maxStaged: REACT_MAX_STAGED_MUTATIONS,
  maxToolErrors: REACT_MAX_TOOL_ERRORS,
};

/**
 * Which ceiling (if any) the loop has hit. Returns null while there is room.
 * The caller treats any non-null as "stop looping and answer from what you
 * have" — never as an error.
 */
export function checkBudgets(
  scratch: Scratchpad,
  now: number,
  budgets: Budgets = DEFAULT_BUDGETS,
): StopReason | null {
  if (now >= scratch.deadlineAt) return 'deadline';
  if (scratch.iterations >= budgets.maxIterations) return 'iterations';
  if (scratch.steps.length >= budgets.maxToolCalls) return 'tool-calls';
  if (scratch.costlyCalls >= budgets.maxCostlyCalls) return 'costly-calls';
  if (scratch.staged.length >= budgets.maxStaged) return 'staged';
  if (scratch.toolErrors >= budgets.maxToolErrors) return 'tool-errors';
  return null;
}

/** Whether one more call of this class would exceed its own ceiling */
export function canRun(
  scratch: Scratchpad,
  use: ToolUseClass,
  budgets: Budgets = DEFAULT_BUDGETS,
): boolean {
  if (use === 'stage') return scratch.staged.length < budgets.maxStaged;
  if (use === 'costly') return scratch.costlyCalls < budgets.maxCostlyCalls;
  return scratch.steps.length < budgets.maxToolCalls;
}

/**
 * Is the loop going in circles? Any of: it repeated a call it already made, an
 * iteration produced observations byte-identical to the previous one, or the
 * model replied with neither text nor a tool call. All three mean another turn
 * on the SAME model will not help — the caller escalates a tier instead.
 */
export function detectStall(scratch: Scratchpad): boolean {
  return scratch.stallRounds >= REACT_STALL_LIMIT;
}

/** Whether there is still an escalation left to spend */
export function canEscalate(scratch: Scratchpad, chainLength: number): boolean {
  return scratch.escalations < REACT_MAX_ESCALATIONS && scratch.tierIndex + 1 < chainLength;
}
