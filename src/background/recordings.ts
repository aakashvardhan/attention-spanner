import { geminiProvider } from '../shared/ai/geminiProvider';
import { summarizeTranscript } from '../shared/ai/transcribe';
import { FETCH_TIMEOUT_MS } from '../shared/constants';
import { onLiveSegment, startLive, stopLive } from './live';
import { broadcastMessage } from '../shared/messages';
import {
  appendSegment,
  appendVisual,
  newRecording,
  patchRecording,
  reconcileOrphans,
  sortAndCap,
  transcriptWithVisuals,
  type RecordingPurpose,
  type RecordingSource,
  type TranscriptSegment,
} from '../shared/recordings';
import { getLocal, getSession, getSettings, setLocal, setSession } from '../shared/storage';
import { getYouTubeVideoId } from '../shared/youtube';
import {
  captionTracks,
  extractPlayerResponse,
  json3Url,
  parseJson3,
  pickCaptionTrack,
  videoTitle,
} from '../shared/youtubeCaptions';
import { captureCaptionsFromPlayer, type TabCaptionResult } from '../shared/youtubeTabCaptions';
import { updateBadge } from './feeds';
import { acquireOffscreen, releaseOffscreen } from './offscreen';

/**
 * Recording control: acquiring the capture stream, owning every mutation of the
 * `recordings` array, and summarizing once the transcript is complete.
 *
 * The array is mutated only here. The offscreen recorder reports finished
 * segments as messages rather than writing storage itself, because the single
 * service-worker context serializes read-modify-write — the same reason
 * ASSISTANT_APPEND_TURN exists in router.ts.
 */

/**
 * Promise wrapper for tabCapture, which @types/chrome still types as
 * callback-only. The failure lands in runtime.lastError rather than a throw, so
 * it has to be read inside the callback or it is lost.
 */
function getTabStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const failure = chrome.runtime.lastError;
      if (failure) reject(new Error(failure.message ?? 'Could not capture this tab.'));
      else resolve(streamId);
    });
  });
}

export async function startRecording(
  mode: 'mic' | 'tab' | 'mixed',
  tabId?: number,
  title?: string,
  purpose?: RecordingPurpose,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { activeRecording } = await getSession('activeRecording');
  if (activeRecording) return { ok: false, error: 'Already recording.' };

  // Transcription is Gemini-only, so a missing key is a hard stop rather than a
  // recording that silently produces nothing.
  if (!(await geminiProvider.available())) {
    return { ok: false, error: 'Add a Gemini API key in Settings → Assistant to transcribe audio.' };
  }

  let source: RecordingSource;
  let streamId: string | undefined;

  if (mode === 'mic') {
    source = { kind: 'mic' };
  } else {
    if (tabId === undefined) return { ok: false, error: 'No tab to record.' };
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, error: 'That tab is gone.' };
    }
    try {
      // Requires the extension to have been invoked on this tab — which is why
      // tab capture starts from the popup, not the dashboard.
      streamId = await getTabStreamId(tabId);
    } catch (error) {
      return {
        ok: false,
        error:
          (error as Error)?.message ??
          'Could not capture this tab — open the popup on the tab you want to record.',
      };
    }
    source = { kind: mode, tabUrl: tab.url ?? '', tabTitle: tab.title ?? '' };
  }

  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const recording = newRecording(id, source, startedAt, title, purpose);

  const { recordings } = await getLocal('recordings');
  await setLocal({ recordings: sortAndCap([recording, ...recordings]) });
  await setSession({ activeRecording: { id, startedAt, source, segmentIndex: 0 } });
  await updateBadge();

  // Frame capture rides on tab audio capture — same stream id, same consent.
  const settings = await getSettings();
  const visualCapture = settings.assistantVisionEnabled && mode !== 'mic';

  // Live mode follows the recording: there is nothing to answer about before
  // capture starts, and nothing to answer about after it ends.
  if (settings.assistantLiveEnabled) await startLive(id);

  await acquireOffscreen('recorder');
  // broadcastMessage, not sendMessage: this is addressed to the offscreen
  // document, and the SW's in-process dispatcher would swallow it (see
  // messages.ts) — the recording would sit at 'recording' having captured nothing.
  await broadcastMessage({
    type: 'REC_BEGIN',
    id,
    mode,
    streamId,
    visualCapture,
    title: recording.title,
    purpose: recording.purpose,
  });
  return { ok: true, id };
}

