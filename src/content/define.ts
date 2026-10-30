import { clickedWord } from '../pages/reader/clickedWord';
import { TEXT_ANCHOR_CONTEXT_CHARS } from '../shared/textAnchor';

/*
 * Option/Alt-click a word on any page: its meaning, as the paper reader gives
 * it, in a small card by the click. The card is an extension page in an
 * iframe, so the model call, the API key and the answer never touch the page;
 * this script only finds the word and places the frame.
 */

const CARD_WIDTH = 340;
/** Where the reading layout of a page breaks: the word's paragraph is its context. */
const BLOCK = 'p, li, td, th, dd, dt, blockquote, figcaption, h1, h2, h3, h4, h5, h6, pre';

declare global {
  interface Window {
    __readerDefineStop?: () => void;
  }
}

/** A script orphaned by an extension reload can no longer reach its pages. */
const alive = () => Boolean(chrome.runtime?.id);

function start(): void {
  let host: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;

  const close = () => {
    host?.remove();
    host = null;
    frame = null;
  };

  const open = (
    hit: { word: string; context: string; near: string; prefix: string; suffix: string },
    x: number,
    y: number,
  ) => {
    close();
    const below = y < window.innerHeight / 2;
    const params = new URLSearchParams({ ...hit, src: location.href });
    host = document.createElement('div');
    // Closed shadow root: the page's CSS can't restyle the frame, nor its scripts reach it.
    const root = host.attachShadow({ mode: 'closed' });
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`src/pages/define/index.html?${params}`);
    frame.title = `Definition of ${hit.word}`;
    frame.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      `width: ${CARD_WIDTH}px`,
      'height: 96px',
      `left: ${Math.min(Math.max(x - CARD_WIDTH / 2, 8), window.innerWidth - CARD_WIDTH - 8)}px`,
      below ? `top: ${y + 14}px` : `bottom: ${window.innerHeight - y + 14}px`,
      'border: 0',
      'border-radius: 8px',
      'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18)',
      'color-scheme: normal',
    ].join(';');
    root.appendChild(frame);
    document.documentElement.appendChild(host);
  };

  const onClick = (e: MouseEvent) => {
    if (!alive()) return stop();
    if (!e.altKey || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = e.target as Element | null;
    // Alt-click is a multi-cursor or a form gesture in editors; leave those alone.
    if (!target || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const caret = document.caretPositionFromPoint(e.clientX, e.clientY);
    const node = caret?.offsetNode;
    if (!caret || !(node instanceof Text)) return;
    const block = node.parentElement?.closest(BLOCK) ?? node.parentElement;
    if (!block) return;
    let text = '';
    let offset = -1;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) offset = text.length + caret.offset;
      text += n.nodeValue ?? '';
    }
    // The caret lands on the nearer edge of a glyph: past the last letter when its right half is clicked.
    const hit = clickedWord(text, offset) ?? clickedWord(text, offset - 1);
    if (!hit) return;
    // The text either side of the word, so a kept note can find this occurrence again.
    const at = text.lastIndexOf(hit.word, offset);
    const start = at >= 0 && offset <= at + hit.word.length ? at : text.indexOf(hit.word);
    const end = start + hit.word.length;
    // Chrome downloads an Alt-clicked link; the click was for the word.
    e.preventDefault();
    e.stopPropagation();
    open(
      {
        ...hit,
        prefix: text.slice(Math.max(0, start - TEXT_ANCHOR_CONTEXT_CHARS), start),
        suffix: text.slice(end, end + TEXT_ANCHOR_CONTEXT_CHARS),
      },
      e.clientX,
      e.clientY,
    );
  };

  // A click outside the card, Esc or a scroll puts it away; clicks inside the frame never reach here.
  const onPointerDown = (e: PointerEvent) => {
    if (host && !(e.altKey && e.button === 0)) close();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const onMessage = (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data as { type?: string; height?: number };
    if (data?.type === 'reader-define-size' && typeof data.height === 'number') {
      frame.style.height = `${Math.min(Math.ceil(data.height), 420)}px`;
    } else if (data?.type === 'reader-define-close') {
      close();
    }
  };

  const stop = () => {
    close();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('message', onMessage);
    delete window.__readerDefineStop;
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, { capture: true, passive: true });
  window.addEventListener('message', onMessage);
  window.__readerDefineStop = stop;
}

// A re-injection after an extension reload replaces the orphan instead of doubling up.
window.__readerDefineStop?.();
start();
