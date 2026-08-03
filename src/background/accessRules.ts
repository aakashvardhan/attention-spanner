import {
  BLOCKED_PAGE_PATH,
  DAILY_GATE_ALLOW_DNR_ID,
  DAILY_GATE_DNR_ID,
  DAILY_GATE_PAGE_PATH,
  FLOWTUNES_URL,
  FOCUS_DNR_ID_BASE,
  FOCUS_DNR_ID_LIMIT,
} from '../shared/constants';
import {
  buildDailyGateAllowRule,
  buildDailyGateRedirectRule,
  isDailyBrainDumpComplete,
} from '../shared/dailyBrainDump';
import { buildFocusRules } from '../shared/focusRules';
import { getLocal, getSettings } from '../shared/storage';
import type { DailyBrainDumpGateState, FocusSession } from '../shared/types';

function dailyGatePageUrl(): string {
  return chrome.runtime.getURL(DAILY_GATE_PAGE_PATH);
}

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
 * The redirect is deliberately always present. The per-browser-session allow
 * rule is what opens the web after today's dump; it disappears on shutdown,
 * so a restored page cannot beat startup reconciliation on a new day.
 */
export async function ensurePersistentDailyGateRule(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = rules
      .map((rule) => rule.id)
      .filter((id) => id === DAILY_GATE_DNR_ID || isLegacyFocusRule(id));
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: [buildDailyGateRedirectRule(dailyGatePageUrl())],
      });
      return;
    } catch (error) {
      // Startup, onInstalled and a page message can reconcile concurrently.
      // Re-read once so a duplicate-ID race cannot strand the gate.
      if (attempt === 1) throw error;
    }
  }
}

export function buildSessionAccessRules(config: {
  gate: DailyBrainDumpGateState;
  focusSession: FocusSession | null;
  focusDomains: string[];
  focusRedirectUrl: string;
}): chrome.declarativeNetRequest.Rule[] {
  if (!isDailyBrainDumpComplete(config.gate)) return [];
  const rules = [buildDailyGateAllowRule()];
  if (
    config.focusSession?.phase === 'focus' &&
    config.focusSession.phaseEndsAt > Date.now()
  ) {
    rules.push(...buildFocusRules(config.focusDomains, config.focusRedirectUrl));
  }
  return rules;
}

/**
 * Rebuild all session-scoped access rules in one atomic DNR update:
 * daily locked → no session rules; unlocked → global allow; active Focus →
 * higher-priority domain redirects layered above that allow.
 */
export async function syncSessionAccessRules(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [{ dailyBrainDumpGate, focusSession }, settings, existing] = await Promise.all([
      getLocal('dailyBrainDumpGate', 'focusSession'),
      getSettings(),
      chrome.declarativeNetRequest.getSessionRules(),
    ]);
    const removeRuleIds = existing.map((rule) => rule.id).filter(isOwnedSessionRule);
    const focusDomains = settings.focusBlocklist.filter(
      (domain) => domain !== new URL(FLOWTUNES_URL).hostname,
    );
    const addRules = buildSessionAccessRules({
      gate: dailyBrainDumpGate,
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

export async function dailyGateCompleteNow(): Promise<boolean> {
  const { dailyBrainDumpGate } = await getLocal('dailyBrainDumpGate');
  return isDailyBrainDumpComplete(dailyBrainDumpGate);
}
