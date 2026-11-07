// Functions the side panel runs in a YouTube tab (chrome.scripting
// executeScript `func`). They are static here because extension pages may
// not build functions at run time (CSP: no eval).

/** Jumps the page's video to `t` seconds and plays it. */
export function seekVideo(t) {
  const v = document.querySelector('video');
  if (!v) return false;
  v.currentTime = t;
  const p = v.play();
  if (p) p.catch(() => {});
  return true;
}

/** Where the page's video is, in seconds (0 without one). */
export function videoPosition() {
  const v = document.querySelector('video');
  return v ? v.currentTime : 0;
}

// Handed to Rust as values, to pass on as executeScript's `func`.
export const seekFn = () => seekVideo;
export const positionFn = () => videoPosition;
