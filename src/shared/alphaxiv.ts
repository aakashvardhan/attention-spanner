import { z } from 'zod';
import type { Folder, Paper } from './types';

/**
 * alphaXiv, the pure half: the OAuth request shapes, the MCP tool replies and
 * how the library folds into the local shelf. No chrome.* here, so every rule
 * is a unit test (alphaxiv.test.ts, against replies recorded from a real
 * account). The network half is src/background/alphaxiv.ts.
 *
 * alphaXiv is the master copy of the library. The shelf mirrors its folders and
 * keeps only what alphaXiv does not: reading progress and where you stopped.
 */

export const ALPHAXIV_MCP_URL = 'https://api.alphaxiv.org/mcp/v1';
export const ALPHAXIV_AUTH = {
  authorize: 'https://api.alphaxiv.org/auth/oauth2/authorize',
  token: 'https://api.alphaxiv.org/auth/oauth2/token',
  register: 'https://api.alphaxiv.org/auth/oauth2/register',
  userinfo: 'https://api.alphaxiv.org/auth/oauth2/userinfo',
  revoke: 'https://api.alphaxiv.org/auth/oauth2/revoke',
} as const;
/** offline_access asks for a refresh token, so one sign-in lasts; alphaXiv may not grant it. */
export const ALPHAXIV_SCOPE = 'openid profile email offline_access';

/** What is stored after sign-in (chrome.storage.local alphaxivAuth). */
export interface AlphaxivAuth {
  /** Dynamically registered, per redirect URI (the extension id can change) */
  clientId: string;
  redirectUri: string;
  accessToken: string;
  /**
   * '' when alphaXiv issued none: it drops offline_access from the scope (seen
   * 2026-11-01), so the sign-in may last only as long as the access token.
   */
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface AlphaxivStatus {
  email: string;
  lastSyncAt: number | null;
  /** '' when the last attempt worked; otherwise what to tell the user */
  error: string;
}

export type AlphaxivErrorKind = 'signed-out' | 'rate-limited' | 'not-found' | 'offline' | 'failed';

export class AlphaxivError extends Error {
  constructor(
    readonly kind: AlphaxivErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AlphaxivError';
  }
}

/** The sentence Settings shows for each failure. */
export function errorMessage(kind: AlphaxivErrorKind): string {
  switch (kind) {
    case 'signed-out':
      return 'Your alphaXiv sign-in ended. Sign in again to sync your shelf.';
    case 'rate-limited':
      return 'alphaXiv asked us to slow down. The next sync will try again.';
    case 'not-found':
      return 'alphaXiv could not find that paper or folder.';
    case 'offline':
      return 'You are offline. The shelf will sync when you are back.';
    case 'failed':
      return 'alphaXiv did not answer as expected. The next sync will try again.';
  }
}

/** An HTTP status (or a thrown error) as an error kind. */
export function kindForStatus(status: number): AlphaxivErrorKind {
  if (status === 401 || status === 403) return 'signed-out';
  if (status === 429) return 'rate-limited';
  if (status === 404) return 'not-found';
  return 'failed';
}

/* ---------- OAuth (PKCE, public client) ---------- */

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: ALPHAXIV_SCOPE,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    // RFC 8707: the token is for the MCP server, as the MCP auth spec asks.
    resource: ALPHAXIV_MCP_URL,
  });
  return `${ALPHAXIV_AUTH.authorize}?${q}`;
}

/** The code from the redirect, or why there is none. A state mismatch is a forged redirect. */
export function codeFromRedirect(redirect: string, state: string): { code: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return { error: 'alphaXiv sent back an unreadable address.' };
  }
  const q = url.searchParams;
  if (q.get('error')) return { error: q.get('error_description') || q.get('error') || 'Sign-in was refused.' };
  if (q.get('state') !== state) return { error: 'Sign-in reply did not match the request. Try again.' };
  const code = q.get('code');
  return code ? { code } : { error: 'alphaXiv sent no sign-in code.' };
}

const TokenReply = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});

/**
 * A token endpoint reply as stored auth. A refresh may omit refresh_token
 * (no rotation); the old one is kept then, and with none at all the sign-in
 * simply ends with the access token. expires_in is trusted minus a minute, so
 * a token is never sent in its last seconds.
 */
export function authFromTokenReply(
  json: unknown,
  base: Pick<AlphaxivAuth, 'clientId' | 'redirectUri'> & { refreshToken?: string },
  now: number,
): AlphaxivAuth {
  const t = TokenReply.parse(json);
  const refreshToken = t.refresh_token ?? base.refreshToken ?? '';
  return {
    clientId: base.clientId,
    redirectUri: base.redirectUri,
    accessToken: t.access_token,
    refreshToken,
    expiresAt: now + Math.max(0, (t.expires_in ?? 3600) - 60) * 1000,
  };
}

export function needsRefresh(auth: AlphaxivAuth, now: number): boolean {
  return now >= auth.expiresAt;
}

/* ---------- MCP tool replies ---------- */

const LibraryReply = z.object({
  folders: z.array(
    z.object({
      folder_id: z.string(),
      name: z.string(),
      type: z.string(),
      paper_count: z.number().optional(),
      papers: z
        .array(
          z.object({
            universal_paper_id: z.string(),
            title: z.string(),
            type: z.string().optional(),
            publication_date: z.string().nullish(),
          }),
        )
        .optional(),
      papers_truncated: z.boolean().optional(),
    }),
  ),
});
export type Library = z.infer<typeof LibraryReply>;

