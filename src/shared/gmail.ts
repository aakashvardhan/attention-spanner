/**
 * Gmail — pure types and state helpers. All IO lives in
 * src/background/gmail.ts and src/background/gmailAuth.ts.
 *
 * Multi-account by design, unlike the calendar connector: a student's mail is
 * split across a personal address and a school one, and triaging only half of
 * it is worse than useless — it teaches you the card is incomplete, so you
 * check Gmail anyway.
 *
 * Each account carries its own tokens and its own lastError. A Workspace
 * tenant that blocks third-party OAuth apps (Google answers
 * `admin_policy_enforced`) takes down exactly one row; the other account keeps
 * triaging.
 */

/** The blog's four buckets, which are the only ones that change what you do next. */
export type TriageBucket = 'URGENT' | 'THIS_WEEK' | 'FYI' | 'ARCHIVE';

export const TRIAGE_BUCKETS: readonly TriageBucket[] = ['URGENT', 'THIS_WEEK', 'FYI', 'ARCHIVE'];

export const BUCKET_LABELS: Record<TriageBucket, string> = {
  URGENT: 'Today',
  THIS_WEEK: 'This week',
  FYI: 'Read only',
  ARCHIVE: 'Archive',
};

/**
 * One unread message, as much of it as this extension ever sees. Fetched with
 * `format=metadata`, so there is no body here and none is ever requested —
 * sender, subject and Gmail's own one-line snippet are enough to sort mail
 * into four buckets, and the rest is nobody's business but the user's.
 */
export interface GmailMessage {
  id: string;
  threadId: string;
  /** Which connected account this arrived in */
  accountId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: number;
}

export interface TriagedMessage extends GmailMessage {
  bucket: TriageBucket;
  /** One line on why it landed there; '' when untriaged */
  reason: string;
}

export interface GmailAccount {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry (ms epoch); 0 = unknown, treat as expired */
  expiresAt: number;
  connected: boolean;
  /** '' = healthy */
  lastError: string;
}

/** → LocalSchema.gmail. Device-local; tokens must never reach Firestore. */
export interface GmailState {
  /** One OAuth client from the user's own Cloud project, shared by both accounts */
  clientId: string;
  clientSecret: string;
  accounts: GmailAccount[];
  /** Last triage run's output, newest-first within each bucket */
  triaged: TriagedMessage[];
  triagedAt: number;
  /** '' = healthy; run-level errors, as opposed to per-account ones */
  lastError: string;
}

export const GMAIL_DEFAULTS: GmailState = {
  clientId: '',
  clientSecret: '',
  accounts: [],
  triaged: [],
  triagedAt: 0,
  lastError: '',
};

/** Whether this install has an OAuth client to sign in with at all. */
export function hasGmailCredentials(state: GmailState): boolean {
  return Boolean(state.clientId && state.clientSecret);
}

/**
 * What is missing from the scopes Google actually granted.
 *
 * Google is happy to mint a perfectly valid token carrying none of the scopes
 * you asked for — that is what happens when the consent screen was never
 * configured with them. Without this check the failure surfaces much later as
 * an opaque 403 on the first fetch, long after the user has stopped associating
 * it with the consent screen they set up.
 */
export function missingScopes(granted: string | undefined): string[] {
  const have = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return ['gmail.readonly', 'gmail.modify'].filter(
    (needed) => ![...have].some((s) => s.endsWith(`/auth/${needed}`)),
  );
}

export function connectedAccounts(state: GmailState): GmailAccount[] {
  return state.accounts.filter((a) => a.connected);
}

/**
 * Add or refresh an account. Re-authorizing an address that is already
 * connected updates it in place rather than producing a second row for the
 * same mailbox — the natural thing to do after fixing a broken grant.
 */
export function upsertAccount(accounts: GmailAccount[], account: GmailAccount): GmailAccount[] {
  const existing = accounts.findIndex(
    (a) => a.email !== '' && a.email.toLowerCase() === account.email.toLowerCase(),
  );
  if (existing === -1) return [...accounts, account];
  return accounts.map((a, i) => (i === existing ? { ...account, id: a.id } : a));
}

/** Group triaged mail for rendering; buckets always appear in priority order. */
export function byBucket(messages: TriagedMessage[]): [TriageBucket, TriagedMessage[]][] {
  return TRIAGE_BUCKETS.map(
    (bucket) =>
      [bucket, messages.filter((m) => m.bucket === bucket)] as [TriageBucket, TriagedMessage[]],
  ).filter(([, list]) => list.length > 0);
}

/** 'Dr. Lee <lee@sjsu.edu>' → 'Dr. Lee'; a bare address is left alone. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return match?.[1]?.trim() || from.trim();
}
