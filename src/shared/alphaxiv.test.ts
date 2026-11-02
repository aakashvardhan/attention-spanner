import { describe, expect, it } from 'vitest';
import {
  ALPHAXIV_AUTH,
  ALPHAXIV_MCP_URL,
  AlphaxivError,
  authFromTokenReply,
  authorizeUrl,
  base64url,
  codeFromRedirect,
  folderKey,
  kindForStatus,
  mergeLibrary,
  needsRefresh,
  parseFeed,
  parseFolderId,
  parseLibrary,
  pkceChallenge,
  planPush,
  type Library,
} from './alphaxiv';
import { AUTH_METADATA, FOR_YOU_FEED, HOT_FEED, LIST_LIBRARY, REGISTER_REPLY } from './alphaxiv.fixtures';
import type { Folder, Paper } from './types';

const NOW = 1_800_000_000_000;

function paper(id: string, over: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: '',
    year: 2024,
    url: `https://arxiv.org/abs/${id}`,
    folderIds: [],
    progressPercent: 0,
    leftOff: '',
    addedAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    ...over,
  };
}

describe('contract: the recorded alphaXiv replies', () => {
  it('our endpoints are the ones the authorization server publishes', () => {
    expect(ALPHAXIV_AUTH.authorize).toBe(AUTH_METADATA.authorization_endpoint);
    expect(ALPHAXIV_AUTH.token).toBe(AUTH_METADATA.token_endpoint);
    expect(ALPHAXIV_AUTH.register).toBe(AUTH_METADATA.registration_endpoint);
    expect(ALPHAXIV_AUTH.userinfo).toBe(AUTH_METADATA.userinfo_endpoint);
    expect(ALPHAXIV_AUTH.revoke).toBe(AUTH_METADATA.revocation_endpoint);
    expect(AUTH_METADATA.code_challenge_methods_supported).toContain('S256');
    expect(AUTH_METADATA.token_endpoint_auth_methods_supported).toContain('none');
    expect(REGISTER_REPLY.public).toBe(true);
  });

  it('parses list_library into folders with their papers', () => {
    const lib = parseLibrary(LIST_LIBRARY);
    expect(lib.folders.map((f) => f.name)).toEqual(['Want to read', 'Reading', 'Completed', 'My publications']);
    expect(lib.folders[1].papers?.map((p) => p.universal_paper_id)).toEqual(['1706.03762', '2110.14168']);
  });

  it('parses both feeds into arXiv ids, in order', () => {
    expect(parseFeed(HOT_FEED)).toEqual(['2610.39302', '2610.40564', '2610.40636']);
    expect(parseFeed(FOR_YOU_FEED)).toEqual(['2610.37381', '2610.28480', '2609.24972']);
  });

  it('drops link blogs from a feed and copes with an empty one', () => {
    expect(parseFeed('{"papers":[{"universal_paper_id":"blog-abc"},{"universal_paper_id":"1706.03762"}]}')).toEqual(['1706.03762']);
    expect(parseFeed('{"papers":[]}')).toEqual([]);
  });

  it('turns a reply that is not JSON, or a changed shape, into a "failed" error', () => {
    for (const text of ['The user has no notes on [ID=1].', '{"folders":"nope"}', '{}'])
      expect(() => parseLibrary(text)).toThrowError(AlphaxivError);
    try {
      parseFeed('<html>');
    } catch (e) {
      expect((e as AlphaxivError).kind).toBe('failed');
    }
  });

  it('finds the new folder id in a create_folder reply, whatever the wording', () => {
    expect(parseFolderId('Created folder "Diffusion" [folder_id=01985f0e-9788-7673-a495-c113dd5ac4be].')).toBe(
      '01985f0e-9788-7673-a495-c113dd5ac4be',
    );
    expect(parseFolderId('{"folder_id":"01985F0E-9788-7673-A495-C113DD5AC4BE"}')).toBe('01985F0E-9788-7673-A495-C113DD5AC4BE');
    expect(parseFolderId('Folder created.')).toBeNull();
  });
});

