import { LAYA_DRIFT_MIN, NOTIFICATION_IDS } from '../shared/constants';
import { isBlockedHost } from '../shared/focusRules';
import { clip, confident, layaReady, systemOne, type LayaAnswer } from '../shared/llm/laya';
import { paperMatchKey } from '../shared/papers';
import { getLocal, getSession, getSettings, setSession } from '../shared/storage';
import type { FocusSession, Paper } from '../shared/types';
import { GLOBAL_NUDGE_GAP_MS } from './nudges';

/**
 * Off-task tabs during a focus session. The blocklist catches the sites you
 * named in advance; this catches the rest, by asking Laya whether a page is a
 * distraction from the paper you are reading. Only a page Laya is at least
 * LAYA_DRIFT_MIN sure is one gets one quiet notification — never a block —
 * and each host is asked about once per session.
 */

/**
 * Asked as "is it a distraction", never "is it on-task": Laya's doubt piles up
 * near zero, so a low P(on-task) also covers PyTorch docs (0.04) and the
 * author's Scholar page (0.03). Only a confident yes here is evidence.
 */
const DISTRACTION_QUESTION = {
  type: 'noul',
  instructions: 'Is this tab a distraction unrelated to the research topic of the focus paper?',
} as const;

export function isDistraction(answer: LayaAnswer | undefined): boolean {
  return confident(answer, LAYA_DRIFT_MIN) === true;
}

/** What the session is "for": the paper read most recently. */
export function focusTarget(papers: readonly Paper[]): Paper | null {
  return (
    papers
      .filter((p) => p.status === 'reading')
      .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0] ?? null
  );
}

/** The host worth asking about, or null. Pure, so every gate is a unit test. */
export function driftCandidate(opts: {
  url: string;
  session: FocusSession;
  checked: { startedAt: number; hosts: string[] };
  blocklist: string[];
  target: Paper | null;
}): string | null {
  const { url, session, checked, blocklist, target } = opts;
  if (!target || !/^https?:/.test(url)) return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  // Blocked hosts never load; DNR has them.
  if (isBlockedHost(host, blocklist)) return null;
  const key = paperMatchKey(url);
  if (key && (key === paperMatchKey(target.url) || (target.pdf && key === paperMatchKey(target.pdf.url)))) {
    return null;
  }
  if (checked.startedAt === session.startedAt && checked.hosts.includes(host)) return null;
  return host;
}

export async function checkDrift(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.active || !tab.url) return;
  const { focusSession: session, papers } = await getLocal('focusSession', 'papers');
  if (!session) return;
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !settings.layaUrl) return;

  const { driftChecked, lastGlobalNudgeAt } = await getSession('driftChecked', 'lastGlobalNudgeAt');
  const target = focusTarget(papers);
  const host = driftCandidate({
    url: tab.url,
    session,
    checked: driftChecked,
    blocklist: settings.focusBlocklist,
    target,
  });
  if (!host || !target || Date.now() - lastGlobalNudgeAt < GLOBAL_NUDGE_GAP_MS) return;
  if (!(await layaReady(settings.layaUrl))) return;

  // Marked before asking, so a burst of tab events asks once.
  const hosts = driftChecked.startedAt === session.startedAt ? driftChecked.hosts : [];
  await setSession({ driftChecked: { startedAt: session.startedAt, hosts: [...hosts, host] } });

  let distracted: boolean;
  try {
    const { distraction } = await systemOne(
      settings.layaUrl,
      { focus: `${target.title}. ${clip(target.abstract, 800)}`, tab: { title: tab.title ?? '', host } },
      { distraction: DISTRACTION_QUESTION },
    );
    distracted = isDistraction(distraction);
  } catch {
    return;
  }
  if (!distracted) return;

  await setSession({ lastGlobalNudgeAt: Date.now() });
  const minutesLeft = Math.max(1, Math.round((session.phaseEndsAt - Date.now()) / 60_000));
  chrome.notifications.create(NOTIFICATION_IDS.focusDrift, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: `Still on ${clip(target.title, 60)}?`,
    message: `${host} doesn't look like part of it. ${minutesLeft} min left in this focus session.`,
    priority: 0,
  });
}
