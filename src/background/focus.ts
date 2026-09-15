import {
  ALARMS,
  BLOCKED_PAGE_PATH,
  FLOWTUNES_URL,
  NOTIFICATION_IDS,
} from '../shared/constants';
import { isBlockedHost } from '../shared/focusRules';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { FocusSession } from '../shared/types';
import { syncSessionAccessRules } from './accessRules';
import { updateBadge } from './feeds';

/**
 * Focus-mode session engine. Blocking is enforced by declarativeNetRequest
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

function notifyPhase(title: string, message: string, notificationsEnabled: boolean): void {
  if (!notificationsEnabled) return;
  chrome.notifications.create(NOTIFICATION_IDS.focusPhase, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
    priority: 0,
  });
}

/** Open Flowtunes pinned and unfocused; reuse an existing tab (never steal focus) */
async function openFocusMusic(): Promise<void> {
  const existing = await chrome.tabs.query({ url: '*://*.flowtunes.app/*' });
  if (existing.length > 0) return;
  await chrome.tabs.create({ url: FLOWTUNES_URL, pinned: true, active: false });
}

export async function startFocus(config: {
  mode: 'oneshot' | 'pomodoro';
  focusMinutes: number;
  breakMinutes: number;
}): Promise<{ ok: boolean }> {
  const focusMinutes = Math.min(240, Math.max(5, Math.round(config.focusMinutes)));
  const breakMinutes = Math.min(60, Math.max(1, Math.round(config.breakMinutes || 10)));
  const now = Date.now();

  const session: FocusSession = {
    mode: config.mode,
    phase: 'focus',
    startedAt: now,
    phaseEndsAt: now + focusMinutes * 60_000,
    focusMinutes,
    breakMinutes,
    completedBlocks: 0,
  };
  await setLocal({ focusSession: session });

  const settings = await getSettings();
  await syncSessionAccessRules();
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  chrome.alarms.create(ALARMS.focusBadgeTick, { periodInMinutes: 1 });
  await redirectOpenBlockedTabs(settings.focusBlocklist);
  if (settings.focusMusicEnabled) {
    await openFocusMusic();
  }
  await updateBadge();
  return { ok: true };
}

export async function stopFocus(_early: boolean): Promise<{ ok: boolean }> {
  await chrome.alarms.clear(ALARMS.focusPhaseEnd);
  await chrome.alarms.clear(ALARMS.focusBadgeTick);
  await setLocal({ focusSession: null });
  await syncSessionAccessRules();
  await updateBadge();
  return { ok: true };
}

/** Phase math always uses Date.now() — a throttled alarm must never schedule a phase in the past */
export async function handleFocusPhaseEnd(): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session) {
    // Stray/duplicate alarm — rules must never outlive state
    await syncSessionAccessRules();
    return;
  }
  const settings = await getSettings();
  const now = Date.now();

  if (session.phase === 'focus') {
    if (session.mode === 'oneshot') {
      await chrome.alarms.clear(ALARMS.focusBadgeTick);
      await setLocal({ focusSession: null });
      await syncSessionAccessRules();
      await updateBadge();
      notifyPhase(
        'Focus complete',
        `${session.focusMinutes} minutes banked. Sites are open again.`,
        settings.notificationsEnabled,
      );
      return;
    }

    // Pomodoro: focus → break (breaks unblock)
    session.completedBlocks += 1;
    session.phase = 'break';
    session.phaseEndsAt = now + session.breakMinutes * 60_000;
    await setLocal({ focusSession: session });
    await syncSessionAccessRules();
    chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
    await updateBadge();
    notifyPhase(
      'Break time',
      `${session.breakMinutes} minutes — sites are open. Block ${session.completedBlocks} done.`,
      settings.notificationsEnabled,
    );
    return;
  }

  // Pomodoro: break → focus (re-block)
  session.phase = 'focus';
  session.phaseEndsAt = now + session.focusMinutes * 60_000;
  await setLocal({ focusSession: session });
  await syncSessionAccessRules();
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  await redirectOpenBlockedTabs(settings.focusBlocklist);
  await updateBadge();
  notifyPhase(
    'Back to focus',
    `${session.focusMinutes} minutes. Sites re-blocked.`,
    settings.notificationsEnabled,
  );
}

/**
 * onStartup/onInstalled: state must win. Never auto-resume blocking after
 * arbitrary downtime; a focus phase that expired while closed still earns its
 * block (the time was served).
 */
export async function reconcileFocusOnStartup(): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');

  if (!session) {
    await syncSessionAccessRules();
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    return;
  }

  if (session.phaseEndsAt <= Date.now()) {
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    await setLocal({ focusSession: null });
    await syncSessionAccessRules();
    await updateBadge();
    return;
  }

  // Phase still live: re-arm the alarms and sync rules to the phase
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  chrome.alarms.create(ALARMS.focusBadgeTick, { periodInMinutes: 1 });
  await syncSessionAccessRules();
  await updateBadge();
}

/** Blocklist edited mid-session: refresh rules if currently blocking */
export async function refreshFocusRules(newBlocklist: string[]): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session || session.phase !== 'focus') return;
  await syncSessionAccessRules();
  await redirectOpenBlockedTabs(newBlocklist);
}
