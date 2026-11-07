// Functions the side panel runs in a YouTube tab (chrome.scripting
// executeScript `func`, MAIN world). They are static here because extension
// pages may not build functions at run time (CSP: no eval). executeScript
// sends only each function's own source, so each is self-contained: no
// helpers from this module. YouTube's own player API comes first: during an
// ad the page's <video> is the ad.

/** Jumps the video to `t` seconds and plays it. */
export function seekVideo(t) {
  const p = document.getElementById('movie_player');
  if (p && typeof p.seekTo === 'function') {
    p.seekTo(t, true);
    if (typeof p.playVideo === 'function') p.playVideo();
    return true;
  }
  const v = document.querySelector('video');
  if (!v) return false;
  v.currentTime = t;
  const playing = v.play();
  if (playing) playing.catch(() => {});
  return true;
}

/** Where the video is, in seconds (0 without one). */
export function videoPosition() {
  const p = document.getElementById('movie_player');
  if (p && typeof p.getCurrentTime === 'function') return p.getCurrentTime();
  const v = document.querySelector('video');
  return v ? v.currentTime : 0;
}

// Handed to Rust as values, to pass on as executeScript's `func`.
export const seekFn = () => seekVideo;
export const positionFn = () => videoPosition;
