import { extensionAlive } from '../shared/messages';

/**
 * The floating Jarvis overlay — Pluely's shape, within what a Chrome extension
 * can actually do. Two honest limits, stated so nobody expects otherwise: it
 * lives inside the page rather than above every app, and it is visible on a
 * screen share like any other page content. There is no stealth here.
 *
 * The window is an <iframe> pointing at an extension page, not markup built in
 * this file. That is what gives the panel theme.css, the bundled font and the
 * extension's own CSP, none of which a content script can have — and it means
 * the overlay and the side panel render the exact same component instead of two
 * that drift apart. This file owns only the frame: where it sits, dragging it,
 * and taking it away.
 *
 * Bundled standalone (IIFE) by esbuild — chrome.scripting.executeScript cannot
 * inject module scripts.
 */

declare global {
  interface Window {
    /** Runs inside the owning instance's closure — see timePill.ts */
    __readerCopilotAlive?: () => boolean;
    __readerCopilotStop?: () => void;
    __readerCopilotToggle?: () => void;
  }
}

const WIDTH = 380;
const HEIGHT = 520;
const MARGIN = 16;

if (window.__readerCopilotAlive?.() === true) {
  // Already running: the command is a toggle, not a second overlay.
  window.__readerCopilotToggle?.();
} else {
  window.__readerCopilotStop?.();
  initOverlay();
}

function initOverlay() {
  const mount = document.createElement('div');
  mount.dataset.readerCopilot = '1';
  const root = mount.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .frame {
      position: fixed;
      right: ${MARGIN}px;
      bottom: ${MARGIN}px;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
      background: #fff;
    }
    /* The pill sits one above us, so stay one below it. */
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px 6px 12px;
      cursor: grab;
      user-select: none;
      font: 600 12px/1.4 -apple-system, system-ui, sans-serif;
      color: #fff;
      background: rgba(40, 44, 52, 0.96);
    }
    .bar[data-dragging='1'] { cursor: grabbing; }
    .close {
      border: none;
      background: none;
      color: #fff;
      font: 16px/1 -apple-system, system-ui, sans-serif;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .close:hover { background: rgba(255, 255, 255, 0.16); }
    iframe {
      flex: 1 1 auto;
      border: none;
      width: 100%;
      /* Pointer events land in the frame; while dragging they must not, or the
         iframe swallows the mousemove and the panel sticks to the cursor. */
    }
    .frame[data-dragging='1'] iframe { pointer-events: none; }
  `;

  const frame = document.createElement('div');
  frame.className = 'frame';

  const bar = document.createElement('div');
  bar.className = 'bar';
  const title = document.createElement('span');
  title.textContent = 'Jarvis';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close';
  close.addEventListener('click', teardown);
  bar.append(title, close);

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('src/pages/overlay/index.html');
  iframe.title = 'Jarvis live copilot';

  frame.append(bar, iframe);
  root.append(style, frame);
  (document.body ?? document.documentElement).appendChild(mount);

  /* Dragging. Positioned from the left/top once moved, so the right/bottom
     anchors stop applying — set both to auto rather than fighting them. */
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  bar.addEventListener('mousedown', (e) => {
    const rect = frame.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    frame.dataset.dragging = '1';
    bar.dataset.dragging = '1';
    e.preventDefault();
  });

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    // Clamped so the title bar can never be dragged out of reach.
    const x = Math.max(0, Math.min(window.innerWidth - WIDTH, e.clientX - offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
    frame.style.left = `${x}px`;
    frame.style.top = `${y}px`;
    frame.style.right = 'auto';
    frame.style.bottom = 'auto';
  };

  const onUp = () => {
    dragging = false;
    delete frame.dataset.dragging;
    delete bar.dataset.dragging;
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') teardown();
  };
  document.addEventListener('keydown', onKey);

  // Self-evict when the extension is reloaded, matching timePill.ts — an
  // orphaned overlay would show a frame whose page can no longer load.
  const watchdog = window.setInterval(() => {
    if (!extensionAlive()) teardown();
  }, 5000);

  function teardown() {
    clearInterval(watchdog);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
    mount.remove();
    if (window.__readerCopilotAlive === alive) {
      delete window.__readerCopilotAlive;
      delete window.__readerCopilotStop;
      delete window.__readerCopilotToggle;
    }
  }

  const alive = () => extensionAlive();
  window.__readerCopilotAlive = alive;
  window.__readerCopilotStop = teardown;
  // Re-running the command closes it. Injection is the only way in, so the
  // toggle has to live here rather than in the worker.
  window.__readerCopilotToggle = teardown;
}
