import { MENTION_EVIDENCE_CHARS } from './constants';
import { paperMatchKey } from './papers';
import { recordingDocUrl, type Recording } from './recordings';
import { scanIdentifiers, type IdentifierMention } from './workResolve';

/**
 * "This recording discusses that paper."
 *
 * The bridge between what you watched and what you read. A recording is the
 * only thing in the library carrying durable long-form text — an article's body
 * and a video's captions are both extracted and thrown away — so it is the only
 * place a paper reference can actually be found rather than guessed at.
 *
 * The payoff is indirect and is the whole reason this works at all: a recording
 * is *already* joined to the video or article it was captured from (see the
 * `video` reason in graphModel.ts). So a video reaches the papers it discusses
 * through the recording that points at it, and no new capture path, storage
 * key, or migration is needed for any of it.
 *
 * Deliberately local-only. A mention resolves against papers already in the
 * library and nothing else: that is the case the graph exists to show ("the two
 * videos I watched about this paper"), it needs no network, no queue and no
 * rate limit, and it cannot be wrong in a way the user cannot see. Identifiers
 * naming papers you do not have are skipped rather than fetched.
 */

export interface PaperMention {
  /** The recording node id */
  from: string;
  /** The paper node id it names */
  to: string;
  /** Which identifier form matched — a DOI is a stronger signal than a PMID */
  kind: IdentifierMention['kind'];
  /**
   * The passage that justified this edge. A transcript segment or a described
   * frame, kept verbatim: an edge the user cannot audit is one they cannot
   * trust, and "why is this here" has to have an answer in the recording's own
   * words.
   */
  evidence: string;
  /** Seconds in, so the evidence can be played back rather than just read */
  atSec: number;
}

/** One passage of a recording that might name a paper, with where it sits. */
interface Passage {
  text: string;
  atSec: number;
}

/**
 * Everything in a recording worth scanning, in time order.
 *
 * Visual descriptions matter more than they look. A spoken arXiv id transcribes
 * badly — "twenty oh six point one one two three nine" is not going to match
 * anything — whereas a slide or a shared screen showing `arXiv:2006.11239` is
 * read verbatim by the vision model. On a recorded talk the frames are usually
 * where the citation actually is.
 */
function passagesOf(recording: Recording): Passage[] {
  const parts: Passage[] = [];
  for (const s of recording.segments) {
    const text = s.text.trim();
    if (text) parts.push({ text, atSec: s.startSec });
  }
  for (const v of recording.visuals ?? []) {
    const text = v.description.trim();
    if (text) parts.push({ text, atSec: v.atSec });
  }
  return parts.sort((a, b) => a.atSec - b.atSec);
}

/**
 * The library key an identifier implies, via the same helper the paper tracker
 * and the reader already use — so a paper named in a transcript is recognised
 * by exactly the rule that recognises it everywhere else.
 */
export function mentionMatchKey(hit: IdentifierMention): string | null {
  if (hit.kind === 'arxiv') return paperMatchKey(`https://arxiv.org/abs/${hit.value}`);
  if (hit.kind === 'doi') return paperMatchKey(`https://doi.org/${hit.value}`);
  return paperMatchKey(`https://pubmed.ncbi.nlm.nih.gov/${hit.value}`);
}

/** The passage around a match, trimmed to something quotable. */
export function evidenceFor(passage: string, at: number, matchLength: number): string {
  if (passage.length <= MENTION_EVIDENCE_CHARS) return passage;

  // Centre the window on the match rather than taking the opening: the useful
  // part of a two-minute segment is the sentence the identifier is in. Clamped
  // at both ends, so a match near either edge still yields a full-width window
  // instead of a short one.
  const slack = Math.max(0, MENTION_EVIDENCE_CHARS - matchLength);
  const end = Math.min(passage.length, Math.max(0, at - Math.floor(slack / 2)) + MENTION_EVIDENCE_CHARS);
  const start = Math.max(0, end - MENTION_EVIDENCE_CHARS);
  const cut = passage.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${cut}${end < passage.length ? '…' : ''}`;
}

/**
 * Every paper in the library named by a recording.
 *
 * One edge per recording-and-paper pair however many times it comes up: a talk
 * returning to the same work six times is one relationship, and six parallel
 * arrows would say nothing extra while making the graph unreadable. The first
 * mention wins, because that is where the paper is usually introduced.
 */
export function paperMentions(
  recordings: readonly Recording[],
  paperNodeByKey: ReadonlyMap<string, string>,
): PaperMention[] {
  const out: PaperMention[] = [];
  if (paperNodeByKey.size === 0) return out;

  for (const recording of recordings) {
    const from = recordingDocUrl(recording.id);
    const linked = new Set<string>();

    for (const passage of passagesOf(recording)) {
      for (const hit of scanIdentifiers(passage.text)) {
        const key = mentionMatchKey(hit);
        const to = key ? paperNodeByKey.get(key) : undefined;
        // Not in the library, or the recording of the paper itself — neither is
        // a relationship worth drawing.
        if (!to || to === from || linked.has(to)) continue;
        linked.add(to);
        out.push({
          from,
          to,
          kind: hit.kind,
          evidence: evidenceFor(passage.text, hit.at, hit.match.length),
          atSec: passage.atSec,
        });
      }
    }
  }

  return out;
}
