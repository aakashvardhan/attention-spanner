import {
  JOB_RUN_DEADLINE_MS,
  JOB_RUN_MAX_ERRORS,
  JOB_RUN_MAX_REQUESTS,
} from '../constants';
import { callSignature } from '../ai/react/guardrails';
import type { JobStopReason } from '../types';

/**
 * The ceilings on one ingestion run. Every function here is pure, for the same
 * reason guardrails.ts is: the question "could this run away?" should be
 * answerable by a unit test rather than by reading the loop. Workday is N+1
 * against an undocumented endpoint, so that question has a real answer riding
 * on it.
 *
 * The governing rule is the ReAct loop's own — **every exit is a commit**. A
 * run that trips a ceiling still writes what it found and records why it
 * stopped; a stop reason is never an error.
 *
 * `callSignature` is imported rather than reimplemented: sorting the param
 * keys so {a,b} and {b,a} collide is exactly the property a detail-fetch
 * deduper needs, and it is already written and tested.
 */

export { callSignature };

export interface JobRunBudgets {
  maxRequests: number;
  maxErrors: number;
  deadlineMs: number;
}

export const DEFAULT_JOB_BUDGETS: JobRunBudgets = {
  maxRequests: JOB_RUN_MAX_REQUESTS,
  maxErrors: JOB_RUN_MAX_ERRORS,
  deadlineMs: JOB_RUN_DEADLINE_MS,
};

export interface RunState {
  startedAt: number;
  deadlineAt: number;
  requests: number;
  errors: number;
  /** Request signatures already spent, so one run never fetches the same URL twice */
  seen: Set<string>;
}

export function beginRun(now: number, budgets: JobRunBudgets = DEFAULT_JOB_BUDGETS): RunState {
  return {
    startedAt: now,
    deadlineAt: now + budgets.deadlineMs,
    requests: 0,
    errors: 0,
    seen: new Set(),
  };
}

/**
 * Which ceiling the run has hit, or null while there is room. The caller
 * treats any non-null as "stop and commit what you have" — never as a failure.
 */
export function checkJobBudgets(
  state: RunState,
  now: number,
  budgets: JobRunBudgets = DEFAULT_JOB_BUDGETS,
): JobStopReason | null {
  if (now >= state.deadlineAt) return 'deadline';
  if (state.requests >= budgets.maxRequests) return 'requests';
  if (state.errors >= budgets.maxErrors) return 'errors';
  return null;
}

/**
 * Claim one request against the budget. Returns false when the run is out of
 * room or has already made this exact call — the caller skips rather than
 * waits, so a rotating listing can't spend the whole budget re-reading itself.
 */
export function claimRequest(
  state: RunState,
  signature: string,
  now: number,
  budgets: JobRunBudgets = DEFAULT_JOB_BUDGETS,
): boolean {
  if (checkJobBudgets(state, now, budgets) !== null) return false;
  if (state.seen.has(signature)) return false;
  state.seen.add(signature);
  state.requests += 1;
  return true;
}

export function noteError(state: RunState): void {
  state.errors += 1;
}
