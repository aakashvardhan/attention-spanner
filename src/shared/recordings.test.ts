import { describe, expect, it } from 'vitest';
import {
  appendSegment,
  appendVisual,
  MAX_AUTO_VISUALS,
  defaultTitle,
  formatTimestamp,
  newRecording,
  patchRecording,
  reconcileOrphans,
  recordingDocUrl,
  segmentStartSec,
  sortAndCap,
  sourceUrl,
  sourceUrlAt,
  tailOf,
  timestampSeconds,
  transcriptText,
  transcriptWithVisuals,
  type Recording,
  type TranscriptSegment,
} from './recordings';

const NOW = Date.parse('2026-07-24T14:05:00.000Z');

function rec(patch: Partial<Recording> = {}): Recording {
  return { ...newRecording('r1', { kind: 'mic' }, NOW), ...patch };
}

function seg(startSec: number, text: string): TranscriptSegment {
  return { startSec, endSec: startSec + 300, text };
}

describe('transcriptText', () => {
  it('joins segments and drops empty ones', () => {
    const r = rec({ segments: [seg(0, 'first'), seg(300, '   '), seg(600, 'third')] });
    expect(transcriptText(r)).toBe('first\n\nthird');
  });

  it('is empty for a recording with no segments', () => {
    expect(transcriptText(rec())).toBe('');
  });
});

