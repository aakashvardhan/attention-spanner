import {
  JOB_STALE_DAYS,
  MAX_JOB_RUNS,
  MAX_JOBS,
} from '../../shared/constants';
import { beginRun, checkJobBudgets } from '../../shared/jobs/budgets';
import { compareJobs, needsRescore, profileHash, scoreJob } from '../../shared/jobs/score';
import { getLocal, getSession, setLocal, setSession } from '../../shared/storage';
import type { Job, JobProfile, JobRun, JobStatus, JobSource } from '../../shared/types';
import { withLock } from '../runLock';
import { FETCHERS, type SourceContext } from './sources';

/**
 * The ingestion run, and the writes around it.
 *
 * Two rules govern this file. **Every exit is a commit**: a run that trips a
 * budget still writes what it found and records why it stopped — a stop reason
 * is a fact about the run, never an error. And **one writer**: every mutation
 * goes through withLock('jobs'), so a scheduled refresh and a click on the
 * board cannot interleave read-modify-write over the same array.
 */

export type JobResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fold a fetch into what's already stored. The user's own columns — status,
 * and the time we first saw it — belong to the record and survive; everything
 * the source owns is refreshed.
 *
 * Merging by id rather than replacing is what lets YC's rotating sample
 * accumulate: each poll returns a different 37, and the union grows.
 */
export function mergeJobs(existing: Job[], incoming: Job[], now: number): Job[] {
  const byId = new Map(existing.map((job) => [job.id, job]));
  for (const fresh of incoming) {
    const prior = byId.get(fresh.id);
    if (!prior) {
      byId.set(fresh.id, fresh);
      continue;
    }
    byId.set(fresh.id, {
      ...fresh,
      status: prior.status,
      capturedAt: prior.capturedAt,
      // Keep the prior score; the caller rescores what actually needs it.
      score: prior.score,
      updatedAt: now,
    });
  }
  return [...byId.values()];
}

/**
 * Bring the list back under its cap. Anything you shortlisted or applied to is
 * untouchable — those are your records now, not the source's. Everything else
 * ages out, and if that still isn't enough the lowest-ranked go first.
 */
export function pruneJobs(jobs: Job[], now: number, cap = MAX_JOBS): Job[] {
  const keep: Job[] = [];
  const droppable: Job[] = [];
  for (const job of jobs) {
    if (job.status === 'shortlist' || job.status === 'applied') keep.push(job);
    else droppable.push(job);
  }
  const cutoff = now - JOB_STALE_DAYS * DAY_MS;
  const fresh = droppable.filter((job) => (job.postedAt ?? job.capturedAt) >= cutoff);
  const room = Math.max(0, cap - keep.length);
  return [...keep, ...fresh.sort(compareJobs).slice(0, room)];
}

/** Rescore only what the current profile hasn't scored. */
export function rescore(jobs: Job[], profile: JobProfile, now: number): Job[] {
  const hash = profileHash(profile);
  return jobs.map((job) => (needsRescore(job, hash) ? { ...job, score: scoreJob(job, profile, now) } : job));
}

