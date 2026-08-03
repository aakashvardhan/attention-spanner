import { cloudProviderFor, hasCloudKey } from '../shared/ai/cloud';
import { newTurn } from '../shared/ai/assistantTypes';
import {
  buildTriageSchema,
  buildTriageSystem,
  describeTriage,
  formatMessagesForTriage,
  parseTriageReply,
  untriaged,
} from '../shared/ai/triage';
import { GMAIL_TRIAGE_DEBOUNCE_MS, NOTIFICATION_IDS, QUIET_HOURS_END, QUIET_HOURS_START } from '../shared/constants';
import { connectedAccounts, type GmailMessage, type TriagedMessage } from '../shared/gmail';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import { inQuietHours } from '../shared/week';
import { listUnread } from './gmail';
import { noteAccountError } from './gmailAuth';
import { recordEntrySafe } from './journal';

/**
 * A triage run: pull unread mail from every connected account, sort it into
 * four buckets, store the result for the Inbox card.
 *
 * Runs in the service worker on cloud fetch — the one LLM path the worker is
 * allowed (Nano needs a page context, and 50 messages exceed its budget
 * anyway). With no cloud key the mail is still fetched and listed, untriaged:
 * the point is that the user can see their inbox from the dashboard, and a
 * sorted view is the improvement, not the whole feature.
 *
 * One account failing never sinks the run. A Workspace tenant that blocks the
 * app leaves its own error on its own row while the other mailbox triages.
 */

export async function runTriage(
  opts: { force?: boolean } = {},
  now = new Date(),
): Promise<{ ok: boolean; text: string }> {
  const [{ gmail }, settings] = await Promise.all([getLocal('gmail'), getSettings()]);
  const accounts = connectedAccounts(gmail);
  if (accounts.length === 0) {
    // Distinguish "never set up" from "set up and now broken" — with account
    // rows on screen, "no mailbox connected" reads as though they vanished
    return {
      ok: false,
      text:
        gmail.accounts.length === 0
          ? 'No mailbox connected — connect Gmail in Settings.'
          : 'Every connected mailbox has lost its Google sign-in. Reconnect them in Settings.',
    };
  }
  if (!opts.force && now.getTime() - gmail.triagedAt < GMAIL_TRIAGE_DEBOUNCE_MS) {
    return { ok: true, text: describeTriage(gmail.triaged) };
  }

  const messages: GmailMessage[] = [];
  const failures: string[] = [];
  for (const account of accounts) {
    try {
      messages.push(...(await listUnread(account.id)));
      // A mailbox that just answered has no outstanding problem — clear the
      // error the last failed run left on it, or a fixed project keeps
      // showing the complaint that it was broken
      if (account.lastError) await noteAccountError(account.id, '');
    } catch (err) {
      // Stored per account by the auth/API layer; collected here for the run
      failures.push(`${account.email || 'account'}: ${(err as Error).message}`);
    }
  }
  messages.sort((a, b) => b.receivedAt - a.receivedAt);

  // Nothing reached Gmail at all. Reporting that as an empty inbox is the
  // worst available answer — it reads as "you're all caught up" when the truth
  // is "I couldn't look" — and overwriting the stored list would throw away a
  // good triage because of a transient failure.
  if (failures.length === accounts.length) {
    const { gmail: fresh } = await getLocal('gmail');
    await setLocal({ gmail: { ...fresh, lastError: failures.join(' ') } });
    return { ok: false, text: failures.join(' ') };
  }

  let triaged: TriagedMessage[] = untriaged(messages);
  let runError = failures.join(' ');
  if (messages.length > 0 && hasCloudKey(settings)) {
    try {
      const { assistantProfile } = await getLocal('assistantProfile');
      const reply = await cloudProviderFor(settings).generate({
        system: buildTriageSystem(assistantProfile.text.trim()),
        turns: [newTurn('user', formatMessagesForTriage(messages))],
        responseSchema: buildTriageSchema(messages.length),
      });
      triaged = parseTriageReply(reply.text, messages);
    } catch (err) {
      runError = [runError, `Triage failed: ${(err as Error).message}`].filter(Boolean).join(' ');
    }
  }

  const { gmail: fresh } = await getLocal('gmail');
  await setLocal({
    gmail: { ...fresh, triaged, triagedAt: now.getTime(), lastError: runError },
  });

  const text = describeTriage(triaged);
  recordEntrySafe('digest', `Inbox: ${text}`);
  return { ok: failures.length === 0, text };
}

/**
 * Forget one message. Called after a successful archive: the mail is out of
 * the inbox, so leaving it on the triage list would offer to archive it twice
 * — and re-running the whole triage to notice would spend an LLM call to learn
 * something already known.
 */
export async function dropFromTriage(messageId: string): Promise<void> {
  const { gmail } = await getLocal('gmail');
  await setLocal({
    gmail: { ...gmail, triaged: gmail.triaged.filter((m) => m.id !== messageId) },
  });
}

/**
 * The scheduled run. Quiet hours apply — mail sorted at 3am is mail you find
 * out about at 3am — and the notification only fires for genuinely urgent mail,
 * since a daily "you have 20 emails" is the thing people mute.
 */
export async function fireScheduledTriage(now = new Date()): Promise<void> {
  const settings = await getSettings();
  if (!settings.assistantEnabled) return;
  if (inQuietHours(QUIET_HOURS_START, QUIET_HOURS_END, now)) return;

  const { ok } = await runTriage({}, now).catch(() => ({ ok: false }));
  if (!ok) return;

  const { gmail } = await getLocal('gmail');
  const urgent = gmail.triaged.filter((m) => m.bucket === 'URGENT');
  if (urgent.length === 0 || !settings.notificationsEnabled) return;

  chrome.notifications.create(NOTIFICATION_IDS.gmailTriage, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: `Jarvis: ${urgent.length} email${urgent.length === 1 ? '' : 's'} need you today`,
    message: urgent
      .slice(0, 3)
      .map((m) => m.subject)
      .join(' · '),
    priority: 0,
  });
}
