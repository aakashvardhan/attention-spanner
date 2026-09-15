import { FETCH_TIMEOUT_MS } from '../shared/constants';
import { getSession, setSession } from '../shared/storage';
import { getYouTubeVideoId } from '../shared/youtube';
import {
  captionTracks,
  extractPlayerResponse,
  json3Url,
  parseJson3,
  pickCaptionTrack,
  type TranscriptSegment,
} from '../shared/youtubeCaptions';
import { captureCaptionsFromPlayer, type TabCaptionResult } from '../shared/youtubeTabCaptions';

/**
 * The transcript of the video playing right now, for the side panel's Follow
 * pane. Fetched lazily and cached for the session — nothing here may fetch
 * speculatively, because the panel asks the moment a video starts playing and
 * most videos are never followed.
 *
 * Session rather than local storage: a transcript is only interesting while the
 * video is on screen, and caching them to disk would grow without a bound
 * nobody is watching.
 */

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
 * Re-inject the timedtext tee into YouTube tabs that are already open.
 *
 * `registerContentScripts` only covers future navigations, and injecting into a
 * loaded page is too late for the caption request it already made — but it does
 * put a live tee back for the SPA navigations that follow.
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
 * The transcript for a video, fetching it once if we do not have it.
 *
 * Never drives the player: the user is *watching* this video, and a question
 * about it must not start playback or flip captions on. That is why the tab
 * path here reads only what the tee already stashed.
 */
export async function transcriptFor(
  videoId: string,
): Promise<{ segments: TranscriptSegment[] } | { error: string }> {
  const { videoTranscripts } = await getSession('videoTranscripts');
  const cached = videoTranscripts[videoId];
  if (cached) return { segments: cached };

  let player: unknown;
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `YouTube returned HTTP ${res.status}.` };
    player = extractPlayerResponse(await res.text());
  } catch {
    return { error: 'Could not reach YouTube.' };
  }

  const track = pickCaptionTrack(captionTracks(player), navigator.languages ?? ['en']);
  if (!track) return { error: 'This video has no captions.' };

  // Direct fetch first: one cheap request, and it just works if YouTube ever
  // relaxes the gating. Today it returns 200 with an EMPTY body — timedtext
  // requires a proof-of-origin token minted by the player, single-use — so the
  // real path is captionsViaTab, which reads the player's own request.
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
    if ('error' in viaTab) return { error: viaTab.error };
    segments = viaTab.segments;
  }
  if (segments.length === 0) return { error: 'YouTube served an empty caption track.' };

  const { videoTranscripts: latest } = await getSession('videoTranscripts');
  await setSession({ videoTranscripts: { ...latest, [videoId]: segments } });
  return { segments };
}

/** Injection errors worth retrying: the player just hasn't booted yet. */
const RETRYABLE = new Set(['no-player', 'player-api']);

const TAB_CAPTION_ERRORS: Record<string, string> = {
  'no-player': 'The video player never appeared — is the tab still loading?',
  'no-tracks': 'This video has no caption tracks.',
  'no-request': 'Could not read the captions the player loaded.',
  'player-api': 'Could not read this video’s captions.',
  'tee-missing': 'Reload the video tab once to follow along.',
};

/**
 * Read the caption track from inside the video's own tab. The tee content
 * script stashed the body of the player's own timedtext request — the one
 * request YouTube cannot gate, since the player mints the proof-of-origin token
 * it demands.
 */
async function captionsViaTab(
  videoId: string,
): Promise<{ segments: TranscriptSegment[] } | { error: string }> {
  const tabId = await findVideoTab(videoId);
  if (tabId === null) return { error: 'That video is not open in a tab.' };

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
  return { error: TAB_CAPTION_ERRORS[lastError] ?? 'Could not read the captions.' };
}

/** The video's tab, if it is open. */
async function findVideoTab(videoId: string): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] });
  return tabs.find((tab) => tab.url && getYouTubeVideoId(tab.url) === videoId)?.id ?? null;
}