/** list_library (include_papers: true) text → the library. Throws AlphaxivError('failed') on a shape change. */
export function parseLibrary(text: string): Library {
  return parseJson(LibraryReply, text, 'list_library');
}

const FeedReply = z.object({ papers: z.array(z.object({ universal_paper_id: z.string() })) });

/** get_hot_feed / get_for_you_feed → arXiv ids in app order. Link blogs (non-arXiv ids) are dropped. */
export function parseFeed(text: string): string[] {
  return parseJson(FeedReply, text, 'feed')
    .papers.map((p) => p.universal_paper_id)
    .filter((id) => ARXIV_ID.test(id));
}

/** create_folder's reply names the new folder somewhere in its text; the uuid is all we need. */
export function parseFolderId(text: string): string | null {
  return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
}

function parseJson<T>(schema: z.ZodType<T>, text: string, tool: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AlphaxivError('failed', `${tool}: alphaXiv replied with something other than JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AlphaxivError('failed', `${tool}: alphaXiv changed its reply format.`);
  return parsed.data;
}

/** New-style (2406.09246) and old-style (hep-th/9901001) arXiv ids, no version. */
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})$/i;

/* ---------- Library → shelf ---------- */

/**
 * Fold alphaXiv's library into the local shelf. alphaXiv decides which folders
 * a paper is in; the local record keeps its reading state. Rules:
 * - A paper only on alphaXiv joins with empty reading state.
 * - A paper alphaXiv no longer lists stays stored with no folders: off the
 *   shelf, but its progress survives a later re-add.
 * - A truncated folder lists only some of its papers, so membership the reply
 *   cannot see is kept rather than dropped.
 * - Papers alphaXiv marks as uploads (not public arXiv) are skipped: the reader
 *   is arXiv-only.
 * Pure; returns new arrays.
 */
export function mergeLibrary(local: readonly Paper[], library: Library, now: number): { folders: Folder[]; papers: Paper[] } {
  const folders: Folder[] = library.folders.map((f) => ({ id: f.folder_id, name: f.name, type: f.type }));
  const truncated = new Set(library.folders.filter((f) => f.papers_truncated).map((f) => f.folder_id));
  const remote = new Map<string, { title: string; year: number | null; folderIds: Set<string> }>();
  for (const f of library.folders)
    for (const p of f.papers ?? []) {
      if ((p.type && p.type !== 'public') || !ARXIV_ID.test(p.universal_paper_id)) continue;
      const entry = remote.get(p.universal_paper_id) ?? {
        title: p.title,
        year: yearOf(p.publication_date),
        folderIds: new Set<string>(),
      };
      entry.folderIds.add(f.folder_id);
      remote.set(p.universal_paper_id, entry);
    }

  const papers: Paper[] = [];
  const seen = new Set<string>();
  for (const paper of local) {
    seen.add(paper.id);
    const r = remote.get(paper.id);
    const kept = paper.folderIds.filter((id) => truncated.has(id));
    const folderIds = [...new Set([...(r?.folderIds ?? []), ...kept])];
    const title = r?.title.trim() || paper.title;
    const year = r?.year ?? paper.year;
    const changed = title !== paper.title || year !== paper.year || !sameSet(folderIds, paper.folderIds);
    papers.push(changed ? { ...paper, title, year, folderIds, updatedAt: now } : paper);
  }
  for (const [id, r] of remote) {
    if (seen.has(id)) continue;
    papers.push({
      id,
      title: r.title.trim() || id,
      authors: '',
      year: r.year,
      url: `https://arxiv.org/abs/${id}`,
      folderIds: [...r.folderIds],
      progressPercent: 0,
      leftOff: '',
      addedAt: now,
      updatedAt: now,
      lastReadAt: null,
    });
  }
  return { folders, papers };
}

function yearOf(date: string | null | undefined): number | null {
  const y = Number(date?.slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/* ---------- The one-time push of pre-alphaXiv papers ---------- */

export interface PushPlan {
  /** Folder names that do not exist on alphaXiv yet */
  create: string[];
  /** Folder name → arXiv ids to save there, in batches of at most 50 (the tool's cap) */
  saves: { folder: string; ids: string[] }[];
}

/** 'Want to read' and 'want  to READ' are the same folder; alphaXiv's own default included. */
export function folderKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Group the v27 queue by folder, matching existing alphaXiv folders by name
 * (case- and space-insensitive) and naming the ones to create. Papers already
 * in that folder are skipped. Pure.
 */
export function planPush(
  queue: readonly { id: string; folder: string }[],
  folders: readonly Folder[],
  papers: readonly Paper[],
): PushPlan {
  const byKey = new Map(folders.map((f) => [folderKey(f.name), f]));
  const groups = new Map<string, { folder: string; ids: string[] }>();
  for (const item of queue) {
    const key = folderKey(item.folder) || folderKey('Want to read');
    const existing = byKey.get(key);
    if (existing && papers.find((p) => p.id === item.id)?.folderIds.includes(existing.id)) continue;
    const group = groups.get(key) ?? { folder: existing?.name ?? item.folder.trim(), ids: [] };
    if (!group.ids.includes(item.id)) group.ids.push(item.id);
    groups.set(key, group);
  }
  const create = [...groups.keys()].filter((k) => !byKey.has(k)).map((k) => groups.get(k)!.folder);
  const saves: PushPlan['saves'] = [];
  for (const g of groups.values())
    for (let i = 0; i < g.ids.length; i += 50) saves.push({ folder: g.folder, ids: g.ids.slice(i, i + 50) });
  return { create, saves };
}
