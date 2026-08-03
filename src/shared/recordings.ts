/**
 * Recorded lectures, meetings and videos — pure types and reducers. All IO
 * lives in src/background/recordings.ts (capture control, YouTube captions) and
 * src/pages/offscreen/recorder.ts (the audio itself).
 *
 * Only the transcript is kept. The audio is discarded the moment a segment has
 * been transcribed: an hour of speech is ~60 KB of text but ~15 MB of audio, and
 * nothing downstream — reader, library search, summaries — ever needs to play it
 * back. That decision is what makes MAX_RECORDINGS affordable.
 */

export type RecordingSource =
  | { kind: 'mic' }
  | { kind: 'tab'; tabUrl: string; tabTitle: string }
  /** Mic and tab mixed into one stream — a hybrid meeting, you plus the room */
  | { kind: 'mixed'; tabUrl: string; tabTitle: string }
  /** Imported from YouTube's own caption track; no audio was ever captured */
  | { kind: 'youtube'; videoId: string };

/**
 * One transcribed slice. Boundaries come from recorder rotation, never from the
 * model — `startSec` is measured, so a hallucinated timestamp can't move it.
 * Where rotation happens depends on the mode: batch cuts every SEGMENT_MINUTES
 * (see segmentStartSec), live cuts at a speech pause, which makes segments
 * variable-length and the offset a wall-clock reading instead.
 */
export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * 'recording' → capturing now. 'transcribing' → capture stopped, segments still
 * in flight. 'ready' → transcript complete (a summary may still be filling in).
 * 'failed' → see `error`.
 */
export type RecordingStatus = 'recording' | 'transcribing' | 'ready' | 'failed';

/**
 * What the recording is FOR — the question the record button asks, because it
 * is the one the user can actually answer. Purpose picks the audio source
 * (meeting wants the call plus your voice; a lecture is usually a room) and
 * tailors the summary (a meeting summary leads with decisions; a lecture
 * summary with concepts). Distinct from RecordingSource, which is the audio
 * topology that resulted.
 */
export type RecordingPurpose = 'meeting' | 'lecture' | 'video';

/**
 * A described frame from a tab recording — a slide, a shared screen, a diagram.
 * Only the description is kept, for the same reason only the transcript is:
 * the text is what search, summaries and the reader consume, and a thumbnail
 * nothing renders would be dead weight.
 */
export interface RecordingVisual {
  atSec: number;
  /** 'auto' = the change detector fired; 'manual' = the user pressed Capture */
  kind: 'auto' | 'manual';
  /** Plain text from the vision model, capped at VISION_DESC_MAX_CHARS */
  description: string;
}

export interface Recording {
  id: string;
  title: string;
  source: RecordingSource;
  /** Absent on records made before purposes existed — read with a fallback */
  purpose?: RecordingPurpose;
  startedAt: number;
  durationSeconds: number;
  status: RecordingStatus;
  segments: TranscriptSegment[];
  /** Absent on records made before vision existed — read with `?? []` */
  visuals?: RecordingVisual[];
  /** Markdown, as rendered by components/Markdown.tsx */
  summary: string;
  actionItems: string[];
  /** '' = healthy */
  error: string;
  updatedAt: number;
}

/**
 * Newest-wins cap. Transcripts are the largest per-record payload in the
 * extension (~60 KB an hour), which is why the manifest asks for
 * unlimitedStorage — but unbounded growth is still worth refusing.
 */
export const MAX_RECORDINGS = 50;

/**
 * Recorder rotation period. Chosen so a segment lands near 1.2 MB at 32 kbps —
 * comfortably inside Gemini's 20 MB inline request cap even after base64, which
 * is what lets the whole pipeline skip the Files API. It also bounds how much a
 * single failed segment can cost, and how long you wait to see the first text.
 */
export const SEGMENT_MINUTES = 5;

/** Trailing context handed to the next segment so the model doesn't restart mid-sentence */
export const PRIOR_TAIL_CHARS = 200;