/**
 * The offscreen recorder stops itself: REC_STOP is a broadcast and the document
 * listens on it directly, the same way WAKE_MIC_BUSY reaches the wake listener.
 * This side only marks the record, and waits for REC_CAPTURE_ENDED to settle it.
 */
export async function stopRecording(): Promise<{ ok: boolean }> {
  const { activeRecording } = await getSession('activeRecording');
  if (!activeRecording) return { ok: true };
  const { recordings } = await getLocal('recordings');
  await setLocal({
    recordings: patchRecording(recordings, activeRecording.id, { status: 'transcribing' }, Date.now()),
  });
  return { ok: true };
}

export async function handleSegmentReady(msg: {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
}): Promise<void> {
  const { recordings } = await getLocal('recordings');
  await setLocal({
    recordings: appendSegment(
      recordings,
      msg.id,
      { startSec: msg.startSec, endSec: msg.endSec, text: msg.text },
      Date.now(),
    ),
  });
  // After the write, so the window a live answer reads already includes this
  // segment. Never awaited into the caller's failure path: a suggestion that
  // fails must not look like a transcript that failed.
  await onLiveSegment(msg.id, msg.text, msg.endSec).catch((error) =>
    console.error('[recordings] live segment hook failed', error),
  );
}

/** A described frame from the offscreen watcher — same single-writer rule as segments. */
export async function handleVisualReady(msg: {
  id: string;
  atSec: number;
  kind: 'auto' | 'manual';
  description: string;
}): Promise<void> {
  const { recordings } = await getLocal('recordings');
  await setLocal({
    recordings: appendVisual(
      recordings,
      msg.id,
      { atSec: msg.atSec, kind: msg.kind, description: msg.description },
      Date.now(),
    ),
  });
}

/**
 * Grab the current frame of the recording in progress. The offscreen watcher
 * owns the pixels, so this only validates and forwards — a manual capture
 * bypasses the change detector but not the per-recording cap.
 */
export async function captureNow(): Promise<{ ok: boolean; error?: string }> {
  const { activeRecording } = await getSession('activeRecording');
  if (!activeRecording) return { ok: false, error: 'Not recording.' };
  const kind = activeRecording.source.kind;
  if (kind !== 'tab' && kind !== 'mixed') {
    return { ok: false, error: 'Frame capture needs a tab recording.' };
  }
  await broadcastMessage({ type: 'REC_GRAB_FRAME' });
  return { ok: true };
}

/** Capture finished (or failed): settle the record, free the document, summarize. */
export async function handleCaptureEnded(msg: {
  id: string;
  durationSeconds: number;
  error?: string;
}): Promise<void> {
  await setSession({ activeRecording: null });
  await stopLive();
  await updateBadge();
  await releaseOffscreen('recorder');

  const { recordings } = await getLocal('recordings');
  const recording = recordings.find((r) => r.id === msg.id);
  if (!recording) return;

  const hasText = recording.segments.length > 0;
  // A failure that still produced text is worth keeping as a short recording,
  // not throwing away — the error only wins when there is nothing to show.
  const failed = !!msg.error && !hasText;

  await setLocal({
    recordings: patchRecording(
      recordings,
      msg.id,
      {
        status: failed ? 'failed' : 'ready',
        error: failed ? msg.error! : '',
        durationSeconds: Math.max(recording.durationSeconds, msg.durationSeconds),
      },
      Date.now(),
    ),
  });

  if (!failed && hasText) await summarizeRecording(msg.id);
}

/**
 * Summarize a finished transcript. Separate and re-runnable: the worker can be
 * torn down mid-call, which leaves a perfectly good transcript with an empty
 * summary, and the panel offers a retry rather than pretending it failed.
 */
export async function summarizeRecording(id: string): Promise<{ ok: boolean; error?: string }> {
  const { recordings } = await getLocal('recordings');
  const recording = recordings.find((r) => r.id === id);
  if (!recording) return { ok: false, error: 'No such recording.' };

  // Timestamped, with visual descriptions interleaved — the summarizer is asked
  // to cite [mm:ss] markers, and these are the markers it cites.
  const text = transcriptWithVisuals(recording);
  if (!text) return { ok: false, error: 'Nothing was transcribed.' };

  try {
    // Records made before purposes existed lack the field; a youtube source is
    // the video purpose by construction either way.
    const purpose =
      recording.purpose ?? (recording.source.kind === 'youtube' ? 'video' : undefined);
    const { summary, actionItems } = await summarizeTranscript(recording.title, text, purpose);
    const fresh = await getLocal('recordings');
    await setLocal({
      recordings: patchRecording(fresh.recordings, id, { summary, actionItems }, Date.now()),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? 'Could not summarize.' };
  }
}

/**
 * Register the timedtext tee (content/timedtextTee.js) for YouTube pages.
 * document_start + MAIN world are both load-bearing: the player binds its
 * fetch/XHR references at boot, so a later or isolated-world injection sees
 * nothing. Idempotent — safe from both onInstalled and onStartup.
 */
export async function registerTimedtextTee(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['yt-timedtext-tee'] });
  if (existing.length > 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: 'yt-timedtext-tee',
      matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
      js: ['content/timedtextTee.js'],
      runAt: 'document_start',
      world: 'MAIN',
    },
  ]);
}

