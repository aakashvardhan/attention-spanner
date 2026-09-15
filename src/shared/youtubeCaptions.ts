import type { TranscriptSegment } from './recordings';

/**
 * YouTube's own caption track, parsed into the same TranscriptSegment shape the
 * recorder produces. Pure — the fetching lives in background/recordings.ts.
 *
 * Pulling captions costs nothing and is exactly timed, so it always beats
 * transcribing the audio of a video that already has them. It is also the most
 * fragile path here: YouTube has been progressively gating `timedtext`, and a
 * caption track can be absent, auto-translated, or served empty. Every function
 * below returns null/[] rather than throwing so the caller can fall back to
 * recording the tab audio instead.
 */

/** Caption events are grouped into blocks of about this long, for readable paragraphs. */
export const CAPTION_GROUP_SECONDS = 60;

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** True for YouTube's speech-recognition track rather than an authored one */
  auto: boolean;
}

/**
 * Pull `ytInitialPlayerResponse` out of a watch page. Brace-matched rather than
 * regex-captured: the object contains nested braces and strings, so a lazy
 * `\{.*?\}` truncates it and a greedy one swallows the rest of the document.
 */
export function extractPlayerResponse(html: string): unknown | null {
  const marker = /ytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if (!marker) return null;

  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface ApiCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
}

/** Every usable caption track on the page, in YouTube's own order. */
export function captionTracks(playerResponse: unknown): CaptionTrack[] {
  const raw = (
    playerResponse as {
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: ApiCaptionTrack[] } };
    }
  )?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((t): t is ApiCaptionTrack & { baseUrl: string } => typeof t?.baseUrl === 'string')
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode ?? '',
      // 'asr' = automatic speech recognition
      auto: t.kind === 'asr' || (t.vssId ?? '').startsWith('a.'),
    }));
}

/**
 * Best track for a viewer preferring `languages` (e.g. navigator.languages).
 * An authored track wins over an auto-generated one in the same language —
 * auto-captions miss punctuation and mangle proper nouns.
 */
export function pickCaptionTrack(tracks: CaptionTrack[], languages: readonly string[]): CaptionTrack | null {
  if (tracks.length === 0) return null;

  for (const lang of languages) {
    const base = lang.toLowerCase().split('-')[0];
    const matches = tracks.filter((t) => t.languageCode.toLowerCase().split('-')[0] === base);
    if (matches.length === 0) continue;
    return matches.find((t) => !t.auto) ?? matches[0];
  }
  return tracks.find((t) => !t.auto) ?? tracks[0];
}

/** The track URL, asking for the JSON format rather than YouTube's default XML. */
export function json3Url(baseUrl: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

/**
 * json3 events → grouped segments. Individual caption cues are a few words
 * long, which would make one "segment" per line; they are merged into
 * CAPTION_GROUP_SECONDS blocks so the reader gets paragraphs and the library
 * gets meaningful chunks.
 */
export function parseJson3(json: unknown, groupSeconds = CAPTION_GROUP_SECONDS): TranscriptSegment[] {
  const events = (json as { events?: Json3Event[] })?.events;
  if (!Array.isArray(events)) return [];

  const segments: TranscriptSegment[] = [];
  let buffer: string[] = [];
  let blockStart = 0;
  let blockEnd = 0;

  const flush = () => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text) segments.push({ startSec: blockStart, endSec: Math.max(blockEnd, blockStart), text });
    buffer = [];
  };

  for (const event of events) {
    // Events without `segs` are window/pen definitions, not text
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;

    const startSec = Math.round((event.tStartMs ?? 0) / 1000);
    const endSec = Math.round(((event.tStartMs ?? 0) + (event.dDurationMs ?? 0)) / 1000);

    // Close the block BEFORE appending: a cue that begins past the window (a
    // long silence, or a gap in the captions) starts the next block rather than
    // stretching this one across the gap.
    if (buffer.length > 0 && startSec - blockStart >= groupSeconds) flush();

    if (buffer.length === 0) blockStart = startSec;
    buffer.push(text);
    blockEnd = endSec;
  }
  flush();

  return segments;
}

/** Video title from the player response; '' when absent. */
export function videoTitle(playerResponse: unknown): string {
  const title = (playerResponse as { videoDetails?: { title?: string } })?.videoDetails?.title;
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * Which transcript block the playhead is in, or -1 when there is no transcript.
 *
 * Binary search rather than a scan: this runs on every tick of the live
 * readout, against an hour of captions. Blocks are CAPTION_GROUP_SECONDS long
 * and contiguous, so "the last block that has started" is the answer — which
 * also puts a playhead before the first block, or past the end, on the nearest
 * real block instead of nowhere.
 */
export function segmentAt(segments: TranscriptSegment[], positionSeconds: number): number {
  if (segments.length === 0) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startSec <= positionSeconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Blocks mentioning `query`, in transcript order. Substring, not BM25 — the
 *  caller is looking for a phrase they half-remember hearing, not ranking a
 *  corpus, and the whole haystack is one video. */
export function searchSegments(
  segments: TranscriptSegment[],
  query: string,
  limit = 5,
): TranscriptSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: TranscriptSegment[] = [];
  for (const segment of segments) {
    if (segment.text.toLowerCase().includes(needle)) hits.push(segment);
    if (hits.length >= limit) break;
  }
  return hits;
}
