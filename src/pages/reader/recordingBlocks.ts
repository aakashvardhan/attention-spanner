import type { ArticleBlock } from '../../shared/articleExtract';
import { formatTimestamp, type Recording, type RecordingVisual } from '../../shared/recordings';

/**
 * A recording rendered as one article-shaped document: summary, then the
 * transcript. Action items live in the reader popup so they stay out of the
 * reading flow. Shaping it this way is what lets the transcript reuse
 * the article reader wholesale — ArticleViewport for highlights and card-making,
 * outlineOf() for navigation, AskPanel for grounded Q&A — instead of growing a
 * third viewport.
 *
 * Each segment is preceded by a heading holding its timestamp, so the outline
 * sidebar becomes a clickable timeline. On a 90-minute lecture that is the
 * difference between a wall of text and something you can move around in.
 */

/** Inline markdown emphasis, removed for the viewport's plain-text blocks. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*[-*]\s+/, '')
    .trim();
}

/**
 * Our own summary markdown → blocks. Deliberately minimal: this parses what
 * transcribe.ts asks the model to produce (## sections, "- " bullets), not
 * markdown in general.
 */
export function summaryBlocks(summary: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  for (const raw of summary.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', text: plain(heading[2]), level: heading[1].length });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push({ kind: 'list', text: plain(line), level: 0 });
      continue;
    }
    blocks.push({ kind: 'para', text: plain(line), level: 0 });
  }
  return blocks.filter((b) => b.text !== '');
}

/** A described frame as one viewport block. Quote styling keeps it visually
 *  distinct from speech without inventing a new block kind. */
function visualBlock(visual: RecordingVisual): ArticleBlock {
  return {
    kind: 'quote',
    text: `On screen at ${formatTimestamp(visual.atSec)} — ${visual.description}`,
    level: 0,
  };
}

export function recordingBlocks(recording: Recording): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];

  if (recording.summary.trim()) {
    blocks.push({ kind: 'heading', text: 'Summary', level: 1 });
    // Summaries cite [mm:ss] markers; say where those point before asking
    // anyone to trust a claim.
    blocks.push({
      kind: 'para',
      text: 'Generated from the transcript; timestamps mark each claim’s source.',
      level: 0,
    });
    blocks.push(...summaryBlocks(recording.summary));
  }

  const spoken = recording.segments.filter((s) => s.text.trim());
  const visuals = recording.visuals ?? [];
  if (spoken.length > 0 || visuals.length > 0) {
    blocks.push({ kind: 'heading', text: 'Transcript', level: 1 });
    // Each visual lands inside the segment whose window holds its timestamp:
    // after that segment's text, before the next heading. Visuals before the
    // first segment (or with no segments at all) lead the transcript.
    let vi = 0;
    while (vi < visuals.length && spoken.length > 0 && visuals[vi].atSec < spoken[0].startSec) {
      blocks.push(visualBlock(visuals[vi]));
      vi++;
    }
    for (let si = 0; si < spoken.length; si++) {
      const segment = spoken[si];
      blocks.push({ kind: 'heading', text: formatTimestamp(segment.startSec), level: 2 });
      blocks.push({ kind: 'para', text: segment.text.trim(), level: 0 });
      const windowEnd = si + 1 < spoken.length ? spoken[si + 1].startSec : Infinity;
      while (vi < visuals.length && visuals[vi].atSec < windowEnd) {
        blocks.push(visualBlock(visuals[vi]));
        vi++;
      }
    }
    // No spoken segments: the loop above never ran, so flush everything.
    while (vi < visuals.length) {
      blocks.push(visualBlock(visuals[vi]));
      vi++;
    }
  }

  return blocks;
}