/**
 * Unwind orphaned tees in YouTube tabs that are already open.
 *
 * The tee wraps window.fetch and XMLHttpRequest, and unlike the isolated-world
 * content scripts it cannot evict itself: MAIN world has no chrome.runtime, so
 * it has no way to notice the extension was reloaded out from under it. Left
 * alone, its wrapper stays on every request the page makes for as long as the
 * tab lives. A registered content script does not apply to already-open tabs
 * either, so re-injecting is what puts a live tee back for the SPA navigations
 * that follow (too late for the caption request this page already made).
 */
export async function refreshTimedtextTees(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://m.youtube.com/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const target = { tabId: tab.id };
      try {
        await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          func: () => window.__readerTimedtextStop?.(),
        });
        await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          files: ['content/timedtextTee.js'],
        });
      } catch {
        // Tab closed or navigating — the registered script covers its next load
      }
    }),
  );
}

/**
 * The video's tab, waiting for it to exist: the dashboard picker opens the tab
 * (OPEN_ARTICLE) and imports in the same breath, so the tab is usually still
 * navigating when this runs.
 */
async function findVideoTab(videoId: string, timeoutMs = 10_000): Promise<number | null> {
  const search = async (): Promise<number | null> => {
    const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] });
    return tabs.find((tab) => tab.url && getYouTubeVideoId(tab.url) === videoId)?.id ?? null;
  };

  const open = await search();
  if (open !== null) return open;

  // Not there yet — wait to be told, rather than asking every 500ms.
  return new Promise<number | null>((resolve) => {
    const settle = (id: number | null) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(id);
    };
    const onUpdated = (tabId: number, _change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.url && getYouTubeVideoId(tab.url) === videoId) settle(tabId);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The tab can have finished loading in the gap between the search above and
    // the listener being attached, and nothing would fire again.
    void search().then((id) => {
      if (id !== null) settle(id);
    });
  });
}

/** Injection errors worth retrying: the player just hasn't booted yet. */
const RETRYABLE = new Set(['no-player', 'player-api']);

const TAB_CAPTION_ERRORS: Record<string, string> = {
  'no-player': 'The video player never appeared — is the tab still loading?',
  'no-tracks': 'This video has no caption tracks — record the tab audio instead.',
  'no-request': 'Could not capture captions from the player — record the tab audio instead.',
  'player-api': 'Could not drive the YouTube player — record the tab audio instead.',
  'tee-missing': 'Reload the video tab once, then import again.',
};

/**
 * Capture the caption track from inside the video's own tab. The tee content
 * script stashed (or will stash) the body of the player's own timedtext
 * request — the one request YouTube cannot gate, since the player mints the
 * proof-of-origin token it demands. The injected capture function reads that
 * stash, driving the player's captions API when it's empty.
 */
async function captionsViaTab(
  videoId: string,
): Promise<{ segments: TranscriptSegment[] } | { error: string }> {
  const tabId = await findVideoTab(videoId);
  if (tabId === null) {
    return { error: 'Open the video in a tab first, then import its captions.' };
  }

  let lastError = 'no-player';
  let reloaded = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    let result: TabCaptionResult | undefined;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: captureCaptionsFromPlayer,
        args: [videoId],
      });
      result = injection?.result as TabCaptionResult | undefined;
    } catch (error) {
      return { error: (error as Error)?.message ?? 'Could not reach the video tab.' };
    }
    if (!result) return { error: 'The video tab did not respond.' };

    if (result.ok && result.body) {
      try {
        return { segments: parseJson3(JSON.parse(result.body)) };
      } catch {
        return { error: 'The player used an unexpected caption format.' };
      }
    }
    lastError = result.error ?? 'no-request';

    // Tab predates the tee registration (extension just updated): one reload
    // injects it at document_start, and the flow self-heals.
    if (lastError === 'tee-missing' && !reloaded) {
      reloaded = true;
      await chrome.tabs.reload(tabId);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    // A still-loading tab reports no-player; anything else is final
    if (!RETRYABLE.has(lastError)) break;
  }
  return { error: TAB_CAPTION_ERRORS[lastError] ?? 'Could not capture the captions.' };
}

