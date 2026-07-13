import {
  ALARMS,
  BLOCKED_PAGE_PATH,
  FLOWTUNES_URL,
  FOCUS_DNR_ID_BASE,
  NOTIFICATION_IDS,
} from '../shared/constants';
import { buildFocusRules, isBlockedHost } from '../shared/focusRules';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { FocusSession } from '../shared/types';
import { updateBadge } from './feeds';
import { awardXp } from './gamification';
import { recordFocusBlock } from './streaks';

/**
 * Focus-mode session engine. Blocking is enforced by declarativeNetRequest
 * dynamic rules, which the browser applies independently of this worker's
 * lifetime and across restarts — so state (storage.local focusSession) is
 * the source of truth and rules are reconciled to it on every startup.
 */

function blockedPageUrl(): string {
  return chrome.runtime.getURL(BLOCKED_PAGE_PATH);
}

async function ownedRuleIds(): Promise<number[]> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.map((r) => r.id).filter((id) => id >= FOCUS_DNR_ID_BASE);
}

async function installBlockRules(domains: string[]): Promise<void> {
  // Never block the focus-music site — a blocklisted flowtunes.app would
  // silently kill the user's own music tab mid-session
  const effective = domains.filter((d) => d !== 'flowtunes.app');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: await ownedRuleIds(),
    addRules: buildFocusRules(effective, blockedPageUrl()),
  });
}

async function clearBlockRules(): Promise<void> {
  const ids = await ownedRuleIds();
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }
}

/** An already-open Netflix tab would defeat the whole point */
async function redirectOpenBlockedTabs(domains: string[]): Promise<void> {
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

async function awardFocusBlock(): Promise<void> {
  await recordFocusBlock();
  await awardXp('focus_block');
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
  taskId?: string;
  intent?: string;
}): Promise<{ ok: boolean }> {
  // Floor of 2 allows ignition micro-sprints; regular UI never goes below 5
  const focusMinutes = Math.min(240, Math.max(2, Math.round(config.focusMinutes)));
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
    ...(config.taskId && { taskId: config.taskId }),
    ...(config.intent && { intent: config.intent.slice(0, 140) }),
  };
  await setLocal({ focusSession: session });

  const settings = await getSettings();
  await installBlockRules(settings.focusBlocklist);
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
  // No award on any manual stop: completed pomodoro blocks were already
  // awarded at each phase end; only the in-flight block is forfeited.
  await chrome.alarms.clear(ALARMS.focusPhaseEnd);
  await chrome.alarms.clear(ALARMS.focusBadgeTick);
  await clearBlockRules();
  await setLocal({ focusSession: null });
  await updateBadge();
  return { ok: true };
}

/** Phase math always uses Date.now() — a throttled alarm must never schedule a phase in the past */
export async function handleFocusPhaseEnd(): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session) {
    // Stray/duplicate alarm — rules must never outlive state
    await clearBlockRules();
    return;
  }
  const settings = await getSettings();
  const now = Date.now();

  if (session.phase === 'focus') {
    await awardFocusBlock();

    if (session.mode === 'oneshot') {
      await clearBlockRules();
      await chrome.alarms.clear(ALARMS.focusBadgeTick);
      await setLocal({ focusSession: null });
      await updateBadge();
      notifyPhase(
        'Focus complete 🎉',
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
    await clearBlockRules();
    chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
    await updateBadge();
    notifyPhase(
      'Break time ☕',
      `${session.breakMinutes} minutes — sites are open. Block ${session.completedBlocks} done.`,
      settings.notificationsEnabled,
    );
    return;
  }

  // Pomodoro: break → focus (re-block)
  session.phase = 'focus';
  session.phaseEndsAt = now + session.focusMinutes * 60_000;
  await setLocal({ focusSession: session });
  await installBlockRules(settings.focusBlocklist);
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  await redirectOpenBlockedTabs(settings.focusBlocklist);
  await updateBadge();
  notifyPhase(
    'Back to focus 🎯',
    `${session.focusMinutes} minutes. Sites re-blocked.`,
    settings.notificationsEnabled,
  );
}

/**
 * onStartup/onInstalled: DNR rules persist across restarts and extension
 * reloads — state must win. Never auto-resume blocking after arbitrary
 * downtime; a focus phase that expired while closed still earns its block
 * (the time was served).
 */
export async function reconcileFocusOnStartup(): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');

  if (!session) {
    await clearBlockRules();
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    return;
  }

  if (session.phaseEndsAt <= Date.now()) {
    if (session.phase === 'focus') {
      await awardFocusBlock();
    }
    await clearBlockRules();
    await chrome.alarms.clear(ALARMS.focusBadgeTick);
    await setLocal({ focusSession: null });
    await updateBadge();
    return;
  }

  // Phase still live: re-arm the alarms and sync rules to the phase
  chrome.alarms.create(ALARMS.focusPhaseEnd, { when: session.phaseEndsAt });
  chrome.alarms.create(ALARMS.focusBadgeTick, { periodInMinutes: 1 });
  if (session.phase === 'focus') {
    const settings = await getSettings();
    await installBlockRules(settings.focusBlocklist);
  } else {
    await clearBlockRules();
  }
  await updateBadge();
}

/** Blocklist edited mid-session: refresh rules if currently blocking */
export async function refreshFocusRules(newBlocklist: string[]): Promise<void> {
  const { focusSession: session } = await getLocal('focusSession');
  if (!session || session.phase !== 'focus') return;
  await installBlockRules(newBlocklist);
  await redirectOpenBlockedTabs(newBlocklist);
}
