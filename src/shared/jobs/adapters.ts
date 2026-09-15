import type { Job, JobKind, JobRequirements, JobSourceId } from '../types';
import {
  hasSeniorityMarker,
  jobId,
  jobKindFromTitle,
  requirementsFromText,
  stripHtml,
  unescapeHtml,
} from './parse';

/**
 * Source payload → Job. Pure, so every one of these is testable against a
 * saved response without a network or a service worker.
 *
 * Everything here is defensive about shape. These are third-party payloads —
 * two of the five endpoints are undocumented — so a missing or retyped field
 * has to drop one posting, never throw and sink the whole run.
 */

/* Narrow readers. `unknown` in, a usable value or a default out. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown): string[] => list(v).map(str).filter(Boolean);

/** Millis from an ISO date or epoch-millis number; null when unparseable. */
function toEpoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** "US / Remote (US)" and "Boston, MA, US" both become usable location lists. */
function splitLocations(raw: string): string[] {
  return raw
    .split(/\s*[/;|]\s*|\s+or\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isRemote(raw: string): boolean | null {
  if (/\bremote\b/i.test(raw)) return true;
  if (/\bon-?site\b|\bin-?office\b|\bhybrid\b/i.test(raw)) return false;
  return null;
}

function build(
  source: JobSourceId,
  fields: {
    company: string;
    title: string;
    locations: string[];
    remote: boolean | null;
    url: string;
    applyUrl?: string;
    postedAt: number | null;
    description: string;
    kind: JobKind;
    requirements: JobRequirements | null;
  },
  now: number,
): Job {
  return {
    id: jobId(fields.company, fields.title, fields.url),
    source,
    company: fields.company,
    title: fields.title,
    locations: fields.locations,
    remote: fields.remote,
    url: fields.url,
    applyUrl: fields.applyUrl || fields.url,
    postedAt: fields.postedAt,
    description: fields.description,
    kind: fields.kind,
    status: 'new',
    requirements: fields.requirements,
    score: null,
    capturedAt: now,
    updatedAt: now,
  };
}

/* ---------------------------------------------------------------- Y Combinator */

/**
 * Pull the Inertia page props out of a YC jobs page. The whole page state ships
 * as HTML-escaped JSON in one attribute, so this is a read of published data
 * rather than a scrape of rendered markup — the same move
 * `extractPlayerResponse` makes in youtubeCaptions.ts, and it returns null on
 * anything unexpected for the same reason.
 *
 * The attribute is entity-escaped, so its value can hold no raw `"` and
 * `[^"]*` is a safe delimiter without the brace-matching that file needs.
 */
export function extractDataPage(html: string): Record<string, unknown> | null {
  const match = /data-page="([^"]*)"/.exec(html);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(unescapeHtml(match[1]));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * YC's `minExperience` is a display string, and the new-grad case is the one
 * that matters: "Any (new grads ok)" is an explicit zero, not an absent value,
 * which is why it clears the years blocker instead of merely not tripping it.
 */
export function ycMinYears(minExperience: string): number | null {
  if (/any|new\s*grad/i.test(minExperience)) return 0;
  const match = /(\d{1,2})/.exec(minExperience);
  return match ? Number(match[1]) : null;
}

/**
 * YC's three verified `visa` values. "US citizen/visa only" means you must
 * already hold work authorization, so it reads as "won't sponsor" — but
 * deliberately NOT as `requiresCitizenship`, which would wrongly block a green
 * card holder. The sponsorship filter already catches the case that matters.
 */
export function ycSponsors(visa: string): boolean | null {
  if (/will\s+sponsor/i.test(visa)) return true;
  if (/only/i.test(visa)) return false;
  return null;
}

export function fromYc(payload: unknown, now: number): Job[] {
  const postings = list(rec(rec(payload).props).jobPostings);
  const jobs: Job[] = [];
  for (const raw of postings) {
    const p = rec(raw);
    const title = str(p.title);
    const company = str(p.companyName);
    const path = str(p.url);
    if (!title || !company || !path) continue;

    const location = str(p.location);
    const minExperience = str(p.minExperience);
    const minYears = ycMinYears(minExperience);
    const batch = str(p.companyBatchName);
    const oneLiner = str(p.companyOneLiner);
    const salary = str(p.salaryRange);

    // Stage from the title; eligibility from minYears. A "Staff Software
    // Engineer" tagged new-grads-ok is a staff job with a generous filter,
    // and filing it under new-grad would be believing the wrong field.
    let kind = jobKindFromTitle(title);
    if (kind === 'other' && minYears === 0 && !hasSeniorityMarker(title)) kind = 'new-grad';

    jobs.push(
      build(
        'ycombinator',
        {
          company,
          title,
          locations: splitLocations(location),
          remote: isRemote(location),
          // The listing carries only relative strings ("3 days"), so there is
          // no honest absolute date to record here.
          postedAt: null,
          url: `https://www.ycombinator.com${path}`,
          applyUrl: str(p.applyUrl),
          description: [
            oneLiner && `${company}${batch ? ` (${batch})` : ''} — ${oneLiner}`,
            salary && `Salary ${salary}`,
            minExperience && `Experience: ${minExperience}`,
          ]
            .filter(Boolean)
            .join('\n'),
          kind,
          requirements: {
            skills: strList(p.skills),
            minYears,
            sponsors: ycSponsors(str(p.visa)),
            requiresCitizenship: false,
            mustHaves: [],
          },
        },
        now,
      ),
    );
  }
  return jobs;
}

/* ------------------------------------------------------------------ Greenhouse */

export function fromGreenhouse(payload: unknown, company: string, now: number): Job[] {
  return list(rec(payload).jobs).flatMap((raw) => {
    const p = rec(raw);
    const title = str(p.title);
    const url = str(p.absolute_url);
    if (!title || !url) return [];
    const location = str(rec(p.location).name);
    // `content` is HTML and entity-escaped on top of that; stripHtml handles both.
    const description = stripHtml(str(p.content));
    return [
      build(
        'greenhouse',
        {
          company,
          title,
          locations: splitLocations(location),
          remote: isRemote(`${location} ${title}`),
          url,
          postedAt: toEpoch(p.first_published) ?? toEpoch(p.updated_at),
          description,
          kind: jobKindFromTitle(title),
          requirements: description ? requirementsFromText(description) : null,
        },
        now,
      ),
    ];
  });
}

/* ----------------------------------------------------------------------- Lever */

export function fromLever(payload: unknown, company: string, now: number): Job[] {
  return list(payload).flatMap((raw) => {
    const p = rec(raw);
    const title = str(p.text);
    const url = str(p.hostedUrl);
    if (!title || !url) return [];
    const categories = rec(p.categories);
    const location = str(categories.location);
    const workplace = str(p.workplaceType);
    const description = str(p.descriptionPlain).slice(0, 8000);
    return [
      build(
        'lever',
        {
          company,
          title,
          locations: splitLocations(location),
          remote: isRemote(`${workplace} ${location}`),
          url,
          applyUrl: str(p.applyUrl),
          postedAt: num(p.createdAt),
          description,
          kind: jobKindFromTitle(title, str(categories.commitment)),
          requirements: description ? requirementsFromText(description) : null,
        },
        now,
      ),
    ];
  });
}

/* ----------------------------------------------------------------------- Ashby */

export function fromAshby(payload: unknown, company: string, now: number): Job[] {
  return list(rec(payload).jobs).flatMap((raw) => {
    const p = rec(raw);
    const title = str(p.title);
    const url = str(p.jobUrl) || str(p.applyUrl);
    if (!title || !url) return [];
    // Ashby ships unlisted postings in the same array; they are not open.
    if (p.isListed === false) return [];
    const location = str(p.location);
    const description = stripHtml(str(p.descriptionHtml)) || str(p.descriptionPlain);
    return [
      build(
        'ashby',
        {
          company,
          title,
          locations: splitLocations(location),
          remote: typeof p.isRemote === 'boolean' ? p.isRemote : isRemote(location),
          url,
          applyUrl: str(p.applyUrl),
          postedAt: toEpoch(p.publishedAt),
          description,
          kind: jobKindFromTitle(title, str(p.employmentType)),
          requirements: description ? requirementsFromText(description) : null,
        },
        now,
      ),
    ];
  });
}

/* --------------------------------------------------------------------- Workday */

/* -------------------------------------------------------------- SimplifyJobs */

/** One row of the SimplifyJobs listings.json, as verified against the live file. */
export interface SimplifyEntry {
  company_name: string;
  title: string;
  url: string;
  locations: string[];
  /** Epoch SECONDS, not millis — the one field here that bites */
  date_posted: number;
  active: boolean;
  is_visible: boolean;
  category: string;
  sponsorship: string;
  degrees: string[];
}

export function toSimplifyEntries(payload: unknown): SimplifyEntry[] {
  return list(payload).flatMap((raw) => {
    const p = rec(raw);
    const title = str(p.title);
    const url = str(p.url);
    if (!title || !url) return [];
    return [
      {
        company_name: str(p.company_name),
        title,
        url,
        locations: strList(p.locations),
        date_posted: num(p.date_posted) ?? 0,
        active: p.active === true,
        is_visible: p.is_visible !== false,
        category: str(p.category),
        sponsorship: str(p.sponsorship),
        degrees: strList(p.degrees),
      },
    ];
  });
}

/**
 * Which of 18,000 rows are worth turning into records.
 *
 * The file is a full history, not a current board: only ~2,700 entries are
 * `active`, and even the recent slice of those runs to ~2,000 — more than the
 * whole board is meant to hold. Left uncapped this one source would evict
 * every other. So: drop the closed and hidden ones, drop the stale, keep what
 * the profile actually wants, then take the newest N.
 *
 * Pure, and exported, so the cut is a test rather than a hope.
 */
export function simplifyPrefilter(
  entries: SimplifyEntry[],
  profile: { roleFamilies: string[]; kinds: string[] },
  now: number,
  staleDays: number,
  limit: number,
): SimplifyEntry[] {
  const cutoff = (now - staleDays * 24 * 60 * 60 * 1000) / 1000;
  return entries
    .filter((entry) => entry.active && entry.is_visible && entry.date_posted >= cutoff)
    .filter((entry) => {
      // A seniority marker here means the row is mis-filed; these feeds are
      // new-grad and internship boards by construction.
      if (hasSeniorityMarker(entry.title)) return false;
      if (profile.roleFamilies.length === 0) return true;
      const haystack = `${entry.title} ${entry.category}`.toLowerCase();
      return profile.roleFamilies.some((family) => haystack.includes(family.toLowerCase()));
    })
    .sort((a, b) => b.date_posted - a.date_posted)
    .slice(0, limit);
}

/**
 * `sponsorship` is a controlled vocabulary, but an uninformative one — 1,971 of
 * 1,972 recent rows say "Other". Only the explicit refusals carry signal, so
 * everything else stays null rather than being read as permission or denial.
 */
export function simplifySponsorship(value: string): {
  sponsors: boolean | null;
  requiresCitizenship: boolean;
} {
  if (/citizen/i.test(value)) return { sponsors: false, requiresCitizenship: true };
  if (/does not offer/i.test(value)) return { sponsors: false, requiresCitizenship: false };
  if (/offers sponsorship/i.test(value)) return { sponsors: true, requiresCitizenship: false };
  return { sponsors: null, requiresCitizenship: false };
}

/**
 * `feedKind` is what the repo is (new-grad or internship). The title still
 * wins when it says something more specific — a PhD research posting in the
 * new-grad feed is a research role.
 */
export function fromSimplify(
  entries: SimplifyEntry[],
  feedKind: JobKind,
  now: number,
): Job[] {
  return entries.map((entry) => {
    const titled = jobKindFromTitle(entry.title);
    const phd = entry.degrees.some((degree) => /phd/i.test(degree));
    return build(
      'simplify',
      {
        company: entry.company_name,
        title: entry.title,
        locations: entry.locations,
        remote: isRemote(entry.locations.join(' ')),
        url: entry.url,
        // Seconds → millis. Left raw this reads as January 1970 and every
        // posting scores zero on freshness.
        postedAt: entry.date_posted > 0 ? entry.date_posted * 1000 : null,
        description: [entry.category, entry.degrees.join(', ')].filter(Boolean).join(' · '),
        kind: titled !== 'other' ? titled : phd ? 'research' : feedKind,
        requirements: {
          skills: [],
          // These are new-grad and internship boards; the bar is zero by
          // construction, which is exactly what clears the years blocker.
          minYears: 0,
          mustHaves: [],
          ...simplifySponsorship(entry.sponsorship),
        },
      },
      now,
    );
  });
}

/* ------------------------------------------------------------------------- RSS */

/**
 * A feed item as a posting. This is the research-role path: university HR
 * boards and lab pages publish RSS, and adding one is just a URL.
 *
 * A feed entry is thin by nature — a title, a link and a date, with at most a
 * 200-character snippet. So `requirements` stays null rather than being
 * guessed from a summary: an experience bar read out of two sentences of
 * marketing copy would be a blocker built on nothing.
 */
export function fromRss(
  items: { title: string; link: string; pubDate: string; snippet: string; source: string }[],
  company: string,
  now: number,
): Job[] {
  return items.flatMap((item) => {
    if (!item.title || !item.link) return [];
    return [
      build(
        'rss',
        {
          company: company || item.source,
          title: item.title,
          locations: [],
          remote: isRemote(`${item.title} ${item.snippet}`),
          url: item.link,
          postedAt: toEpoch(item.pubDate),
          description: item.snippet,
          kind: jobKindFromTitle(item.title, item.snippet),
          requirements: null,
        },
        now,
      ),
    ];
  });
}

/**
 * The board token, from either a bare token or a pasted job-board URL.
 *
 * "Board token" is the vendor's word, not a thing anyone knows offhand — but
 * it is always the first path segment of the board's own URL, so pasting the
 * link you were already looking at is enough. A bare token is passed through
 * so nothing breaks for someone who does know it.
 */
const BOARD_HOSTS: Record<string, RegExp> = {
  greenhouse: /(?:^|\.)greenhouse\.io$/i,
  lever: /(?:^|\.)lever\.co$/i,
  ashby: /(?:^|\.)ashbyhq\.com$/i,
};

export function parseBoardToken(adapter: string, input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const host = BOARD_HOSTS[adapter];
  // A URL for some other ATS is a mistake worth surfacing, not one to paper
  // over by turning the hostname into a token that will 404 later.
  if (!host || !host.test(url.hostname)) return '';

  const segments = url.pathname.split('/').filter(Boolean);
  // Greenhouse embeds sometimes read /embed/job_board?for=<token>
  const embedded = url.searchParams.get('for');
  if (embedded) return embedded;
  return segments[0] ?? '';
}

/**
 * Pull the three fields a Workday source needs out of a pasted careers URL.
 * Nobody knows their tenant's `wd` number off the top of their head, and it
 * varies per company — but it is right there in the address bar.
 *
 *   https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/…
 *          └tenant┘ └host┘                └locale┘└─────── site ───────┘
 */
export function parseWorkdayUrl(
  input: string,
): { tenant: string; host: string; site: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const hostMatch = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(url.hostname);
  if (!hostMatch) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  // Workday prefixes an optional locale ("en-US", "fr-FR") ahead of the site.
  const site = segments.find((segment) => !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(segment));
  if (!site) return null;
  return { tenant: hostMatch[1].toLowerCase(), host: hostMatch[2].toLowerCase(), site };
}

/** One row of a Workday list response, before the detail fetch fills it in. */
export interface WorkdayListing {
  title: string;
  externalPath: string;
  locationsText: string;
}

export function fromWorkdayList(payload: unknown): WorkdayListing[] {
  return list(rec(payload).jobPostings).flatMap((raw) => {
    const p = rec(raw);
    const title = str(p.title);
    const externalPath = str(p.externalPath);
    if (!title || !externalPath) return [];
    return [{ title, externalPath, locationsText: str(p.locationsText) }];
  });
}

/**
 * A Workday detail response. `postedOn` on the listing is the string "Posted
 * 30+ Days Ago" and useless as a date — `startDate` on the detail is the only
 * real one, which is why a Workday job has no `postedAt` until it is fetched.
 */
export function fromWorkdayDetail(
  payload: unknown,
  listing: WorkdayListing,
  company: string,
  fallbackUrl: string,
  now: number,
): Job | null {
  const info = rec(rec(payload).jobPostingInfo);
  const title = str(info.title) || listing.title;
  const url = str(info.externalUrl) || fallbackUrl;
  if (!title || !url) return null;
  const location = str(info.location) || listing.locationsText;
  // The service worker has no DOMParser, so this is a regex strip by necessity
  // as much as by preference — see stripHtml.
  const description = stripHtml(str(info.jobDescription));
  return build(
    'workday',
    {
      company,
      title,
      locations: splitLocations(location),
      remote: isRemote(`${location} ${title}`),
      url,
      postedAt: toEpoch(info.startDate),
      description,
      kind: jobKindFromTitle(title, str(info.timeType)),
      requirements: description ? requirementsFromText(description) : null,
    },
    now,
  );
}
