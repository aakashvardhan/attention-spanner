import { sendMessage, type ResumeTarget } from '../shared/messages';

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
    __readerTrackerLoaded?: boolean;
  }
}

const REPORT_INTERVAL_MS = 5000;
const ACTIVITY_WINDOW_MS = 60_000;
const RESTORE_RETRY_MS = 500;
const RESTORE_MAX_MS = 4000;

if (!window.__readerTrackerLoaded) {
  window.__readerTrackerLoaded = true;
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
  setInterval(() => {
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

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      void report(false);
    }
  }, REPORT_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void report(true);
    } else {
      lastSentHidden = false;
      markActivity();
      void report(false);
    }
  });
  window.addEventListener('pagehide', () => void report(true));

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
      if (Math.abs(window.scrollY - targetY) > 4) {
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