export async function refreshJobs(): Promise<JobResult<{ run: JobRun }>> {
  const { jobSources, jobProfile } = await getLocal('jobSources', 'jobProfile');
  const enabled = jobSources.filter((source) => source.enabled);
  const now = Date.now();

  const { jobFetchState } = await getSession('jobFetchState');
  const state = { ...jobFetchState };
  const run = beginRun(now);
  const ctx: SourceContext = { run, state, now, profile: jobProfile };

  // Fan out. Adapters are independent I/O, so one dead host must not take the
  // others with it — the same rule refreshFeeds follows.
  const settled = await Promise.allSettled(
    enabled.map(async (source) => {
      const fetcher = FETCHERS[source.adapter];
      if (!fetcher) throw new Error(`No adapter for ${source.adapter}`);
      return { source, jobs: await fetcher(source, ctx) };
    }),
  );

  // Per-source rather than flattened: two Greenhouse boards are two lines, and
  // crediting whichever one the adapter name matched first would misreport
  // exactly the thing the run log exists to tell you.
  const harvest = settled.map((result, index) => ({
    source: enabled[index],
    jobs: result.status === 'fulfilled' ? result.value.jobs : [],
    error:
      result.status === 'fulfilled'
        ? ''
        : String(result.reason instanceof Error ? result.reason.message : result.reason),
  }));
  const incoming = harvest.flatMap((entry) => entry.jobs);

  const finishedAt = Date.now();
  const record = await withLock('jobs', async () => {
    const { jobs, jobRuns } = await getLocal('jobs', 'jobRuns');
    const known = new Set(jobs.map((job) => job.id));

    const lines: JobRun['sources'] = harvest.map((entry) => {
      let added = 0;
      for (const job of entry.jobs) {
        if (known.has(job.id)) continue;
        known.add(job.id);
        added += 1;
      }
      return {
        label: entry.source.label || entry.source.token || entry.source.adapter,
        adapter: entry.source.adapter,
        fetched: entry.jobs.length,
        added,
        error: entry.error,
      };
    });

    const next: JobRun = {
      id: crypto.randomUUID(),
      startedAt: now,
      finishedAt,
      // A tripped ceiling is how the run ended, not a failure of it.
      stopReason: checkJobBudgets(run, finishedAt) ?? 'done',
      requests: run.requests,
      sources: lines,
    };

    const merged = pruneJobs(
      rescore(mergeJobs(jobs, incoming, finishedAt), jobProfile, finishedAt),
      finishedAt,
    );
    await setLocal({
      jobs: merged.sort(compareJobs),
      jobRuns: [...jobRuns, next].slice(-MAX_JOB_RUNS),
    });
    return next;
  });

  await setSession({ jobFetchState: state });
  return { ok: true, run: record };
}

export async function setJobStatus(id: string, status: JobStatus): Promise<JobResult> {
  return withLock('jobs', async () => {
    const { jobs } = await getLocal('jobs');
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) return { ok: false, error: 'Job not found.' };
    job.status = status;
    job.updatedAt = Date.now();
    await setLocal({ jobs });
    return { ok: true };
  });
}

export async function saveJobSource(source: JobSource): Promise<JobResult> {
  if (!source.adapter) return { ok: false, error: 'Pick a source type.' };
  // YC and SimplifyJobs both treat a blank token as "every feed I know about",
  // so for them it is a valid choice rather than a missing field.
  const optionalToken = source.adapter === 'ycombinator' || source.adapter === 'simplify';
  if (!optionalToken && !source.token && !source.tenant) {
    return { ok: false, error: 'A board token is required.' };
  }
  return withLock('jobs', async () => {
    const { jobSources } = await getLocal('jobSources');
    const index = jobSources.findIndex((existing) => existing.id === source.id);
    if (index === -1) jobSources.push(source);
    else jobSources[index] = source;
    await setLocal({ jobSources });
    return { ok: true };
  });
}

export async function deleteJobSource(id: string): Promise<JobResult> {
  return withLock('jobs', async () => {
    const { jobSources } = await getLocal('jobSources');
    await setLocal({ jobSources: jobSources.filter((source) => source.id !== id) });
    return { ok: true };
  });
}

/**
 * Save the profile and rescore against it immediately. Leaving the board on
 * yesterday's ranking after you changed the filters is the kind of staleness
 * that makes a score untrustworthy.
 */
export async function saveJobProfile(patch: Partial<JobProfile>): Promise<JobResult> {
  return withLock('jobs', async () => {
    const { jobProfile, jobs } = await getLocal('jobProfile', 'jobs');
    const next = { ...jobProfile, ...patch };
    const now = Date.now();
    await setLocal({ jobProfile: next, jobs: rescore(jobs, next, now).sort(compareJobs) });
    return { ok: true };
  });
}
