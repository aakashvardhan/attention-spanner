import { byBucket, senderName, type TriagedMessage } from '../../gmail';
import { sendMessage } from '../../messages';
import { getLocal } from '../../storage';
import { resolveByText, type Connector } from './base';

/**
 * The inbox, as tools. Read freely; change nothing without a confirm chip —
 * archiving is the one action here the user cannot trivially undo from the
 * dashboard, so it goes through the same confirm path as deleting a task.
 *
 * There is no send and no draft tool, and the OAuth scope does not permit
 * either: Jarvis reads the user's mail and sorts it, and never writes in
 * their name.
 */

/** Find a triaged message by loose subject/sender match — the LLM never sees ids. */
async function findMessage(text: string): Promise<TriagedMessage> {
  const { gmail } = await getLocal('gmail');
  if (gmail.triaged.length === 0) {
    throw new Error('No triaged mail to act on — run “triage my inbox” first.');
  }
  const hit = resolveByText(gmail.triaged, (m) => `${m.subject} ${senderName(m.from)}`, text);
  if (hit.kind === 'match') return hit.item;
  if (hit.kind === 'ambiguous') {
    throw new Error(
      `Several emails match “${text}”: ${hit.candidates.map((m) => `“${m.subject}”`).join(', ')}. Which one?`,
    );
  }
  throw new Error(`No email in the last triage matches “${text}”.`);
}

function formatBuckets(triaged: TriagedMessage[]): string {
  if (triaged.length === 0) return 'Nothing unread.';
  return byBucket(triaged)
    .map(([bucket, list]) => {
      const rows = list
        .map((m) => `  - ${m.subject} — ${senderName(m.from)}${m.reason ? ` (${m.reason})` : ''}`)
        .join('\n');
      return `${bucket}:\n${rows}`;
    })
    .join('\n');
}

export const gmailConnector: Connector = {
  id: 'gmail',
  label: 'Gmail',
  // Advertised only once a mailbox is connected, so filtered surfaces don't
  // offer to archive mail this install cannot reach
  isAvailable: (env) => env.gmailConnected,
  tools: [
    {
      name: 'triage_inbox',
      // No confirm chip, but it hits the network, runs a model call, and
      // rewrites gmail.triaged. show_inbox is the read-only counterpart.
      loop: 'stage',
      description:
        'Fetch unread email from every connected mailbox and sort it into urgent / this week / FYI / archive. Use for "triage my inbox", "check my email", "what emails need me", "any urgent email".',
      params: { type: 'object', required: [], additionalProperties: false, properties: {} },
      palette: { label: 'Triage my inbox', keywords: ['email', 'inbox', 'mail', 'triage'] },
      summary: () => 'Triage the inbox',
      run: async () => {
        const res = await sendMessage({ type: 'GMAIL_TRIAGE', force: true });
        return res.text;
      },
    },
    {
      name: 'show_inbox',
      loop: 'auto',
      description:
        'Read back the last inbox triage, grouped by bucket, without fetching again. Use for "what was in my inbox", "show my triaged mail", "what did you say was urgent".',
      params: { type: 'object', required: [], additionalProperties: false, properties: {} },
      summary: () => 'Show the triaged inbox',
      run: async () => {
        const { gmail } = await getLocal('gmail');
        if (gmail.triagedAt === 0) return 'No triage yet — say “triage my inbox”.';
        return {
          text: formatBuckets(gmail.triaged),
          // Gmail addresses a thread by id, so this opens the actual message.
          // Only the subject travels as the title — the snippet stays out of
          // the citation, the same restraint the triage fetch itself shows.
          sources: gmail.triaged.map((m) => ({
            id: '',
            kind: 'email' as const,
            title: `${m.subject || '(no subject)'} — ${m.from}`,
            url: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
          })),
        };
      },
    },
    {
      name: 'archive_email',
      description:
        'Archive one email from the last triage — out of the inbox and marked read. Identify it by subject or sender.',
      params: {
        type: 'object',
        required: ['which'],
        additionalProperties: false,
        properties: {
          which: {
            type: 'string',
            description: 'Subject or sender of the email to archive',
            maxLength: 200,
          },
        },
      },
      confirm: true,
      summary: (p) => `Archive the email matching “${p.which as string}”`,
      run: async (p) => {
        const message = await findMessage(p.which as string);
        const res = await sendMessage({
          type: 'GMAIL_ARCHIVE',
          accountId: message.accountId,
          messageId: message.id,
        });
        if (!res.ok) throw new Error(res.error ?? 'Gmail refused the archive.');
        return `Archived “${message.subject}”.`;
      },
    },
    {
      name: 'task_from_email',
      description:
        'Turn one email from the last triage into a task on the task list. Identify the email by subject or sender.',
      params: {
        type: 'object',
        required: ['which'],
        additionalProperties: false,
        properties: {
          which: {
            type: 'string',
            description: 'Subject or sender of the email',
            maxLength: 200,
          },
          text: {
            type: 'string',
            description: 'Task wording; omit to use "Reply to <sender>: <subject>"',
            maxLength: 200,
          },
        },
      },
      confirm: true,
      summary: (p) => `Make a task from the email matching “${p.which as string}”`,
      run: async (p) => {
        const message = await findMessage(p.which as string);
        const text =
          (p.text as string | undefined)?.trim() ||
          `Reply to ${senderName(message.from)}: ${message.subject}`;
        const res = await sendMessage({ type: 'ADD_TASK', text, source: 'newtab' });
        return `Added task “${res.task.text}”.`;
      },
    },
  ],
};
