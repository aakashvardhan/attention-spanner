import type { Job, JobProfile, JobScore } from '../types';
import { hash64 } from './parse';

/**
 * Ranking a posting against the profile. Two stages, both deterministic and
 * both explainable: hard filters produce `blockers`, everything else produces
 * `parts` that sum to `total`.
 *
 * Nothing here is opaque on purpose. The board has to be able to answer "why
 * is this at the top" — the moment it can't, you stop trusting the order and
 * the whole thing is just a list.
 *
 * A blocked job still scores and still renders, greyed, with its reason. The
 * filters are regexes over prose written by someone in a hurry; the cost of a
 * wrong one should be a glance, never a job you never saw.
 */

/** Changing any of these invalidates every cached score. */
export function profileHash(profile: JobProfile): string {
  return hash64(
    JSON.stringify([
      [...profile.skills].sort(),
      [...profile.roleFamilies].sort(),
      [...profile.kinds].sort(),
      [...profile.locations].sort(),
      [...profile.watchlist].sort(),
      profile.maxYearsRequired,
      profile.needsSponsorship,
      profile.usCitizen,
    ]),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `+`, `#` and `.` survive so "c++", "c#" and "node.js" stay single terms.
 * The second pass then drops a dot that isn't joining two characters — without
 * it a sentence-ending "Python." never matches the skill "python".
 */
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\.+(?![a-z0-9])/g, ' ')} `;
}

/**
 * Is this term present as a term? A plain `includes` says yes to "go" inside
 * "category", and fuzzyScore's subsequence tier says yes to "sql" inside
 * "specialist queue logic" — both are false skill hits that inflate a score
 * with evidence the posting never gave. Padded word boundaries instead.
 */
export function hasTerm(haystack: string, term: string): boolean {
  const needle = normalize(term).trim();
  if (!needle) return false;
  return normalize(haystack).includes(` ${needle} `);
}

function countMatches(haystack: string, terms: string[]): string[] {
  return terms.filter((term) => hasTerm(haystack, term));
}

export function scoreJob(job: Job, profile: JobProfile, now: number): JobScore {
  const req = job.requirements;
  const haystack = `${job.title} ${job.company} ${job.description} ${req?.skills.join(' ') ?? ''}`;

  /* Hard filters. Each reads "unstated" as permission, never as refusal. */
  const blockers: string[] = [];
  if (req?.minYears != null && req.minYears > profile.maxYearsRequired) {
    blockers.push(`Wants ${req.minYears}+ years`);
  }
  if (profile.needsSponsorship && req?.sponsors === false) {
    blockers.push('Will not sponsor');
  }
  if (!profile.usCitizen && req?.requiresCitizenship) {
    blockers.push('Requires US citizenship or clearance');
  }
  if (
    profile.locations.length > 0 &&
    job.remote !== true &&
    job.locations.length > 0 &&
    !job.locations.some((loc) => profile.locations.some((want) => hasTerm(loc, want)))
  ) {
    blockers.push(`Not in ${profile.locations.join(', ')}`);
  }

  const parts: JobScore['parts'] = [];

  // Skills — the profile's own list matched against the posting. No extraction
  // needed: we're asking "does this posting mention what I can evidence".
  const skillHits = countMatches(haystack, profile.skills);
  parts.push({
    label: 'Skills',
    points: profile.skills.length === 0 ? 0 : Math.round((skillHits.length / profile.skills.length) * 35),
    max: 35,
    why:
      profile.skills.length === 0
        ? 'No skills set in your profile'
        : skillHits.length === 0
          ? 'None of your skills appear'
          : `Matches ${skillHits.join(', ')}`,
  });

  // Role family — in the title it's the job; in the body it's context.
  const titleHits = countMatches(job.title, profile.roleFamilies);
  const bodyHits = countMatches(job.description, profile.roleFamilies);
  parts.push({
    label: 'Role',
    points: titleHits.length > 0 ? 25 : bodyHits.length > 0 ? 12 : 0,
    max: 25,
    why:
      titleHits.length > 0
        ? `Title matches ${titleHits.join(', ')}`
        : bodyHits.length > 0
          ? `Mentioned in the description only`
          : profile.roleFamilies.length === 0
            ? 'No target roles set in your profile'
            : 'No target role matched',
  });

  parts.push({
    label: 'Stage',
    points: profile.kinds.includes(job.kind) ? 15 : 0,
    max: 15,
    why: profile.kinds.includes(job.kind) ? `A ${job.kind} role` : `A ${job.kind} role, which you filtered out`,
  });

  // Freshness. An unknown date scores mid rather than zero: YC and Workday
  // both withhold it on the listing, and punishing that would bury two whole
  // sources behind whichever one happens to publish timestamps.
  const ageDays = job.postedAt == null ? null : Math.floor((now - job.postedAt) / DAY_MS);
  parts.push({
    label: 'Fresh',
    points: ageDays == null ? 5 : ageDays <= 7 ? 10 : ageDays <= 30 ? 7 : ageDays <= 60 ? 3 : 0,
    max: 10,
    why: ageDays == null ? 'Posting date unknown' : ageDays <= 1 ? 'Posted today' : `Posted ${ageDays}d ago`,
  });

  const watched = profile.watchlist.some((company) => hasTerm(job.company, company));
  parts.push({
    label: 'Company',
    points: watched ? 10 : 0,
    max: 10,
    why: watched ? `${job.company} is on your watchlist` : 'Not on your watchlist',
  });

  // Corpus coverage arrives with the writing bank in Phase 2. Scored as a
  // visible zero rather than dropped, so a score stays out of 100 and the
  // board doesn't silently change scale when the corpus lands.
  parts.push({
    label: 'Evidence',
    points: 0,
    max: 5,
    why: 'Your writing corpus arrives in Phase 2',
  });

  return {
    total: parts.reduce((sum, part) => sum + part.points, 0),
    parts,
    blockers,
    computedAt: now,
    profileHash: profileHash(profile),
  };
}

/** Recompute only what's stale — a re-score of 1000 jobs is otherwise free but pointless. */
export function needsRescore(job: Job, hash: string): boolean {
  return job.score === null || job.score.profileHash !== hash;
}

/**
 * Board order: blocked jobs sink below everything clear, and within each group
 * the higher score wins. Sinking rather than hiding is the whole point — you
 * can still scroll to a job the regex misjudged.
 */
export function compareJobs(a: Job, b: Job): number {
  const blockedA = (a.score?.blockers.length ?? 0) > 0 ? 1 : 0;
  const blockedB = (b.score?.blockers.length ?? 0) > 0 ? 1 : 0;
  if (blockedA !== blockedB) return blockedA - blockedB;
  return (b.score?.total ?? 0) - (a.score?.total ?? 0);
}
