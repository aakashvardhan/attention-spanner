import {
  senderName,
  TRIAGE_BUCKETS,
  type GmailMessage,
  type TriageBucket,
  type TriagedMessage,
} from '../gmail';

/**
 * Inbox triage: sort unread mail into four buckets, each with a one-line
 * reason.
 *
 * Four and only four, because they are the ones that change what you do next —
 * reply today, reply this week, read and forget, or bin it. More categories
 * would be a taxonomy to maintain rather than a decision to make, which for an
 * ADHD inbox is the failure mode, not the feature.
 *
 * Cloud-only: two mailboxes at 25 messages each blows past Nano's input budget
 * long before the schema does. With no cloud key the card lists the mail
 * untriaged rather than pretending to have sorted it.
 */

/** Chars of snippet the model sees per message — enough to place it, no more. */
const SNIPPET_CHARS = 160;

export function buildTriageSystem(profile: string): string {
  return (
    'You triage the unread inbox of a person with ADHD. Sort every message into exactly one ' +
    'bucket:\n' +
    'URGENT — needs a reply today, or something breaks.\n' +
    'THIS_WEEK — needs a reply, but not today.\n' +
    'FYI — worth reading, needs no reply.\n' +
    'ARCHIVE — automated, promotional or already-handled; safe to bin unread.\n\n' +
    'Give each a reason of at most twelve words, concrete and specific to that message — never ' +
    '"seems important". Judge from sender, subject and snippet only; you are not shown message ' +
    'bodies and must not guess at their contents. When genuinely unsure, prefer THIS_WEEK over ' +
    'URGENT and FYI over ARCHIVE — a misfiled reply costs more than a second look. No emoji.' +
    (profile ? `\n\nAbout the user (their own words):\n${profile}` : '')
  );
}

/** The messages as the model sees them: index, sender, subject, snippet. */
export function formatMessagesForTriage(messages: GmailMessage[]): string {
  return messages
    .map((m, i) => {
      const snippet = m.snippet.slice(0, SNIPPET_CHARS);
      return `${i}. from: ${senderName(m.from)} | subject: ${m.subject}${snippet ? ` | ${snippet}` : ''}`;
    })
    .join('\n');
}

export function buildTriageSchema(count: number): object {
  return {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        maxItems: count,
        items: {
          type: 'object',
          required: ['index', 'bucket', 'reason'],
          additionalProperties: false,
          properties: {
            index: { type: 'number', description: 'The message number from the list' },
            bucket: { type: 'string', enum: [...TRIAGE_BUCKETS] },
            reason: { type: 'string', description: 'At most twelve words' },
          },
        },
      },
    },
  };
}

function isBucket(value: unknown): value is TriageBucket {
  return typeof value === 'string' && (TRIAGE_BUCKETS as readonly string[]).includes(value);
}

/**
 * Fold a model reply back onto the messages it was given.
 *
 * Every message comes back, whether or not the model classified it: a message
 * silently dropped from a triage is one the user never sees again, which is
 * the one outcome an inbox tool must not have. Unclassified mail lands in
 * THIS_WEEK with an empty reason — visible, and not presented as judged.
 */
export function parseTriageReply(raw: string, messages: GmailMessage[]): TriagedMessage[] {
  const assigned = new Map<number, { bucket: TriageBucket; reason: string }>();
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    for (const item of items) {
      const row = item as { index?: unknown; bucket?: unknown; reason?: unknown };
      const index = Number(row?.index);
      if (!Number.isInteger(index) || index < 0 || index >= messages.length) continue;
      if (!isBucket(row?.bucket)) continue;
      assigned.set(index, {
        bucket: row.bucket,
        reason: String(row?.reason ?? '').trim().slice(0, 120),
      });
    }
  } catch {
    // every message falls through to the default below
  }

  return messages.map((message, i) => {
    const hit = assigned.get(i);
    return { ...message, bucket: hit?.bucket ?? 'THIS_WEEK', reason: hit?.reason ?? '' };
  });
}

/** Untriaged fallback — used when no cloud key is configured. */
export function untriaged(messages: GmailMessage[]): TriagedMessage[] {
  return messages.map((m) => ({ ...m, bucket: 'THIS_WEEK' as const, reason: '' }));
}

/** One line summarising a triage run, for the tool reply and the notification. */
export function describeTriage(triaged: TriagedMessage[]): string {
  if (triaged.length === 0) return 'Nothing unread worth triaging.';
  const counts = TRIAGE_BUCKETS.map(
    (bucket) => [bucket, triaged.filter((m) => m.bucket === bucket).length] as const,
  ).filter(([, n]) => n > 0);
  const parts = counts.map(([bucket, n]) => `${n} ${bucket.toLowerCase().replace('_', ' ')}`);
  const urgent = triaged.filter((m) => m.bucket === 'URGENT');
  const lead = urgent.length > 0 ? ` Top: “${urgent[0].subject}” — ${senderName(urgent[0].from)}.` : '';
  return `${triaged.length} unread: ${parts.join(', ')}.${lead}`;
}
