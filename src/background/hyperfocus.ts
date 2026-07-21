import { NOTIFICATION_IDS } from '../shared/constants';
import { getSession, getSettings, setSession } from '../shared/storage';

/**
 * Hyperfocus guardrail — the inverse of a focus timer. The trackers already
 * report engagement deltas every ~5s while the user actively reads/watches;
 * this accumulates them into an "unbroken run" and fires a gentle break
 * nudge when the run crosses the configured threshold. The run resets when
 * a hidden/stopped flush arrives or the deltas stop coming (walked away).
 */

/** Deltas arrive ~5s apart while engaged; a longer silence means a real break */
const ENGAGEMENT_GAP_MS = 3 * 60 * 1000;
/** Keep nudging this often while the run continues past the threshold */
const RENOTIFY_SECONDS = 30 * 60;

export async function recordEngagement(deltaSeconds: number, ended: boolean): Promise<void> {
  const { hyperfocus } = await getSession('hyperfocus');
  const now = Date.now();

  if (ended) {
    if (hyperfocus.unbrokenSeconds > 0) {
      await setSession({ hyperfocus: { unbrokenSeconds: 0, lastDeltaAt: now, notifiedAtSeconds: 0 } });
    }
    return;
  }
  if (deltaSeconds <= 0) return;

  let state = hyperfocus;
  if (now - state.lastDeltaAt > ENGAGEMENT_GAP_MS) {
    state = { unbrokenSeconds: 0, lastDeltaAt: now, notifiedAtSeconds: 0 };
  }
  state.unbrokenSeconds += deltaSeconds;
  state.lastDeltaAt = now;

  const settings = await getSettings();
  const threshold = settings.hyperfocusMinutes * 60;
  const due =
    settings.hyperfocusMinutes > 0 &&
    state.unbrokenSeconds >= threshold &&
    (state.notifiedAtSeconds === 0 ||
      state.unbrokenSeconds - state.notifiedAtSeconds >= RENOTIFY_SECONDS);

  if (due) {
    state.notifiedAtSeconds = state.unbrokenSeconds;
    if (settings.notificationsEnabled) {
      const minutes = Math.round(state.unbrokenSeconds / 60);
      chrome.notifications.create(NOTIFICATION_IDS.hyperfocus, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: `${minutes} minutes locked in`,
        message:
          'Hyperfocus check: water, stand up, look 20 feet away for 20 seconds. The work will still be here.',
        priority: 0,
      });
    }
  }

  await setSession({ hyperfocus: state });
}
