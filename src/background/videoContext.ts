import { newTurn } from '../shared/ai/assistantTypes';
import { cloudProviderFor, hasCloudKey } from '../shared/ai/cloud';
import { recentWindow } from '../shared/ai/liveTriggers';
import type { TranscriptSegment } from '../shared/recordings';
import { getLocal, getSettings } from '../shared/storage';
import { currentlyWatching, livePositionSeconds } from '../shared/youtube';
import { searchSegments } from '../shared/youtubeCaptions';
import { importYouTubeCaptions } from './recordings';

/**
 * The video playing right now, as assistant context.
 *
 * Transcripts are fetched lazily and cached in `recordings`, which already
 * dedupes by videoId and already feeds Library search — a second store would
 * duplicate it. The cost of that reuse is MAX_RECORDINGS: heavy YouTube use can
 * push meeting transcripts out of a 50-slot list sorted by recency. Laziness is
 * what buys it off, so nothing here may fetch speculatively.
 */

const CATCH_UP_MIN_MINUTES = 1;
const CATCH_UP_MAX_MINUTES = 15;

export interface WatchingNow {
  videoId: string;
  title: string;
  channel: string;
  positionSeconds: number;
  durationSeconds: number;
  chapter: string;
}

/** The live video, or null. Read-only and free — no network, no player. */
export async function watchingNow(): Promise<WatchingNow | null> {
  const { readingProgress } = await getLocal('readingProgress');
  const video = currentlyWatching(readingProgress);
  if (!video) return null;
  return {
    videoId: video.videoId,
    title: video.title,
    channel: video.source,
    positionSeconds: Math.round(livePositionSeconds(video)),
    durationSeconds: video.durationSeconds,
    chapter: video.chapter ?? '',
  };
}

/**
 * The transcript for a video, importing it once if we do not have it.
 *
 * `importYouTubeCaptions` may drive the player as a last resort — it can turn
 * captions on and call playVideo() (see shared/youtubeTabCaptions.ts). That is
 * acceptable when the user explicitly asks to import a video, and NOT
 * acceptable here, where they are watching it: a question must never start
 * playback. Callers that are on the live path pass `alreadyImportedOnly` so a
 * cache miss reports back instead of touching the tab.
 */
export async function transcriptFor(
  videoId: string,
  opts: { alreadyImportedOnly?: boolean } = {},
): Promise<{ segments: TranscriptSegment[] } | { error: string }> {
  const { recordings } = await getLocal('recordings');
  const prior = recordings.find(
    (r) => r.source.kind === 'youtube' && r.source.videoId === videoId && r.status === 'ready',
  );
  if (prior?.segments.length) return { segments: prior.segments };
  if (opts.alreadyImportedOnly) {
    return { error: 'No transcript for this video yet — import it from the panel first.' };
  }

  const res = await importYouTubeCaptions(`https://www.youtube.com/watch?v=${videoId}`);
  if (!res.ok || !res.id) return { error: res.error ?? 'Could not read this video’s captions.' };
  const { recordings: after } = await getLocal('recordings');
  const saved = after.find((r) => r.id === res.id);
  return saved?.segments.length
    ? { segments: saved.segments }
    : { error: 'That video’s transcript came back empty.' };
}

/** Summarize the minutes just watched, from the transcript before the playhead. */
export async function catchUpVideo(minutes: number): Promise<{ text: string }> {
  const live = await watchingNow();
  if (!live) return { text: 'Nothing is playing right now.' };

  const window = Math.max(CATCH_UP_MIN_MINUTES, Math.min(CATCH_UP_MAX_MINUTES, Math.round(minutes)));
  const transcript = await transcriptFor(live.videoId, { alreadyImportedOnly: true });
  if ('error' in transcript) return { text: transcript.error };

  // Everything up to the playhead — summarizing speech they have not reached
  // yet would be a spoiler, not a recap.
  const heard = transcript.segments.filter((s) => s.startSec <= live.positionSeconds);
  const text = recentWindow(heard, live.positionSeconds, window * 60);
  if (!text) return { text: 'Nothing has been said in that window yet.' };

  const settings = await getSettings();
  if (!hasCloudKey(settings)) {
    return { text: 'Add a cloud API key in Settings → Assistant to summarize a video.' };
  }
  const reply = await cloudProviderFor(settings).generate({
    system:
      'Summarize what was said in this excerpt of a video the user is watching. ' +
      'Lead with the answer, 2-4 short bullets, no preamble. Never invent content.',
    turns: [newTurn('user', `Video: "${live.title}"\n\n${text}`)],
  });
  return { text: reply.text };
}

/** Find a phrase in the live video's transcript, with clickable timestamps. */
export async function searchVideoTranscript(
  query: string,
): Promise<{ text: string; videoId?: string }> {
  const live = await watchingNow();
  if (!live) return { text: 'Nothing is playing right now.' };
  const transcript = await transcriptFor(live.videoId, { alreadyImportedOnly: true });
  if ('error' in transcript) return { text: transcript.error };

  const hits = searchSegments(transcript.segments, query);
  if (hits.length === 0) return { text: `Nothing in "${live.title}" mentions that.`, videoId: live.videoId };
  const lines = hits.map((h) => `- ${formatStamp(h.startSec)} — ${h.text.trim()}`);
  return { text: lines.join('\n'), videoId: live.videoId };
}

function formatStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** One-line status for the assistant: what is playing and how far in. */
export async function describeWatching(): Promise<{ text: string }> {
  const live = await watchingNow();
  if (!live) return { text: 'No video is playing right now.' };
  const chapter = live.chapter ? ` (chapter: ${live.chapter})` : '';
  return {
    text:
      `Watching "${live.title}" by ${live.channel || 'an unknown channel'} — ` +
      `at ${formatStamp(live.positionSeconds)} of ${formatStamp(live.durationSeconds)}${chapter}.`,
  };
}
