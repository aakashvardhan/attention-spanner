/**
 * Caption capture that runs INSIDE the YouTube tab (chrome.scripting, world
 * MAIN). YouTube serves caption tracks only to the player's own request — the
 * URL carries a single-use BotGuard proof-of-origin token, and refetching it
 * from any context returns an empty body (verified empirically). The tee at
 * src/content/timedtextTee.ts (document_start, before the player binds its
 * network references) stashes the body of that request on the page's window;
 * this function reads the stash, and when it's empty, drives the player's
 * captions API to force a fresh request and waits for the stash to fill.
 *
 * IMPORTANT: serialized by chrome.scripting.executeScript — must stay
 * completely self-contained. No imports, no outer-scope references.
 */

export interface TabCaptionResult {
  ok: boolean;
  /** Raw body of the player's caption request (json3 when the URL says so) */
  body?: string;
  /** The URL the player used — carries v=<id> and fmt=, for validation */
  url?: string;
  error?: string;
}

export function captureCaptionsFromPlayer(videoId: string): Promise<TabCaptionResult> {
  const DEADLINE_MS = 12_000;
  const POLL_MS = 250;

  return new Promise((resolve) => {
    /* eslint-disable @typescript-eslint/no-explicit-any -- page globals */
    const w = window as any;
    const player = document.getElementById('movie_player') as any;
    let settled = false;
    let startedPlayback = false;
    let captionsWereOff = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const finish = (result: TabCaptionResult) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      try {
        // Leave the tab the way it was found
        if (startedPlayback) player?.pauseVideo?.();
        if (captionsWereOff) player?.unloadModule?.('captions');
      } catch {
        /* the player can be torn down mid-capture; nothing to restore then */
      }
      resolve(result);
    };

    // The tee stamps null at document_start; undefined means it never ran —
    // a tab from before the extension (re)load. A reload injects it.
    if (w.__readerTimedtext === undefined) {
      finish({ ok: false, error: 'tee-missing' });
      return;
    }

    // Only accept a stash for THIS video — the tab is an SPA, and the stash
    // may hold the captions of whatever was watched before it.
    const stashFor = (id: string) => {
      const hit = w.__readerTimedtext;
      return hit && typeof hit.url === 'string' && hit.url.indexOf(`v=${id}`) !== -1 ? hit : null;
    };

    const ready = stashFor(videoId);
    if (ready) {
      finish({ ok: true, body: ready.body, url: ready.url });
      return;
    }

    if (!player) {
      finish({ ok: false, error: 'no-player' });
      return;
    }

    pollTimer = setInterval(() => {
      const hit = stashFor(videoId);
      if (hit) finish({ ok: true, body: hit.body, url: hit.url });
    }, POLL_MS);
    setTimeout(() => finish({ ok: false, error: 'no-request' }), DEADLINE_MS);

    // Drive the player: force a FRESH caption request (a cached track never
    // hits the network, and the stash would stay empty until the deadline)
    try {
      const prior = (() => {
        try {
          return player.getOption?.('captions', 'track');
        } catch {
          return null;
        }
      })();
      captionsWereOff = !prior || !prior.languageCode;

      player.unloadModule?.('captions');
      player.loadModule?.('captions');

      setTimeout(() => {
        if (settled) return;
        try {
          const tracklist = player.getOption?.('captions', 'tracklist') ?? [];
          if (!tracklist.length) {
            finish({ ok: false, error: 'no-tracks' });
            return;
          }
          player.setOption?.('captions', 'track', tracklist[0]);
          // Some player builds only fetch the track once playback runs
          setTimeout(() => {
            if (!settled && player.getPlayerState?.() !== 1) {
              startedPlayback = true;
              player.playVideo?.();
            }
          }, 4000);
        } catch {
          finish({ ok: false, error: 'player-api' });
        }
      }, 600);
    } catch {
      finish({ ok: false, error: 'player-api' });
    }
  });
}
