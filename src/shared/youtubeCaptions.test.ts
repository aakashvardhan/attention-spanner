import { describe, expect, it } from 'vitest';
import {
  captionTracks,
  extractPlayerResponse,
  json3Url,
  parseJson3,
  pickCaptionTrack,
  searchSegments,
  segmentAt,
  videoTitle,
  type CaptionTrack,
} from './youtubeCaptions';

const PLAYER_RESPONSE = {
  videoDetails: { title: 'Lecture 5: Backpropagation' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://yt/timedtext?v=1&lang=en', languageCode: 'en', kind: 'asr' },
        { baseUrl: 'https://yt/timedtext?v=1&lang=es', languageCode: 'es' },
      ],
    },
  },
};

function page(inner: string): string {
  return `<html><script>var ytInitialPlayerResponse = ${inner};var meta = 1;</script></html>`;
}

describe('extractPlayerResponse', () => {
  it('extracts the object from a watch page', () => {
    const parsed = extractPlayerResponse(page(JSON.stringify(PLAYER_RESPONSE)));
    expect(videoTitle(parsed)).toBe('Lecture 5: Backpropagation');
  });

  it('survives braces and escaped quotes inside strings', () => {
    // A naive brace count stops early on the "}" inside the title
    // ...and a naive string scan ends the string on the escaped quote
    const title = 'a } brace, a " quote, and a \\ backslash';
    const parsed = extractPlayerResponse(page(JSON.stringify({ videoDetails: { title } })));
    expect(videoTitle(parsed)).toBe(title);
  });

  it('returns null when the marker is absent', () => {
    expect(extractPlayerResponse('<html>nothing here</html>')).toBeNull();
  });

  it('returns null on a truncated object rather than throwing', () => {
    expect(extractPlayerResponse('var ytInitialPlayerResponse = {"a":')).toBeNull();
  });
});

describe('captionTracks', () => {
  it('reads tracks and flags auto-generated ones', () => {
    const tracks = captionTracks(PLAYER_RESPONSE);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ languageCode: 'en', auto: true });
    expect(tracks[1]).toMatchObject({ languageCode: 'es', auto: false });
  });

  it('flags the vssId form of auto-captions', () => {
    const tracks = captionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://yt/t', languageCode: 'en', vssId: 'a.en' }],
        },
      },
    });
    expect(tracks[0].auto).toBe(true);
  });

  it('is empty for a video with no captions', () => {
    expect(captionTracks({ videoDetails: {} })).toEqual([]);
    expect(captionTracks(null)).toEqual([]);
  });

  it('skips malformed tracks without a baseUrl', () => {
    const tracks = captionTracks({
      captions: {
        playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] },
      },
    });
    expect(tracks).toEqual([]);
  });
});

describe('pickCaptionTrack', () => {
  const authored: CaptionTrack = { baseUrl: 'a', languageCode: 'en', auto: false };
  const auto: CaptionTrack = { baseUrl: 'b', languageCode: 'en', auto: true };
  const spanish: CaptionTrack = { baseUrl: 'c', languageCode: 'es', auto: false };

  it('prefers an authored track over auto-captions in the same language', () => {
    expect(pickCaptionTrack([auto, authored], ['en'])).toBe(authored);
  });

  it('matches on the base language, ignoring region', () => {
    expect(pickCaptionTrack([spanish, authored], ['en-US'])).toBe(authored);
  });

  it('honors preference order', () => {
    expect(pickCaptionTrack([authored, spanish], ['es', 'en'])).toBe(spanish);
  });

  it('falls back to any authored track when no language matches', () => {
    expect(pickCaptionTrack([auto, spanish], ['de'])).toBe(spanish);
  });

  it('returns null when there are no tracks', () => {
    expect(pickCaptionTrack([], ['en'])).toBeNull();
  });
});

describe('json3Url', () => {
  it('appends the format to a url that already has a query', () => {
    expect(json3Url('https://yt/timedtext?v=1')).toBe('https://yt/timedtext?v=1&fmt=json3');
  });

  it('starts a query when there is none', () => {
    expect(json3Url('https://yt/timedtext')).toBe('https://yt/timedtext?fmt=json3');
  });
});

describe('parseJson3', () => {
  const events = [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'The chain' }, { utf8: ' rule' }] },
    { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'gives us\nthe gradient' }] },
    { tStartMs: 70_000, dDurationMs: 2000, segs: [{ utf8: 'Next topic' }] },
  ];

  it('groups cues into blocks and joins their pieces', () => {
    const segs = parseJson3({ events });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ startSec: 0, endSec: 4, text: 'The chain rule gives us the gradient' });
    expect(segs[1]).toMatchObject({ startSec: 70, text: 'Next topic' });
  });

  it('respects a custom group length', () => {
    // Every cue becomes its own block once the window is shorter than one cue
    expect(parseJson3({ events }, 1)).toHaveLength(3);
  });

  it('skips window definition events that carry no text', () => {
    const segs = parseJson3({ events: [{ tStartMs: 0 }, ...events.slice(0, 1)] });
    expect(segs).toHaveLength(1);
  });

  it('is empty for a malformed or empty response', () => {
    expect(parseJson3({})).toEqual([]);
    expect(parseJson3(null)).toEqual([]);
    expect(parseJson3({ events: [] })).toEqual([]);
  });
});

describe('videoTitle', () => {
  it('returns an empty string when absent', () => {
    expect(videoTitle({})).toBe('');
    expect(videoTitle(null)).toBe('');
  });
});

/**
 * Following a live playhead through an already-parsed transcript. Both pure, so
 * the UI and the assistant agree on "where are we" without either owning it.
 */
describe('segmentAt', () => {
  const segs = [
    { startSec: 0, endSec: 60, text: 'intro' },
    { startSec: 60, endSec: 120, text: 'middle' },
    { startSec: 120, endSec: 180, text: 'end' },
  ];

  it('returns -1 when there is nothing to follow', () => {
    expect(segmentAt([], 10)).toBe(-1);
  });

  it('finds the block containing the playhead', () => {
    expect(segmentAt(segs, 30)).toBe(0);
    expect(segmentAt(segs, 90)).toBe(1);
    expect(segmentAt(segs, 150)).toBe(2);
  });

  it('treats a boundary as the start of the next block', () => {
    expect(segmentAt(segs, 60)).toBe(1);
    expect(segmentAt(segs, 120)).toBe(2);
  });

  it('clamps before the first block and past the last', () => {
    expect(segmentAt([{ startSec: 10, endSec: 70, text: 'a' }], 2)).toBe(0);
    expect(segmentAt(segs, 9999)).toBe(2);
  });
});

describe('searchSegments', () => {
  const segs = [
    { startSec: 0, endSec: 60, text: 'We discuss Attention and softmax' },
    { startSec: 60, endSec: 120, text: 'Then the residual connections' },
    { startSec: 120, endSec: 180, text: 'attention again, briefly' },
  ];

  it('matches case-insensitively and keeps timestamps', () => {
    const hits = searchSegments(segs, 'ATTENTION');
    expect(hits.map((h) => h.startSec)).toEqual([0, 120]);
  });

  it('respects the limit and returns [] when nothing matches', () => {
    expect(searchSegments(segs, 'attention', 1)).toHaveLength(1);
    expect(searchSegments(segs, 'transformers on ice')).toEqual([]);
    expect(searchSegments(segs, '   ')).toEqual([]);
  });
});
