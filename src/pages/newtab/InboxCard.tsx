import { useState } from 'react';
import { Button, EmptyState, Panel } from '../../shared/components/ui';
import {
  BUCKET_LABELS,
  byBucket,
  connectedAccounts,
  senderName,
  type TriagedMessage,
} from '../../shared/gmail';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';

const INBOX_PREVIEW_MESSAGES = 8;

/**
 * The inbox, in four buckets.
 *
 * The card exists to make "do I need to open Gmail?" answerable from the
 * dashboard. It shows sender, subject and the triage reason — the same
 * metadata the extension fetched, no bodies — and offers the two actions that
 * clear a message off the list: archive it, or turn it into a task.
 *
 * Untriaged mail (no cloud key configured) still renders, under "This week",
 * with the reason blank. Listing the inbox honestly beats pretending to have
 * sorted it.
 */
export function InboxCard() {
  const [gmail] = useStorageValue('gmail');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const accounts = gmail ? connectedAccounts(gmail) : [];
  const triaged = gmail?.triaged ?? [];
  const multiAccount = accounts.length > 1;

  const refresh = async () => {
    setBusy(true);
    await sendMessage({ type: 'GMAIL_TRIAGE', force: true }).catch(() => undefined);
    setBusy(false);
  };

  const archive = async (message: TriagedMessage) => {
    setActing(message.id);
    // The worker drops it from the stored triage on success, so the row leaves
    // on the next storage tick without a second round-trip
    await sendMessage({
      type: 'GMAIL_ARCHIVE',
      accountId: message.accountId,
      messageId: message.id,
    }).catch(() => undefined);
    setActing(null);
  };

  const makeTask = async (message: TriagedMessage) => {
    setActing(message.id);
    await sendMessage({
      type: 'ADD_TASK',
      text: `Reply to ${senderName(message.from)}: ${message.subject}`,
      source: 'newtab',
    }).catch(() => undefined);
    setActing(null);
  };

  if (accounts.length === 0) {
    return (
      <Panel title="Inbox">
        <EmptyState>
          Gmail needs an OAuth client of your own — set it up in Settings (see
          docs/gmail-setup.md), then connect one mailbox per address.
        </EmptyState>
      </Panel>
    );
  }

  const emailOf = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.email ?? '';
  const buckets = byBucket(triaged);
  let remaining = expanded ? Number.POSITIVE_INFINITY : INBOX_PREVIEW_MESSAGES;
  const shownBuckets = buckets
    .map(([bucket, list]) => {
      const shown = list.slice(0, remaining);
      remaining -= shown.length;
      return [bucket, shown] as const;
    })
    .filter(([, list]) => list.length > 0);

  return (
    <Panel
      title="Inbox"
      action={
        <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? '…' : 'Refresh'}
        </Button>
      }
    >
      {triaged.length === 0 ? (
        <EmptyState>
          {gmail?.triagedAt === 0 ? 'No triage yet.' : 'Nothing unread — inbox clear.'}
        </EmptyState>
      ) : (
        <div className="panel-scroll">
          {shownBuckets.map(([bucket, list]) => (
            <div key={bucket} className="ib-bucket">
              <h3 className={`ib-bucket-head ${bucket.toLowerCase()}`}>
                {BUCKET_LABELS[bucket]}{' '}
                <span className="ib-count">
                  {buckets.find(([candidate]) => candidate === bucket)?.[1].length ?? list.length}
                </span>
              </h3>
              {list.map((message) => (
                <div key={message.id} className="ib-row">
                  <div className="ib-main">
                    <span className="ib-subject">{message.subject}</span>
                    <span className="ib-meta">
                      {senderName(message.from)}
                      {multiAccount && <> · {emailOf(message.accountId)}</>}
                      {message.reason && <> · {message.reason}</>}
                    </span>
                  </div>
                  <div className="ib-actions">
                    <Button
                      variant="ghost"
                      disabled={acting === message.id}
                      title="Add a task to reply"
                      onClick={() => void makeTask(message)}
                    >
                      Task
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={acting === message.id}
                      title="Archive and mark read"
                      onClick={() => void archive(message)}
                    >
                      Archive
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {triaged.length > INBOX_PREVIEW_MESSAGES && (
        <Button block variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer messages' : `Show all ${triaged.length} messages`}
        </Button>
      )}

      {/* Per account, so one blocked Workspace tenant doesn't read as total failure */}
      {accounts
        .filter((a) => a.lastError)
        .map((a) => (
          <p key={a.id} className="ag-error">
            {a.email || 'Mailbox'}: {a.lastError}
          </p>
        ))}
      {gmail?.lastError && <p className="ag-error">{gmail.lastError}</p>}
    </Panel>
  );
}
