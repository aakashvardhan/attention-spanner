import {
  JOB_SIMPLIFY_MAX,
  JOB_STALE_DAYS,
  JOB_WORKDAY_MAX_DETAILS,
  JOB_WORKDAY_MIN_INTERVAL_MS,
} from '../../shared/constants';
import {
  extractDataPage,
  fromAshby,
  fromGreenhouse,
  fromLever,
  fromWorkdayDetail,
  fromWorkdayList,
  fromRss,
  fromSimplify,
  fromYc,
  simplifyPrefilter,
  toSimplifyEntries,
} from '../../shared/jobs/adapters';
import { hasSeniorityMarker, jobKindFromTitle } from '../../shared/jobs/parse';
import { claimRequest, noteError, type RunState } from '../../shared/jobs/budgets';
import type { Job, JobProfile, JobSource } from '../../shared/types';
import { get, parseJson, type FetchState } from './gate';
import { fetchFeed } from '../rssParser';

/**
 * The fetch half of each adapter. The parsing half is pure and lives in
 * shared/jobs/adapters.ts; these functions only know how to ask.
 *
 * A misconfigured source returns `[]` — there is nothing to report about a
 * board you never finished setting up. A source that was asked and failed
 * throws, and the run loop turns that into its line in the run log. The
 * distinction matters: "0 fetched" and "404" look identical otherwise, and
 * one of them means something is broken.
 *
 * Only vendor-published board APIs and pages robots.txt permits are here.
 * LinkedIn, Indeed and Work at a Startup are deliberately absent: they are
 * covered by capturing a page you have personally opened, which is a different
 * thing from a crawler.
 */

export interface SourceContext {
  run: RunState;
  state: FetchState;
  now: number;
  profile: JobProfile;
}

export type Fetcher = (source: JobSource, ctx: SourceContext) => Promise<Job[]>;

/**
 * Turn a dead request into a run-log line. Without this a source that 404s
 * reports "0 fetched" and looks indistinguishable from a board with nothing
 * new — which is exactly how a wrong Accept header hid for a whole run.
 */
function failed(what: string, res: { status: number } | null): Error {
  return new Error(res ? `${what} returned HTTP ${res.status}` : `${what} could not be reached`);
}

/**
 * A 304 is a success with an empty body: the board hasn't changed since the
 * last poll, so there is nothing to parse and nothing to complain about.
 */
const unchanged = (res: { status: number } | null): boolean => res?.status === 304;

const YC_ROLES = ['software-engineer', 'science'];

/**
 * YC's board. `token` is a role slug; blank means the two that matter here.
 *
 * No pagination: `?page=2` and `?offset=37` both come back with 37 postings
 * under different leading ids, which reads as a rotating sample rather than
 * paging. Enumerating it is not on offer, so the run takes what it is given
 * and lets daily merges accumulate the rest.
 */
export const fetchYc: Fetcher = async (source, ctx) => {
  const roles = source.token ? [source.token] : YC_ROLES;
  const jobs: Job[] = [];
  const failures: Error[] = [];
  for (const role of roles) {
    const res = await get(
      `https://www.ycombinator.com/jobs/role/${encodeURIComponent(role)}`,
      ctx.run,
      ctx.state,
      ctx.now,
      // The page is HTML with the payload embedded; asking for JSON 404s.
      { accept: 'text/html' },
    );
    if (unchanged(res)) continue;
    if (!res?.text) {
      failures.push(failed(`YC ${role}`, res));
      continue;
    }
    const page = extractDataPage(res.text);
    if (!page) {
      failures.push(new Error(`YC ${role} page had no data-page payload`));
      continue;
    }
    jobs.push(...fromYc(page, ctx.now));
  }
  // One dead role among several is not worth failing the source over; all of
  // them dead is, and the reason belongs in the log.
  if (jobs.length === 0 && failures.length > 0) throw failures[0];
  return jobs;
};

export const fetchGreenhouse: Fetcher = async (source, ctx) => {
  if (!source.token) return [];
  const res = await get(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.token)}/jobs?content=true`,
    ctx.run,
    ctx.state,
    ctx.now,
  );
  if (unchanged(res)) return [];
  if (!res?.text) throw failed(`Greenhouse board "${source.token}"`, res);
  return fromGreenhouse(parseJson(res.text), source.label || source.token, ctx.now);
};

export const fetchLever: Fetcher = async (source, ctx) => {
  if (!source.token) return [];
  const res = await get(
    `https://api.lever.co/v0/postings/${encodeURIComponent(source.token)}?mode=json`,
    ctx.run,
    ctx.state,
    ctx.now,
  );
  if (unchanged(res)) return [];
  if (!res?.text) throw failed(`Lever board "${source.token}"`, res);
  return fromLever(parseJson(res.text), source.label || source.token, ctx.now);
};

