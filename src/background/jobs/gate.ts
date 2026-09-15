import { JOB_HOST_MIN_INTERVAL_MS } from '../../shared/constants';
import { claimRequest, noteError, type RunState } from '../../shared/jobs/budgets';
import type { SessionSchema } from '../../shared/storage';

/**
 * Politeness, as code rather than as a comment: one serialized queue per host,
 * a floor between calls on it, a conditional GET when we've seen the URL
 * before, and a timeout on everything. Modelled on the gate in citations.ts,
 * which spaces OpenAlex and Semantic Scholar the same way.
 *
 * Per-host rather than one global chain, unlike citations.ts: adapters fan out
 * with Promise.allSettled and there is no reason a slow Workday tenant should
 * hold up Greenhouse. Within a host, calls still go one at a time.
 *
 * The queue is module state, so it empties when the worker is torn down. That
 * is fine for what it guards — the calls that need spacing are the ones inside
 * a single run, and runs are a daily alarm apart.
 */

/** Matches rssParser's FETCH_TIMEOUT_MS: same job, same patience. */
const FETCH_TIMEOUT_MS = 15_000;

const queues = new Map<string, Promise<unknown>>();
const lastCallAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gate(host: string, minIntervalMs: number): Promise<void> {
  const prev = queues.get(host) ?? Promise.resolve();
  const next = prev.then(async () => {
    const wait = (lastCallAt.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt.set(host, Date.now());
  });
  queues.set(
    host,
    next.catch(() => undefined),
  );
  return next;
}

export type FetchState = SessionSchema['jobFetchState'];

export interface GetOptions {
  minIntervalMs?: number;
  /** Workday's list endpoint is a POST; everything else is a plain GET. */
  body?: unknown;
  /**
   * Defaults to JSON because most of these are JSON APIs. YC has to override
   * it: its jobs page is HTML with the data embedded, and asking that URL for
   * application/json gets a 404 rather than the page.
   */
  accept?: string;
}

export interface GetResult {
  status: number;
  /** '' on 304 — the caller keeps what it already had */
  text: string;
}

/**
 * One budgeted, rate-gated request. Returns null when the run has no room for
 * it or has already made this exact call, so a caller can keep going rather
 * than treating a spent budget as a failure.
 */
export async function get(
  url: string,
  run: RunState,
  state: FetchState,
  now: number,
  options: GetOptions = {},
): Promise<GetResult | null> {
  const signature = `${options.body ? 'POST' : 'GET'} ${url}`;
  if (!claimRequest(run, signature, now)) return null;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    noteError(run);
    return null;
  }

  await gate(host, options.minIntervalMs ?? JOB_HOST_MIN_INTERVAL_MS);

  const prior = state[url];
  const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' };
  // Conditional GET turns the 12MB SimplifyJobs poll into a 304 on most days.
  if (prior?.etag) headers['If-None-Match'] = prior.etag;
  if (prior?.lastModified) headers['If-Modified-Since'] = prior.lastModified;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    state[url] = {
      etag: response.headers.get('etag') ?? '',
      lastModified: response.headers.get('last-modified') ?? '',
      lastCallAt: Date.now(),
    };

    if (response.status === 304) return { status: 304, text: '' };
    if (!response.ok) {
      noteError(run);
      return { status: response.status, text: '' };
    }
    return { status: response.status, text: await response.text() };
  } catch {
    // Timeout, DNS, offline. One source failing must not sink the run.
    noteError(run);
    return null;
  }
}

/** Parse a response body, treating malformed JSON as an empty result. */
export function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