describe('OAuth', () => {
  it('builds a PKCE S256 challenge (RFC 7636 appendix B vector)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('base64url has no padding or unsafe characters', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-');
  });

  it('asks for a refresh token, PKCE and the MCP server as the resource', () => {
    const u = new URL(authorizeUrl({ clientId: 'c', redirectUri: 'https://x.chromiumapp.org/alphaxiv', state: 's', challenge: 'ch' }));
    expect(u.origin + u.pathname).toBe(ALPHAXIV_AUTH.authorize);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'https://x.chromiumapp.org/alphaxiv',
      scope: 'openid profile email offline_access',
      state: 's',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      resource: ALPHAXIV_MCP_URL,
    });
  });

  it('takes the code only when the state matches', () => {
    expect(codeFromRedirect('https://x.chromiumapp.org/alphaxiv?code=abc&state=s1', 's1')).toEqual({ code: 'abc' });
    expect(codeFromRedirect('https://x.chromiumapp.org/alphaxiv?code=abc&state=forged', 's1')).toHaveProperty('error');
    expect(codeFromRedirect('https://x.chromiumapp.org/alphaxiv?error=access_denied&error_description=User+said+no&state=s1', 's1')).toEqual({
      error: 'User said no',
    });
    expect(codeFromRedirect('https://x.chromiumapp.org/alphaxiv?state=s1', 's1')).toHaveProperty('error');
    expect(codeFromRedirect('not a url', 's1')).toHaveProperty('error');
  });

  it('stores a token reply, a minute short of its expiry', () => {
    const auth = authFromTokenReply({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer' }, { clientId: 'c', redirectUri: 'u' }, NOW);
    expect(auth).toEqual({ clientId: 'c', redirectUri: 'u', accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3540_000 });
    expect(needsRefresh(auth, NOW + 3539_000)).toBe(false);
    expect(needsRefresh(auth, NOW + 3540_000)).toBe(true);
  });

  it('keeps the old refresh token when a refresh does not rotate it', () => {
    const auth = authFromTokenReply({ access_token: 'a2', expires_in: 60 }, { clientId: 'c', redirectUri: 'u', refreshToken: 'r1' }, NOW);
    expect(auth.refreshToken).toBe('r1');
    expect(auth.expiresAt).toBe(NOW);
  });

  it('refuses a reply with no access token; takes one with no refresh token (alphaXiv may drop offline_access)', () => {
    expect(() => authFromTokenReply({ error: 'invalid_grant' }, { clientId: 'c', redirectUri: 'u' }, NOW)).toThrow();
    expect(authFromTokenReply({ access_token: 'a' }, { clientId: 'c', redirectUri: 'u' }, NOW).refreshToken).toBe('');
  });

  it('maps HTTP failures to what the user can do about them', () => {
    expect(kindForStatus(401)).toBe('signed-out');
    expect(kindForStatus(403)).toBe('signed-out');
    expect(kindForStatus(429)).toBe('rate-limited');
    expect(kindForStatus(404)).toBe('not-found');
    expect(kindForStatus(500)).toBe('failed');
  });
});

describe('mergeLibrary', () => {
  const lib = parseLibrary(LIST_LIBRARY);
  const READING = '01985f0e-9788-7c5f-9cff-000000000002';
  const TO_READ = '01985f0e-9788-7673-a495-000000000001';

  it('brings in every folder and every paper on an empty shelf', () => {
    const { folders, papers } = mergeLibrary([], lib, NOW);
    expect(folders).toHaveLength(4);
    expect(papers.map((p) => p.id).sort()).toEqual(['1706.03762', '2110.14168', '2406.09246', '2410.24164', '2506.01844']);
    expect(papers.find((p) => p.id === '1706.03762')).toEqual({
      id: '1706.03762',
      title: 'Attention Is All You Need',
      authors: '',
      year: 2017,
      url: 'https://arxiv.org/abs/1706.03762',
      folderIds: [READING],
      progressPercent: 0,
      leftOff: '',
      addedAt: NOW,
      updatedAt: NOW,
      lastReadAt: null,
    });
  });

  it('never touches local reading state', () => {
    const mine = paper('1706.03762', { progressPercent: 60, leftOff: '3.2 Attention', lastReadAt: 5, pdf: { url: 'u', page: 4, pageCount: 15, offset: 0.3 } });
    const merged = mergeLibrary([mine], lib, NOW).papers.find((p) => p.id === mine.id)!;
    expect(merged).toMatchObject({ progressPercent: 60, leftOff: '3.2 Attention', lastReadAt: 5, pdf: mine.pdf, folderIds: [READING] });
  });

  it('returns an unchanged record as the same object, so storage is not rewritten for nothing', () => {
    const first = mergeLibrary([], lib, NOW).papers;
    const second = mergeLibrary(first, lib, NOW + 1).papers;
    second.forEach((p, i) => expect(p).toBe(first[i]));
  });

  it('a paper moved between folders on alphaXiv moves on the shelf', () => {
    const moved: Library = { folders: lib.folders.map((f) => (f.folder_id === READING ? { ...f, papers: [] } : f.folder_id === TO_READ ? { ...f, papers: [...(f.papers ?? []), { universal_paper_id: '1706.03762', title: 'Attention Is All You Need', type: 'public' }] } : f)) };
    const merged = mergeLibrary([paper('1706.03762', { folderIds: [READING] })], moved, NOW).papers.find((p) => p.id === '1706.03762')!;
    expect(merged.folderIds).toEqual([TO_READ]);
  });

  it('a paper in two folders sits on both shelves once', () => {
    const twice: Library = { folders: [{ folder_id: 'a', name: 'A', type: 'custom', papers: [{ universal_paper_id: '1706.03762', title: 'T' }] }, { folder_id: 'b', name: 'B', type: 'custom', papers: [{ universal_paper_id: '1706.03762', title: 'T' }] }] };
    const { papers } = mergeLibrary([], twice, NOW);
    expect(papers).toHaveLength(1);
    expect(papers[0].folderIds).toEqual(['a', 'b']);
  });

  it('a paper removed from every folder leaves the shelf but keeps its progress', () => {
    const mine = paper('9999.99999', { folderIds: [READING], progressPercent: 40 });
    const merged = mergeLibrary([mine], lib, NOW).papers.find((p) => p.id === mine.id)!;
    expect(merged.folderIds).toEqual([]);
    expect(merged.progressPercent).toBe(40);
  });

  it('a deleted or renamed folder: renamed keeps its id and papers; deleted empties its papers\' membership', () => {
    const renamed: Library = { folders: lib.folders.map((f) => (f.folder_id === READING ? { ...f, name: 'Now reading' } : f)) };
    const r = mergeLibrary([paper('1706.03762', { folderIds: [READING] })], renamed, NOW);
    expect(r.folders.find((f) => f.id === READING)?.name).toBe('Now reading');
    expect(r.papers.find((p) => p.id === '1706.03762')?.folderIds).toEqual([READING]);
    const deleted: Library = { folders: lib.folders.filter((f) => f.folder_id !== READING) };
    expect(mergeLibrary([paper('1706.03762', { folderIds: [READING] })], deleted, NOW).papers[0].folderIds).toEqual([]);
  });

  it('a truncated folder keeps memberships the reply could not show', () => {
    const cut: Library = { folders: [{ folder_id: 'big', name: 'Big', type: 'custom', papers: [{ universal_paper_id: '1706.03762', title: 'T' }], papers_truncated: true }] };
    const merged = mergeLibrary([paper('2006.11239', { folderIds: ['big'] })], cut, NOW).papers;
    expect(merged.find((p) => p.id === '2006.11239')?.folderIds).toEqual(['big']);
  });

  it('skips uploads and non-arXiv ids; an empty library empties the shelf but keeps the records', () => {
    const odd: Library = { folders: [{ folder_id: 'a', name: 'A', type: 'custom', papers: [{ universal_paper_id: 'upload-123', title: 'My draft', type: 'private' }, { universal_paper_id: '1706.03762', title: 'T', type: 'private' }] }] };
    expect(mergeLibrary([], odd, NOW).papers).toEqual([]);
    const mine = paper('1706.03762', { folderIds: ['a'] });
    const empty = mergeLibrary([mine], { folders: [] }, NOW);
    expect(empty.folders).toEqual([]);
    expect(empty.papers[0].folderIds).toEqual([]);
  });

  it('a blank remote title keeps the local one; a missing date keeps the local year', () => {
    const blank: Library = { folders: [{ folder_id: 'a', name: 'A', type: 'custom', papers: [{ universal_paper_id: '1706.03762', title: '  ', publication_date: null }] }] };
    const merged = mergeLibrary([paper('1706.03762', { title: 'Attention', year: 2017 })], blank, NOW).papers[0];
    expect(merged).toMatchObject({ title: 'Attention', year: 2017 });
  });
});

