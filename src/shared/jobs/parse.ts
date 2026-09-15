import { JOB_DESC_MAX_CHARS } from '../constants';
import type { JobKind, JobRequirements } from '../types';

/**
 * Turning posting text into the few facts the scorer needs. All pure, all
 * regex — no model. "5+ years of experience" is not a task that needs an LLM,
 * and a regex is free, instant, and answerable by a unit test.
 *
 * Everything here biases toward *not* blocking: a missed requirement costs a
 * glance at a job you can't take, while a false blocker greys out one you
 * could. Hence "unstated" is null rather than no, and a posting listing
 * several experience bars is read at its lowest.
 *
 * Service-worker safe: no DOMParser, no textarea-decoding trick.
 */

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  // Last: an entity's own text can contain the others' output, so unescaping
  // &amp; first would turn "&amp;lt;" into "<" instead of "&lt;".
  '&amp;': '&',
};

/** Decode the handful of entities that actually show up in job payloads. */
export function unescapeHtml(input: string): string {
  let out = input;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  // Numeric escapes, which Workday's HTML descriptions use for punctuation
  return out.replace(/&#(\d{1,6});/g, (_, code: string) =>
    String.fromCodePoint(Number(code)),
  );
}

/**
 * HTML job description → plain text, capped. Block tags become line breaks.
 *
 * Two sources, two encodings: Workday returns live HTML, while Greenhouse
 * returns its `content` field with the markup itself entity-escaped, so its
 * tags are still text at this point. Decoding up front is only safe when there
 * are no live tags to protect — otherwise a description containing "if a &lt; b"
 * would decode into something the tag stripper then eats.
 */
export function stripHtml(input: string): string {
  const html = /<[a-z!/][^>]*>/i.test(input) ? input : unescapeHtml(input);
  return unescapeHtml(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, JOB_DESC_MAX_CHARS);
}

/**
 * A years-of-experience number, but only where it is plainly a requirement.
 * The bare number is worthless on its own — "founded 5 years ago" and "5+
 * years of experience" differ only in the words around them — so a match has
 * to either be followed by "experience"/"industry" or introduced by
 * "minimum"/"at least"/"requires".
 */
const YEARS = /(\d{1,2})\s*(?:\+|\s*-\s*\d{1,2}|\s+or\s+more)?\s*(?:\+\s*)?years?/gi;
const WANTS_AFTER = /^[\s,)]*(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|work\s+|hands-on\s+)*(?:experience|industry)/i;
const WANTS_BEFORE = /(?:minimum(?:\s+of)?|at\s+least|requires?|must\s+have)\s*$/i;

/**
 * The lowest experience bar the posting states, or null when it states none.
 * Lowest, not highest: a posting asking "2+ years backend, 5+ years leading
 * teams" is describing one role's spread, and reading it at 5 would block a
 * job that is genuinely open.
 */
export function parseMinYears(text: string): number | null {
  let lowest: number | null = null;
  for (const match of text.matchAll(YEARS)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 24), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 40);
    if (!WANTS_AFTER.test(after) && !WANTS_BEFORE.test(before)) continue;
    const years = Number(match[1]);
    if (!Number.isFinite(years) || years > 40) continue;
    if (lowest === null || years < lowest) lowest = years;
  }
  return lowest;
}

