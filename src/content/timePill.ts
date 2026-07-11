import { sendMessage } from '../shared/messages';

/**
 * Visible time pill — a small floating "⏱ 23m" badge on user-chosen sites,
 * externalizing time-on-site for time-blind brains. Counts only visible
 * seconds; totals are per-host per-local-day, persisted by the service
 * worker so navigations and tab switches don't reset the number.
 *
 * Bundled standalone (IIFE) by esbuild — chrome.scripting.executeScript
 * cannot inject module scripts. Rendered in a closed shadow root so host
 * page CSS can't restyle it.
 */

declare global {
  interface Window {
    __readerTimePillLoaded?: boolean;
  }
}

const FLUSH_INTERVAL_MS = 15_000;
const WARM_MINUTES = 10;
const HOT_MINUTES = 25;

if (!window.__readerTimePillLoaded) {
  window.__readerTimePillLoaded = true;
  initPill();
}

function initPill() {
  const host = location.hostname;
  let totalSeconds = 0;
  let pendingSeconds = 0;

  const mount = document.createElement('div');
  mount.dataset.readerTimePill = '1';
  const root = mount.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .pill {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483646;
      font: 600 12px/1 -apple-system, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      padding: 7px 12px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      color: #fff;
      background: rgba(55, 60, 70, 0.85);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      transition: background 0.5s;
    }
    .pill[data-level='warm'] { background: rgba(217, 119, 6, 0.9); }
    .pill[data-level='hot'] { background: rgba(220, 38, 38, 0.92); }
  `;
  const pill = document.createElement('button');
  pill.className = 'pill';
  pill.title = 'Time on this site today — click to hide until your next visit';
  pill.addEventListener('click', () => mount.remove());
  root.append(style, pill);

  function render() {
    const minutes = Math.floor(totalSeconds / 60);
    pill.textContent =
      minutes < 60 ? `⏱ ${minutes}m` : `⏱ ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    pill.dataset.level = minutes >= HOT_MINUTES ? 'hot' : minutes >= WARM_MINUTES ? 'warm' : 'cool';
  }

  // Seed with today's accumulated time for this host, then show
  void (async () => {
    try {
      const res = await sendMessage({ type: 'TIME_PILL_READY', host });
      totalSeconds = res.todaySeconds;
    } catch {
      // Worker unavailable — count from zero, still useful
    }
    render();
    (document.body ?? document.documentElement).appendChild(mount);
  })();

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      totalSeconds += 1;
      pendingSeconds += 1;
      render();
    }
  }, 1000);

  function flush() {
    if (pendingSeconds === 0) return;
    const delta = pendingSeconds;
    pendingSeconds = 0;
    sendMessage({ type: 'TIME_PILL_TICK', host, seconds: delta }).catch(() => {
      pendingSeconds += delta;
    });
  }

  setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
