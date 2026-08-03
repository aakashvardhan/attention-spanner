import { describe, expect, it } from 'vitest';
import { explain403, mapApiMessage } from './gmail';

describe('mapApiMessage', () => {
  const raw = {
    id: 'm1',
    threadId: 't1',
    snippet: '  Could you send the draft by Friday?  ',
    internalDate: '1753500000000',
    payload: {
      headers: [
        { name: 'From', value: 'Dr. Lee <lee@sjsu.edu>' },
        { name: 'Subject', value: 'Thesis draft' },
        { name: 'Date', value: 'Fri, 25 Jul 2026 09:00:00 -0700' },
      ],
    },
  };

  it('maps the metadata fields and tags the account', () => {
    expect(mapApiMessage(raw, 'acct-1')).toEqual({
      id: 'm1',
      threadId: 't1',
      accountId: 'acct-1',
      from: 'Dr. Lee <lee@sjsu.edu>',
      subject: 'Thesis draft',
      snippet: 'Could you send the draft by Friday?',
      receivedAt: 1753500000000,
    });
  });

  it('matches headers case-insensitively', () => {
    const lower = { ...raw, payload: { headers: [{ name: 'subject', value: 'Lowercase' }] } };
    expect(mapApiMessage(lower, 'a')?.subject).toBe('Lowercase');
  });

  it('falls back sanely on missing pieces', () => {
    const bare = mapApiMessage({ id: 'm2' }, 'a');
    expect(bare).toEqual({
      id: 'm2',
      threadId: 'm2',
      accountId: 'a',
      from: '',
      subject: '(no subject)',
      snippet: '',
      receivedAt: 0,
    });
  });

  it('rejects anything without an id', () => {
    expect(mapApiMessage(null, 'a')).toBeNull();
    expect(mapApiMessage({}, 'a')).toBeNull();
  });
});

describe('explain403', () => {
  it('names the disabled Gmail API and says no reconnect is needed', () => {
    // Google's real shape for this one
    const body = {
      error: {
        code: 403,
        message:
          'Gmail API has not been used in project 123456 before or it is disabled. Enable it by visiting …',
        errors: [{ reason: 'accessNotConfigured', message: 'Access Not Configured.' }],
        status: 'PERMISSION_DENIED',
      },
    };
    const out = explain403(body);
    expect(out).toContain('Gmail API is not enabled');
    expect(out).toContain('do not need to reconnect');
  });

  it('names the missing scopes and sends the user to the consent screen', () => {
    const body = {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      },
    };
    const out = explain403(body);
    expect(out).toContain('no permission to read mail');
    expect(out).toContain('consent screen');
  });

  it('recognises rate limiting', () => {
    const body = { error: { errors: [{ reason: 'rateLimitExceeded' }] } };
    expect(explain403(body)).toContain('rate-limited');
  });

  it('falls back to Google’s own message, then to a bare statement', () => {
    expect(explain403({ error: { message: 'Something specific went wrong' } })).toBe(
      'Gmail refused the request: Something specific went wrong',
    );
    expect(explain403(null)).toBe('Gmail refused the request (HTTP 403).');
    expect(explain403({})).toBe('Gmail refused the request (HTTP 403).');
  });
});