const NO_SPONSOR =
  /(?:not?|unable|cannot|can't|does\s+not|will\s+not|are\s+not\s+able)\s+(?:to\s+)?(?:be\s+able\s+to\s+)?(?:offer|provide|consider)?\s*(?:visa\s+|immigration\s+)?sponsor|sponsorship\s+is\s+not|without\s+(?:visa\s+)?sponsorship|no\s+(?:visa\s+)?sponsorship/i;
const WILL_SPONSOR =
  /will\s+sponsor|sponsorship\s+(?:is\s+)?(?:available|provided|offered)|(?:we|do)\s+sponsor|open\s+to\s+sponsor/i;

/** true = sponsors, false = explicitly won't, null = doesn't say. */
export function parseSponsorship(text: string): boolean | null {
  // Negatives first: "will not provide visa sponsorship" contains "sponsor".
  if (NO_SPONSOR.test(text)) return false;
  if (WILL_SPONSOR.test(text)) return true;
  return null;
}

const CITIZENSHIP =
  /\b(?:u\.?s\.?|united\s+states)\s+(?:citizen|person)|\bcitizenship\s+(?:is\s+)?required|\bmust\s+be\s+a\s+(?:u\.?s\.?\s+)?citizen|security\s+clearance|\bTS\/SCI\b/i;
/** "US citizenship/visa not required" must not read as a citizenship demand. */
const CITIZENSHIP_NEGATED = /(?:citizenship|clearance)[^.\n]{0,30}\bnot\s+required/i;

export function parseCitizenship(text: string): boolean {
  if (CITIZENSHIP_NEGATED.test(text)) return false;
  return CITIZENSHIP.test(text);
}

const INTERN = /\bintern(?:ship)?\b|\bco-?op\b|\bsummer\s+20\d\d\b/i;
const RESEARCH = /\bresearch\s+(?:scientist|engineer|intern|assistant|fellow)\b|\bphd\b|\bpostdoc/i;
const NEW_GRAD =
  /\bnew\s*grad(?:uate)?\b|\bentry[\s-]level\b|\buniversity\s+grad|\bcampus\s+hire\b|\bearly\s+career\b|\bgraduate\s+(?:program|engineer|role)\b|\b(?:engineer|developer|scientist)\s+i\b|\bassociate\s+(?:software|data|research)/i;

const SENIOR = /\b(?:senior|sr\.?|staff|principal|lead|head\s+of|director|vp|distinguished|manager)\b/i;

/**
 * Does the title claim seniority? YC lets a company tag a Staff role "Any (new
 * grads ok)", and taking that flag at face value would file a staff opening
 * under new-grad. Eligibility and stage are different questions: the flag
 * answers who may apply, the title answers what the job is.
 */
export function hasSeniorityMarker(title: string): boolean {
  return SENIOR.test(title);
}

/**
 * Which bucket a posting falls in, from its title (plus whatever short
 * subtitle a source gives). Research wins over intern: a "Research Intern" is
 * the research pipeline, which is what you're actually filtering for.
 */
export function jobKindFromTitle(title: string, extra = ''): JobKind {
  const text = `${title} ${extra}`;
  if (RESEARCH.test(text)) return 'research';
  if (INTERN.test(text)) return 'internship';
  if (NEW_GRAD.test(text)) return 'new-grad';
  return 'other';
}

/**
 * What a plain-text description states. Sources that hand over structured
 * fields (YC) build their own JobRequirements and never call this.
 *
 * `skills` stays empty here by design: pulling a skill list out of prose is
 * the one part that genuinely wants a model, and it arrives in Phase 3. Skill
 * scoring meanwhile matches the profile's own list against the description,
 * which needs no extraction at all.
 */
export function requirementsFromText(text: string): JobRequirements {
  return {
    skills: [],
    minYears: parseMinYears(text),
    sponsors: parseSponsorship(text),
    requiresCitizenship: parseCitizenship(text),
    mustHaves: [],
  };
}

function fnv1a(input: string, basis: number): number {
  let hash = basis;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A posting's stable id. Two FNV-1a passes in opposite orders over a
 * NUL-joined key, for the reasons generateItemId documents in rssParser.ts:
 * base64 truncation collided across a whole site, and btoa throws outside
 * Latin-1. Kept here rather than imported so the jobs page doesn't pull
 * fast-xml-parser in with it.
 *
 * Keyed on the posting URL plus company and title, so the same role re-fetched
 * tomorrow merges instead of duplicating — which is what makes YC's rotating
 * sample accumulate rather than pile up.
 */
export function hash64(input: string): string {
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(fnv1a(input, 0x811c9dc5)) + hex(fnv1a([...input].reverse().join(''), 0x9dc5811c));
}

export function jobId(company: string, title: string, url: string): string {
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const key = `${url} ${company} ${title}`.toLowerCase();
  const flipped = `${title} ${company} ${url}`.toLowerCase();
  return hex(fnv1a(key, 0x811c9dc5)) + hex(fnv1a(flipped, 0x9dc5811c));
}
