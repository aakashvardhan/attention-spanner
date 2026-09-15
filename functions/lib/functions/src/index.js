"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.whatsappWebhook = void 0;
const node_crypto_1 = require("node:crypto");
const app_1 = require("firebase-admin/app");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const allowlist_1 = require("./allowlist");
const calendar_1 = require("./calendar");
const commands_1 = require("./commands");
const reply_1 = require("./reply");
const store = __importStar(require("./store"));
(0, app_1.initializeApp)();
/**
 * WhatsApp → Firestore bridge (Meta Business Cloud API webhook).
 *
 * GET  = Meta's verify handshake (echo hub.challenge).
 * POST = signed message events: verify the X-Hub-Signature-256 HMAC FIRST,
 * drop non-allowlisted senders silently, parse the command grammar, write
 * Firestore records the extension's sync layer already merges (see store.ts
 * for the contract), reply bluntly.
 */
const WHATSAPP_VERIFY_TOKEN = (0, params_1.defineSecret)('WHATSAPP_VERIFY_TOKEN');
const WHATSAPP_ACCESS_TOKEN = (0, params_1.defineSecret)('WHATSAPP_ACCESS_TOKEN');
const META_APP_SECRET = (0, params_1.defineSecret)('META_APP_SECRET');
const ALLOWED_USERS = (0, params_1.defineSecret)('ALLOWED_USERS');
const WHATSAPP_PHONE_NUMBER_ID = (0, params_1.defineString)('WHATSAPP_PHONE_NUMBER_ID', { default: '' });
const USER_TIMEZONE = (0, params_1.defineString)('USER_TIMEZONE', { default: 'America/Los_Angeles' });
// Optional Google Calendar bridge — leave unset to disable `event add`
const GCAL_CLIENT_ID = (0, params_1.defineString)('GCAL_CLIENT_ID', { default: '' });
const GCAL_CLIENT_SECRET = (0, params_1.defineString)('GCAL_CLIENT_SECRET', { default: '' });
const GCAL_REFRESH_TOKEN = (0, params_1.defineString)('GCAL_REFRESH_TOKEN', { default: '' });
function validSignature(req, appSecret) {
    const header = req.header('x-hub-signature-256') ?? '';
    if (!header.startsWith('sha256='))
        return false;
    const expected = (0, node_crypto_1.createHmac)('sha256', appSecret).update(req.rawBody).digest('hex');
    const given = header.slice('sha256='.length);
    if (given.length !== expected.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}
function extractMessages(body) {
    const out = [];
    const entries = body?.entry ?? [];
    for (const entry of entries) {
        const changes = entry?.changes ?? [];
        for (const change of changes) {
            const messages = change?.value?.messages ?? [];
            for (const msg of messages) {
                const m = msg;
                if (m.type === 'text' && m.from && m.text?.body) {
                    out.push({ from: m.from, text: m.text.body });
                }
            }
        }
    }
    return out;
}
async function resolveTask(uid, ref) {
    const tasks = await store.listOpenTasks(uid);
    const index = (0, commands_1.parseIndexRef)(ref);
    if (index !== null)
        return tasks[index] ?? null;
    return store.resolveRef(tasks, (t) => t.text, ref);
}
function formatTaskList(tasks) {
    if (tasks.length === 0)
        return 'No open tasks.';
    return `Tasks:\n${tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n')}`;
}
function formatPaperList(papers) {
    if (papers.length === 0)
        return 'No papers.';
    return `Papers:\n${papers.map((p, i) => `${i + 1}. ${p.title}`).join('\n')}`;
}
async function handleCommand(uid, command) {
    switch (command.kind) {
        case 'help':
            return commands_1.HELP_TEXT;
        case 'task-add': {
            const task = await store.addTask(uid, command.text);
            return `Added: ${task.text}`;
        }
        case 'task-list':
            return formatTaskList(await store.listOpenTasks(uid));
        case 'task-done': {
            const task = await resolveTask(uid, command.ref);
            if (!task)
                return `No open task matching "${command.ref}".`;
            await store.completeTask(uid, task);
            return `Done: ${task.text}`;
        }
        case 'task-del': {
            const task = await resolveTask(uid, command.ref);
            if (!task)
                return `No open task matching "${command.ref}".`;
            await store.deleteTask(uid, task);
            return `Deleted: ${task.text}`;
        }
        case 'task-edit': {
            const task = await resolveTask(uid, command.ref);
            if (!task)
                return `No open task matching "${command.ref}".`;
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
            const index = (0, commands_1.parseIndexRef)(command.ref);
            const paper = index !== null ? (papers[index] ?? null) : store.resolveRef(papers, (p) => p.title, command.ref);
            if (!paper)
                return `No paper matching "${command.ref}".`;
            await store.deletePaper(uid, paper);
            return `Deleted paper: ${paper.title}`;
        }
        case 'event-add': {
            const env = {
                clientId: GCAL_CLIENT_ID.value(),
                clientSecret: GCAL_CLIENT_SECRET.value(),
                refreshToken: GCAL_REFRESH_TOKEN.value(),
            };
            if (!(0, calendar_1.calendarConfigured)(env)) {
                return 'Calendar is not configured on the bridge. See docs/whatsapp-setup.md.';
            }
            return (0, calendar_1.createEvent)(env, {
                title: command.title,
                date: command.date,
                time: command.time,
                timeZone: USER_TIMEZONE.value(),
            });
        }
        case 'unknown':
            return `Did not understand "${command.input}".\n${commands_1.HELP_TEXT}`;
    }
}
exports.whatsappWebhook = (0, https_1.onRequest)({
    region: 'us-central1',
    secrets: [WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, META_APP_SECRET, ALLOWED_USERS],
    // Personal bridge: keep the instance count where a runaway can't bill
    maxInstances: 2,
}, async (req, res) => {
    // Meta's subscription handshake
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN.value()) {
            res.status(200).send(String(challenge));
        }
        else {
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
    const allowlist = (0, allowlist_1.parseAllowlist)(ALLOWED_USERS.value());
    for (const message of extractMessages(req.body)) {
        const uid = (0, allowlist_1.uidForPhone)(allowlist, message.from);
        if (!uid)
            continue; // unknown sender: silent drop, zero surface
        let reply;
        try {
            reply = await handleCommand(uid, (0, commands_1.parseCommand)(message.text));
        }
        catch (err) {
            console.error('command failed', err);
            reply = 'That failed on the bridge. Try again.';
        }
        await (0, reply_1.sendText)(WHATSAPP_PHONE_NUMBER_ID.value(), WHATSAPP_ACCESS_TOKEN.value(), message.from, reply);
    }
    // Always 200 once authenticated — Meta retries anything else aggressively
    res.sendStatus(200);
});
//# sourceMappingURL=index.js.map