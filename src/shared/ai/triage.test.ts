import { describe, expect, it } from 'vitest';
import type { GmailMessage } from '../gmail';
import {
  buildTriageSchema,
  buildTriageSystem,
  describeTriage,
  formatMessagesForTriage,
  parseTriageReply,
  untriaged,
} from './triage';

function message(id: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: id,
    accountId: 'a1',
    from: 'Dr. Lee <lee@sjsu.edu>',
    subject: `Subject ${id}`,
    snippet: 'A short preview of the message.',
    receivedAt: 0,
    ...overrides,
  };
}

describe('buildTriageSystem', () => {
  it('names all four buckets and forbids guessing at bodies', () => {
    const system = buildTriageSystem('');
    for (const bucket of ['URGENT', 'THIS_WEEK', 'FYI', 'ARCHIVE']) {
      expect(system).toContain(bucket);
    }
    expect(system).toContain('not shown message bodies');
  });

  it('includes the profile only when there is one', () => {
    expect(buildTriageSystem('')).not.toContain('About the user');
    expect(buildTriageSystem('Masters student at SJSU.')).toContain('Masters student at SJSU.');
  });
});

describe('formatMessagesForTriage', () => {
  it('numbers messages and uses the sender display name', () => {
    const out = formatMessagesForTriage([message('m1')]);
    expect(out).toBe('0. from: Dr. Lee | subject: Subject m1 | A short preview of the message.');
  });

  it('omits the snippet separator when there is no snippet', () => {
    expect(formatMessagesForTriage([message('m1', { snippet: '' })])).toBe(
      '0. from: Dr. Lee | subject: Subject m1',
    );
  });
});

describe('parseTriageReply', () => {
  const messages = [message('m1'), message('m2'), message('m3')];

  it('assigns buckets and reasons by index', () => {
    const out = parseTriageReply(
      JSON.stringify({
        items: [
          { index: 0, bucket: 'URGENT', reason: 'advisor wants the draft today' },
          { index: 1, bucket: 'ARCHIVE', reason: 'newsletter' },
          { index: 2, bucket: 'FYI', reason: 'course announcement' },
        ],
      }),
      messages,
    );
    expect(out.map((m) => m.bucket)).toEqual(['URGENT', 'ARCHIVE', 'FYI']);
    expect(out[0].reason).toBe('advisor wants the draft today');
    expect(out[0].id).toBe('m1');
  });

  it('returns every message even when the model classifies none', () => {
    const out = parseTriageReply('total garbage', messages);
    expect(out).toHaveLength(3);
    expect(out.every((m) => m.bucket === 'THIS_WEEK' && m.reason === '')).toBe(true);
  });

  it('keeps unclassified messages visible rather than dropping them', () => {
    const out = parseTriageReply(
      JSON.stringify({ items: [{ index: 1, bucket: 'URGENT', reason: 'deadline' }] }),
      messages,
    );
    expect(out).toHaveLength(3);
    expect(out[0].bucket).toBe('THIS_WEEK');
    expect(out[1].bucket).toBe('URGENT');
    expect(out[2].bucket).toBe('THIS_WEEK');
  });

  it('ignores out-of-range indexes and invalid buckets', () => {
    const out = parseTriageReply(
      JSON.stringify({
        items: [
          { index: 99, bucket: 'URGENT', reason: 'nope' },
          { index: -1, bucket: 'URGENT', reason: 'nope' },
          { index: 0, bucket: 'SOMEDAY', reason: 'not a bucket' },
        ],
      }),
      messages,
    );
    expect(out.every((m) => m.bucket === 'THIS_WEEK')).toBe(true);
  });

  it('handles an empty inbox', () => {
    expect(parseTriageReply(JSON.stringify({ items: [] }), [])).toEqual([]);
  });
});

describe('untriaged', () => {
  it('files everything under this week with no reason', () => {
    const out = untriaged([message('m1')]);
    expect(out[0].bucket).toBe('THIS_WEEK');
    expect(out[0].reason).toBe('');
  });
});

describe('describeTriage', () => {
  it('says so when there is nothing unread', () => {
    expect(describeTriage([])).toBe('Nothing unread worth triaging.');
  });

  it('counts each non-empty bucket and leads with the top urgent item', () => {
    const triaged = parseTriageReply(
      JSON.stringify({
        items: [
          { index: 0, bucket: 'URGENT', reason: 'r' },
          { index: 1, bucket: 'FYI', reason: 'r' },
          { index: 2, bucket: 'FYI', reason: 'r' },
        ],
      }),
      [message('m1'), message('m2'), message('m3')],
    );
    const out = describeTriage(triaged);
    expect(out).toContain('3 unread: 1 urgent, 2 fyi.');
    expect(out).toContain('Top: “Subject m1” — Dr. Lee.');
  });

  it('omits the lead when nothing is urgent', () => {
    expect(describeTriage(untriaged([message('m1')]))).toBe('1 unread: 1 this week.');
  });

  /* An empty result means "your inbox is clear", which is only ever true when
     Gmail actually answered. runTriage returns early on a total fetch failure
     precisely so this string can't stand in for "I couldn't look". */
  it('reads as a clear inbox, so callers must not use it to report a failure', () => {
    expect(describeTriage([])).not.toMatch(/error|fail/i);
  });
});

describe('buildTriageSchema', () => {
  it('caps items at the message count and constrains the bucket enum', () => {
    const schema = buildTriageSchema(4) as {
      properties: { items: { maxItems: number; items: { properties: { bucket: { enum: string[] } } } } };
    };
    expect(schema.properties.items.maxItems).toBe(4);
    expect(schema.properties.items.items.properties.bucket.enum).toEqual([
      'URGENT',
      'THIS_WEEK',
      'FYI',
      'ARCHIVE',
    ]);
  });
});