describe('appendSegment', () => {
  it('orders by start time when a slow segment lands late', () => {
    // Each segment is its own network call, so #2 can finish before #1
    let list = [rec()];
    list = appendSegment(list, 'r1', seg(300, 'second'), NOW);
    list = appendSegment(list, 'r1', seg(0, 'first'), NOW);
    expect(list[0].segments.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('replaces a segment retried at the same offset', () => {
    let list = [rec()];
    list = appendSegment(list, 'r1', seg(0, 'garbled'), NOW);
    list = appendSegment(list, 'r1', seg(0, 'clean'), NOW);
    expect(list[0].segments).toHaveLength(1);
    expect(list[0].segments[0].text).toBe('clean');
  });

  it('extends duration but never shortens it', () => {
    let list = [rec({ durationSeconds: 900 })];
    list = appendSegment(list, 'r1', seg(0, 'early'), NOW);
    expect(list[0].durationSeconds).toBe(900);
    list = appendSegment(list, 'r1', seg(900, 'later'), NOW);
    expect(list[0].durationSeconds).toBe(1200);
  });

  it('leaves other recordings untouched', () => {
    const list = appendSegment([rec(), rec({ id: 'r2' })], 'r1', seg(0, 'x'), NOW);
    expect(list[1].segments).toEqual([]);
  });
});

describe('reconcileOrphans', () => {
  it('keeps what was transcribed before the interruption', () => {
    const list = reconcileOrphans([rec({ status: 'recording', segments: [seg(0, 'kept')] })], NOW);
    expect(list[0].status).toBe('ready');
    expect(list[0].error).toBe('');
  });

  it('fails a recording that captured nothing', () => {
    const list = reconcileOrphans([rec({ status: 'recording' })], NOW);
    expect(list[0].status).toBe('failed');
    expect(list[0].error).not.toBe('');
  });

  it('resolves a recording stranded mid-transcription', () => {
    const list = reconcileOrphans([rec({ status: 'transcribing', segments: [seg(0, 'a')] })], NOW);
    expect(list[0].status).toBe('ready');
  });

  it('leaves settled recordings alone', () => {
    const done = rec({ status: 'ready', updatedAt: 1 });
    const failed = rec({ id: 'r2', status: 'failed', error: 'original', updatedAt: 1 });
    expect(reconcileOrphans([done, failed], NOW)).toEqual([done, failed]);
  });
});

describe('sortAndCap', () => {
  it('orders newest first and enforces the cap', () => {
    const list = [
      rec({ id: 'old', startedAt: 100 }),
      rec({ id: 'new', startedAt: 300 }),
      rec({ id: 'mid', startedAt: 200 }),
    ];
    expect(sortAndCap(list, 2).map((r) => r.id)).toEqual(['new', 'mid']);
  });

  it('sorts by start time, so a late summary does not reorder the list', () => {
    const list = [
      rec({ id: 'a', startedAt: 100, updatedAt: 999 }),
      rec({ id: 'b', startedAt: 200, updatedAt: 1 }),
    ];
    expect(sortAndCap(list).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('patchRecording', () => {
  it('patches by id and stamps updatedAt', () => {
    const list = patchRecording([rec()], 'r1', { status: 'ready' }, 555);
    expect(list[0].status).toBe('ready');
    expect(list[0].updatedAt).toBe(555);
  });

  it('is a no-op for an unknown id', () => {
    const before = [rec()];
    expect(patchRecording(before, 'nope', { status: 'ready' }, 555)).toEqual(before);
  });
});

describe('tailOf', () => {
  it('returns short text unchanged', () => {
    expect(tailOf('a short tail', 200)).toBe('a short tail');
  });

  it('keeps the first word when the cut lands on a boundary', () => {
    expect(tailOf('alpha beta gamma delta', 11)).toBe('gamma delta');
  });

  it('drops a leading fragment when the cut lands mid-word', () => {
    expect(tailOf('alpha beta gamma delta', 8)).toBe('delta');
  });
});

describe('formatTimestamp', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65)).toBe('1:05');
  });

  it('pads minutes once past an hour', () => {
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });

  it('clamps junk to zero', () => {
    expect(formatTimestamp(-5)).toBe('0:00');
  });
});

describe('defaultTitle', () => {
  it('borrows the page title for a tab recording', () => {
    expect(defaultTitle({ kind: 'tab', tabUrl: 'https://x', tabTitle: 'CS 152 Lecture' }, NOW)).toBe(
      'CS 152 Lecture',
    );
  });

  it('falls back to date and time when the tab has no title', () => {
    const title = defaultTitle({ kind: 'mixed', tabUrl: 'https://x', tabTitle: '  ' }, NOW);
    expect(title).toMatch(/^Recording /);
  });

  it('names a YouTube import by video id', () => {
    expect(defaultTitle({ kind: 'youtube', videoId: 'abc123' }, NOW)).toBe('YouTube abc123');
  });
});

describe('newRecording', () => {
  it('starts a captured recording in the recording state', () => {
    expect(newRecording('r1', { kind: 'mic' }, NOW).status).toBe('recording');
  });

  it('starts a YouTube import already past capture', () => {
    expect(newRecording('r1', { kind: 'youtube', videoId: 'v' }, NOW).status).toBe('transcribing');
  });

  it('prefers an explicit title', () => {
    expect(newRecording('r1', { kind: 'mic' }, NOW, '  Standup  ').title).toBe('Standup');
  });

  it('stamps the purpose it was given', () => {
    expect(newRecording('r1', { kind: 'mic' }, NOW, undefined, 'lecture').purpose).toBe('lecture');
    expect(newRecording('r1', { kind: 'mic' }, NOW).purpose).toBeUndefined();
  });

  it('coerces a youtube source to the video purpose regardless of the caller', () => {
    expect(newRecording('r1', { kind: 'youtube', videoId: 'v' }, NOW, undefined, 'meeting').purpose)
      .toBe('video');
  });
});

describe('segmentStartSec', () => {
  it('spaces segments by the rotation period', () => {
    expect(segmentStartSec(0)).toBe(0);
    expect(segmentStartSec(3)).toBe(900);
  });
});

describe('sourceUrl', () => {
  it('rebuilds a YouTube watch url', () => {
    expect(sourceUrl({ kind: 'youtube', videoId: 'abc' })).toBe(
      'https://www.youtube.com/watch?v=abc',
    );
  });

  it('returns the captured tab url', () => {
    expect(sourceUrl({ kind: 'tab', tabUrl: 'https://meet.example', tabTitle: '' })).toBe(
      'https://meet.example',
    );
  });

  it('is undefined for a microphone recording, which has no original', () => {
    expect(sourceUrl({ kind: 'mic' })).toBeUndefined();
    expect(sourceUrl({ kind: 'mixed', tabUrl: '', tabTitle: '' })).toBeUndefined();
  });

  it('opens YouTube at a transcript timestamp but leaves generic tabs untouched', () => {
    expect(sourceUrlAt({ kind: 'youtube', videoId: 'abc' }, 92)).toBe(
      'https://www.youtube.com/watch?v=abc&t=92',
    );
    expect(sourceUrlAt({ kind: 'tab', tabUrl: 'https://meet.example', tabTitle: '' }, 92)).toBe(
      'https://meet.example',
    );
  });
});

describe('timestampSeconds', () => {
  it('parses the timestamp formats used by recording headings', () => {
    expect(timestampSeconds('03:12')).toBe(192);
    expect(timestampSeconds('1:03:12')).toBe(3792);
    expect(timestampSeconds('not a timestamp')).toBeNull();
    expect(timestampSeconds('03:61')).toBeNull();
  });
});

describe('recordingDocUrl', () => {
  it('namespaces transcripts so annotations can key off them', () => {
    expect(recordingDocUrl('r1')).toBe('recording:r1');
  });
});

describe('appendVisual', () => {
  const visual = (atSec: number, kind: 'auto' | 'manual' = 'auto') => ({
    atSec,
    kind,
    description: `frame at ${atSec}`,
  });

  it('inserts sorted by atSec and dedupes on atSec', () => {
    let list = [rec()];
    list = appendVisual(list, 'r1', visual(600), NOW);
    list = appendVisual(list, 'r1', visual(100), NOW);
    list = appendVisual(list, 'r1', { ...visual(600), description: 'replaced' }, NOW);
    expect(list[0].visuals?.map((v) => v.atSec)).toEqual([100, 600]);
    expect(list[0].visuals?.[1].description).toBe('replaced');
  });

  it('caps auto and manual budgets separately', () => {
    let list = [rec()];
    for (let i = 0; i < MAX_AUTO_VISUALS + 5; i++) {
      list = appendVisual(list, 'r1', visual(i * 30, 'auto'), NOW);
    }
    expect(list[0].visuals).toHaveLength(MAX_AUTO_VISUALS);
    // Manual captures still land after the auto cap binds
    list = appendVisual(list, 'r1', visual(9999, 'manual'), NOW);
    expect(list[0].visuals).toHaveLength(MAX_AUTO_VISUALS + 1);
  });

  it('leaves other recordings untouched', () => {
    const other = { ...rec(), id: 'r2' };
    const list = appendVisual([rec(), other], 'r1', visual(10), NOW);
    expect(list[1].visuals).toBeUndefined();
  });
});

describe('transcriptWithVisuals', () => {
  it('prefixes segments with [mm:ss] and merges visuals chronologically', () => {
    const r = rec({
      segments: [seg(0, 'intro'), seg(300, 'main point')],
      visuals: [{ atSec: 120, kind: 'auto' as const, description: 'title slide' }],
    });
    expect(transcriptWithVisuals(r)).toBe(
      '[0:00] intro\n\n[Visual 2:00] On screen: title slide\n\n[5:00] main point',
    );
  });

  it('works with visuals and no segments, and matches transcriptText emptiness', () => {
    const withVisual = rec({
      visuals: [{ atSec: 30, kind: 'manual' as const, description: 'a chart' }],
    });
    expect(transcriptWithVisuals(withVisual)).toBe('[Visual 0:30] On screen: a chart');
    expect(transcriptWithVisuals(rec())).toBe('');
  });
});
