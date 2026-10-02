import {
  BLOCKED_PAGE_PATH,
  DAILY_GATE_ALLOW_DNR_ID,
  DAILY_GATE_DNR_ID,
  FLOWTUNES_URL,
  FOCUS_DNR_ID_BASE,
  FOCUS_DNR_ID_LIMIT,
} from '../shared/constants';
import { buildFocusRules } from '../shared/focusRules';
import { getLocal, getSettings } from '../shared/storage';
import type { FocusSession } from '../shared/types';

function blockedPageUrl(): string {
  return chrome.runtime.getURL(BLOCKED_PAGE_PATH);
}

function isLegacyFocusRule(id: number): boolean {
  return id >= FOCUS_DNR_ID_BASE && id < FOCUS_DNR_ID_LIMIT;
}

function isOwnedSessionRule(id: number): boolean {
  return id === DAILY_GATE_ALLOW_DNR_ID || isLegacyFocusRule(id);
}

/**
 * Remove the browser-wide gate redirect, if this profile still carries it.
 *
 * The gate used to redirect every http(s) main-frame navigation until the day's
 * brain dump was written, unlocked by a per-session allow rule. It is now a
 * newtab prompt instead, so the redirect must come off — and it has to be taken
 * off actively, not merely left uncreated. Rule 900 is a DYNAMIC rule: it
 * survives restarts and updates, while the session allow rule that opened the
 * web disappears on every shutdown. Shipping a build that simply stopped
 * creating it would strand anyone who already had it behind a permanently
 * redirected browser, with no code left to unlock it.
 *
 * Called from src/background/index.ts at module scope, so it runs on every
 * service-worker start and the removal cannot be missed. The gate itself is
 * gone; this sweep outlives it deliberately and should stay for at least one
 * release after that removal.
 */
export async function removeLegacyDailyGateRule(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = rules
      .map((rule) => rule.id)
      .filter((id) => id === DAILY_GATE_DNR_ID || isLegacyFocusRule(id));
    if (removeRuleIds.length === 0) return;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      return;
    } catch (error) {
      // Startup, onInstalled and a page message can reconcile concurrently.
      // Re-read once so a racing removal cannot leave the rule installed.
      if (attempt === 1) throw error;
    }
  }
}

/**
 * Focus blocking is all that is left here. The daily gate's allow rule is gone
 * with the redirect it existed to punch through — focus rules are redirects in
 * their own right and never depended on it.
 */
export function buildSessionAccessRules(config: {
  focusSession: FocusSession | null;
  focusDomains: string[];
  focusRedirectUrl: string;
}): chrome.declarativeNetRequest.Rule[] {
  if (config.focusSession && config.focusSession.phaseEndsAt > Date.now()) {
    return buildFocusRules(config.focusDomains, config.focusRedirectUrl);
  }
  return [];
}

/**
 * Rebuild the session-scoped access rules in one atomic DNR update. Also sweeps
 * the daily gate's old allow rule, which some sessions may still be carrying.
 */
export async function syncSessionAccessRules(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [{ focusSession }, settings, existing] = await Promise.all([
      getLocal('focusSession'),
      getSettings(),
      chrome.declarativeNetRequest.getSessionRules(),
    ]);
    const removeRuleIds = existing.map((rule) => rule.id).filter(isOwnedSessionRule);
    const focusDomains = settings.focusBlocklist.filter(
      (domain) => domain !== new URL(FLOWTUNES_URL).hostname,
    );
    const addRules = buildSessionAccessRules({
      focusSession,
      focusDomains,
      focusRedirectUrl: blockedPageUrl(),
    });
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