/**
 * Import a YouTube video's own caption track. Free and exactly timed, so it
 * always beats transcribing audio that has already been transcribed by YouTube.
 * Every failure names tab recording as the way through, because that path
 * exists and works when this one is gated.
 */
export async function importYouTubeCaptions(
  url: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) return { ok: false, error: 'That is not a YouTube video URL.' };

  // Already imported: hand back the existing transcript instead of refetching
  // and paying for a second summary. The resume-picker on the dashboard makes
  // repeat clicks on the same video the NORMAL case, not an accident.
  const existing = await getLocal('recordings');
  const prior = existing.recordings.find(
    (r) => r.source.kind === 'youtube' && r.source.videoId === videoId && r.status === 'ready',
  );
  if (prior) return { ok: true, id: prior.id };

  const fallback = ' — record the tab audio instead.';
  let player: unknown;
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `YouTube returned HTTP ${res.status}${fallback}` };
    player = extractPlayerResponse(await res.text());
  } catch {
    return { ok: false, error: `Could not reach YouTube${fallback}` };
  }

  const track = pickCaptionTrack(captionTracks(player), navigator.languages ?? ['en']);
  if (!track) return { ok: false, error: `This video has no captions${fallback}` };

  // Direct fetch first: one cheap request, and it just works if YouTube ever
  // relaxes the gating. Today it returns 200 with an EMPTY body — timedtext
  // requires a proof-of-origin token minted by the player, single-use — so the
  // real path is captionsViaTab, which captures the player's own request.
  let segments: TranscriptSegment[] = [];
  try {
    const res = await fetch(json3Url(track.baseUrl), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) segments = parseJson3(await res.json());
  } catch {
    // expected: empty body fails res.json(); fall through to the tab path
  }

  if (segments.length === 0) {
    const viaTab = await captionsViaTab(videoId);
    if ('error' in viaTab) return { ok: false, error: viaTab.error };
    segments = viaTab.segments;
  }
  if (segments.length === 0) {
    return { ok: false, error: `YouTube served an empty caption track${fallback}` };
  }

  const id = crypto.randomUUID();
  const recording = newRecording(
    id,
    { kind: 'youtube', videoId },
    Date.now(),
    videoTitle(player) || undefined,
  );
  const { recordings } = await getLocal('recordings');
  await setLocal({
    recordings: sortAndCap([
      {
        ...recording,
        segments,
        durationSeconds: segments[segments.length - 1].endSec,
        status: 'ready' as const,
      },
      ...recordings,
    ]),
  });

  await summarizeRecording(id);
  return { ok: true, id };
}

export async function deleteRecording(id: string): Promise<{ ok: boolean }> {
  const { recordings } = await getLocal('recordings');
  await setLocal({ recordings: recordings.filter((r) => r.id !== id) });

  // Deleting the recording that is (or claims to be) in flight has to clear the
  // session state too, or the button stays stuck on "Stop recording" against a
  // record that no longer exists.
  const { activeRecording } = await getSession('activeRecording');
  if (activeRecording?.id === id) {
    await setSession({ activeRecording: null });
    await broadcastMessage({ type: 'REC_STOP' });
    await releaseOffscreen('recorder');
    await updateBadge();
  }
  return { ok: true };
}

export async function renameRecording(id: string, title: string): Promise<{ ok: boolean }> {
  const clean = title.trim();
  if (!clean) return { ok: false };
  const { recordings } = await getLocal('recordings');
  await setLocal({ recordings: patchRecording(recordings, id, { title: clean }, Date.now()) });
  return { ok: true };
}

/**
 * Settle recordings stranded by a browser restart, and drop a stale
 * activeRecording — the offscreen document that was filling it is long gone.
 */
export async function reconcileRecordings(): Promise<void> {
  const { recordings } = await getLocal('recordings');
  const settled = reconcileOrphans(recordings, Date.now());
  if (settled.some((r, i) => r !== recordings[i])) await setLocal({ recordings: settled });
  await setSession({ activeRecording: null });
  await updateBadge();
}