describe('planPush', () => {
  const folders: Folder[] = [
    { id: 'f-to-read', name: 'Want to read', type: 'default-to-read' },
    { id: 'f-diff', name: 'Diffusion', type: 'custom' },
  ];

  it('saves into existing folders by name, case- and space-insensitively, and creates the rest', () => {
    const plan = planPush(
      [
        { id: '2006.11239', folder: 'diffusion ' },
        { id: '1706.03762', folder: 'Transformers' },
        { id: '2406.09246', folder: 'Want  to read' },
      ],
      folders,
      [],
    );
    expect(plan.create).toEqual(['Transformers']);
    expect(plan.saves).toEqual([
      { folder: 'Diffusion', ids: ['2006.11239'] },
      { folder: 'Transformers', ids: ['1706.03762'] },
      { folder: 'Want to read', ids: ['2406.09246'] },
    ]);
  });

  it('skips papers already in the folder and duplicates in the queue', () => {
    const plan = planPush(
      [
        { id: '2006.11239', folder: 'Diffusion' },
        { id: '2006.11239', folder: 'Diffusion' },
      ],
      folders,
      [paper('2006.11239', { folderIds: ['f-diff'] })],
    );
    expect(plan).toEqual({ create: [], saves: [] });
    expect(planPush([{ id: 'a', folder: 'X' }, { id: 'a', folder: 'x' }], [], []).saves).toEqual([{ folder: 'X', ids: ['a'] }]);
  });

  it('a blank folder name goes to Want to read', () => {
    expect(planPush([{ id: 'a', folder: '  ' }], folders, []).saves).toEqual([{ folder: 'Want to read', ids: ['a'] }]);
  });

  it('batches at 50, the tool\'s cap', () => {
    const queue = Array.from({ length: 120 }, (_, i) => ({ id: `2401.${String(i).padStart(5, '0')}`, folder: 'Diffusion' }));
    expect(planPush(queue, folders, []).saves.map((s) => s.ids.length)).toEqual([50, 50, 20]);
  });

  it('an empty queue is an empty plan', () => {
    expect(planPush([], folders, [])).toEqual({ create: [], saves: [] });
    expect(folderKey('  A   b ')).toBe('a b');
  });
});
