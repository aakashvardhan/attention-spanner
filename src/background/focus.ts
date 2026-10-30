import { logActivity } from '../shared/activity';
import {
  ALARMS,
  BLOCKED_PAGE_PATH,
  CHIME_PAGE_PATH,
  NOTIFICATION_IDS,
} from '../shared/constants';
import { isBlockedHost, nextPhase } from '../shared/focusRules';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { FocusSession, Settings } from '../shared/types';
import { syncSessionAccessRules } from './accessRules';
import { updateBadge } from './feeds';

/**
 * Focus-mode session engine: a clocked-in shift of Pomodoro rounds. A focus
 * phase blocks, its break does not, and the shift cycles until clock out. Blocking is enforced by declarativeNetRequest
 * session rules, which the browser applies independently of this worker's
 * lifetime. State (storage.local focusSession) remains the source of truth and
 * rules are reconciled on startup.
 */

function blockedPageUrl(): string {
  return chrome.runtime.getURL(BLOCKED_PAGE_PATH);
}

/** An already-open Netflix tab would defeat the whole point */
export async function redirectOpenBlockedTabs(domains: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    try {
      const host = new URL(tab.url).hostname;
      if (isBlockedHost(host, domains)) {
        await chrome.tabs.update(tab.id, { url: `${blockedPageUrl()}#${tab.url}` });
      }
    } catch {
      // unparseable URL — skip
    }
  }
}

function notifyPhase(title: string, message: string, settings: Settings): void {
  if (!settings.notificationsEnabled) return;
  chrome.notifications.create(NOTIFICATION_IDS.focusPhase, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
    priority: 0,
    // The alarm is the sound; an OS ding on top of it would cut the swell.
    silent: settings.focusSound,
  });
}

/**
 * The phase chime. A service worker cannot play audio, so an offscreen
 * document plays it on load; the last chime's document is closed first (one
 * offscreen document at a time). Fire-and-forget: sound must never break the timer.
 */
async function chime(kind: 'focus' | 'break'): Promise<void> {
  const settings = await getSettings();
  if (!settings.focusSound) return;
  await chrome.offscreen.closeDocument().catch(() => undefined);
  await chrome.offscreen.createDocument({
    url: `${CHIME_PAGE_PATH}#${kind}`,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Chime when a focus round or a break ends',
  });
}

/** Clock in: round 1 starts now */
export async function startFocus(config: { focusMinutes: number; intention?: string }): Promise<{ ok: boolean }> {
  const focusMinutes = Math.min(240, Math.max(5, Math.round(config.focusMinutes)));
  const intention = config.intention?.trim().slice(0, 120);
  const now = Date.now();

  const session: FocusSession = {
    startedAt: now,
    phase: 'focus',
    phaseStartedAt: now,
    phaseEndsAt: now + focusMinutes * 60_000,
    focusMinutes,
    round: 1,
    ...(intention ? { intention } : {}),
  };
  await setLocal({ focusSession: session });

  const settings = await getSettings();
  await syncSessionAccessRules();
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  chrome.alarms.create(ALARMS.focusBadgeTick, { periodInMinutes: 1 });
  await redirectOpenBlockedTabs(settings.focusBlocklist);
  await updateBadge();
  void chime('focus').catch(() => undefined);
  return { ok: true };
}

/** Clock out: the shift's minutes go into today's activity */
export async function stopFocus(_early: boolean): Promise<{ ok: boolean }> {
  const { focusSession: session } = await getLocal('focusSession');
  await chrome.alarms.clear(ALARMS.focusPhaseEnd);
  await chrome.alarms.clear(ALARMS.focusBadgeTick);
  await setLocal({ focusSession: null });
  if (session) await logActivity({ clocked: Math.round((Date.now() - session.startedAt) / 60_000) });
  await syncSessionAccessRules();
  await updateBadge();
  return { ok: true };
}

/** Move the shift on a phase: focus → break (unblock), break → next round (block) */
async function advancePhase(session: FocusSession): Promise<void> {
  const settings = await getSettings();
  const next = nextPhase(session, settings.breakMinutes, Date.now());
  await setLocal({ focusSession: next });
  if (session.phase === 'focus') await logActivity({ focus: true });
  await syncSessionAccessRules();
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: next.phaseEndsAt });
  if (next.phase === 'focus') await redirectOpenBlockedTabs(settings.focusBlocklist);
  await updateBadge();
  void chime(next.phase).catch(() => undefined);
  if (next.phase === 'break') {
    notifyPhase(
      `Round ${session.round} done`,
      `${settings.breakMinutes}-minute break. Sites are open; get up and look far away.`,
      settings,
    );
  } else {
    notifyPhase(
      `Round ${next.round}`,
      `${next.focusMinutes} minutes of focus. Sites are blocked again.`,
      settings,
    );
  }
}

export async function handleFocusPhaseEnd(): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session) {
    // Stray/duplicate alarm — rules must never outlive state
    await syncSessionAccessRules();
    return;
  }
  // A duplicate alarm for a phase already advanced
  if (session.phaseEndsAt > Date.now() + 1000) return;
  await advancePhase(session);
}

/** End the break now and start the next round */
export async function skipBreak(): Promise<{ ok: boolean }> {
  const { focusSession: session } = await getLocal('focusSession');
  if (session?.phase !== 'break') return { ok: false };
  await advancePhase(session);
  return { ok: true };
}

/**
 * onStartup/onInstalled: state must win. Never auto-resume blocking after
 * arbitrary downtime: a phase that expired while closed clocks you out at the
 * end of that phase, and a focus round that ran out still counts (the time
 * was served).
 */
export async function reconcileFocusOnStartup(): Promise<void> {
  const { focusSession: stored } = await getLocal('focusSession');

  if (!stored) {
    await syncSessionAccessRules();
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    return;
  }
  // A session started before Pomodoro came back (no phase stored) is one focus round.
  const legacy = !stored.phase;
  const session: FocusSession = legacy
    ? { ...stored, phase: 'focus', phaseStartedAt: stored.startedAt, round: 1 }
    : stored;

  if (session.phaseEndsAt <= Date.now()) {
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    await setLocal({ focusSession: null });
    if (session.phase === 'focus') await logActivity({ focus: true });
    await logActivity({ clocked: Math.round((session.phaseEndsAt - session.startedAt) / 60_000) });
    await syncSessionAccessRules();
    await updateBadge();
    return;
  }

  // Phase still live: re-arm the alarms and sync rules to the phase
  if (legacy) await setLocal({ focusSession: session });
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  chrome.alarms.create(ALARMS.focusBadgeTick, { periodInMinutes: 1 });
  await syncSessionAccessRules();
  await updateBadge();
}

/** Blocklist edited mid-session: refresh rules if currently blocking */
export async function refreshFocusRules(newBlocklist: string[]): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session) return;
  await syncSessionAccessRules();
  await redirectOpenBlockedTabs(newBlocklist);
}
