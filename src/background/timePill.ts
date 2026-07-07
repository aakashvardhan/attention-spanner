import { localDate } from '../shared/format';
import { getLocal, getSettings, setLocal } from '../shared/storage';

/**
 * Time-pill backend: injects the badge on configured hosts and keeps the
 * per-host per-local-day visible-seconds totals, so the number survives
 * navigations, tab switches, and browser restarts within the same day.
 */

/** Configured domain a page host falls under (subdomains aggregate), or null */
function pillKeyFor(host: string, configured: string[]): string | null {
  const h = host.toLowerCase();
  return configured.find((domain) => h === domain || h.endsWith(`.${domain}`)) ?? null;
}

export async function maybeInjectTimePill(tabId: number, url: string): Promise<void> {
  if (!/^https?:/i.test(url)) return;
  const settings = await getSettings();
  if (settings.timePillHosts.length === 0) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (pillKeyFor(host, settings.timePillHosts) === null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/timePill.js'],
    });
  } catch {
    // Tab closed mid-flight or page not injectable
  }
}

/** Today's totals, discarding a stale record from a previous day */
async function todaysSiteTime(): Promise<{ date: string; hosts: Record<string, number> }> {
  const { siteTime } = await getLocal('siteTime');
  const today = localDate();
  return siteTime.date === today ? siteTime : { date: today, hosts: {} };
}

export async function handleTimePillReady(host: string): Promise<{ ok: true; todaySeconds: number }> {
  const settings = await getSettings();
  const key = pillKeyFor(host, settings.timePillHosts);
  if (key === null) return { ok: true, todaySeconds: 0 };
  const siteTime = await todaysSiteTime();
  return { ok: true, todaySeconds: siteTime.hosts[key] ?? 0 };
}

export async function handleTimePillTick(host: string, seconds: number): Promise<{ ok: true }> {
  // A tick covers at most the 15s flush window; clamp junk from stale pages
  const delta = Math.min(Math.max(0, Math.floor(seconds)), 60);
  if (delta === 0) return { ok: true };
  const settings = await getSettings();
  const key = pillKeyFor(host, settings.timePillHosts);
  if (key === null) return { ok: true };
  const siteTime = await todaysSiteTime();
  siteTime.hosts[key] = (siteTime.hosts[key] ?? 0) + delta;
  await setLocal({ siteTime });
  return { ok: true };
}
