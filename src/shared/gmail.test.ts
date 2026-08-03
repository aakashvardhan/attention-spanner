import { describe, expect, it } from 'vitest';
import {
  byBucket,
  connectedAccounts,
  GMAIL_DEFAULTS,
  hasGmailCredentials,
  missingScopes,
  senderName,
  upsertAccount,
  type GmailAccount,
  type TriagedMessage,
} from './gmail';

function account(overrides: Partial<GmailAccount> = {}): GmailAccount {
  return {
    id: 'a1',
    email: 'me@example.com',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
    connected: true,
    lastError: '',
    ...overrides,
  };
}

function message(bucket: TriagedMessage['bucket'], id: string): TriagedMessage {
  return {
    id,
    threadId: id,
    accountId: 'a1',
    from: 'Someone <s@example.com>',
    subject: `Subject ${id}`,
    snippet: '',
    receivedAt: 0,
    bucket,
    reason: '',
  };
}

describe('hasGmailCredentials', () => {
  it('needs both halves of the client', () => {
    expect(hasGmailCredentials(GMAIL_DEFAULTS)).toBe(false);
    expect(hasGmailCredentials({ ...GMAIL_DEFAULTS, clientId: 'x' })).toBe(false);
    expect(hasGmailCredentials({ ...GMAIL_DEFAULTS, clientId: 'x', clientSecret: 'y' })).toBe(true);
  });
});

describe('missingScopes', () => {
  const READ = 'https://www.googleapis.com/auth/gmail.readonly';
  const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

  it('is empty when both scopes were granted', () => {
    expect(missingScopes(`openid email ${READ} ${MODIFY}`)).toEqual([]);
  });

  it('reports both when Google granted only the identity scopes', () => {
    // What a consent screen with no Gmail scopes configured actually returns
    expect(missingScopes('openid email profile')).toEqual(['gmail.readonly', 'gmail.modify']);
    expect(missingScopes(undefined)).toEqual(['gmail.readonly', 'gmail.modify']);
    expect(missingScopes('')).toEqual(['gmail.readonly', 'gmail.modify']);
  });

  it('reports just the one that is missing', () => {
    expect(missingScopes(`openid ${READ}`)).toEqual(['gmail.modify']);
    expect(missingScopes(`openid ${MODIFY}`)).toEqual(['gmail.readonly']);
  });

  it('does not accept a lookalike scope as the real one', () => {
    // gmail.metadata ends in a different segment; a suffix match on the bare
    // word would wrongly pass something like …/auth/gmail.readonly.evil
    expect(missingScopes('https://www.googleapis.com/auth/gmail.metadata')).toEqual([
      'gmail.readonly',
      'gmail.modify',
    ]);
  });
});

describe('connectedAccounts', () => {
  it('excludes accounts whose grant is gone', () => {
    const state = {
      ...GMAIL_DEFAULTS,
      accounts: [account(), account({ id: 'a2', email: 'b@x.com', connected: false })],
    };
    expect(connectedAccounts(state).map((a) => a.id)).toEqual(['a1']);
  });
});

describe('upsertAccount', () => {
  it('appends a new mailbox', () => {
    const out = upsertAccount([account()], account({ id: 'a2', email: 'school@sjsu.edu' }));
    expect(out.map((a) => a.email)).toEqual(['me@example.com', 'school@sjsu.edu']);
  });

  it('replaces in place when the same address reconnects, keeping the original id', () => {
    const out = upsertAccount(
      [account({ lastError: 'expired' })],
      account({ id: 'fresh-uuid', email: 'ME@example.com', accessToken: 'new' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a1');
    expect(out[0].accessToken).toBe('new');
    expect(out[0].lastError).toBe('');
  });

  it('does not merge two accounts that both failed before naming themselves', () => {
    const out = upsertAccount([account({ email: '' })], account({ id: 'a2', email: '' }));
    expect(out).toHaveLength(2);
  });
});

describe('byBucket', () => {
  it('orders buckets by priority and drops the empty ones', () => {
    const out = byBucket([
      message('FYI', '1'),
      message('URGENT', '2'),
      message('FYI', '3'),
    ]);
    expect(out.map(([bucket, list]) => [bucket, list.length])).toEqual([
      ['URGENT', 1],
      ['FYI', 2],
    ]);
  });

  it('returns nothing for an empty inbox', () => {
    expect(byBucket([])).toEqual([]);
  });
});

describe('senderName', () => {
  it('takes the display name out of a full From header', () => {
    expect(senderName('Dr. Lee <lee@sjsu.edu>')).toBe('Dr. Lee');
    expect(senderName('"Lee, Alex" <lee@sjsu.edu>')).toBe('Lee, Alex');
  });

  it('falls back to the bare address', () => {
    expect(senderName('lee@sjsu.edu')).toBe('lee@sjsu.edu');
    expect(senderName('  <lee@sjsu.edu>  ')).toBe('<lee@sjsu.edu>');
  });
});