/**
 * Per-recording caps on described frames, counted separately so a talkative
 * change detector can't eat the manual budget. 40 auto captures at the
 * detector's 20-second minimum spacing covers a dense hour of slides.
 */
export const MAX_AUTO_VISUALS = 40;
export const MAX_MANUAL_VISUALS = 15;

/** Wall-clock offset of segment `index`, in seconds. */
export function segmentStartSec(index: number): number {
  return index * SEGMENT_MINUTES * 60;
}

export function newRecording(
  id: string,
  source: RecordingSource,
  startedAt: number,
  title?: string,
  purpose?: RecordingPurpose,
): Recording {
  return {
    id,
    title: title?.trim() || defaultTitle(source, startedAt),
    source,
    // A YouTube source IS the video purpose, whatever the caller said
    purpose: source.kind === 'youtube' ? 'video' : purpose,
    startedAt,
    durationSeconds: 0,
    // A YouTube import never captures audio, so it starts a step further along
    status: source.kind === 'youtube' ? 'transcribing' : 'recording',
    segments: [],
    summary: '',
    actionItems: [],
    error: '',
    updatedAt: startedAt,
  };
}

/**
 * A name you can find later without being asked to invent one up front — the
 * point being that naming a recording is exactly the kind of friction that stops
 * it being made. A tab recording borrows the page title; a bare mic recording
 * gets the date and time, which is usually enough to recognize.
 */
export function defaultTitle(source: RecordingSource, startedAt: number): string {
  const when = new Date(startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (source.kind === 'tab' || source.kind === 'mixed') {
    const title = source.tabTitle.trim();
    if (title) return title;
  }
  if (source.kind === 'youtube') return `YouTube ${source.videoId}`;
  return `Recording ${when}`;
}

/** The whole transcript as one block of text — what search and the AI consume. */
export function transcriptText(recording: Recording): string {
  return recording.segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The transcript the summarizer reads: each segment prefixed with its [mm:ss]
 * marker and visual descriptions merged in chronologically. The markers exist
 * so the summary can cite them — a claim with a timestamp is one click to
 * verify against the reader's segment headings, and one without is not.
 */
export function transcriptWithVisuals(recording: Recording): string {
  const parts: { atSec: number; text: string }[] = [];
  for (const s of recording.segments) {
    const text = s.text.trim();
    if (text) parts.push({ atSec: s.startSec, text: `[${formatTimestamp(s.startSec)}] ${text}` });
  }
  for (const v of recording.visuals ?? []) {
    parts.push({
      atSec: v.atSec,
      text: `[Visual ${formatTimestamp(v.atSec)}] On screen: ${v.description}`,
    });
  }
  return parts
    .sort((a, b) => a.atSec - b.atSec)
    .map((p) => p.text)
    .join('\n\n');
}

/** Last `chars` characters, snapped to a word boundary — context for the next segment. */
export function tailOf(text: string, chars = PRIOR_TAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= chars) return trimmed;
  const cut = trimmed.length - chars;
  const tail = trimmed.slice(cut);
  // Drop a leading fragment only when the cut actually landed mid-word; one that
  // already fell on a boundary keeps its first word.
  if (/\s/.test(trimmed[cut - 1])) return tail;
  const space = tail.search(/\s/);
  return space === -1 ? tail : tail.slice(space + 1);
}

/** 'MM:SS', or 'H:MM:SS' once past an hour — the reader's timestamp gutter. */
export function formatTimestamp(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Newest first, then capped. The sort key is start time, not update time —
 *  a late-arriving summary shouldn't reorder your list under you. */
export function sortAndCap(list: Recording[], max = MAX_RECORDINGS): Recording[] {
  return [...list].sort((a, b) => b.startedAt - a.startedAt).slice(0, max);
}

/** Replace one recording by id; a no-op (same array contents) when it's gone. */
export function patchRecording(
  list: Recording[],
  id: string,
  patch: Partial<Omit<Recording, 'id'>>,
  now: number,
): Recording[] {
  return list.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: now } : r));
}

