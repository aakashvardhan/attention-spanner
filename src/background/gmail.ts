import {
  FETCH_TIMEOUT_MS,
  GMAIL_API_BASE,
  GMAIL_MAX_MESSAGES,
} from '../shared/constants';
import type { GmailMessage } from '../shared/gmail';
import {
  getAccessToken,
  markAccountDisconnected,
  noteAccountError,
  refreshAccessToken,
} from './gmailAuth';

/**
 * Gmail REST calls. Reads are metadata-only by deliberate choice: `format=
 * metadata` returns headers and Google's own snippet but never the body, and
 * nothing here ever asks for `full`. Four buckets can be decided from sender,
 * subject and one line — so that is all that is fetched, all that is stored,
 * and all that any model is shown.
 */

/**
 * Unread mail worth triaging. Promotions and social are excluded at the query:
 * they are already sorted by Google, and a triage list that opens with sixty
 * newsletters is one the user stops reading.
 */
const UNREAD_QUERY = 'is:unread -category:promotions -category:social';

interface ApiHeader {
  name?: string;
  value?: string;
}

interface ApiMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: ApiHeader[] };
}

/** Map one metadata response. Returns null for anything unusable. */
export function mapApiMessage(raw: unknown, accountId: string): GmailMessage | null {
  const msg = raw as ApiMessage | null;
  if (!msg?.id) return null;
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
  return {
    id: msg.id,
    threadId: msg.threadId ?? msg.id,
    accountId,
    from: header('From'),
    subject: header('Subject') || '(no subject)',
    snippet: (msg.snippet ?? '').trim(),
    receivedAt: Number(msg.internalDate ?? 0),
  };
}

interface ApiError {
  error?: {
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { reason?: string }[];
  };
}

/**
 * Turn Gmail's 403 into something the user can act on.
 *
 * A 403 here is almost never a dead grant, and treating it as one is actively
 * harmful: revoking the stored refresh token turns a thirty-second console fix
 * into a full reconnect of every mailbox. The three that actually happen:
 *
 *  - `accessNotConfigured` — the Gmail API isn't enabled on the Cloud project.
 *    The OAuth grant is perfect; the API just isn't switched on.
 *  - `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / `insufficientPermissions` — the
 *    consent screen never offered the Gmail scopes, so Google minted a valid
 *    token that cannot read mail. Refreshing re-mints the same narrow token;
 *    only re-consenting fixes it.
 *  - `rateLimitExceeded` / `userRateLimitExceeded` — quota. Try later.
 *
 * Only 401 ("Invalid Credentials") means the token itself is bad.
 */
export function explain403(body: unknown): string {
  const err = (body as ApiError | null)?.error;
  const reasons = [
    ...(err?.errors ?? []).map((e) => e.reason),
    ...(err?.details ?? []).map((d) => d.reason),
    err?.status,
  ].filter(Boolean) as string[];
  const message = err?.message ?? '';
  const has = (needle: string) =>
    reasons.some((r) => r.toLowerCase().includes(needle.toLowerCase())) ||
    message.toLowerCase().includes(needle.toLowerCase());

  if (has('accessNotConfigured') || has('has not been used in project')) {
    return 'The Gmail API is not enabled on your Google Cloud project. Enable it (APIs & Services → Library → Gmail API), wait a minute, then Triage again — you do not need to reconnect.';
  }
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || has('insufficient authentication scopes') || has('insufficientPermissions')) {
    return 'This connection has no permission to read mail — the Gmail scopes are missing from your OAuth consent screen. Add gmail.readonly and gmail.modify there, then disconnect and reconnect this account.';
  }
  if (has('rateLimitExceeded')) {
    return 'Gmail rate-limited this account. Try again in a few minutes.';
  }
  return message
    ? `Gmail refused the request: ${message}`
    : 'Gmail refused the request (HTTP 403).';
}

/**
 * One authenticated Gmail call.
 *
 * 401 refreshes once and retries; a second 401 means the grant really is gone,
 * so the account is marked disconnected. A 403 is reported against the account
 * but never destroys its tokens — see explain403 for why.
 */
async function apiFetch(
  accountId: string,
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<unknown> {
  const token = await getAccessToken(accountId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${GMAIL_API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    if (retried) {
      await markAccountDisconnected(accountId, 'Reconnect this account in Settings.');
      throw new Error('Gmail rejected the credentials — reconnect this account in Settings.');
    }
    await refreshAccessToken(accountId);
    return apiFetch(accountId, path, init, true);
  }

  if (res.status === 403) {
    const hint = explain403(await res.json().catch(() => null));
    // Kept connected on purpose: the tokens are fine, the project or the
    // consent screen is not, and both are fixable without signing in again.
    await noteAccountError(accountId, hint);
    throw new Error(hint);
  }

  if (!res.ok) throw new Error(`Gmail returned HTTP ${res.status}.`);
  return res.json().catch(() => null);
}

/** Unread messages for one account, newest first. */
export async function listUnread(
  accountId: string,
  max = GMAIL_MAX_MESSAGES,
): Promise<GmailMessage[]> {
  const list = (await apiFetch(
    accountId,
    `/messages?q=${encodeURIComponent(UNREAD_QUERY)}&maxResults=${max}`,
  )) as { messages?: { id?: string }[] } | null;

  const ids = (list?.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];

  // Sequential: Gmail rate-limits per user, and 25 metadata reads are cheap
  const messages: GmailMessage[] = [];
  for (const id of ids) {
    const raw = await apiFetch(
      accountId,
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    ).catch(() => null);
    const mapped = mapApiMessage(raw, accountId);
    if (mapped) messages.push(mapped);
  }
  return messages.sort((a, b) => b.receivedAt - a.receivedAt);
}

/** Archive: out of the inbox and marked read, which is what "archive" means here. */
export async function archiveMessage(accountId: string, id: string): Promise<void> {
  await apiFetch(accountId, `/messages/${id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }),
  });
}

/** Apply an existing label by id. Labels are never created from here. */
export async function labelMessage(
  accountId: string,
  id: string,
  labelId: string,
): Promise<void> {
  await apiFetch(accountId, `/messages/${id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

/** The account's user-created labels, for the label picker. */
export async function listLabels(accountId: string): Promise<{ id: string; name: string }[]> {
  const res = (await apiFetch(accountId, '/labels')) as {
    labels?: { id?: string; name?: string; type?: string }[];
  } | null;
  return (res?.labels ?? [])
    .filter((l) => l.type === 'user' && l.id && l.name)
    .map((l) => ({ id: l.id as string, name: l.name as string }));
}
