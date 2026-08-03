import type { SourceRef } from '../tools';

/**
 * Making a fabricated citation impossible rather than merely discouraged.
 *
 * The prompt already asks the model not to invent sources (see PERSONA), but a
 * prompt is a request. The guarantee here is structural: the model may only
 * REFERENCE ids that the loop minted from real tool return values, and every
 * marker is resolved against that table before the answer is shown. An id that
 * does not exist cannot be rendered, so `[S7]` in a turn that gathered three
 * sources is removed rather than displayed as a plausible-looking citation.
 *
 * The bare-URL guard closes the hole markers alone leave open. Nothing stops a
 * model writing `https://arxiv.org/abs/2406.09246` inline, and a URL that looks
 * right is the most convincing possible fabrication — so any link whose target
 * is not in the source table is stripped to its text.
 *
 * What this does NOT do, and should not be described as doing: it cannot tell
 * whether S1 actually supports the sentence it is attached to. That is a
 * relevance error, not an invention. The hover snippet is the mitigation — the
 * user checks the claim in one glance. This guarantees provenance, not accuracy.
 */

export interface ResolvedAnswer {
  /** The answer with valid citations linked and invalid ones removed */
  text: string;
  /** Sources the answer actually cited, in id order */
  cited: SourceRef[];
  /** Citation markers that referenced nothing — a fabrication attempt */
  fabricated: number;
  /** Links to somewhere no tool ever returned */
  strippedUrls: number;
}

/** `[S1]`, `[S12]` — the citation marker the loop asks for */
const MARKER_RE = /\[S(\d+)\]/g;
/** A markdown link, so an unverifiable target can be reduced to its text */
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
/** A bare URL the model typed out */
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s<>()[\]]+/g;

/** Trailing punctuation belongs to the sentence, not the URL */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '');
}

/**
 * Resolve citations against the sources this turn actually gathered.
 *
 * Order matters: markers are linked first so the links they produce are already
 * trusted by the time the URL guard runs, otherwise the guard would strip the
 * very links this function just created.
 */
export function resolveCitations(
  answer: string,
  sources: readonly SourceRef[],
): ResolvedAnswer {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const allowed = new Set(sources.map((s) => trimUrl(s.url)).filter(Boolean));
  const citedIds = new Set<string>();
  let fabricated = 0;
  let strippedUrls = 0;

  let text = answer.replace(MARKER_RE, (marker, n: string) => {
    const source = byId.get(`S${n}`);
    if (!source) {
      // Referenced something that was never looked up — drop it silently in the
      // prose (the count is what surfaces the problem to the caller).
      fabricated++;
      return '';
    }
    citedIds.add(source.id);
    // Local evidence (tasks, memory, counters) is real but has nowhere useful
    // to navigate. Keep its source marker visible without manufacturing a link.
    return source.url ? `[${marker}](${source.url})` : marker;
  });

  text = text.replace(MD_LINK_RE, (whole, label: string, url: string) => {
    if (allowed.has(trimUrl(url))) return whole;
    strippedUrls++;
    // Keep what the sentence said, lose the claim about where it came from.
    return label;
  });

  text = text.replace(BARE_URL_RE, (url: string) => {
    if (allowed.has(trimUrl(url))) return url;
    strippedUrls++;
    return '[link removed — not from a source I checked]';
  });

  return {
    text: text.replace(/ {2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1'),
    cited: sources.filter((s) => citedIds.has(s.id)),
    fabricated,
    strippedUrls,
  };
}

/**
 * The instruction that makes the ids usable. Only included when the turn has
 * something to cite — telling a model to cite when nothing was looked up is an
 * invitation to invent an id.
 */
export function buildCitationRule(sources: readonly SourceRef[]): string {
  if (sources.length === 0) return '';
  return (
    '\n\nEach observation lists the source ids it came from. Cite them inline as ' +
    '[S1], [S2] when you state something they support. Cite ONLY ids that appear ' +
    'in the observations above — never invent one, and never write a URL of your ' +
    'own. If nothing you looked up supports a claim, say so instead of citing.'
  );
}

/** "Sources" footer listing only what the answer actually cited */
export function renderSourceList(cited: readonly SourceRef[]): string {
  if (cited.length === 0) return '';
  const lines = cited.map((s) =>
    s.url ? `- [${s.id}] [${s.title}](${s.url})` : `- [${s.id}] ${s.title}`,
  );
  return `\n\n## Sources\n${lines.join('\n')}`;
}
