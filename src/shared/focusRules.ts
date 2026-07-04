import { FOCUS_DNR_ID_BASE } from './constants';

/**
 * Focus-mode blocking rules, pure and unit-testable. Blocking uses
 * declarativeNetRequest dynamic rules — one per domain — so enforcement is
 * done by the browser itself and survives service-worker death and browser
 * restarts (state reconciliation lives in src/background/focus.ts).
 */

const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** User input → canonical blocklist domain, or null if unusable */
export function normalizeBlockDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  let host = raw;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return DOMAIN_SHAPE.test(host) ? host : null;
}

/** Mirrors DNR requestDomains semantics: exact host or any subdomain */
export function isBlockedHost(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return domains.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * One redirect rule per domain. regexSubstitution carries the full blocked
 * URL in the hash so the blocked page can show it and offer "continue" once
 * the session ends. redirectBase is injected so this stays pure for tests.
 */
export function buildFocusRules(
  domains: string[],
  redirectBase: string,
): chrome.declarativeNetRequest.Rule[] {
  return domains.map((domain, i) => ({
    id: FOCUS_DNR_ID_BASE + i,
    priority: 1,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `${redirectBase}#\\0` },
    },
    condition: {
      requestDomains: [domain],
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  }));
}
