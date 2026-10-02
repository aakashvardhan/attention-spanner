import { extensionAlive, sendMessage, type ResumeTarget } from '../shared/messages';

/**
 * Reading tracker, injected dynamically into known article tabs.
 * Tracks how far the user has scrolled and how long they've actively read;
 * flushes a final update when the tab goes hidden so the service worker can
 * schedule a come-back nudge. Restores scroll position on resume.
 *
 * Bundled standalone (IIFE) by esbuild — chrome.scripting.executeScript
 * cannot inject module scripts.
 */

declare global {
  interface Window {
    /**
     * Present while an instance is running. Calling it runs inside *that*
     * instance's closure, so it reports whether that instance's extension
     * context is still valid — something a replacement cannot see otherwise.
     */
    __readerTrackerAlive?: () => boolean;
    __readerTrackerStop?: () => void;
  }
}

const REPORT_INTERVAL_MS = 5000;
const ACTIVITY_WINDOW_MS = 60_000;
const RESTORE_RETRY_MS = 500;
const RESTORE_MAX_MS = 4000;
/** How close to the target counts as restored */
const RESTORE_TOLERANCE_PX = 4;

// A live instance short-circuits repeat injections. An orphaned one must be
// evicted instead: it can never report again, and a tab the user is simply
// sitting on will not navigate to trigger a fresh injection on its own.
if (window.__readerTrackerAlive?.() !== true) {
  window.__readerTrackerStop?.();
  initTracker();
}

function initTracker() {
  let lastActivityAt = Date.now();
  let activeSecondsPending = 0;
  let lastSentHidden = false;
  let userInteracted = false;

  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const markInteraction = () => {
    userInteracted = true;
    markActivity();
  };

  const alive = () => extensionAlive();
  const teardown = () => {
    clearInterval(activityTimer);
    clearInterval(reportTimer);
    window.removeEventListener('scroll', markActivity);
    window.removeEventListener('mousemove', markActivity);
    window.removeEventListener('wheel', markInteraction);
    window.removeEventListener('touchstart', markInteraction);
    window.removeEventListener('keydown', markInteraction);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    // Only disown the globals if they are still ours — a replacement that
    // evicted us has already installed its own.
    if (window.__readerTrackerAlive === alive) {
      delete window.__readerTrackerAlive;
      delete window.__readerTrackerStop;
    }
  };

  window.addEventListener('scroll', markActivity, { passive: true });
  window.addEventListener('mousemove', markActivity, { passive: true });
  window.addEventListener('wheel', markInteraction, { passive: true });
  window.addEventListener('touchstart', markInteraction, { passive: true });
  window.addEventListener('keydown', markInteraction);

  const pageHeight = () => document.documentElement.scrollHeight;
  const percent = () => {
    const height = pageHeight();
    if (height <= 0) return 0;
    return Math.min(100, ((window.scrollY + window.innerHeight) / height) * 100);
  };

  // Accumulate active reading time: visible + input within the last minute
  const activityTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastActivityAt < ACTIVITY_WINDOW_MS) {
      activeSecondsPending += 1;
    }
  }, 1000);

  async function report(hidden: boolean) {
    // Skip only exact duplicates of a hidden flush; visible reports always go
    // out so the service worker can cancel a pending nudge.
    if (hidden && lastSentHidden) return;
    lastSentHidden = hidden;
    const delta = activeSecondsPending;
    activeSecondsPending = 0;
    try {
      await sendMessage({
        type: 'PROGRESS_UPDATE',
        percent: percent(),
        scrollY: window.scrollY,
        pageHeight: pageHeight(),
        activeSecondsDelta: delta,
        hidden,
      });
    } catch {
      // Extension reloaded/updated — this orphaned script can't reach it anymore
      activeSecondsPending += delta;
    }
  }

  const reportTimer = window.setInterval(() => {
    // Self-evict rather than spin timers forever against a dead context
    if (!extensionAlive()) return teardown();
    if (document.visibilityState === 'visible') {
      void report(false);
    }
  }, REPORT_INTERVAL_MS);

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      void report(true);
    } else {
      lastSentHidden = false;
      markActivity();
      void report(false);
    }
  };
  const onPageHide = () => void report(true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  window.__readerTrackerAlive = alive;
  window.__readerTrackerStop = teardown;

  // Announce readiness; restore scroll if the worker hands back a target
  void (async () => {
    try {
      const res = await sendMessage({ type: 'TRACKER_READY' });
      if (res?.resume) restoreScroll(res.resume);
    } catch {
      // Worker unavailable; tracking still works, just no resume
    }
  })();

  function restoreScroll(target: ResumeTarget) {
    const startedAt = Date.now();

    const attempt = () => {
      // The user started reading/scrolling — never fight them for the scrollbar
      if (userInteracted) return;
      // Percent-based target: layout (ads, lazy images) shifts between loads,
      // so a stored ratio survives better than an absolute pixel offset
      const targetY =
        target.pageHeight > 0
          ? (target.scrollY / target.pageHeight) * pageHeight()
          : target.scrollY;
      // Only ever scroll forward. This script is now re-injected into pages
      // that are already open, where the stored offset predates however long
      // the tracker was orphaned — restoring it would throw away real reading.
      if (window.scrollY > targetY + RESTORE_TOLERANCE_PX) return;
      if (Math.abs(window.scrollY - targetY) > RESTORE_TOLERANCE_PX) {
        window.scrollTo({ top: targetY, behavior: 'instant' as ScrollBehavior });
      }
      if (Date.now() - startedAt < RESTORE_MAX_MS) {
        setTimeout(attempt, RESTORE_RETRY_MS);
      }
    };
    attempt();
  }
}

export {};
