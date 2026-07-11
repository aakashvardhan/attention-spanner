/**
 * Demo overlay, injected into every page via context.addInitScript.
 * Provides window.__demo:
 *   setCaption(text)      — bottom caption pill (empty string hides it)
 *   cursorTo(x, y, ms)    — ease the fake cursor to viewport coords
 *   clickPulse()          — click ripple at the cursor's position
 *   hideCursor()/showCursor()
 * All methods are safe to call before DOMContentLoaded (queued until ready).
 */
(() => {
  if (window.__demo) return;

  const state = { x: -100, y: -100, ready: false, queue: [] };
  let cursorEl = null;
  let captionEl = null;
  let captionText = null;

  function build() {
    const host = document.createElement('div');
    host.id = '__demo-overlay';
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

    cursorEl = document.createElement('div');
    cursorEl.style.cssText =
      'position:absolute;width:26px;height:26px;transform:translate(-4px,-3px);' +
      'transition:opacity .25s;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55));';
    cursorEl.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24">' +
      '<path d="M5 2 L5 19 L9.5 15.2 L12.3 21.3 L15 20 L12.2 14 L18 13.6 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

    captionEl = document.createElement('div');
    captionEl.style.cssText =
      'position:absolute;left:50%;bottom:56px;transform:translateX(-50%);' +
      'max-width:72%;padding:16px 30px;border-radius:16px;' +
      'background:rgba(12,14,20,.88);backdrop-filter:blur(6px);' +
      'border:1px solid rgba(255,255,255,.14);color:#f2f4f8;' +
      'font:600 27px/1.4 -apple-system,"SF Pro Display",Segoe UI,sans-serif;' +
      'letter-spacing:.1px;text-align:center;opacity:0;transition:opacity .35s;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.45);white-space:pre-line;';
    captionEl.textContent = '';

    host.append(captionEl, cursorEl);
    document.documentElement.appendChild(host);
    state.ready = true;
    place();
    for (const fn of state.queue) fn();
    state.queue.length = 0;
  }

  function place() {
    if (cursorEl) cursorEl.style.transform = `translate(${state.x - 4}px, ${state.y - 3}px)`;
  }

  const whenReady = (fn) => (state.ready ? fn() : state.queue.push(fn));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.__demo = {
    setCaption(text) {
      whenReady(() => {
        if (text === captionText) return;
        captionText = text;
        if (!text) {
          captionEl.style.opacity = '0';
          return;
        }
        captionEl.style.opacity = '0';
        setTimeout(() => {
          captionEl.textContent = text;
          captionEl.style.opacity = '1';
        }, captionEl.textContent ? 240 : 0);
      });
    },

    cursorTo(x, y, ms = 700) {
      return new Promise((resolve) => {
        whenReady(() => {
          const fromX = state.x;
          const fromY = state.y;
          const start = performance.now();
          const step = (t) => {
            const k = Math.min(1, (t - start) / ms);
            const e = ease(k);
            state.x = fromX + (x - fromX) * e;
            state.y = fromY + (y - fromY) * e;
            place();
            if (k < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
      });
    },

    clickPulse() {
      whenReady(() => {
        const ring = document.createElement('div');
        ring.style.cssText =
          `position:absolute;left:${state.x - 22}px;top:${state.y - 22}px;` +
          'width:44px;height:44px;border-radius:50%;border:3px solid #7aa2ff;' +
          'opacity:.95;transform:scale(.35);pointer-events:none;' +
          'transition:transform .45s ease-out,opacity .45s ease-out;';
        cursorEl.parentElement.appendChild(ring);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            ring.style.transform = 'scale(1.15)';
            ring.style.opacity = '0';
          }),
        );
        setTimeout(() => ring.remove(), 600);
      });
    },

    hideCursor() {
      whenReady(() => (cursorEl.style.opacity = '0'));
    },
    showCursor() {
      whenReady(() => (cursorEl.style.opacity = '1'));
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
