import { describe, expect, it } from 'vitest';
import { evidenceFor, mentionMatchKey, paperMentions } from './paperMentions';
import { paperMatchKey } from './papers';
import type { Recording, RecordingVisual, TranscriptSegment } from './recordings';

const NOW = 1_700_000_000_000;

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'r1',
    title: 'A talk',
    source: { kind: 'mic' },
    startedAt: NOW,
    durationSeconds: 600,
    status: 'ready',
    segments: [],
    summary: '',
    actionItems: [],
    error: '',
    updatedAt: NOW,
    ...over,
  };
}

function segment(text: string, startSec = 0): TranscriptSegment {
  return { startSec, endSec: startSec + 30, text };
}

function visual(description: string, atSec = 0): RecordingVisual {
  return { atSec, kind: 'auto', description };
}

/** The library, keyed the way buildGraph keys it. */
const OWNED = new Map([
  [paperMatchKey('https://arxiv.org/abs/2006.11239')!, 'paper:ddpm'],
  [paperMatchKey('https://doi.org/10.1038/s41586-020-2012-7')!, 'paper:covid'],
]);

describe('mentionMatchKey', () => {
  it('keys an arXiv id the same way the library does', () => {
    const key = mentionMatchKey({ kind: 'arxiv', value: '2006.11239', at: 0, match: '' });

    expect(key).toBe(paperMatchKey('https://arxiv.org/abs/2006.11239'));
  });

  it('keys a DOI the same way the library does', () => {
    const key = mentionMatchKey({ kind: 'doi', value: '10.1038/s41586-020-2012-7', at: 0, match: '' });

    expect(key).toBe(paperMatchKey('https://doi.org/10.1038/s41586-020-2012-7'));
  });
});

describe('paperMentions', () => {
  it('links a recording to a paper its transcript names', () => {
    const found = paperMentions(
      [recording({ segments: [segment('the key result is in arXiv:2006.11239 if you want it', 90)] })],
      OWNED,
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ from: 'recording:r1', to: 'paper:ddpm', kind: 'arxiv', atSec: 90 });
  });

  /**
   * Where the reference usually actually is. A spoken arXiv id transcribes as
   * "twenty oh six point one one two three nine" and matches nothing; a slide
   * showing it is read verbatim by the vision model.
   */
  it('reads an identifier off a described frame, not just the audio', () => {
    const found = paperMentions(
      [
        recording({
          segments: [segment('as you can see on this slide', 0)],
          visuals: [visual('A title slide reading "Denoising Diffusion" with arXiv:2006.11239', 12)],
        }),
      ],
      OWNED,
    );

    expect(found).toMatchObject([{ to: 'paper:ddpm', atSec: 12 }]);
  });

  it('carries the passage that justified it', () => {
    const line = 'compare that against 10.1038/s41586-020-2012-7 from early 2020';
    const found = paperMentions([recording({ segments: [segment(line)] })], OWNED);

    expect(found[0].evidence).toBe(line);
    expect(found[0].to).toBe('paper:covid');
  });

  // A talk returning to the same work six times is one relationship. Six
  // parallel arrows would say nothing extra and make the graph unreadable.
  it('draws one edge however often a paper comes up', () => {
    const found = paperMentions(
      [
        recording({
          segments: [
            segment('starting from arXiv:2006.11239', 0),
            segment('back to arXiv:2006.11239 again', 60),
            segment('and arxiv.org/abs/2006.11239 once more', 120),
          ],
        }),
      ],
      OWNED,
    );

    expect(found).toHaveLength(1);
    // The first mention wins, because that is where the paper gets introduced.
    expect(found[0].atSec).toBe(0);
  });

  it('links every distinct paper a recording names', () => {
    const found = paperMentions(
      [
        recording({
          segments: [
            segment('first arXiv:2006.11239', 0),
            segment('then 10.1038/s41586-020-2012-7', 30),
          ],
        }),
      ],
      OWNED,
    );

    expect(found.map((m) => m.to)).toEqual(['paper:ddpm', 'paper:covid']);
  });

  // Local-only by design: an identifier naming something you do not have is
  // skipped rather than fetched, so this can never invent a node.
  it('ignores a paper that is not in the library', () => {
    expect(
      paperMentions([recording({ segments: [segment('see arXiv:1706.03762 for that')] })], OWNED),
    ).toEqual([]);
  });

  it('finds nothing in a transcript that names nothing', () => {
    expect(
      paperMentions([recording({ segments: [segment('so anyway that is the plan for Q3')] })], OWNED),
    ).toEqual([]);
  });

  it('does nothing at all when the library is empty', () => {
    expect(
      paperMentions([recording({ segments: [segment('arXiv:2006.11239')] })], new Map()),
    ).toEqual([]);
  });
});

describe('evidenceFor', () => {
  it('keeps a short passage whole', () => {
    expect(evidenceFor('see arXiv:2006.11239', 4, 16)).toBe('see arXiv:2006.11239');
  });

  it('centres a long passage on the match rather than taking the opening', () => {
    const long = `${'filler words '.repeat(40)}arXiv:2006.11239${' trailing words'.repeat(40)}`;
    const at = long.indexOf('arXiv:');
    const evidence = evidenceFor(long, at, 16);

    expect(evidence).toContain('arXiv:2006.11239');
    expect(evidence.startsWith('…')).toBe(true);
    expect(evidence.endsWith('…')).toBe(true);
  });
});
