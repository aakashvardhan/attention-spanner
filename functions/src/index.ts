import { createHmac, timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest, type Request } from 'firebase-functions/v2/https';
import { parseAllowlist, uidForPhone } from './allowlist';
import { calendarConfigured, createEvent } from './calendar';
import { HELP_TEXT, parseCommand, parseIndexRef, type Command } from './commands';
import { sendText } from './reply';
import * as store from './store';
import type { Paper, Task } from '../../src/shared/types';

initializeApp();

/**
 * WhatsApp → Firestore bridge (Meta Business Cloud API webhook).
 *
 * GET  = Meta's verify handshake (echo hub.challenge).
 * POST = signed message events: verify the X-Hub-Signature-256 HMAC FIRST,
 * drop non-allowlisted senders silently, parse the command grammar, write
 * Firestore records the extension's sync layer already merges (see store.ts
 * for the contract), reply bluntly.
 */

const WHATSAPP_VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN');
const WHATSAPP_ACCESS_TOKEN = defineSecret('WHATSAPP_ACCESS_TOKEN');
const META_APP_SECRET = defineSecret('META_APP_SECRET');
const ALLOWED_USERS = defineSecret('ALLOWED_USERS');
const WHATSAPP_PHONE_NUMBER_ID = defineString('WHATSAPP_PHONE_NUMBER_ID', { default: '' });
const USER_TIMEZONE = defineString('USER_TIMEZONE', { default: 'America/Los_Angeles' });
// Optional Google Calendar bridge — leave unset to disable `event add`
const GCAL_CLIENT_ID = defineString('GCAL_CLIENT_ID', { default: '' });
const GCAL_CLIENT_SECRET = defineString('GCAL_CLIENT_SECRET', { default: '' });
const GCAL_REFRESH_TOKEN = defineString('GCAL_REFRESH_TOKEN', { default: '' });

function validSignature(req: Request, appSecret: string): boolean {
  const header = req.header('x-hub-signature-256') ?? '';
  if (!header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

interface IncomingMessage {
  from: string;
  text: string;
}

function extractMessages(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const messages =
        (change as { value?: { messages?: unknown[] } })?.value?.messages ?? [];
      for (const msg of messages) {
        const m = msg as { from?: string; type?: string; text?: { body?: string } };
        if (m.type === 'text' && m.from && m.text?.body) {
          out.push({ from: m.from, text: m.text.body });
        }
      }
    }
  }
  return out;
}

async function resolveTask(uid: string, ref: string): Promise<Task | null> {
  const tasks = await store.listOpenTasks(uid);
  const index = parseIndexRef(ref);
  if (index !== null) return tasks[index] ?? null;
  return store.resolveRef(tasks, (t) => t.text, ref);
}

function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return 'No open tasks.';
  return `Tasks:\n${tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n')}`;
}

function formatPaperList(papers: Paper[]): string {
  if (papers.length === 0) return 'No papers.';
  return `Papers:\n${papers.map((p, i) => `${i + 1}. ${p.title}`).join('\n')}`;
}

async function handleCommand(uid: string, command: Command): Promise<string> {
  switch (command.kind) {
    case 'help':
      return HELP_TEXT;
    case 'task-add': {
      const task = await store.addTask(uid, command.text);
      return `Added: ${task.text}`;
    }
    case 'task-list':
      return formatTaskList(await store.listOpenTasks(uid));
    case 'task-done': {
      const task = await resolveTask(uid, command.ref);
      if (!task) return `No open task matching "${command.ref}".`;
      await store.completeTask(uid, task);
      return `Done: ${task.text}`;
    }
    case 'task-del': {
      const task = await resolveTask(uid, command.ref);
      if (!task) return `No open task matching "${command.ref}".`;
      await store.deleteTask(uid, task);
      return `Deleted: ${task.text}`;
    }
    case 'task-edit': {
      const task = await resolveTask(uid, command.ref);
      if (!task) return `No open task matching "${command.ref}".`;
      await store.editTask(uid, task, command.text);
      return `Renamed to: ${command.text}`;
    }
    case 'card-add': {
      const { deck } = await store.addFlashcard(uid, command.deck, command.front, command.back);
      return `Card added to ${deck.name}: ${command.front}`;
    }
    case 'paper-add': {
      const paper = await store.addPaper(uid, command.ref);
      return `Paper added: ${paper.title}`;
    }
    case 'paper-list':
      return formatPaperList(await store.listPapers(uid));
    case 'paper-del': {
      const papers = await store.listPapers(uid);
      const index = parseIndexRef(command.ref);
      const paper =
        index !== null ? (papers[index] ?? null) : store.resolveRef(papers, (p) => p.title, command.ref);
      if (!paper) return `No paper matching "${command.ref}".`;
      await store.deletePaper(uid, paper);
      return `Deleted paper: ${paper.title}`;
    }
    case 'event-add': {
      const env = {
        clientId: GCAL_CLIENT_ID.value(),
        clientSecret: GCAL_CLIENT_SECRET.value(),
        refreshToken: GCAL_REFRESH_TOKEN.value(),
      };
      if (!calendarConfigured(env)) {
        return 'Calendar is not configured on the bridge. See docs/whatsapp-setup.md.';
      }
      return createEvent(env, {
        title: command.title,
        date: command.date,
        time: command.time,
        timeZone: USER_TIMEZONE.value(),
      });
    }
    case 'unknown':
      return `Did not understand "${command.input}".\n${HELP_TEXT}`;
  }
}

export const whatsappWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, META_APP_SECRET, ALLOWED_USERS],
    // Personal bridge: keep the instance count where a runaway can't bill
    maxInstances: 2,
  },
  async (req, res) => {
    // Meta's subscription handshake
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN.value()) {
        res.status(200).send(String(challenge));
      } else {
        res.sendStatus(403);
      }
      return;
    }

    if (req.method !== 'POST') {
      res.sendStatus(405);
      return;
    }
    // Authenticity first — nothing is parsed before the HMAC checks out
    if (!validSignature(req, META_APP_SECRET.value())) {
      res.sendStatus(401);
      return;
    }

    const allowlist = parseAllowlist(ALLOWED_USERS.value());
    for (const message of extractMessages(req.body)) {
      const uid = uidForPhone(allowlist, message.from);
      if (!uid) continue; // unknown sender: silent drop, zero surface

      let reply: string;
      try {
        reply = await handleCommand(uid, parseCommand(message.text));
      } catch (err) {
        console.error('command failed', err);
        reply = 'That failed on the bridge. Try again.';
      }
      await sendText(
        WHATSAPP_PHONE_NUMBER_ID.value(),
        WHATSAPP_ACCESS_TOKEN.value(),
        message.from,
        reply,
      );
    }
    // Always 200 once authenticated — Meta retries anything else aggressively
    res.sendStatus(200);
  },
);