export const fetchAshby: Fetcher = async (source, ctx) => {
  if (!source.token) return [];
  const res = await get(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.token)}`,
    ctx.run,
    ctx.state,
    ctx.now,
  );
  if (unchanged(res)) return [];
  if (!res?.text) throw failed(`Ashby board "${source.token}"`, res);
  return fromAshby(parseJson(res.text), source.label || source.token, ctx.now);
};

/**
 * A job feed. Reuses fetchFeed wholesale — RSS parsing, Atom handling and the
 * 15s timeout are already written and tested in rssParser.ts, and a second
 * copy would be a second thing to get wrong.
 *
 * It does its own fetching, so it sidesteps the gate. The budget still has to
 * hear about the request, or a list of feeds could spend an unbounded number
 * of them: claimRequest is what keeps that honest.
 */
export const fetchRss: Fetcher = async (source, ctx) => {
  const url = source.url || source.token;
  if (!url) return [];
  if (!claimRequest(ctx.run, `GET ${url}`, ctx.now)) return [];

  const result = await fetchFeed(url);
  if (!result.ok) {
    noteError(ctx.run);
    throw new Error(`Feed "${source.label || url}" failed: ${result.error}`);
  }
  return fromRss(result.items, source.label, ctx.now);
};

/**
 * The two SimplifyJobs aggregator repos, keyed by the `kind` each one is.
 * Blank token means both.
 */
const SIMPLIFY_FEEDS = {
  'new-grad': 'New-Grad-Positions',
  internship: 'Summer2026-Internships',
} as const;

/**
 * SimplifyJobs' community boards. Enormous coverage of exactly the two stages
 * you care about, at the cost of being the heaviest source here by far: each
 * repo publishes its entire history as one ~12MB JSON file.
 *
 * Three things make that affordable. GitHub serves ETags, so most days this is
 * a 304 and no bytes move at all. The parse is scoped tightly and the raw array
 * is never stored — only the slim slice that survives the prefilter. And that
 * prefilter runs before any Job records exist, because ~2,000 rows would
 * otherwise evict every other source from the board.
 */
export const fetchSimplify: Fetcher = async (source, ctx) => {
  const wanted = (source.token ? [source.token] : Object.keys(SIMPLIFY_FEEDS)) as (keyof typeof SIMPLIFY_FEEDS)[];
  const jobs: Job[] = [];
  const failures: Error[] = [];

  for (const kind of wanted) {
    const repo = SIMPLIFY_FEEDS[kind];
    if (!repo) continue;
    const res = await get(
      `https://raw.githubusercontent.com/SimplifyJobs/${repo}/dev/.github/scripts/listings.json`,
      ctx.run,
      ctx.state,
      ctx.now,
      { accept: 'application/json' },
    );
    if (unchanged(res)) continue;
    if (!res?.text) {
      failures.push(failed(`SimplifyJobs ${repo}`, res));
      continue;
    }
    const entries = simplifyPrefilter(
      toSimplifyEntries(parseJson(res.text)),
      ctx.profile,
      ctx.now,
      JOB_STALE_DAYS,
      JOB_SIMPLIFY_MAX,
    );
    jobs.push(...fromSimplify(entries, kind, ctx.now));
  }

  if (jobs.length === 0 && failures.length > 0) throw failures[0];
  return jobs;
};

/**
 * Which listings are worth a detail request. This is the whole defence against
 * Workday's N+1: a tenant with 907 openings must not become 907 fetches, and
 * the budget ceiling alone would spend itself on the first 25 rows in
 * whatever order the server felt like.
 *
 * Cheap signals only — title and location are all the list response carries.
 * Pure and exported so the cut is a unit test rather than a hope.
 */
export function workdayPrefilter(
  listings: { title: string; externalPath: string; locationsText: string }[],
  profile: JobProfile,
  limit = JOB_WORKDAY_MAX_DETAILS,
): typeof listings {
  const wanted = listings.filter((listing) => {
    if (hasSeniorityMarker(listing.title)) return false;
    const kind = jobKindFromTitle(listing.title);
    if (kind !== 'other') return profile.kinds.includes(kind);
    // A neutral title still qualifies if it names a role family you want.
    const title = listing.title.toLowerCase();
    return profile.roleFamilies.some((family) => title.includes(family.toLowerCase()));
  });
  return wanted.slice(0, limit);
}

/**
 * Workday, the one two-phase source. The list endpoint is the careers site's
 * own SPA backend — unauthenticated, but undocumented and therefore fragile,
 * so it gets the slowest interval of the set and the tightest cut.
 *
 * `searchText` narrows server-side before we spend anything; the prefilter
 * narrows again; only then does anything earn a detail request. The listing's
 * `postedOn` is the string "Posted 30+ Days Ago", so the real date arrives
 * with the detail or not at all.
 */
export const fetchWorkday: Fetcher = async (source, ctx) => {
  const { tenant, host, site } = source;
  if (!tenant || !host || !site) return [];
  const base = `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const company = source.label || tenant;

  const listRes = await get(`${base}/jobs`, ctx.run, ctx.state, ctx.now, {
    minIntervalMs: JOB_WORKDAY_MIN_INTERVAL_MS,
    body: { appliedFacets: {}, limit: 20, offset: 0, searchText: source.token || 'intern' },
  });
  if (unchanged(listRes)) return [];
  if (!listRes?.text) throw failed(`Workday tenant "${tenant}"`, listRes);

  const listings = workdayPrefilter(fromWorkdayList(parseJson(listRes.text)), ctx.profile);

  const jobs: Job[] = [];
  for (const listing of listings) {
    const detailRes = await get(`${base}${listing.externalPath}`, ctx.run, ctx.state, ctx.now, {
      minIntervalMs: JOB_WORKDAY_MIN_INTERVAL_MS,
    });
    // null means the budget said no — stop asking rather than loop to the cap.
    if (!detailRes) break;
    if (!detailRes.text) continue;
    const job = fromWorkdayDetail(
      parseJson(detailRes.text),
      listing,
      company,
      `https://${tenant}.${host}.myworkdayjobs.com/${site}${listing.externalPath}`,
      ctx.now,
    );
    if (job) jobs.push(job);
  }
  return jobs;
};

export const FETCHERS: Partial<Record<JobSource['adapter'], Fetcher>> = {
  ycombinator: fetchYc,
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workday: fetchWorkday,
  rss: fetchRss,
  simplify: fetchSimplify,
};