/**
 * Append a transcribed segment, keeping `durationSeconds` in step. Segments can
 * complete out of order — transcription is a network call per segment, and a
 * slow one can land after its successor — so they are inserted by `startSec`
 * rather than pushed.
 */
export function appendSegment(
  list: Recording[],
  id: string,
  segment: TranscriptSegment,
  now: number,
): Recording[] {
  return list.map((r) => {
    if (r.id !== id) return r;
    const segments = [...r.segments.filter((s) => s.startSec !== segment.startSec), segment].sort(
      (a, b) => a.startSec - b.startSec,
    );
    return {
      ...r,
      segments,
      durationSeconds: Math.max(r.durationSeconds, segment.endSec),
      updatedAt: now,
    };
  });
}

/**
 * Append a described frame, mirroring appendSegment's rules: inserted by
 * `atSec` (descriptions arrive out of order when a slow Gemini call lands
 * after a fast one), deduped on `atSec`, and capped per kind — the caps are
 * the cost ceiling on a runaway change detector.
 */
export function appendVisual(
  list: Recording[],
  id: string,
  visual: RecordingVisual,
  now: number,
): Recording[] {
  return list.map((r) => {
    if (r.id !== id) return r;
    const existing = r.visuals ?? [];
    const cap = visual.kind === 'auto' ? MAX_AUTO_VISUALS : MAX_MANUAL_VISUALS;
    const sameKind = existing.filter((v) => v.kind === visual.kind);
    const replacing = existing.some((v) => v.atSec === visual.atSec);
    if (!replacing && sameKind.length >= cap) return r;
    const visuals = [...existing.filter((v) => v.atSec !== visual.atSec), visual].sort(
      (a, b) => a.atSec - b.atSec,
    );
    return { ...r, visuals, updatedAt: now };
  });
}

/**
 * Resolve recordings stranded mid-flight by a browser restart. The recorder
 * lives in an offscreen document and its progress in session storage, so a
 * profile that closes during capture leaves a record claiming to be recording
 * with nothing left to do it. Whatever was already transcribed is real and
 * worth keeping; a record with nothing at all is just noise.
 */
export function reconcileOrphans(list: Recording[], now: number): Recording[] {
  return list.map((r) => {
    if (r.status !== 'recording' && r.status !== 'transcribing') return r;
    if (r.segments.length > 0) {
      return { ...r, status: 'ready' as const, updatedAt: now };
    }
    return {
      ...r,
      status: 'failed' as const,
      error: 'Recording was interrupted before anything was transcribed.',
      updatedAt: now,
    };
  });
}

/**
 * Where this recording came from, when there is somewhere to go back to. A
 * microphone recording of a room has no original, which is why this is
 * undefined rather than an empty string the toolbar would have to special-case.
 */
export function sourceUrl(source: RecordingSource): string | undefined {
  if (source.kind === 'youtube') return `https://www.youtube.com/watch?v=${source.videoId}`;
  if (source.kind === 'tab' || source.kind === 'mixed') return source.tabUrl || undefined;
  return undefined;
}

/**
 * The closest thing to replay for transcript-only recordings. YouTube accepts
 * a time query; other tab sources are still useful to reopen, even though the
 * web has no universal seek URL convention.
 */
export function sourceUrlAt(source: RecordingSource, seconds: number): string | undefined {
  const base = sourceUrl(source);
  if (!base) return undefined;
  if (source.kind === 'youtube') {
    const url = new URL(base);
    url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
    return url.toString();
  }
  return base;
}

/** Parse the timestamp headings the recording reader creates (MM:SS / H:MM:SS). */
export function timestampSeconds(value: string): number | null {
  const parts = value.trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Synthetic docUrl so transcripts can carry annotations like any other document. */
export function recordingDocUrl(id: string): string {
  return `recording:${id}`;
}

export function isRecordingDocUrl(docUrl: string): boolean {
  return docUrl.startsWith('recording:');
}
