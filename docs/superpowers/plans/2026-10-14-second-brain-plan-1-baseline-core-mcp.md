# Second brain, plan 1 of 5: baseline, platform ground truth, shared core, vault MCP server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Notion baseline and measure the platform before any product code. Then build the tested shared vault logic and the vault MCP server that the import (plan 2) runs through.

**Architecture:**
- **Node tooling under `mcp/brain/`, bundled by esbuild into `dist-mcp/`:**
  - The step 0 baseline commands.
  - The step 1 platform probes.
  - The MCP server.
- **Pure vault logic under `src/shared/brain/`:** parsing, links, search, journaled plans and renames. It never touches disk; each host injects its I/O. The Brain page (plans 3 to 5) reuses it unchanged.
- **Oracles are built in this plan, next to the code they judge.** Each is something other than its author:
  - Obsidian's own metadata cache.
  - The CommonMark spec's expected output.
  - The `yaml` library.
  - Model-based tests.

**Tech Stack:**
- Runtime: TypeScript 5.8, Node 25 locally (CI runs Node 22), Vitest 3, esbuild 0.28.
- New pinned dependencies:
  - `@modelcontextprotocol/sdk` 1.31.0
  - `zod` 4.6.5
  - `yaml` 2.9.1
  - `@lezer/markdown` 1.7.2
  - `fast-check` 4.10.2 (dev only)
- Built-ins used: `node:sqlite` and `node:worker_threads`.

**Spec:** `docs/superpowers/specs/2026-10-14-second-brain-design.md` (read it first; this plan argues from it).

**Plans 2 to 5** are written after Task 28, once step 1's measurements exist (the spec says they may change the design):
- Plan 2: area map, audit, import, to stop A.
- Plan 3: read-only Brain page, to stop B.
- Plan 4: core editing, to stop C.
- Plan 5: extras, to stop D.

**Shared modules that wait for the plan that first uses them:** `merge.ts` (plan 4, auto-merge), `properties.ts` and `base.ts` (plan 2 writes `.base` files and typed properties; plan 3 lists `.base` rows), `tables.ts` and `templates.ts` (plan 5).

**One deliberate difference from the spec:** the spec asks for a per-path write lock in the server; this plan uses one queue for all writes (Task 22), which serialises strictly more. The `ponytail:` comment there names the upgrade.

## Global Constraints

- **Public repo:**
  - Never commit any of these: user notes, Notion content, Notion exports, Chrome history, recall questions, the personal vault path, reports.
  - Personal data lives only in `<vault>/.brain/reports/` or outside both the repo and the vault.
  - Fixtures are synthetic.
- **Notion:** Claude never writes to Notion. Never import or sample the page titled `Account Informations`.
- **Uncommitted work:** do not touch, stage or commit the user's Pomodoro changes. They are about 40 files, including `vite.config.ts`, `manifest.config.ts`, `src/shared/types.ts` and `src/pages/newtab/*`.
  - Stage files by explicit path only, never `git add -A` or `git add .`.
  - This plan modifies none of those files.
- **Dependencies:** exact versions, each at least 14 days old: `@modelcontextprotocol/sdk@1.31.0 zod@4.6.5 yaml@2.9.1 @lezer/markdown@1.7.2`, dev `fast-check@4.10.2`. Add nothing else.
- **No I/O in shared code:** `src/shared/brain/*` never imports `node:*`, `chrome.*` or `fetch`. Hosts pass I/O in through `PlanFs`.
- **Titles:**
  - Titles are unique across the vault ignoring case, NFC-normalised, and filename-safe for Windows and Drive (`/ \ : * ? " < > |`), plus `# ^ [ ]` because they break links.
  - Links are title-only: `[[Title]]`, `[[Title|text]]`, `[[Title#Heading]]`, `![[...]]`.
- **Frontmatter:** a flat subset: scalars and lists of scalars. `toText(parseNote(x)) === x` byte for byte, including CRLF and BOM.
- **MCP write guard:**
  - Refused: `sources/` (except during `promote_staging`) and `.obsidian/`.
  - Inside `.brain/`, only these may be written: `staging/`, `journal/`, `history/`, `trash/`, `import/`, `mcp-log.jsonl` and `starred.json`.
  - Comparisons ignore case (macOS and Windows are case-insensitive).
- **The recall benchmark is blind.** Claude never opens `.brain/reports/recall-questions.md`. Task 27 adds a permission deny rule for it.
- **Before every commit that changes code (not docs or tests only):** run `npm run typecheck`, `npm test` and the project's `/verify` skill.
- **Style:**
  - Comments say why, in plain sentences.
  - Tests use `describe` and `it` from `vitest`, next to the code (`x.ts` and `x.test.ts`).
  - Commit messages are plain sentences, as in `git log`, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No emojis** anywhere: code, fixtures, output. Fixtures use astral-plane letters (`𝑥`, `𝔼`) where the spec says "emoji", which tests the same surrogate-pair handling.

## Review Focus

Each line names an input that the spec implies, followed by the behaviour a person would expect. Each has a test in the task named in brackets.

1. **A note saved on Windows with CRLF endings:** reading, saving, editing one property and rewriting its links keeps every `\r\n`. [Task 12, Task 19]
2. **A file name that macOS lists in decomposed form (NFD)**, for a note linked as `[[Café]]` in NFC: it resolves, renames and rewrites like any other note. [Task 14, Task 22]
3. **A huge note** (1 MB of text, 20,000 lines): indexing it and searching it stay well under a second, and nothing is quadratic. [Task 15, Task 17]
4. **Notion URLs in Chrome history:**
   - Side peeks (`?p=`), `app.notion.com/p/…` links, `*.notion.site` public pages and dashed ids each count as a visit to the page actually shown.
   - Login and other non-page URLs count as nothing.
   [Task 1]
5. **Claude renames a note while a parallel call edits it.** No file is lost. The edit either lands in the renamed note or fails with "No note titled …". It never writes to the old path. [Task 25]

---

## File structure

```
mcp/
  tsconfig.json                     Node types for everything under mcp/ and src/shared/brain
  brain/
    README.md                       how to build, run and register the server
    cli.ts                          `node dist-mcp/cli.mjs <command>`: one entry for every local tool
    args.ts                         --vault / BRAIN_VAULT, reports folder, terminal prompts
    baseline/
      notion.ts                     pure: Notion URL ids, Chrome time, ISO weeks, Notion link measure
      notionDb.ts                   read-only node:sqlite access to Notion's local cache
      usage.ts                      `usage`: Chrome history -> visits per Notion page
      notionLinks.ts                `notion-links`: the Notion side of the Connections baseline
      sample.ts                     pure: seeded PRNG, stratified sample, card-sort parser
      cards.ts                      `cards`: write the card sort, read it back
      recall.ts                     `recall`: the frozen, timed recall benchmark
      treeTest.ts                   `tree-test`: tree testing on an area map
      report.ts                     `baseline`: baseline.md from the reports
    platform/
      driveProbe.ts                 `drive-probe`: sync delay, mtime, rename, conflict, cold reads
    probe/fsa/                      dev-only unpacked extension: File System Access probe (never shipped)
      manifest.json  sw.js  probe.html  probe.js
    guards.ts                       what the server may write; which folders the index skips
    nodeFs.ts                       PlanFs on disk: atomic writes, path and symlink guards
    vault.ts                        in-memory index, refresh, staleness, history copies, log, staging digest
    searchWorker.ts                 regex search in a worker so a runaway regex can be stopped
    regexSearch.ts                  runs searchWorker with the 2 s cut-off
    server.ts                       the MCP server and its tools
    diffObsidian.ts                 compare our index with Obsidian's metadata cache
    obsidian/dump.js                pasted into Obsidian's console to export its metadata cache
    fixtures/
      README.md                     sources and licences of vendored test data
      commonmark-0.31.2.json        CommonMark spec examples (subset), CC BY-SA 4.0
      vault/                        the synthetic fixture vault
      obsidian-dump.json            Obsidian's view of fixtures/vault (generated in Obsidian, checked in)
      obsidian-deviations.json      differences we keep on purpose, each with a reason
src/shared/brain/
  names.ts  daily.ts  frontmatter.ts  blocks.ts  links.ts  entry.ts
  query.ts  search.ts  plan.ts  memFs.ts  rename.ts  mentions.ts
.mcp.json                           registers the server, vault path from $BRAIN_VAULT
.claude/settings.json               allowlists the read tools; denies reading the recall questions
.gitattributes                      keeps fixture line endings byte-exact
```

---

## Part A: step 0, the baseline

### Task 1: Brain CLI, and visits per Notion page from Chrome's history

**Files:**
- Create:
  - `mcp/tsconfig.json`
  - `mcp/brain/args.ts`
  - `mcp/brain/cli.ts`
  - `mcp/brain/baseline/notion.ts`
  - `mcp/brain/baseline/notionDb.ts`
  - `mcp/brain/baseline/usage.ts`
- Modify:
  - `package.json`: scripts `build:mcp`, `brain`, `typecheck`
  - `.gitignore`: `dist-mcp/`
- Test: `mcp/brain/baseline/notion.test.ts`

**Interfaces:**
- Produces:
  - In `notion.ts`:
    - `toUuid(hex32: string): string`
    - `notionPageId(url: string): string | null`
    - `chromeTimeToMs(t: number): number`
    - `isoWeek(ms: number): string`
    - `aggregateVisits(v: { id: string | null; ms: number }[]): Record<string, PageVisits>`
    - `notionTitle(properties: string | null): string`
    - `interface PageVisits { visits: number; weeks: Record<string, number>; lastVisit: string }`
  - In `args.ts`:
    - `vaultPath(flag?: string): string`
    - `reportsDir(vault: string): Promise<string>`
    - `terminal(): Io & { close(): void }`
    - `interface Io { ask(prompt: string): Promise<string>; say(text: string): void; now(): number }`
  - In `notionDb.ts`:
    - `readNotion(file?: string): { blocks: NBlock[]; collectionParents: Map<string, string> }`
    - `pageTitles(blocks: NBlock[]): Map<string, string>`
    - `NOTION_DB`
  - In `cli.ts`: a registry `commands` that later tasks add to.

- [ ] **Step 1: Install the pinned dependencies and add the Node tsconfig**

Run:
```bash
npm install --save-exact @modelcontextprotocol/sdk@1.31.0 zod@4.6.5 yaml@2.9.1 @lezer/markdown@1.7.2
npm install --save-exact --save-dev fast-check@4.10.2
```

Create `mcp/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "resolveJsonModule": true
  },
  "include": [".", "../src/shared/brain"]
}
```

In `package.json` `scripts`, add the two new entries and extend `typecheck` (leave every other script as it is):
```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p e2e && tsc --noEmit -p mcp",
    "build:mcp": "esbuild mcp/brain/cli.ts mcp/brain/server.ts mcp/brain/searchWorker.ts --bundle --platform=node --format=esm --target=node22 --outdir=dist-mcp --out-extension:.js=.mjs --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\" --log-level=error",
    "brain": "npm run -s build:mcp && node dist-mcp/cli.mjs",
```
`server.ts` and `searchWorker.ts` do not exist until Tasks 24 and 25. Until then, use this temporary `build:mcp`, which bundles only `mcp/brain/cli.ts`; Task 24 restores the full entry list:
```json
    "build:mcp": "esbuild mcp/brain/cli.ts --bundle --platform=node --format=esm --target=node22 --outdir=dist-mcp --out-extension:.js=.mjs --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\" --log-level=error",
```

Append to `.gitignore`:
```
# Bundled brain CLI and MCP server (npm run build:mcp)
dist-mcp/
```

- [ ] **Step 2: Write the failing tests**

Create `mcp/brain/baseline/notion.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { aggregateVisits, chromeTimeToMs, isoWeek, notionPageId, notionTitle, toUuid } from './notion';

const ID = '305a8b0b-408d-800b-bfca-c9072e86e85c';
const HEX = '305a8b0b408d800bbfcac9072e86e85c';

describe('notionPageId', () => {
  it('reads the id at the end of a page URL', () => {
    expect(notionPageId(`https://www.notion.so/space/Deep-Learning-Class-${HEX}`)).toBe(ID);
  });
  it('prefers the side peek (?p=) over the page behind it', () => {
    expect(notionPageId(`https://www.notion.so/space/Board-1111111111111111aaaaaaaaaaaaaaaa?p=${HEX}&pm=s`)).toBe(ID);
  });
  it('reads app.notion.com, notion.site and dashed ids', () => {
    expect(notionPageId('https://app.notion.com/p/job-tracker-3d7a8b0b408d801ca8bad7dc07e6e3e7?source=copy_link')).toBe(
      '3d7a8b0b-408d-801c-a8ba-d7dc07e6e3e7',
    );
    expect(notionPageId(`https://someone.notion.site/Public-Page-${HEX}`)).toBe(ID);
    expect(notionPageId(`https://www.notion.so/${ID}`)).toBe(ID);
  });
  it('ignores non-page Notion URLs and other sites', () => {
    expect(notionPageId('https://www.notion.so/login')).toBeNull();
    expect(notionPageId(`https://example.com/${HEX}`)).toBeNull();
    expect(notionPageId('not a url')).toBeNull();
  });
});

describe('time', () => {
  it('converts Chrome microseconds since 1601 to Unix milliseconds', () => {
    expect(chromeTimeToMs(11644473600000000)).toBe(0);
    expect(chromeTimeToMs(11644473600000000 + 86_400_000_000)).toBe(86_400_000);
  });
  it('names ISO weeks, including week 53 and the year boundary', () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2025, 11, 29))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('aggregateVisits', () => {
  it('counts visits per page and per week and keeps the latest', () => {
    const a = Date.UTC(2026, 9, 12), b = Date.UTC(2026, 9, 14);
    expect(aggregateVisits([{ id: ID, ms: a }, { id: ID, ms: b }, { id: null, ms: b }])).toEqual({
      [ID]: { visits: 2, weeks: { '2026-W42': 2 }, lastVisit: new Date(b).toISOString() },
    });
  });
});

describe('notionTitle and toUuid', () => {
  it('joins the text runs of a title', () => {
    expect(notionTitle('{"title":[["Deep "],["Learning",[["b"]]]]}')).toBe('Deep Learning');
    expect(notionTitle(null)).toBe('');
    expect(notionTitle('not json')).toBe('');
  });
  it('dashes a 32-character id', () => {
    expect(toUuid(HEX.toUpperCase())).toBe(ID);
  });
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/baseline/notion.test.ts`
Expected: FAIL with `Failed to resolve import "./notion"`.

- [ ] **Step 4: Write the pure helpers**

Create `mcp/brain/baseline/notion.ts`:
```ts
/**
 * Pure helpers for the step 0 baseline: which Notion page a URL shows, Chrome's
 * timestamps, and the link measure over Notion's own block records. Nothing
 * here reads a file; the commands do that.
 */

export interface PageVisits { visits: number; weeks: Record<string, number>; lastVisit: string }

export const toUuid = (hex: string): string => {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const NOTION_HOST = /(^|\.)notion\.(so|com|site)$/i;
const TAIL_ID = /([0-9a-f]{32})$/i;

/** The page a Notion URL shows. A side peek (?p=) is the page being read, not the one behind it. */
export function notionPageId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!NOTION_HOST.test(u.hostname)) return null;
  const peek = u.searchParams.get('p');
  const fromPeek = peek ? TAIL_ID.exec(peek.replace(/-/g, '')) : null;
  if (fromPeek) return toUuid(fromPeek[1]);
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '').replace(/-/g, '');
  const m = TAIL_ID.exec(last);
  return m ? toUuid(m[1]) : null;
}

/** Chrome stores times as microseconds since 1601-01-01 UTC. */
export const chromeTimeToMs = (t: number): number => t / 1000 - 11644473600000;

/** ISO 8601 week, in UTC so the counts do not move with the machine's time zone. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thursday = day + (3 - ((d.getUTCDay() + 6) % 7)) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function aggregateVisits(visits: { id: string | null; ms: number }[]): Record<string, PageVisits> {
  const out: Record<string, PageVisits> = {};
  for (const v of visits) {
    if (!v.id) continue;
    const p = (out[v.id] ??= { visits: 0, weeks: {}, lastVisit: new Date(0).toISOString() });
    p.visits++;
    const w = isoWeek(v.ms);
    p.weeks[w] = (p.weeks[w] ?? 0) + 1;
    if (new Date(v.ms).toISOString() > p.lastVisit) p.lastVisit = new Date(v.ms).toISOString();
  }
  return out;
}

/** Notion keeps a title as runs of [text, annotations]; only the text matters here. */
export function notionTitle(properties: string | null): string {
  if (!properties) return '';
  try {
    const runs = JSON.parse(properties)?.title;
    return Array.isArray(runs) ? runs.map((r: unknown) => (Array.isArray(r) && typeof r[0] === 'string' ? r[0] : '')).join('') : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/baseline/notion.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Write the CLI, the arguments helper, the Notion cache reader and the `usage` command**

Create `mcp/brain/args.ts`:
```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/** Prompts for the interactive commands; tests pass a scripted one instead. */
export interface Io { ask(prompt: string): Promise<string>; say(text: string): void; now(): number }

export function vaultPath(flag?: string): string {
  const v = flag ?? process.env.BRAIN_VAULT;
  if (!v) throw new Error('Give --vault <folder> or set BRAIN_VAULT to the vault folder.');
  return v;
}

/** Personal results go here, inside the vault, never into the repo. */
export async function reportsDir(vault: string): Promise<string> {
  const dir = join(vault, '.brain', 'reports');
  await mkdir(dir, { recursive: true });
  return dir;
}

export function terminal(): Io & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (p) => rl.question(p), say: (t) => console.log(t), now: () => Date.now(), close: () => rl.close() };
}
```

Create `mcp/brain/baseline/notionDb.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { notionTitle } from './notion';

/** One row of Notion's local block cache, the columns the baseline needs. */
export interface NBlock { id: string; type: string; parent_id: string | null; properties: string | null; format: string | null; alive: number }

export const NOTION_DB = join(homedir(), 'Library/Application Support/Notion/notion.db');

/** Read-only: Notion keeps the file open, and nothing here may change it. */
export function readNotion(file = NOTION_DB): { blocks: NBlock[]; collectionParents: Map<string, string> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, type, parent_id, properties, format, alive FROM block').all() as unknown as NBlock[];
    // The cache can hold one row per signed-in user; one per block is enough here.
    const blocks = [...new Map(rows.map((b) => [b.id, b])).values()];
    const collections = db.prepare('SELECT id, parent_id FROM collection').all() as unknown as { id: string; parent_id: string }[];
    return { blocks, collectionParents: new Map(collections.map((c) => [c.id, c.parent_id])) };
  } finally {
    db.close();
  }
}

export function pageTitles(blocks: NBlock[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) if (b.type === 'page' || b.type === 'collection_view_page') out.set(b.id, notionTitle(b.properties));
  return out;
}
```

Create `mcp/brain/baseline/usage.ts`:
```ts
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { aggregateVisits, chromeTimeToMs, notionPageId } from './notion';
import { NOTION_DB, pageTitles, readNotion } from './notionDb';

const HISTORY = join(homedir(), 'Library/Application Support/Google/Chrome/Default/History');

/**
 * Visits per Notion page from Chrome's own history. Only page ids and counts
 * are kept: every URL, and every other site, is dropped before anything is
 * written. Run only after the user says yes (spec, Ground truth).
 */
export async function usage(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, history: { type: 'string' }, notion: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  // Chrome holds a lock on the live file, so read a copy.
  const copy = join(tmpdir(), `brain-history-${process.pid}.sqlite`);
  await copyFile(values.history ?? HISTORY, copy);
  let rows: { url: string; time: number | bigint }[];
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    const stmt = db.prepare("SELECT urls.url AS url, visits.visit_time AS time FROM visits JOIN urls ON urls.id = visits.url WHERE urls.url LIKE '%notion.%'");
    // Chrome's microseconds since 1601 pass Number.MAX_SAFE_INTEGER; read them as bigints, then round.
    stmt.setReadBigInts(true);
    rows = stmt.all() as unknown as { url: string; time: number | bigint }[];
    db.close();
  } finally {
    await rm(copy, { force: true });
  }
  const pages = aggregateVisits(rows.map((r) => ({ id: notionPageId(r.url), ms: chromeTimeToMs(Number(r.time)) })));
  await writeFile(join(reports, 'baseline-usage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 1));

  // A readable list for writing the recall questions: titles come from Notion's own cache.
  const titles = pageTitles(readNotion(values.notion ?? NOTION_DB).blocks);
  const top = Object.entries(pages).sort((a, b) => b[1].visits - a[1].visits).slice(0, 100);
  const md = [
    '# Most visited Notion pages',
    '',
    'From Chrome history. Use it to remember what you actually look things up for.',
    '',
    '| Visits | Last visit | Page |',
    '|---|---|---|',
    ...top.map(([id, p]) => `| ${p.visits} | ${p.lastVisit.slice(0, 10)} | ${titles.get(id) || '(not in the Notion cache)'} |`),
    '',
  ].join('\n');
  await writeFile(join(reports, 'baseline-usage.md'), md);
  console.log(`${Object.keys(pages).length} Notion pages, ${rows.length} visits. Wrote baseline-usage.json and baseline-usage.md to ${reports}`);
}
```

Create `mcp/brain/cli.ts`:
```ts
/**
 * One entry for the brain's local tools: `node dist-mcp/cli.mjs <command> [flags]`.
 * Each command writes only under <vault>/.brain/reports/, or prints.
 */
import { usage } from './baseline/usage';

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  usage,
};

const [name, ...argv] = process.argv.slice(2);
const run = name ? commands[name] : undefined;
if (!run) {
  console.error(`Usage: node dist-mcp/cli.mjs <${Object.keys(commands).join(' | ')}> [flags]`);
  process.exit(2);
}
run(argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 7: Typecheck, build and smoke-run the command without personal data**

Run: `npm run typecheck && npm run build:mcp && node dist-mcp/cli.mjs`
Expected: typecheck clean, and the CLI prints `Usage: node dist-mcp/cli.mjs <usage> [flags]` with exit code 2. Do not run `usage` itself yet; Task 6 does that, with the user's go-ahead.

- [ ] **Step 8: Commit**

Run `npm test` and `/verify` first (Global Constraints).
```bash
git add mcp/tsconfig.json mcp/brain/args.ts mcp/brain/cli.ts mcp/brain/baseline/notion.ts mcp/brain/baseline/notion.test.ts mcp/brain/baseline/notionDb.ts mcp/brain/baseline/usage.ts package.json package-lock.json .gitignore
git commit -m "Brain CLI, and visits per Notion page from Chrome's history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Notion side of the Connections baseline

**Files:**
- Modify:
  - `mcp/brain/baseline/notion.ts`: add `linkTargets`, `linkMeasure`
  - `mcp/brain/cli.ts`: register `notion-links`
- Create: `mcp/brain/baseline/notionLinks.ts`
- Test: `mcp/brain/baseline/notion.test.ts`

**Interfaces:**
- Consumes: `NBlock` and `readNotion` (Task 1).
- Produces:
  - `linkTargets(b: NBlock): string[]`
  - `linkMeasure(blocks: NBlock[], collectionParents: Map<string, string>, scope?: { roots?: string[]; exclude?: string[] }): { pages: number; connected: number; share: number }`

The spec's measure is the share of in-scope pages with at least one link in and one link out. In Notion's cache, a link is one of two things:
- An `alias` block (link to page), whose `format.alias_pointer.id` is the target.
- A `["p", "<page id>", "<space id>"]` mention inside a block's `properties`. This covers inline mentions and relation values.

Both shapes were confirmed against the user's `notion.db` with ids masked.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/brain/baseline/notion.test.ts`:
```ts
import { linkMeasure, linkTargets } from './notion';
import type { NBlock } from './notionDb';

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const ROOT = '99999999-9999-9999-9999-999999999999';
const SPACE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const block = (b: Partial<NBlock> & { id: string }): NBlock => ({ type: 'text', parent_id: null, properties: null, format: null, alive: 1, ...b });

const vault: NBlock[] = [
  block({ id: ROOT, type: 'page', properties: '{"title":[["Root"]]}' }),
  block({ id: P1, type: 'page', parent_id: ROOT }),
  block({ id: P2, type: 'page', parent_id: ROOT }),
  block({ id: P3, type: 'page', parent_id: ROOT }),
  block({ id: 'b1', parent_id: P1, properties: `{"title":[["see "],["‣",[["p","${P2}","${SPACE}"]]]]}` }),
  block({ id: 'b2', type: 'alias', parent_id: P2, format: `{"alias_pointer":{"id":"${P1}","table":"block"}}` }),
  block({ id: 'b3', parent_id: P3, properties: `{"title":[["‣",[["p","${P1}","${SPACE}"]]]]}`, alive: 0 }),
];

describe('linkTargets', () => {
  it('reads link-to-page blocks and page mentions', () => {
    expect(linkTargets(vault[4])).toEqual([P2]);
    expect(linkTargets(vault[5])).toEqual([P1]);
    expect(linkTargets(block({ id: 'x', type: 'alias', format: 'broken' }))).toEqual([]);
  });
});

describe('linkMeasure', () => {
  it('counts pages with a link both in and out, ignoring deleted blocks', () => {
    expect(linkMeasure(vault, new Map(), { roots: [ROOT] })).toEqual({ pages: 4, connected: 2, share: 0.5 });
  });
  it('drops excluded subtrees from the scope', () => {
    expect(linkMeasure(vault, new Map(), { roots: [ROOT], exclude: [P2] })).toEqual({ pages: 3, connected: 0, share: 0 });
  });
  it('follows database rows up through their collection', () => {
    const rows = [...vault, block({ id: 'row', type: 'page', parent_id: 'coll' })];
    expect(linkMeasure(rows, new Map([['coll', P3]]), { roots: [ROOT] }).pages).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/baseline/notion.test.ts`
Expected: FAIL with `linkMeasure is not a function` (or the equivalent import error).

- [ ] **Step 3: Implement**

Append to `mcp/brain/baseline/notion.ts`:
```ts
import type { NBlock } from './notionDb';

const PAGE_TYPES = new Set(['page', 'collection_view_page']);
const MENTION = /\["p","([0-9a-f-]{36})"/g;

/** Pages a block links to: a link-to-page block, or page mentions in its text and properties. */
export function linkTargets(b: NBlock): string[] {
  const out: string[] = [];
  if (b.type === 'alias' && b.format) {
    try {
      const id = JSON.parse(b.format)?.alias_pointer?.id;
      if (typeof id === 'string') out.push(id);
    } catch {
      // A malformed format is not a link.
    }
  }
  if (b.properties) for (const m of b.properties.matchAll(MENTION)) out.push(m[1]);
  return out;
}

/**
 * The spec's Connections baseline: of the in-scope pages, the share with at
 * least one link in and one link out. Database rows hang off a collection, not
 * a block, so `collectionParents` carries them up to the page that holds it.
 */
export function linkMeasure(
  blocks: NBlock[],
  collectionParents: Map<string, string>,
  scope: { roots?: string[]; exclude?: string[] } = {},
): { pages: number; connected: number; share: number } {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const parent = (id: string) => byId.get(id)?.parent_id ?? collectionParents.get(id) ?? null;
  const roots = new Set(scope.roots ?? []);
  const exclude = new Set(scope.exclude ?? []);
  const inScope = (id: string): boolean => {
    for (let cur: string | null = id, i = 0; cur && i < 500; cur = parent(cur), i++) {
      if (exclude.has(cur)) return false;
      if (roots.has(cur)) return true;
    }
    return roots.size === 0;
  };
  const pageOf = (id: string): string | null => {
    for (let cur: string | null = id, i = 0; cur && i < 500; cur = parent(cur), i++) {
      const b = byId.get(cur);
      if (b && PAGE_TYPES.has(b.type)) return b.id;
    }
    return null;
  };
  const pages = blocks.filter((b) => b.alive && PAGE_TYPES.has(b.type) && inScope(b.id)).map((b) => b.id);
  const scoped = new Set(pages);
  const out = new Set<string>();
  const into = new Set<string>();
  for (const b of blocks) {
    if (!b.alive) continue;
    const src = pageOf(b.id);
    if (!src || !scoped.has(src)) continue;
    for (const t of linkTargets(b)) {
      if (t === src || !scoped.has(t)) continue;
      out.add(src);
      into.add(t);
    }
  }
  const connected = pages.filter((p) => out.has(p) && into.has(p)).length;
  return { pages: pages.length, connected, share: pages.length ? connected / pages.length : 0 };
}
```
Move the new `import type { NBlock } from './notionDb';` to the top of the file, with any other imports.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/baseline/notion.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Add the command**

Create `mcp/brain/baseline/notionLinks.ts`:
```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { linkMeasure, toUuid } from './notion';
import { NOTION_DB, readNotion } from './notionDb';

const ids = (s?: string) => (s ? s.split(',').map((x) => toUuid(x.trim().replace(/-/g, ''))) : undefined);

/**
 * Notion's Connections baseline. With no --roots it covers every page in the
 * cache; rerun it with the in-scope roots once the area map exists (plan 2).
 */
export async function notionLinks(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, notion: { type: 'string' }, roots: { type: 'string' }, exclude: { type: 'string' } } });
  const { blocks, collectionParents } = readNotion(values.notion ?? NOTION_DB);
  const scope = { roots: ids(values.roots), exclude: ids(values.exclude) };
  const m = linkMeasure(blocks, collectionParents, scope);
  const reports = await reportsDir(vaultPath(values.vault));
  await writeFile(join(reports, 'baseline-links.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scope, ...m }, null, 1));
  console.log(`${m.connected} of ${m.pages} pages link both ways (${(m.share * 100).toFixed(1)}%).`);
}
```
In `mcp/brain/cli.ts`, add `import { notionLinks } from './baseline/notionLinks';` and the entry `'notion-links': notionLinks,` to `commands`.

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build:mcp && node dist-mcp/cli.mjs`
Expected: clean, and the usage line lists `usage | notion-links`.

- [ ] **Step 7: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/baseline/notion.ts mcp/brain/baseline/notion.test.ts mcp/brain/baseline/notionLinks.ts mcp/brain/cli.ts
git commit -m "Baseline: how many Notion pages link both ways, from Notion's own cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The card sort

**Files:**
- Create:
  - `mcp/brain/baseline/sample.ts`
  - `mcp/brain/baseline/cards.ts`
- Modify: `mcp/brain/cli.ts`: register `cards`
- Test: `mcp/brain/baseline/sample.test.ts`

**Interfaces:**
- Consumes: `readNotion`, `pageTitles`, `NBlock` (Task 1).
- Produces:
  - `mulberry32(seed: number): () => number`
  - `stratifiedSample<T>(items: T[], stratum: (x: T) => string, n: number, seed: number): T[]`
  - `parseGroups(md: string, expected: string[]): { name: string; cards: string[] }[]`. It throws listing every problem.
  - Plan 2 reads `card-sort.json` to draft the area map.

The spec says the area map comes from the user's own grouping: an open card sort of about 40 representative page titles. "Representative" means stratified by top-level Notion page, so every area of the workspace shows up. The sample is seeded, so it is reproducible.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/baseline/sample.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mulberry32, parseGroups, stratifiedSample } from './sample';

describe('mulberry32', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('stratifiedSample', () => {
  const items = [...Array.from({ length: 30 }, (_, i) => `school-${i}`), ...Array.from({ length: 5 }, (_, i) => `career-${i}`), 'misc-0'];
  const stratum = (s: string) => s.split('-')[0];
  it('draws from every stratum before taking more of any', () => {
    const s = stratifiedSample(items, stratum, 6, 1);
    expect(new Set(s.map(stratum))).toEqual(new Set(['school', 'career', 'misc']));
    expect(s).toHaveLength(6);
  });
  it('is reproducible and never repeats an item', () => {
    const s = stratifiedSample(items, stratum, 20, 3);
    expect(s).toEqual(stratifiedSample(items, stratum, 20, 3));
    expect(new Set(s).size).toBe(20);
  });
  it('returns everything when n exceeds the pool', () => {
    expect(stratifiedSample(items, stratum, 100, 1)).toHaveLength(items.length);
  });
});

describe('parseGroups', () => {
  const expected = ['Sigmoid', 'Lecture 3', 'Resume'];
  it('reads groups under ## headings', () => {
    expect(parseGroups('# Card sort\n\nintro\n\n## Class\n- Sigmoid\n- Lecture 3\n\n## Jobs\n- Resume\n', expected)).toEqual([
      { name: 'Class', cards: ['Sigmoid', 'Lecture 3'] },
      { name: 'Jobs', cards: ['Resume'] },
    ]);
  });
  it('lists every ungrouped, missing, duplicated or unknown card', () => {
    expect(() => parseGroups('- Sigmoid\n## A\n- Lecture 3\n- Lecture 3\n- Stranger\n', expected)).toThrow(
      /not in a group: Sigmoid[\s\S]*more than once: Lecture 3[\s\S]*not in the sample: Stranger[\s\S]*missing: Resume/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/baseline/sample.test.ts`
Expected: FAIL with `Failed to resolve import "./sample"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/baseline/sample.ts`:
```ts
/** Seeded so a sample can be drawn again exactly, by anyone, without Claude choosing it. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Round-robin over shuffled strata, so small areas of the workspace are not drowned by large ones. */
export function stratifiedSample<T>(items: T[], stratum: (x: T) => string, n: number, seed: number): T[] {
  const rand = mulberry32(seed);
  const groups = new Map<string, T[]>();
  for (const x of items) (groups.get(stratum(x)) ?? groups.set(stratum(x), []).get(stratum(x))!).push(x);
  const queues = shuffle([...groups.keys()].sort(), rand).map((k) => shuffle(groups.get(k)!, rand));
  const out: T[] = [];
  while (out.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return shuffle(out, rand);
}

/** The sorted card file: "## Group" headings with "- card" lines. Every sampled card exactly once. */
export function parseGroups(md: string, expected: string[]): { name: string; cards: string[] }[] {
  const groups: { name: string; cards: string[] }[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      groups.push({ name: h[1], cards: [] });
      continue;
    }
    const c = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!c) continue;
    if (!groups.length) problems.push(`not in a group: ${c[1]}`);
    else groups[groups.length - 1].cards.push(c[1]);
    seen.set(c[1], (seen.get(c[1]) ?? 0) + 1);
  }
  for (const [card, k] of seen) if (k > 1) problems.push(`more than once: ${card}`);
  const known = new Set(expected);
  for (const card of seen.keys()) if (!known.has(card)) problems.push(`not in the sample: ${card}`);
  for (const card of expected) if (!seen.has(card)) problems.push(`missing: ${card}`);
  if (problems.length) throw new Error(`The card sort is not finished:\n${problems.join('\n')}`);
  return groups.filter((g) => g.cards.length);
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/baseline/sample.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the command**

Create `mcp/brain/baseline/cards.ts`:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { NOTION_DB, pageTitles, readNotion } from './notionDb';
import { parseGroups, stratifiedSample } from './sample';

// Never sampled, never imported (spec, Scope of import).
const NEVER = new Set(['account informations']);

/**
 * `cards` writes about 40 page titles for the user to group; `cards --read`
 * checks the grouping and saves it as card-sort.json for plan 2's area map.
 */
export async function cards(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, notion: { type: 'string' }, read: { type: 'boolean' }, n: { type: 'string' }, seed: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  const samplePath = join(reports, 'card-sort-sample.json');
  const sortPath = join(reports, 'card-sort.md');
  if (values.read) {
    const expected = JSON.parse(await readFile(samplePath, 'utf8')) as string[];
    const groups = parseGroups(await readFile(sortPath, 'utf8'), expected);
    await writeFile(join(reports, 'card-sort.json'), JSON.stringify({ readAt: new Date().toISOString(), groups }, null, 1));
    console.log(`${groups.length} groups, ${expected.length} cards. Saved card-sort.json.`);
    return;
  }
  const { blocks, collectionParents } = readNotion(values.notion ?? NOTION_DB);
  const titles = pageTitles(blocks);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const parent = (id: string) => byId.get(id)?.parent_id ?? collectionParents.get(id) ?? null;
  // The stratum is the top-level page a page sits under: its area of the workspace.
  const top = (id: string) => {
    let cur = id;
    for (let i = 0; i < 500; i++) {
      const p = parent(cur);
      if (!p || !titles.has(p)) return cur;
      cur = p;
    }
    return cur;
  };
  const pages = [...titles].filter(([id, t]) => t.trim() && byId.get(id)?.alive && !NEVER.has(t.trim().toLowerCase()));
  const titleTaken = new Set<string>();
  const unique = pages.filter(([, t]) => !titleTaken.has(t) && titleTaken.add(t));
  const picked = stratifiedSample(unique, ([id]) => top(id), Number(values.n ?? 40), Number(values.seed ?? 1)).map(([, t]) => t);
  await writeFile(samplePath, JSON.stringify(picked, null, 1));
  await writeFile(
    sortPath,
    [
      '# Card sort',
      '',
      'Group these pages the way you think about them. Add a "## Group name" heading for each group, in your own words, and move every "- title" line under one heading. Use as many groups as you like. Leave nothing ungrouped.',
      '',
      'When done, run: node dist-mcp/cli.mjs cards --read',
      '',
      ...picked.map((t) => `- ${t}`),
      '',
    ].join('\n'),
  );
  console.log(`Wrote ${picked.length} cards to ${sortPath}`);
}
```
In `mcp/brain/cli.ts`, add `import { cards } from './baseline/cards';` and `cards,` to `commands`.

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build:mcp`
Expected: clean.

- [ ] **Step 7: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/baseline/sample.ts mcp/brain/baseline/sample.test.ts mcp/brain/baseline/cards.ts mcp/brain/cli.ts
git commit -m "Baseline: a seeded, stratified card sort of the user's own page titles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The recall benchmark

**Files:**
- Create: `mcp/brain/baseline/recall.ts`
- Modify: `mcp/brain/cli.ts`: register `recall`
- Test: `mcp/brain/baseline/recall.test.ts`

**Interfaces:**
- Consumes: `Io`, `terminal`, `reportsDir`, `vaultPath` (Task 1).
- Produces:
  - `parseQuestions(md: string): string[]`
  - `summarizeRecall(rows: RecallRow[]): { n: number; successRate: number; medianMs: number | null }`
  - `runRecall(questions: string[], tool: string, io: Io): Promise<RecallRow[]>`
  - `interface RecallRow { n: number; ms: number; success: boolean }`
  - `LIMIT_MS = 60_000`
  - Report files: `recall-freeze.json`, `recall-<tool>-<date>.csv` and `recall-summary.json`, the last an array of `{ tool, date, n, successRate, medianMs }`.

Rules from the spec:
- 25 questions, frozen before the import.
- Success means the right note is open within 60 s.
- Failures count as 60 s in the median, so a fast failure never beats a slow find.
- The user judges "right note", because the import rewrites Notion pages into differently named concept notes.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/baseline/recall.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Io } from '../args';
import { LIMIT_MS, parseQuestions, runRecall, summarizeRecall } from './recall';

const qs = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. Question ${i + 1}?`).join('\n');

describe('parseQuestions', () => {
  it('reads exactly 25 numbered questions', () => {
    expect(parseQuestions(`# Mine\n\n${qs(25)}\n`)).toHaveLength(25);
  });
  it('refuses the wrong count or a gap in numbering', () => {
    expect(() => parseQuestions(qs(24))).toThrow(/exactly 25/);
    expect(() => parseQuestions(qs(25).replace('3. Question 3?', '4. Question 3?'))).toThrow(/question 3 is missing/);
  });
});

describe('summarizeRecall', () => {
  it('counts failures as the 60 s limit in the median', () => {
    const rows = [
      { n: 1, ms: 5_000, success: true },
      { n: 2, ms: 1_000, success: false },
      { n: 3, ms: 20_000, success: true },
    ];
    expect(summarizeRecall(rows)).toEqual({ n: 3, successRate: 2 / 3, medianMs: 20_000 });
    expect(summarizeRecall([])).toEqual({ n: 0, successRate: 0, medianMs: null });
  });
});

describe('runRecall', () => {
  function scripted(answers: string[], times: number[]): Io {
    return { ask: async () => answers.shift() ?? '', say: () => {}, now: () => times.shift() ?? 0 };
  }
  it('times each question and asks whether the note was right', async () => {
    const io = scripted(['', '', 'y', '', 'x', '', ''], [0, 4_000, 10, 20, 100, 100 + LIMIT_MS + 1]);
    expect(await runRecall(['a', 'b', 'c'], 'Notion', io)).toEqual([
      { n: 1, ms: 4_000, success: true },
      { n: 2, ms: 10, success: false },
      { n: 3, ms: LIMIT_MS + 1, success: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/baseline/recall.test.ts`
Expected: FAIL with `Failed to resolve import "./recall"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/baseline/recall.ts`:
```ts
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ymd } from '../../../src/shared/brain/daily';
import { reportsDir, terminal, vaultPath, type Io } from '../args';

export interface RecallRow { n: number; ms: number; success: boolean }
export const LIMIT_MS = 60_000;

export function parseQuestions(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (Number(m[1]) !== out.length + 1) throw new Error(`question ${out.length + 1} is missing or out of order (found ${m[1]})`);
    out.push(m[2]);
  }
  if (out.length !== 25) throw new Error(`the benchmark needs exactly 25 questions; found ${out.length}`);
  return out;
}

/** A failure counts as the full minute, so giving up fast never looks better than finding it slowly. */
export function summarizeRecall(rows: RecallRow[]): { n: number; successRate: number; medianMs: number | null } {
  const t = rows.map((r) => (r.success ? Math.min(r.ms, LIMIT_MS) : LIMIT_MS)).sort((a, b) => a - b);
  const median = t.length ? (t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2) : null;
  return { n: rows.length, successRate: rows.length ? rows.filter((r) => r.success).length / rows.length : 0, medianMs: median };
}

export async function runRecall(questions: string[], tool: string, io: Io): Promise<RecallRow[]> {
  const rows: RecallRow[] = [];
  for (let i = 0; i < questions.length; i++) {
    io.say(`\nQuestion ${i + 1} of ${questions.length}: ${questions[i]}`);
    await io.ask('Press Enter to start the clock. ');
    const t0 = io.now();
    const a = (await io.ask(`Find it in ${tool}. Press Enter once the note is open, or type x to give up. `)).trim().toLowerCase();
    const ms = io.now() - t0;
    let success = false;
    if (a === 'x') io.say('Counted as not found.');
    else if (ms > LIMIT_MS) io.say('Over 60 s: counted as not found.');
    else success = (await io.ask('Is it the right note? (y/n) ')).trim().toLowerCase().startsWith('y');
    rows.push({ n: i + 1, ms, success });
  }
  return rows;
}

const TOOLS: Record<string, string> = { notion: 'Notion (its own search)', brain: 'the Brain page' };

/**
 * The questions are frozen on first use: a later edit is refused, so the import
 * cannot be tuned to them. Claude never opens recall-questions.md.
 */
export async function recall(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, tool: { type: 'string' } } });
  const tool = values.tool ?? '';
  if (!TOOLS[tool]) throw new Error(`--tool must be one of: ${Object.keys(TOOLS).join(', ')}`);
  const reports = await reportsDir(vaultPath(values.vault));
  const text = await readFile(join(reports, 'recall-questions.md'), 'utf8').catch(() => {
    throw new Error(`Write 25 numbered questions in ${join(reports, 'recall-questions.md')} first.`);
  });
  const questions = parseQuestions(text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const freezePath = join(reports, 'recall-freeze.json');
  const frozen = await readFile(freezePath, 'utf8').then((s) => JSON.parse(s) as { sha256: string }, () => null);
  if (frozen && frozen.sha256 !== sha256) throw new Error('recall-questions.md changed after it was frozen. Restore it; the benchmark only means something unchanged.');
  if (!frozen) await writeFile(freezePath, JSON.stringify({ sha256, frozenAt: new Date().toISOString(), count: questions.length }, null, 1));

  const io = terminal();
  try {
    const rows = await runRecall(questions, TOOLS[tool], io);
    const date = ymd(new Date());
    await writeFile(join(reports, `recall-${tool}-${date}.csv`), ['n,ms,success', ...rows.map((r) => `${r.n},${r.ms},${r.success}`)].join('\n') + '\n');
    const s = summarizeRecall(rows);
    const summaryPath = join(reports, 'recall-summary.json');
    const all = await readFile(summaryPath, 'utf8').then((x) => JSON.parse(x) as unknown[], () => []);
    await writeFile(summaryPath, JSON.stringify([...all, { tool, date, ...s }], null, 1));
    io.say(`\n${tool}: ${Math.round(s.successRate * 100)}% found, median ${s.medianMs === null ? '-' : (s.medianMs / 1000).toFixed(1) + ' s'}.`);
  } finally {
    io.close();
  }
}
```
This imports `ymd` from `src/shared/brain/daily.ts`, which Task 11 creates. Create that file now with only `ymd`; Task 11 adds the rest:
```ts
/** Local calendar date, YYYY-MM-DD: daily notes and report names follow the user's own day. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
```
In `mcp/brain/cli.ts`, add `import { recall } from './baseline/recall';` and `recall,` to `commands`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/baseline/recall.test.ts && npm run typecheck`
Expected: PASS (4 tests), typecheck clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/baseline/recall.ts mcp/brain/baseline/recall.test.ts mcp/brain/cli.ts src/shared/brain/daily.ts
git commit -m "Baseline: the frozen, timed recall benchmark, failures counted as the full minute

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The tree test

**Files:**
- Create: `mcp/brain/baseline/treeTest.ts`
- Modify: `mcp/brain/cli.ts`: register `tree-test`
- Test: `mcp/brain/baseline/treeTest.test.ts`

**Interfaces:**
- Consumes: `Io`, `terminal`, `reportsDir`, `vaultPath` (Task 1); `ymd` (Task 4).
- Produces:
  - `parseTree(md: string): TreeNode`
  - `parseTreeTasks(md: string): TreeTask[]`
  - `runTreeTask(root: TreeNode, io: Io): Promise<{ path: string; backtracked: boolean }>`
  - `summarizeTree(rows: { success: boolean; direct: boolean }[]): { n: number; success: number; directness: number }`
  - `interface TreeNode { name: string; children: TreeNode[] }`
  - `interface TreeTask { text: string; answers: string[] }`
  - Plan 2 runs it with `--label map` before the pilot; plan 3 runs it with `--label vault` at stop B.

What gets measured (spec Outcomes):
- 15 tasks.
- **Success:** the user picks a folder that is one of the task's answers.
- **Directness:** success without ever going back up. It is counted over all tasks.
- **Targets:** 80% success and 70% directness.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/baseline/treeTest.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Io } from '../args';
import { parseTree, parseTreeTasks, runTreeTask, summarizeTree } from './treeTest';

const MAP = '- School\n  - DL Class\n  - DATA 220\n- Research/\n  - Meetings\n';

describe('parseTree', () => {
  it('reads a nested list into folders', () => {
    const t = parseTree(MAP);
    expect(t.children.map((c) => c.name)).toEqual(['School', 'Research']);
    expect(t.children[0].children.map((c) => c.name)).toEqual(['DL Class', 'DATA 220']);
  });
  it('refuses an empty map', () => {
    expect(() => parseTree('# nothing')).toThrow(/no folders/);
  });
});

describe('parseTreeTasks', () => {
  it('reads tasks with one or more accepted answers', () => {
    const md = Array.from({ length: 15 }, (_, i) => `${i + 1}. Find thing ${i} => School/DL Class | Research`).join('\n');
    const tasks = parseTreeTasks(md);
    expect(tasks).toHaveLength(15);
    expect(tasks[0]).toEqual({ text: 'Find thing 0', answers: ['School/DL Class', 'Research'] });
    expect(() => parseTreeTasks('1. Only one => School')).toThrow(/exactly 15/);
  });
});

describe('runTreeTask', () => {
  const io = (answers: string[]): Io => ({ ask: async () => answers.shift() ?? 'h', say: () => {}, now: () => 0 });
  it('records the folder chosen and whether the user went back up', async () => {
    const root = parseTree(MAP);
    expect(await runTreeTask(root, io(['1', '2', 'h']))).toEqual({ path: 'School/DATA 220', backtracked: false });
    expect(await runTreeTask(root, io(['2', '0', '1', '1', 'h']))).toEqual({ path: 'School/DL Class', backtracked: true });
  });
  it('ignores input it does not understand', async () => {
    expect(await runTreeTask(parseTree(MAP), io(['9', 'zzz', '1', 'h']))).toEqual({ path: 'School', backtracked: false });
  });
});

describe('summarizeTree', () => {
  it('counts directness over all tasks', () => {
    expect(summarizeTree([{ success: true, direct: true }, { success: true, direct: false }, { success: false, direct: false }, { success: true, direct: true }])).toEqual({
      n: 4,
      success: 0.75,
      directness: 0.5,
    });
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/baseline/treeTest.test.ts`
Expected: FAIL with `Failed to resolve import "./treeTest"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/baseline/treeTest.ts`:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ymd } from '../../../src/shared/brain/daily';
import { reportsDir, terminal, vaultPath, type Io } from '../args';

export interface TreeNode { name: string; children: TreeNode[] }
export interface TreeTask { text: string; answers: string[] }

export function parseTree(md: string): TreeNode {
  const root: TreeNode = { name: '', children: [] };
  const stack: { indent: number; node: TreeNode }[] = [{ indent: -1, node: root }];
  for (const line of md.split(/\r?\n/)) {
    const m = /^(\s*)[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const node: TreeNode = { name: m[2].replace(/\/$/, ''), children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  if (!root.children.length) throw new Error('the area map has no folders');
  return root;
}

export function parseTreeTasks(md: string): TreeTask[] {
  const out: TreeTask[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*\d+\.\s+(.+?)\s*=>\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ text: m[1], answers: m[2].split('|').map((a) => a.trim().replace(/^\/|\/$/g, '')) });
  }
  if (out.length !== 15) throw new Error(`the tree test needs exactly 15 tasks written "N. task => Folder/Sub"; found ${out.length}`);
  return out;
}

/** Folder names only, the way tree testing works: no search, no note titles. */
export async function runTreeTask(root: TreeNode, io: Io): Promise<{ path: string; backtracked: boolean }> {
  const trail: TreeNode[] = [root];
  let backtracked = false;
  for (;;) {
    const here = trail[trail.length - 1];
    const where = trail.slice(1).map((n) => n.name).join('/');
    io.say(`\n${where || '(top)'}`);
    here.children.forEach((c, i) => io.say(`  ${i + 1}. ${c.name}${c.children.length ? '/' : ''}`));
    const a = (await io.ask(`Number to open${where ? ', 0 to go up, h for "it is here"' : ''}: `)).trim().toLowerCase();
    if (a === 'h' && where) return { path: where, backtracked };
    if (a === '0' && where) {
      trail.pop();
      backtracked = true;
      continue;
    }
    const next = here.children[Number(a) - 1];
    if (next) trail.push(next);
  }
}

export function summarizeTree(rows: { success: boolean; direct: boolean }[]): { n: number; success: number; directness: number } {
  const n = rows.length;
  return { n, success: n ? rows.filter((r) => r.success).length / n : 0, directness: n ? rows.filter((r) => r.direct).length / n : 0 };
}

export async function treeTest(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, label: { type: 'string' } } });
  const label = values.label ?? 'map';
  const reports = await reportsDir(vaultPath(values.vault));
  const root = parseTree(await readFile(join(reports, 'area-map.md'), 'utf8'));
  const tasks = parseTreeTasks(await readFile(join(reports, 'tree-tasks.md'), 'utf8'));
  const io = terminal();
  try {
    const rows = [];
    for (const [i, t] of tasks.entries()) {
      io.say(`\nTask ${i + 1} of ${tasks.length}: ${t.text}`);
      const r = await runTreeTask(root, io);
      const success = t.answers.some((a) => a.toLowerCase() === r.path.toLowerCase());
      rows.push({ n: i + 1, path: r.path, success, direct: success && !r.backtracked });
    }
    const s = summarizeTree(rows);
    await writeFile(join(reports, `tree-test-${label}-${ymd(new Date())}.json`), JSON.stringify({ label, ...s, rows }, null, 1));
    io.say(`\nSuccess ${Math.round(s.success * 100)}% (target 80), directness ${Math.round(s.directness * 100)}% (target 70).`);
  } finally {
    io.close();
  }
}
```
In `mcp/brain/cli.ts`, add `import { treeTest } from './baseline/treeTest';` and `'tree-test': treeTest,` to `commands`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/baseline/treeTest.test.ts && npm run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/baseline/treeTest.ts mcp/brain/baseline/treeTest.test.ts mcp/brain/cli.ts
git commit -m "Baseline: a tree test of the area map, folder names only, scored on success and directness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The baseline report, and running step 0

**Files:**
- Create: `mcp/brain/baseline/report.ts`
- Modify: `mcp/brain/cli.ts`: register `baseline`
- Test: `mcp/brain/baseline/report.test.ts`

**Interfaces:**
- Consumes: the report files written by Tasks 1 to 4.
- Produces:
  - `baselineMarkdown(i: BaselineInputs): string`
  - `.brain/reports/baseline.md`, which plans 2 and 3 compare against.

- [ ] **Step 1: Write the failing test**

Create `mcp/brain/baseline/report.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { baselineMarkdown } from './report';

describe('baselineMarkdown', () => {
  it('reports what ran and marks what did not', () => {
    const md = baselineMarkdown({
      links: { pages: 200, connected: 30, share: 0.15 },
      recall: { tool: 'notion', date: '2026-10-15', n: 25, successRate: 0.64, medianMs: 41_500 },
      exportPath: '~/Documents/notion-export/2026-10-15',
    });
    expect(md).toContain('| Connections (Notion) | 30 of 200 pages link both ways (15.0%) |');
    expect(md).toContain('| Fast recall (Notion) | 64% found, median 41.5 s (25 questions, 2026-10-15) |');
    expect(md).toContain('| Usage | not run yet |');
    expect(md).toContain('| Card sort | not run yet |');
    expect(md).toContain('~/Documents/notion-export/2026-10-15');
  });
});
```

- [ ] **Step 2: Run the test to make sure it fails**

Run: `npx vitest run mcp/brain/baseline/report.test.ts`
Expected: FAIL with `Failed to resolve import "./report"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/baseline/report.ts`:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';

export interface BaselineInputs {
  usage?: { pages: number; visits: number };
  links?: { pages: number; connected: number; share: number };
  recall?: { tool: string; date: string; n: number; successRate: number; medianMs: number | null };
  cards?: { groups: number; cards: number };
  exportPath?: string;
}

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

export function baselineMarkdown(i: BaselineInputs): string {
  const row = (name: string, value: string | undefined) => `| ${name} | ${value ?? 'not run yet'} |`;
  return [
    '# Baseline',
    '',
    'Taken in Notion before any code (spec, Outcomes). Plans 2 and 3 compare against these numbers.',
    '',
    '| Measure | Result |',
    '|---|---|',
    row('Usage', i.usage && `${i.usage.visits} visits to ${i.usage.pages} Notion pages in Chrome history`),
    row('Connections (Notion)', i.links && `${i.links.connected} of ${i.links.pages} pages link both ways (${pct(i.links.share, 1)})`),
    row(
      'Fast recall (Notion)',
      i.recall && `${pct(i.recall.successRate)} found, median ${i.recall.medianMs === null ? '-' : (i.recall.medianMs / 1000).toFixed(1) + ' s'} (${i.recall.n} questions, ${i.recall.date})`,
    ),
    row('Card sort', i.cards && `${i.cards.cards} cards in ${i.cards.groups} groups`),
    row('Notion export (fidelity reference)', i.exportPath),
    '',
  ].join('\n');
}

const json = async <T>(path: string): Promise<T | undefined> => readFile(path, 'utf8').then((s) => JSON.parse(s) as T, () => undefined);

export async function baseline(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, export: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  const usage = await json<{ pages: Record<string, { visits: number }> }>(join(reports, 'baseline-usage.json'));
  const recalls = await json<BaselineInputs['recall'][]>(join(reports, 'recall-summary.json'));
  const sort = await json<{ groups: { cards: string[] }[] }>(join(reports, 'card-sort.json'));
  const md = baselineMarkdown({
    usage: usage && { pages: Object.keys(usage.pages).length, visits: Object.values(usage.pages).reduce((a, p) => a + p.visits, 0) },
    links: await json(join(reports, 'baseline-links.json')),
    recall: recalls?.filter((r) => r?.tool === 'notion').at(-1),
    cards: sort && { groups: sort.groups.length, cards: sort.groups.reduce((a, g) => a + g.cards.length, 0) },
    exportPath: values.export,
  });
  await writeFile(join(reports, 'baseline.md'), md);
  console.log(md);
}
```
In `mcp/brain/cli.ts`, add `import { baseline } from './baseline/report';` and `baseline,` to `commands`.

- [ ] **Step 4: Run the test to make sure it passes, then commit the code**

Run: `npx vitest run mcp/brain/baseline/report.test.ts && npm run typecheck`
Expected: PASS, clean. Run `npm test` and `/verify`, then:
```bash
git add mcp/brain/baseline/report.ts mcp/brain/baseline/report.test.ts mcp/brain/cli.ts
git commit -m "Baseline: one report of everything step 0 measured

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Run step 0 with the user (no code; nothing from here is committed)**

Every step below writes only into the vault or the export folder.

1. **The vault folder.** Ask the user to confirm the Drive folder. It is normally `~/Library/CloudStorage/GoogleDrive-<account>/My Drive/brain`; if that path differs, use what they give. Then run:
   ```bash
   export BRAIN_VAULT="<that folder>"
   mkdir -p "$BRAIN_VAULT/.brain/reports"
   npm run build:mcp
   ```
2. **The Notion export (user).** In Notion: Settings, Export, Export all workspace content. Choose HTML, with "Include subpages" and files. Unzip it to `~/Documents/notion-export/<date>/`. That folder sits outside both the vault and the repo, and Drive does not sync it.
3. **Usage (needs the user's yes).** Ask:
   > "May I read a copy of Chrome's history, keeping only visit counts per Notion page, with every URL and every other site discarded?"

   Only on yes, run `node dist-mcp/cli.mjs usage`.
4. **The recall questions (user only).**
   - The user writes 25 numbered questions in `$BRAIN_VAULT/.brain/reports/recall-questions.md`. They can use `baseline-usage.md` as a reminder of what they look things up for.
   - Claude must not open, `cat` or search that file.
   - Then the user runs `node dist-mcp/cli.mjs recall --tool notion` in their own terminal (`! node dist-mcp/cli.mjs recall --tool notion` from Claude Code works too). Notion's desktop app should be open.
5. **The card sort (user).**
   - Run `node dist-mcp/cli.mjs cards`.
   - The user groups the cards in `card-sort.md`, in Obsidian or any editor.
   - Then run `node dist-mcp/cli.mjs cards --read` until it reports no problems.
6. **The Notion link measure.** Run `node dist-mcp/cli.mjs notion-links`. This covers every page; plan 2 reruns it with the in-scope roots.
7. **The report.** Run `node dist-mcp/cli.mjs baseline --export "~/Documents/notion-export/<date>"`. Show the user the printed table.

Expected: `baseline.md` has a value in every row. If the user declined step 3, the Usage row says "not run yet", and the spec's Resurfacing baseline is recorded as declined.

---

## Part B: step 1, platform ground truth

### Task 7: Read Chromium's own rules for the folder picker and for writes

**Files:**
- Read only: Chromium source, fetched into the session's scratch folder (`$SCRATCH` below is the scratchpad path).
- Results go to Task 10.

**Interfaces:**
- Produces three answers for Task 10's "Measured platform" table:
  - (a) Does the File System Access blocklist block `~/Library`, its children, or `~/Library/CloudStorage`?
  - (b) Does a `createWritable()` write go to a swap file that is moved into place on `close()`?
  - (c) The installed Chrome version these answers belong to.

- [ ] **Step 1: Fetch the permission code for the installed Chrome version**

Run:
```bash
VER=$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString); echo "$VER"
BASE="https://chromium.googlesource.com/chromium/src/+/refs/tags/$VER"
curl -sf "$BASE/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc?format=TEXT" | base64 --decode > "$SCRATCH/perm.cc"
wc -l "$SCRATCH/perm.cc"
```
Expected: a version such as `141.0.7390.66`, and a file of several thousand lines.

If `curl` returns nothing (HTTP 404), the file moved in that version. Find it with:
```bash
curl -sf "$BASE/chrome/browser/file_system_access/?format=JSON" | tail -c +6 | python3 -c "import json,sys; print('\n'.join(e['name'] for e in json.load(sys.stdin)['entries']))"
```
Then fetch the file whose name contains `permission_context`.

- [ ] **Step 2: Read the blocked-path rules**

Run:
```bash
grep -n -E 'kBlockedPaths|BlockType|kBlockAllChildren|kBlockNestedDirectories|kDontBlockChildren|DIR_HOME|"Library"|CloudStorage|kBlockedPaths\[\]' "$SCRATCH/perm.cc" | head -80
```
Then read the whole `kBlockedPaths` array and the function that applies it, with `sed -n '<start>,<end>p' "$SCRATCH/perm.cc"`. Answer (a) from the code itself. Quote the exact lines: the entry for `~/Library`, its block type, and any rule that exempts `~/Library/CloudStorage` or `~/Library/Mobile Documents`.

- [ ] **Step 3: Read the write path**

Run:
```bash
for f in content/browser/file_system_access/file_system_access_file_writer_impl.cc content/browser/file_system_access/file_system_access_manager_impl.cc; do
  curl -sf "$BASE/$f?format=TEXT" | base64 --decode > "$SCRATCH/$(basename $f)"
done
grep -n -E 'crswap|swap|Move|kSwapFileExtension|CloseImpl|DoAfterWriteCheck' "$SCRATCH"/file_system_access_*.cc | head -60
```
Answer (b) from the code:
- Where the swap file is named.
- That `close()` moves it over the target.
- What `abort()` does to it.
- Whether a crash before `close()` leaves the target untouched.

Quote the lines.

- [ ] **Step 4: Record**

Write the three answers, the quoted lines and the URLs into a scratch note for Task 10. There is nothing to commit in this task.

---

### Task 8: The File System Access probe

**Files:**
- Create:
  - `mcp/brain/probe/fsa/manifest.json`
  - `mcp/brain/probe/fsa/sw.js`
  - `mcp/brain/probe/fsa/probe.html`
  - `mcp/brain/probe/fsa/probe.js`

**Interfaces:**
- Produces `fsa-probe.json` (downloaded by the user, then moved to `$BRAIN_VAULT/.brain/reports/`). Its steps:
  - `pick`, `list top level`, `read up to 20 notes`
  - `write 1 MB through createWritable` (names in the folder while the writable is open; sizes before and after close)
  - `abort leaves the old content`, `move() on a file handle`, `remove the probe folder`
  - `permission after restart`

It is a separate unpacked extension, so the product build and `vite.config.ts`, which holds uncommitted Pomodoro edits, are not touched. Any extension origin gets the same File System Access rules.

- [ ] **Step 1: Write the probe**

Create `mcp/brain/probe/fsa/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Brain FSA probe (dev only)",
  "version": "0.0.1",
  "description": "Measures File System Access behaviour on a folder you pick. Never shipped.",
  "action": {},
  "background": { "service_worker": "sw.js" }
}
```

Create `mcp/brain/probe/fsa/sw.js`:
```js
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') }));
```

Create `mcp/brain/probe/fsa/probe.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>Brain FSA probe</title>
<style>body{font:14px system-ui;margin:24px;max-width:900px}button{margin:4px 8px 4px 0}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style>
<h1>Brain FSA probe</h1>
<p>1. Pick the Drive vault folder. 2. Run the probes. 3. Quit and reopen Chrome, open this page again, and check permission. Also try step 1 on a folder directly inside ~/Library, to record what Chrome refuses. Download the report at the end.</p>
<button id="pick">1. Pick folder</button>
<button id="run">2. Run probes</button>
<button id="again">3. Check permission after restart</button>
<button id="save">Download report</button>
<pre id="out"></pre>
<script src="probe.js"></script>
```

Create `mcp/brain/probe/fsa/probe.js`:
```js
// Dev-only probe for spec build step 1. Results survive a Chrome restart in
// localStorage, so the permission check after a restart lands in the same report.
const out = document.getElementById('out');
const report = JSON.parse(localStorage.getItem('report') || 'null') || { userAgent: navigator.userAgent, steps: [] };
const show = () => {
  localStorage.setItem('report', JSON.stringify(report));
  out.textContent = JSON.stringify(report, null, 2);
};
show();

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const info = (await fn()) || {};
    report.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), ...info });
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: `${e.name}: ${e.message}` });
  }
  show();
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('probe', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveHandle(h) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(h, 'dir');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function loadHandle() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('handles').objectStore('handles').get('dir');
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

let dir = null;
const names = async (d) => {
  const n = [];
  for await (const [name] of d.entries()) n.push(name);
  return n.sort();
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

document.getElementById('pick').onclick = () =>
  step('pick', async () => {
    dir = await showDirectoryPicker({ id: 'brain-probe', mode: 'readwrite' });
    await saveHandle(dir);
    return { folder: dir.name, permission: await dir.queryPermission({ mode: 'readwrite' }) };
  });

document.getElementById('run').onclick = async () => {
  if (!dir) dir = await loadHandle();
  if (!dir) return step('run', async () => { throw new Error('pick a folder first'); });
  await step('list top level', async () => ({ entries: (await names(dir)).length }));
  await step('read up to 20 notes', async () => {
    const times = [];
    const errors = [];
    const walk = async (d, depth) => {
      for await (const [name, h] of d.entries()) {
        if (times.length + errors.length >= 20) return;
        if (h.kind === 'directory' && depth < 3 && !name.startsWith('.')) await walk(h, depth + 1);
        else if (h.kind === 'file' && name.endsWith('.md')) {
          const t0 = performance.now();
          try {
            await (await h.getFile()).text();
            times.push(Math.round(performance.now() - t0));
          } catch (e) {
            errors.push(`${name}: ${e.name}`);
          }
        }
      }
    };
    await walk(dir, 0);
    return { read: times.length, medianMs: median(times), maxMs: times.length ? Math.max(...times) : null, errors };
  });
  const probe = await dir.getDirectoryHandle('.brain-probe', { create: true });
  const fh = await probe.getFileHandle('w.md', { create: true });
  await step('write 1 MB through createWritable', async () => {
    const w = await fh.createWritable();
    await w.write('x'.repeat(1_000_000));
    const namesWhileOpen = await names(probe);
    const sizeBeforeClose = (await fh.getFile()).size;
    await w.close();
    return { namesWhileOpen, sizeBeforeClose, sizeAfterClose: (await fh.getFile()).size };
  });
  await step('abort leaves the old content', async () => {
    const w = await fh.createWritable();
    await w.write('partial');
    await w.abort();
    return { sizeAfterAbort: (await fh.getFile()).size, names: await names(probe) };
  });
  await step('move() on a file handle', async () => {
    if (typeof fh.move !== 'function') return { supported: false };
    await fh.move('moved.md');
    const sub = await probe.getDirectoryHandle('sub', { create: true });
    await fh.move(sub, 'moved-into-sub.md');
    return { supported: true, top: await names(probe), sub: await names(sub) };
  });
  await step('remove the probe folder', async () => {
    await dir.removeEntry('.brain-probe', { recursive: true });
    return { stillThere: (await names(dir)).includes('.brain-probe') };
  });
};

document.getElementById('again').onclick = () =>
  step('permission after restart', async () => {
    const h = await loadHandle();
    if (!h) throw new Error('no saved handle: pick a folder first');
    const before = await h.queryPermission({ mode: 'readwrite' });
    const after = before === 'granted' ? before : await h.requestPermission({ mode: 'readwrite' });
    return { before, after };
  });

document.getElementById('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = 'fsa-probe.json';
  a.click();
};
```

- [ ] **Step 2: Commit the probe (dev tooling, not shipped)**

```bash
git add mcp/brain/probe/fsa/manifest.json mcp/brain/probe/fsa/sw.js mcp/brain/probe/fsa/probe.html mcp/brain/probe/fsa/probe.js
git commit -m "Dev-only probe: what File System Access really does on the Drive folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Run it with the user**

1. Open `chrome://extensions`. Turn on Developer mode, click "Load unpacked" and choose `mcp/brain/probe/fsa/`. Click the probe's toolbar icon.
2. Click "Pick folder" on a folder directly inside `~/Library` (for example `~/Library/Fonts`), then dismiss whatever Chrome shows. This records Chrome's refusal or acceptance.
3. Click "Pick folder" on the vault folder (`~/Library/CloudStorage/GoogleDrive-…/My Drive/brain`), then "Run probes".
4. Quit Chrome fully, reopen it, open the probe again and click "Check permission after restart".
5. Click "Download report" and move `fsa-probe.json` into `$BRAIN_VAULT/.brain/reports/`.
6. Remove the probe extension from `chrome://extensions`.

Expected:
- The report's `pick` step for the vault is `ok: true`, or `ok: false` with the exact error. Either answer is the finding.
- `namesWhileOpen` shows whether a swap file (such as `w.md.crswap`) exists during the write.
- `sizeBeforeClose` shows whether the target changed before `close()`.
- `sizeAfterAbort` is 1000000.
- `move()` is `supported: true` or `false`.

---

### Task 9: The Drive probe

**Files:**
- Create: `mcp/brain/platform/driveProbe.ts`
- Modify: `mcp/brain/cli.ts`: register `drive-probe`
- Test: `mcp/brain/platform/driveProbe.test.ts`

**Interfaces:**
- Consumes: `vaultPath`, `reportsDir` (Task 1).
- Produces:
  - `ping(dir: string, o: { rounds: number; gapMs: number; timeoutMs: number; pollMs?: number }): Promise<number[]>`
  - `pong(dir: string, o: { pollMs?: number; maxMs: number }): Promise<number>`
  - `stats(rtts: number[]): { rounds: number; lost: number; medianRttMs: number | null; maxRttMs: number | null }`
  - `.brain/reports/platform-<hostname>.json`: an array of `{ probe, at, result }`.

The sync delay is measured as a round trip, so it needs no shared clock. The spec says clocks between machines are never trusted for order.

- [ ] **Step 1: Write the failing test**

Create `mcp/brain/platform/driveProbe.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ping, pong, stats } from './driveProbe';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('ping and pong', () => {
  it('measure every round trip through a shared folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-probe-'));
    const [rtts, answered] = await Promise.all([
      ping(dir, { rounds: 3, gapMs: 5, timeoutMs: 2_000, pollMs: 5 }),
      pong(dir, { pollMs: 5, maxMs: 5_000 }),
    ]);
    expect(answered).toBe(3);
    expect(rtts).toHaveLength(3);
    expect(rtts.every(Number.isFinite)).toBe(true);
  });
  it('ignores a ping left over from an earlier run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-probe-'));
    await writeFile(join(dir, 'ping.json'), JSON.stringify({ run: 'old', seq: 30, done: true }));
    const answered = pong(dir, { pollMs: 5, maxMs: 300 });
    expect(await answered).toBe(0);
  });
});

describe('stats', () => {
  it('counts lost rounds and takes the median of the rest', () => {
    expect(stats([300, Number.NaN, 100, 200])).toEqual({ rounds: 4, lost: 1, medianRttMs: 200, maxRttMs: 300 });
    expect(stats([])).toEqual({ rounds: 0, lost: 0, medianRttMs: null, maxRttMs: null });
  });
});
```

- [ ] **Step 2: Run the test to make sure it fails**

Run: `npx vitest run mcp/brain/platform/driveProbe.test.ts`
Expected: FAIL with `Failed to resolve import "./driveProbe"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/platform/driveProbe.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';

// A partly synced file reads as invalid JSON; treat it as not there yet.
const readJson = async (p: string): Promise<any> => readFile(p, 'utf8').then((s) => JSON.parse(s), () => null);

/** Mac side: write ping n, wait for pong n. A round trip needs no shared clock. */
export async function ping(dir: string, o: { rounds: number; gapMs: number; timeoutMs: number; pollMs?: number }): Promise<number[]> {
  const run = randomUUID();
  const rtts: number[] = [];
  for (let seq = 1; seq <= o.rounds; seq++) {
    const sent = Date.now();
    await writeFile(join(dir, 'ping.json'), JSON.stringify({ run, seq, done: seq === o.rounds }));
    for (;;) {
      await sleep(o.pollMs ?? 250);
      const p = await readJson(join(dir, 'pong.json'));
      if (p?.run === run && p.seq === seq) {
        rtts.push(Date.now() - sent);
        break;
      }
      if (Date.now() - sent > o.timeoutMs) {
        rtts.push(Number.NaN);
        break;
      }
    }
    if (seq < o.rounds) await sleep(o.gapMs);
  }
  return rtts;
}

/** Other machine: answer each new ping of a run that started after this one did. */
export async function pong(dir: string, o: { pollMs?: number; maxMs: number }): Promise<number> {
  const stale = (await readJson(join(dir, 'ping.json')))?.run ?? null;
  const start = Date.now();
  let run: string | null = null;
  let last = 0;
  let answered = 0;
  while (Date.now() - start < o.maxMs) {
    const p = await readJson(join(dir, 'ping.json'));
    if (p && p.run !== stale) {
      if (p.run !== run) {
        run = p.run;
        last = 0;
      }
      if (p.seq > last) {
        last = p.seq;
        answered++;
        await writeFile(join(dir, 'pong.json'), JSON.stringify({ run, seq: p.seq }));
        if (p.done) break;
      }
    }
    await sleep(o.pollMs ?? 250);
  }
  return answered;
}

export function stats(rtts: number[]): { rounds: number; lost: number; medianRttMs: number | null; maxRttMs: number | null } {
  const ok = rtts.filter(Number.isFinite).sort((a, b) => a - b);
  return { rounds: rtts.length, lost: rtts.length - ok.length, medianRttMs: ok.length ? ok[Math.floor(ok.length / 2)] : null, maxRttMs: ok.length ? ok[ok.length - 1] : null };
}

const KNOWN_MTIME = new Date('2001-02-03T04:05:06.000Z');
const ROLES = ['ping', 'pong', 'mtime-write', 'mtime-check', 'rename-write', 'rename-watch', 'conflict-setup', 'conflict-list', 'cold-seed', 'cold-measure'];

/** Each role is one measurement from spec Ground truth; results append to platform-<host>.json. */
export async function driveProbe(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, role: { type: 'string' }, rounds: { type: 'string' } } });
  const vault = vaultPath(values.vault);
  const dir = join(vault, '.brain', 'probe');
  await mkdir(dir, { recursive: true });
  const record = async (probe: string, result: unknown) => {
    const file = join(await reportsDir(vault), `platform-${hostname()}.json`);
    const all = ((await readJson(file)) ?? []) as unknown[];
    await writeFile(file, JSON.stringify([...all, { probe, at: new Date().toISOString(), result }], null, 1));
    console.log(probe, JSON.stringify(result));
  };
  switch (values.role) {
    case 'ping':
      return record('sync round trip', stats(await ping(dir, { rounds: Number(values.rounds ?? 30), gapMs: 10_000, timeoutMs: 300_000 })));
    case 'pong':
      return record('pongs answered', await pong(dir, { maxMs: 4 * 3_600_000 }));
    case 'mtime-write': {
      const f = join(dir, 'mtime.md');
      await writeFile(f, 'mtime probe\n');
      await utimes(f, KNOWN_MTIME, KNOWN_MTIME);
      return record('mtime written', { mtime: KNOWN_MTIME.toISOString() });
    }
    case 'mtime-check': {
      const s = await stat(join(dir, 'mtime.md'));
      return record('mtime after sync', { mtime: s.mtime.toISOString(), preserved: s.mtimeMs === KNOWN_MTIME.getTime() });
    }
    case 'rename-write': {
      const a = join(dir, 'rename-a.md');
      await writeFile(a, 'rename probe\n');
      await sleep(60_000);
      await rename(a, join(dir, 'rename-b.md'));
      return record('renamed a to b', { at: new Date().toISOString() });
    }
    case 'rename-watch': {
      const seen: { at: string; names: string[] }[] = [];
      let prev = '';
      for (const end = Date.now() + 600_000; Date.now() < end; await sleep(500)) {
        const names = (await readdir(dir)).filter((n) => n.startsWith('rename-')).sort();
        if (names.join() !== prev) {
          seen.push({ at: new Date().toISOString(), names });
          prev = names.join();
        }
        if (names.length === 1 && names[0] === 'rename-b.md') break;
      }
      return record('rename as seen here', seen);
    }
    case 'conflict-setup':
      await writeFile(join(dir, 'conflict.md'), 'base\n');
      return record('conflict base written', {});
    case 'conflict-list':
      return record('conflict files', (await readdir(dir)).filter((n) => /conflict/i.test(n)));
    case 'cold-seed':
      for (let i = 0; i < 20; i++) await writeFile(join(dir, `cold-${i}.md`), 'cold probe line\n'.repeat(3000));
      return record('cold files seeded', { files: 20 });
    case 'cold-measure': {
      const rows: { file: string; ms: number; result: string }[] = [];
      for (const file of (await readdir(dir)).filter((n) => n.startsWith('cold-'))) {
        const t0 = Date.now();
        const result = await Promise.race([
          readFile(join(dir, file)).then(() => 'ok', (e: NodeJS.ErrnoException) => e.code ?? 'error'),
          sleep(30_000).then(() => 'timeout'),
        ]);
        rows.push({ file, ms: Date.now() - t0, result });
      }
      return record('cold reads', rows);
    }
    default:
      throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }
}
```
In `mcp/brain/cli.ts`, add `import { driveProbe } from './platform/driveProbe';` and `'drive-probe': driveProbe,` to `commands`.

- [ ] **Step 4: Run the test to make sure it passes**

Run: `npx vitest run mcp/brain/platform/driveProbe.test.ts && npm run typecheck`
Expected: PASS (3 tests), clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/platform/driveProbe.ts mcp/brain/platform/driveProbe.test.ts mcp/brain/cli.ts
git commit -m "Drive probe: sync round trips, mtimes, renames, conflict copies and cold reads, measured not assumed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Run it on both machines with the user**

On the Mac, run `npm run build:mcp && cp dist-mcp/cli.mjs "$BRAIN_VAULT/.brain/probe/cli.mjs"`. Drive carries the copy to Windows.

On Windows, install Node 22.13 or newer (the bundle loads `node:sqlite`). Then, in PowerShell:
```powershell
$W = "G:\My Drive\brain"
node "$W\.brain\probe\cli.mjs" drive-probe --vault $W --role <role>
```
On the Mac, the same command is `node dist-mcp/cli.mjs drive-probe --role <role>`.

Run the probes in this order:

1. **Sync delay:** start Windows `pong`, then run Mac `ping` (30 rounds, about 5 minutes or more).
2. **Modification time:**
   - Run Mac `mtime-write`.
   - Wait until Windows shows `.brain\probe\mtime.md`.
   - Run Windows `mtime-check`.
3. **Rename:**
   - Start Windows `rename-watch`.
   - Run Mac `rename-write`.
4. **Conflict copies:**
   - Run Mac `conflict-setup` and wait for it to reach Windows.
   - Turn off the network on both machines.
   - Append a different line to `.brain/probe/conflict.md` on each machine.
   - Turn the network back on and wait 3 minutes.
   - Run `conflict-list` on both.
5. **Cold reads:**
   - Run Windows `cold-seed`.
   - Wait until the Mac lists `cold-*.md`, without opening them.
   - Turn off the Mac's Wi-Fi and run Mac `cold-measure`. This records offline reads of files that were never downloaded.
   - Turn Wi-Fi back on.
   - Run Windows `cold-seed` again to refresh the files, wait, then run Mac `cold-measure` online.
6. **Clean up:** delete `.brain/probe/` on one machine.

Expected: `platform-<mac>.json` and `platform-<windows>.json` in `.brain/reports/`, with every probe present.

---

### Task 10: Write the measured platform into the spec, and recheck what rested on it

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-second-brain-design.md`
  - Add a `## Measured platform` section at the end.
  - Edit every row listed in Step 2 whose assumption the measurements contradict.

**Interfaces:**
- Consumes:
  - Task 7's three answers.
  - `fsa-probe.json`.
  - `platform-<host>.json` from both machines.
- Produces: the "Measured platform" table that plans 2 to 5 cite.

- [ ] **Step 1: Add the section**

Append this to the spec, with every cell filled from the evidence:
```markdown
## Measured platform

Measured in build step 1 on <date>. Chrome <version>, macOS <version>, Windows <version>, Google Drive for desktop <version> in stream mode. Sources: Chromium at tag <version> (URLs below), `fsa-probe.json`, `platform-<host>.json`.

| Question | Measured | Evidence |
|---|---|---|
| Can an extension page pick, read and write `My Drive/brain` under `~/Library/CloudStorage`? | | Chromium `kBlockedPaths` lines …; probe `pick` step |
| Is anything else under `~/Library` refused? | | probe `pick` on `~/Library/Fonts` |
| Does `createWritable()` write a swap file and move it in on `close()`? Does a crash before `close()` leave the target untouched? | | Chromium writer lines …; probe `namesWhileOpen`, `sizeBeforeClose` |
| Does `abort()` keep the old content? | | probe `sizeAfterAbort` |
| Is `move()` available on file handles? | | probe `move()` step |
| Does folder permission survive a Chrome restart? | | probe `permission after restart` |
| Sync delay, Mac to Windows and back (median and max round trip) | | `sync round trip` |
| Does a modification time survive sync? | | `mtime after sync` |
| How a rename arrives on the other machine | | `rename as seen here` |
| Conflict-copy file names | | `conflict files` |
| Reading an online-only file: online, and offline | | `cold reads` (both runs) |
```

- [ ] **Step 2: Recheck each spec claim that rested on these, and edit the ones the measurements contradict**

| Spec place | Assumption | Edit if the measurement differs |
|---|---|---|
| Build order step 1 fallback; Open risks, first bullet | Picker may be blocked under `~/Library/CloudStorage` | If blocked: make Drive Mirror mode with the folder outside `~/Library` the setup, in Decisions "Storage", and say so in Brain page "First run". |
| Error handling "Crash or power loss mid-write" | `createWritable()` swaps on `close()` | If not atomic: the Brain page writes `name.md.brain-tmp`, then copies over the target, and the journal covers the gap. Name this as a change for plan 4. |
| Brain page 12 "Rename and move" (assumption on `move()`) | copy then remove | If `move()` exists and the probe moved within and across folders: keep copy-then-remove anyway (the journal relies on it) and replace "(Assumption)" with the measured fact. |
| Error handling "Drive conflict copy (`Note (1).md`)" | the conflict-copy name pattern | Replace the pattern with the measured names. Plan 3's reconcile matches those. |
| Error handling "Clocks differ" and "Drive offline" (5 s read timeout) | mtimes compared for equality; 5 s timeout | If mtimes are not preserved, add: "a synced file always looks changed once; the content hash (Index entry) keeps that from costing a re-parse". If offline cold reads fail fast or hang, set the timeout from the measured times. |
| Brain page 8 "External change" (5 s check) | 5 s is enough | Compare with the measured sync delay; if the median round trip is under 10 s, keep 5 s. |

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-second-brain-design.md
git commit -m "Spec: the platform as measured in step 1, and the rows that changed because of it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If a measurement changes the design, not just a number (for example, the picker is blocked), stop and tell the user before Part C, quoting the evidence. Otherwise continue.

---

## Part C: step 2, the shared core (test first)

Everything in Part C lives in `src/shared/brain/`. None of it touches disk, so the Brain page and the MCP server share one tested implementation.

### Task 11: Names and dates

**Files:**
- Create: `src/shared/brain/names.ts`
- Modify: `src/shared/brain/daily.ts`. Task 4 created it with `ymd`; this task adds the rest.
- Test:
  - `src/shared/brain/names.test.ts`
  - `src/shared/brain/daily.test.ts`

**Interfaces:**
- Produces:
  - In `names.ts`:
    - `nfc(s)`
    - `titleKey(title): string`: NFC, then lower case
    - `shortHash(s): string`: 6 base-36 characters
    - `safeTitle(title: string, folder?: string): { title: string; changed: boolean }`
    - `titleOf(path: string): string`
    - `MAX_NAME_BYTES = 255`
    - `MAX_PATH_CHARS = 240`
  - In `daily.ts`:
    - `ymd(d)`
    - `dailyHeading(d): string`
    - `dailyPath(d): string`
    - `dailyText(d): string`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/names.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, MAX_PATH_CHARS, safeTitle, shortHash, titleKey, titleOf } from './names';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('safeTitle', () => {
  it('replaces characters Windows, Drive or [[links]] reject', () => {
    expect(safeTitle('A/B: C? "D" <E> |F| #G ^H [I]')).toEqual({ title: 'A-B- C- -D- -E- -F- -G -H -I-', changed: true });
  });
  it('drops trailing dots and spaces, and suffixes reserved device names', () => {
    expect(safeTitle('Notes. ').title).toBe('Notes');
    expect(safeTitle('CON').title).toBe('CON_');
    expect(safeTitle('lpt1').title).toBe('lpt1_');
    expect(safeTitle('   ')).toEqual({ title: 'Untitled', changed: true });
  });
  it('normalises to NFC without calling that a change', () => {
    expect(safeTitle('Cafe\u0301')).toEqual({ title: 'Caf\u00e9', changed: false });
  });
  it('cuts long names on a character boundary and adds a stable hash', () => {
    const long = '\u{1D465}'.repeat(100);
    const t = safeTitle(long).title;
    expect(bytes(t + '.md')).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(t.endsWith(' ' + shortHash(long))).toBe(true);
    expect([...t.replace(/ \w{6}$/, '')].every((c) => c === '\u{1D465}')).toBe(true);
  });
  it('keeps the whole relative path under the Windows budget', () => {
    const folder = 'f'.repeat(50);
    expect(folder.length + 1 + safeTitle('a'.repeat(300), folder).title.length + 3).toBeLessThanOrEqual(MAX_PATH_CHARS);
  });
});

describe('titleKey and titleOf', () => {
  it('compares titles ignoring case and Unicode form', () => {
    expect(titleKey('Caf\u00e9')).toBe(titleKey('CAFE\u0301'));
  });
  it('takes the title from a path, in NFC', () => {
    expect(titleOf('School/DL Class/Lecture 3.md')).toBe('Lecture 3');
    expect(titleOf('Concepts/Cafe\u0301.md')).toBe('Caf\u00e9');
  });
});
```

Create `src/shared/brain/daily.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dailyHeading, dailyPath, dailyText, ymd } from './daily';

describe('daily notes', () => {
  const d = new Date(2026, 9, 14, 23, 59);
  it('names the file by the local date and writes only the heading', () => {
    expect(ymd(d)).toBe('2026-10-14');
    expect(dailyPath(d)).toBe('daily/2026-10-14.md');
    expect(dailyHeading(d)).toBe('Wednesday, 14 October 2026');
    expect(dailyText(d)).toBe('# Wednesday, 14 October 2026\n');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/names.test.ts src/shared/brain/daily.test.ts`
Expected: FAIL. `names` cannot be resolved, and `dailyHeading` is not exported.

- [ ] **Step 3: Implement**

Create `src/shared/brain/names.ts`:
```ts
/**
 * Vault naming. A title is its file name, unique across the vault ignoring
 * case and Unicode form, and safe on Windows, Google Drive and inside [[links]].
 */

// Windows and Drive reject the first nine; "#", "^", "[" and "]" break [[links]].
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_NAME_BYTES = 255;
/** The relative path, leaving room for "G:\My Drive\brain\" inside Windows' 260. */
export const MAX_PATH_CHARS = 240;

export const nfc = (s: string): string => s.normalize('NFC');
export const titleKey = (title: string): string => nfc(title).toLowerCase();
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** FNV-1a: a short, stable suffix for names that had to be cut. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** The title a file can carry. `changed` means the original belongs in `aliases`. */
export function safeTitle(title: string, folder = ''): { title: string; changed: boolean } {
  const original = nfc(title).trim();
  let t = original.replace(ILLEGAL, '-').replace(/[. ]+$/, '');
  if (!t) t = 'Untitled';
  if (RESERVED.test(t)) t += '_';
  const budget = Math.min(MAX_NAME_BYTES - 3, MAX_PATH_CHARS - (folder ? folder.length + 1 : 0) - 3);
  if (bytes(t) > budget || t.length > budget) {
    const suffix = ' ' + shortHash(original);
    let chars = [...t];
    while (chars.length && (bytes(chars.join('') + suffix) > budget || (chars.join('') + suffix).length > budget)) chars = chars.slice(0, -1);
    t = chars.join('').trimEnd() + suffix;
  }
  return { title: t, changed: t !== original };
}

/** The title of the note at `path`: its file name without ".md", in NFC. */
export function titleOf(path: string): string {
  return nfc(path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
}
```

Replace the contents of `src/shared/brain/daily.ts` with:
```ts
/** Local calendar date, YYYY-MM-DD: daily notes and report names follow the user's own day. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Built by hand, not with toLocaleDateString, so Chrome and Node always agree. */
export const dailyHeading = (d: Date): string => `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const dailyPath = (d: Date): string => `daily/${ymd(d)}.md`;
/** A new daily note holds only its date heading (spec, Daily note). */
export const dailyText = (d: Date): string => `# ${dailyHeading(d)}\n`;
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/names.test.ts src/shared/brain/daily.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/names.ts src/shared/brain/names.test.ts src/shared/brain/daily.ts src/shared/brain/daily.test.ts
git commit -m "Brain core: titles that Windows, Drive and links all accept, and daily-note names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Frontmatter, judged by the yaml library

**Files:**
- Create: `src/shared/brain/frontmatter.ts`
- Create: `src/shared/brain/testing.ts`. These are test helpers; this task adds `FC`, and Task 18 adds `MemFs` and `Crash`.
- Test: `src/shared/brain/frontmatter.test.ts`

**Interfaces:**
- Produces:
  - Types:
    - `type FmScalar = string | number | boolean | null`
    - `type FmValue = FmScalar | FmScalar[]`
    - `interface FmField { key: string; value: FmValue }`
    - `interface Note { head: string; body: string; fields: FmField[]; error: string | null; eol: '\n' | '\r\n' }`
  - Functions:
    - `parseNote(text: string): Note`
    - `toText(note: Note): string`
    - `getField(note: Note, key: string): FmValue | undefined`
    - `setField(note: Note, key: string, value: FmValue): Note`
    - `removeField(note: Note, key: string): Note`
    - `asList(v: FmValue | undefined): string[]`
  - In `testing.ts`: `FC = { seed, numRuns }` for every property test.

How it works:
- Values are read by `yaml` (core schema), so they mean exactly what YAML says.
- The raw lines are kept, so an unchanged note saves byte for byte.
- An edited key rewrites only its own line or lines.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/testing.ts`:
```ts
/** Property tests share one seed so CI is repeatable; fast-check prints it on failure. Override with FC_SEED. */
export const FC = { seed: Number(process.env.FC_SEED ?? 20261014), numRuns: 200 };
```
`process` is a Node global; `vitest` defines it in tests, and the root tsconfig has DOM types only. So declare it at the top of this file:
```ts
declare const process: { env: Record<string, string | undefined> };
```

Create `src/shared/brain/frontmatter.test.ts`:
```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { asList, getField, parseNote, removeField, setField, toText } from './frontmatter';
import { FC } from './testing';

const NOTE = '---\ncreated: 2026-02-11\ntags: [concept]\naliases:\n  - Logistic function\nurl: https://arxiv.org/abs/1234.5678  # paper notes only\n---\n# Sigmoid\n';

describe('parseNote', () => {
  it('reads flat fields and keeps the body', () => {
    const n = parseNote(NOTE);
    expect(n.error).toBeNull();
    expect(n.fields).toEqual([
      { key: 'created', value: '2026-02-11' },
      { key: 'tags', value: ['concept'] },
      { key: 'aliases', value: ['Logistic function'] },
      { key: 'url', value: 'https://arxiv.org/abs/1234.5678' },
    ]);
    expect(n.body).toBe('# Sigmoid\n');
  });
  it('treats a note without frontmatter, or with an unclosed fence, as all body', () => {
    expect(parseNote('# Hi\n')).toMatchObject({ head: '', body: '# Hi\n', fields: [] });
    expect(parseNote('---\ntags: [a]\n# no close\n')).toMatchObject({ head: '', fields: [] });
  });
  it('marks frontmatter outside the flat subset instead of misreading it', () => {
    expect(parseNote('---\na:\n  b: 1\n---\n').error).toMatch(/nested/);
    expect(parseNote('---\na: [1\n---\n').error).toMatch(/invalid YAML/);
    expect(parseNote('---\na: 1\na: 2\n---\n').error).toMatch(/invalid YAML/);
  });
  it('keeps a BOM and CRLF line endings in the head', () => {
    const t = '\uFEFF---\r\ntags: [a]\r\n---\r\nbody\r\n';
    const n = parseNote(t);
    expect(n.eol).toBe('\r\n');
    expect(getField(n, 'tags')).toEqual(['a']);
    expect(toText(n)).toBe(t);
  });
});

// Frontmatter written in the layouts people and Obsidian actually use.
const KEYWORDS = new Set(['null', 'true', 'false']);
const key = fc.stringMatching(/^[a-z]([a-z0-9_ ]{0,8}[a-z0-9])?$/).filter((k) => !KEYWORDS.has(k));
const line = fc.string({ maxLength: 12 }).filter((s) => !/[\r\n]/.test(s));
const scalarText = fc.oneof(
  line.map((s) => JSON.stringify(s)),
  line.map((s) => `'${s.replace(/'/g, "''")}'`),
  fc.integer().map(String),
  fc.boolean().map(String),
  fc.constant('null'),
  fc.constantFrom('2026-02-11', 'plain words', 'Logistic function'),
);
const valueText = fc.oneof(
  scalarText.map((t) => ` ${t}`),
  fc.array(scalarText, { maxLength: 4 }).map((a) => ` [${a.join(', ')}]`),
  fc.array(scalarText, { minLength: 1, maxLength: 4 }).map((a) => a.map((t) => `\n  - ${t}`).join('')),
);
const doc = fc
  .uniqueArray(fc.tuple(key, valueText, fc.boolean()), { selector: ([k]) => k, maxLength: 6 })
  .map((fs) => fs.map(([k, v, comment]) => `${k}:${v}${comment && !v.includes('\n') ? '  # note' : ''}`).join('\n'));

describe('round trip', () => {
  it('toText(parseNote(x)) is byte-identical for any text', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (s) => toText(parseNote(s)) === s), FC);
  });
  it('is byte-identical for generated frontmatter, with either line ending', () => {
    fc.assert(
      fc.property(doc, fc.constantFrom('\n', '\r\n'), (d, eol) => {
        const t = `---${eol}${d.replace(/\n/g, eol)}${eol}---${eol}# Body${eol}`;
        return toText(parseNote(t)) === t;
      }),
      FC,
    );
  });
});

describe('oracle: the yaml library', () => {
  it('reads every generated frontmatter exactly as YAML itself does', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const n = parseNote(`---\n${d}\n---\nbody\n`);
        expect(n.error).toBeNull();
        expect(Object.fromEntries(n.fields.map((f) => [f.key, f.value]))).toEqual(parseYaml(d) ?? {});
      }),
      FC,
    );
  });
});

const flatScalar = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => (Object.is(x, -0) ? 0 : x)),
  fc.boolean(),
  fc.constant(null),
);

describe('setField', () => {
  it('rewrites only the key it changes', () => {
    const n = setField(parseNote(NOTE), 'tags', ['concept', 'ml']);
    expect(toText(n)).toBe(NOTE.replace('tags: [concept]', 'tags: [concept, ml]'));
  });
  it('replaces a block list as a whole and removes a key with its lines', () => {
    expect(toText(setField(parseNote(NOTE), 'aliases', ['Logit']))).toContain('aliases: [Logit]\nurl:');
    expect(toText(removeField(parseNote(NOTE), 'aliases'))).toBe(NOTE.replace('aliases:\n  - Logistic function\n', ''));
  });
  it('keeps CRLF when editing a note written on Windows', () => {
    const t = '---\r\ntags: [a]\r\nx: 1\r\n---\r\nbody\r\n';
    expect(toText(setField(parseNote(t), 'tags', ['a', 'b']))).toBe('---\r\ntags: [a, b]\r\nx: 1\r\n---\r\nbody\r\n');
  });
  it('adds frontmatter to a note that has none', () => {
    expect(toText(setField(parseNote('# Hi\n'), 'tags', ['moc']))).toBe('---\ntags: [moc]\n---\n# Hi\n');
  });
  it('round-trips any flat value through YAML', () => {
    fc.assert(
      fc.property(fc.oneof(flatScalar, fc.array(flatScalar, { maxLength: 4 })), (v) => {
        const n = setField(parseNote('---\na: 1\n---\nbody'), 'k', v);
        expect(n.error).toBeNull();
        expect(getField(n, 'k')).toEqual(v);
        expect(getField(n, 'a')).toBe(1);
      }),
      FC,
    );
  });
  it('refuses to edit frontmatter it cannot read', () => {
    expect(() => setField(parseNote('---\na:\n  b: 1\n---\n'), 'a', 1)).toThrow(/cannot edit/);
  });
});

describe('asList', () => {
  it('turns a scalar or list into strings and drops nulls', () => {
    expect(asList(['a', 1, null])).toEqual(['a', '1']);
    expect(asList('x')).toEqual(['x']);
    expect(asList(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/frontmatter.test.ts`
Expected: FAIL with `Failed to resolve import "./frontmatter"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/frontmatter.ts`:
```ts
import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter as a flat subset: each key holds a scalar or a list of scalars.
 * Values are read by the `yaml` library, so they mean exactly what YAML says.
 * The raw lines are kept, so a save that changes nothing, or one key, leaves
 * every other byte as it was (spec, Frontmatter; Done when, Zero loss).
 */

export type FmScalar = string | number | boolean | null;
export type FmValue = FmScalar | FmScalar[];
export interface FmField { key: string; value: FmValue }
export interface Note {
  /** Text before the body, exactly as read: BOM, fences, frontmatter, line endings. '' when there is no frontmatter. */
  head: string;
  body: string;
  fields: FmField[];
  /** Set when there is frontmatter outside the subset. The note then opens raw, and `fields` is empty. */
  error: string | null;
  eol: '\n' | '\r\n';
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[\p{L}\p{N}_][^:#]*?)[ \t]*:(?=[ \t]|$)/u;
const OPEN = /^---[ \t]*\r?\n/;

interface Head { bom: string; open: string; inner: string; close: string; after: number }

function splitHead(text: string): Head | null {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const open = OPEN.exec(text.slice(bom.length))?.[0];
  if (!open) return null;
  const start = bom.length + open.length;
  for (let pos = start; pos <= text.length; ) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    if (/^---[ \t]*\r?\n?$/.test(text.slice(pos, end))) return { bom, open, inner: text.slice(start, pos), close: text.slice(pos, end), after: end };
    if (nl === -1) return null;
    pos = end;
  }
  return null;
}

const innerLines = (inner: string): string[] => {
  const lines = inner.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return JSON.parse(k) as string;
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k.trimEnd();
}

/** Top-level keys and their line numbers. Null when a line is neither a key, a continuation nor a comment. */
function keyLines(lines: string[]): { key: string; line: number }[] | null {
  const out: { key: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^[ \t#]/.test(l) || /^-(\s|$)/.test(l)) continue;
    const m = KEY_LINE.exec(l);
    if (!m) return null;
    out.push({ key: unquoteKey(m[1]), line: i });
  }
  return out;
}

const isScalar = (v: unknown): v is FmScalar => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function readFields(inner: string): { fields: FmField[]; error: string | null } {
  let data: unknown;
  try {
    data = parseYaml(inner, { uniqueKeys: true });
  } catch (e) {
    return { fields: [], error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  if (data === null || data === undefined) return { fields: [], error: null };
  if (typeof data !== 'object' || Array.isArray(data)) return { fields: [], error: 'frontmatter is not a list of keys' };
  const fields: FmField[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) return { fields: [], error: `"${key}" holds a nested value` };
    fields.push({ key, value: value as FmValue });
  }
  const keys = keyLines(innerLines(inner));
  // Compare as sets: JavaScript objects list numeric keys first, whatever order the file has.
  const sorted = (xs: string[]) => [...xs].sort().join('\0');
  if (!keys || sorted(keys.map((k) => k.key)) !== sorted(fields.map((f) => f.key))) {
    return { fields: [], error: 'frontmatter layout is outside the flat subset' };
  }
  return { fields, error: null };
}

export function parseNote(text: string): Note {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const h = splitHead(text);
  if (!h) return { head: '', body: text, fields: [], error: null, eol };
  return { head: text.slice(0, h.after), body: text.slice(h.after), eol, ...readFields(h.inner) };
}

export const toText = (note: Note): string => note.head + note.body;
export const getField = (note: Note, key: string): FmValue | undefined => note.fields.find((f) => f.key === key)?.value;

export function asList(v: FmValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && typeof x !== 'boolean').map(String);
}

const sameAsPlain = (v: string) => {
  try {
    return parseYaml(v) === v;
  } catch {
    return false;
  }
};

function scalar(v: FmScalar): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('frontmatter numbers must be finite');
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  const plain = v !== '' && v === v.trim() && !/[\n\r\t,[\]{}#&*!|>'"%@`]|: |:$|^[-?:]/.test(v) && sameAsPlain(v);
  // JSON strings are valid YAML double-quoted scalars; YAML also wants these characters escaped.
  return plain ? v : JSON.stringify(v).replace(/[\u007f-\u009f\ufeff\ufffe\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const render = (v: FmValue): string => (Array.isArray(v) ? `[${v.map(scalar).join(', ')}]` : scalar(v));
const renderKey = (k: string): string =>
  /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(k) && k === k.trim() && !['null', 'true', 'false', '~'].includes(k.toLowerCase()) ? k : JSON.stringify(k);

function edit(note: Note, key: string, line: string | null): Note {
  if (note.error) throw new Error(`cannot edit frontmatter: ${note.error}`);
  const text = toText(note);
  const h = splitHead(text);
  if (!h) return line === null ? note : parseNote(`---${note.eol}${line}${note.eol}---${note.eol}${text}`);
  // The frontmatter's own line ending: a file can mix LF frontmatter with a CRLF body.
  const eol = h.open.endsWith('\r\n') ? '\r\n' : '\n';
  const lines = innerLines(h.inner);
  const k = (keyLines(lines) ?? []).find((x) => x.key === key);
  if (k) {
    let end = k.line + 1;
    while (end < lines.length && (/^[ \t]+\S/.test(lines[end]) || /^-(\s|$)/.test(lines[end]))) end++;
    lines.splice(k.line, end - k.line, ...(line === null ? [] : [line]));
  } else if (line !== null) lines.push(line);
  return parseNote(h.bom + h.open + lines.map((l) => l + eol).join('') + h.close + note.body);
}

export const setField = (note: Note, key: string, value: FmValue): Note => edit(note, key, `${renderKey(key)}: ${render(value)}`);
export const removeField = (note: Note, key: string): Note => edit(note, key, null);
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/frontmatter.test.ts`
Expected: PASS (14 tests).

If the oracle test fails, read the counterexample that fast-check prints. Then change `frontmatter.ts`; never the generator, and never `yaml`. The library is the judge.

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/frontmatter.ts src/shared/brain/frontmatter.test.ts src/shared/brain/testing.ts
git commit -m "Brain core: flat frontmatter that YAML agrees with and that saves byte for byte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Blocks, headings, tasks and code ranges, judged by the CommonMark spec

**Files:**
- Create:
  - `src/shared/brain/blocks.ts`
  - `mcp/brain/fixtures/README.md`
  - `mcp/brain/fixtures/commonmark-0.31.2.json`
- Test:
  - `src/shared/brain/blocks.test.ts`
  - `mcp/brain/blocks.spec.test.ts`

**Interfaces:**
- Consumes: `@lezer/markdown`, the CommonMark and GFM parser CodeMirror uses. The index and the editor (plan 4) therefore never disagree about structure.
- Produces:
  - `type BlockKind = 'heading' | 'paragraph' | 'item' | 'code' | 'table' | 'quote' | 'html' | 'rule'`
  - `interface Block { kind: BlockKind; from: number; to: number; text: string; section: string; level?: number }`
  - `interface Heading { text: string; level: number; from: number; to: number }`
  - `interface Task { text: string; done: boolean; from: number; to: number }`
  - `interface Structure { blocks: Block[]; headings: Heading[]; tasks: Task[]; code: [number, number][] }`
  - `structure(body: string): Structure`. Offsets are into `body`. List items are separate blocks; a quote (and so a callout) is one block.

- [ ] **Step 1: Vendor the CommonMark examples the oracle needs**

Run:
```bash
mkdir -p mcp/brain/fixtures
curl -sf https://spec.commonmark.org/0.31.2/spec.json -o "$TMPDIR/spec.json"
node -e "
const s = require(process.env.TMPDIR + '/spec.json');
const keep = new Set(['ATX headings','Setext headings','Fenced code blocks','Indented code blocks','Paragraphs','Blank lines','Thematic breaks']);
require('fs').writeFileSync('mcp/brain/fixtures/commonmark-0.31.2.json', JSON.stringify(s.filter(e => keep.has(e.section)).map(({ example, section, markdown, html }) => ({ example, section, markdown, html })), null, 1) + '\n');
console.log(s.filter(e => keep.has(e.section)).length, 'examples');"
```
Expected: about 120 examples.

Create `mcp/brain/fixtures/README.md`:
```markdown
# Test fixtures

- `commonmark-0.31.2.json`: examples from the CommonMark Spec 0.31.2 (sections ATX headings, Setext headings, Fenced code blocks, Indented code blocks, Paragraphs, Blank lines, Thematic breaks), from https://spec.commonmark.org/0.31.2/spec.json. The spec is by John MacFarlane, licensed CC BY-SA 4.0; this file keeps that licence.
- `vault/`: a synthetic vault written for these tests. None of it is anyone's real notes.
- `obsidian-dump.json`: what Obsidian itself reports for `vault/`, exported with `mcp/brain/obsidian/dump.js`.
```

- [ ] **Step 2: Write the failing tests**

Create `src/shared/brain/blocks.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { structure } from './blocks';

const BODY = [
  '# Title',
  '',
  'Intro with `code [[x]]`.',
  '',
  '## Part',
  '',
  '- one',
  '- [ ] todo item',
  '  - [x] done child',
  '- three',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '> [!note]- Folded',
  '> inside',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Setext',
  '===',
  '',
].join('\n');

describe('structure', () => {
  const s = structure(BODY);
  it('splits a note into blocks, one per list item, one per quote', () => {
    expect(s.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'item', 'item', 'item', 'item', 'code', 'quote', 'table', 'heading']);
    expect(s.blocks.filter((b) => b.kind === 'item').map((b) => b.text)).toEqual(['one', 'todo item', 'done child', 'three']);
  });
  it('names the section each block sits in', () => {
    expect(s.blocks[1].section).toBe('Title');
    expect(s.blocks[3].section).toBe('Part');
  });
  it('reads headings with levels, ATX and setext', () => {
    expect(s.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Part'],
      [1, 'Setext'],
    ]);
  });
  it('reads tasks and their state, nested ones too', () => {
    expect(s.tasks.map((t) => [t.text, t.done])).toEqual([
      ['todo item', false],
      ['done child', true],
    ]);
  });
  it('records inline and fenced code so links inside them can be skipped', () => {
    expect(s.code.map(([a, b]) => BODY.slice(a, b))).toEqual(['`code [[x]]`', '```js\nconst a = 1;\n```']);
  });
  it('ends a table at a following quote, as GFM does', () => {
    expect(structure('| abc | def |\n| --- | --- |\n| bar | baz |\n> bar\n').blocks.map((b) => b.kind)).toEqual(['table', 'quote']);
  });
  it('strips the closing hashes of an ATX heading', () => {
    expect(structure('## Uses ##\n').headings[0].text).toBe('Uses');
  });
});
```

Create `mcp/brain/blocks.spec.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { structure } from '../../src/shared/brain/blocks';
import spec from './fixtures/commonmark-0.31.2.json';

// Headings and code inside quotes and list items are part of that block by design (spec, Index entry), so those examples are out.
const examples = spec.filter((e) => !/<(blockquote|li|ul|ol)\b/.test(e.html));

describe('oracle: the CommonMark spec', () => {
  it.each(examples)('example $example ($section) has the headings and code blocks the spec expects', (e) => {
    const s = structure(e.markdown);
    const headings = [...e.html.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: Number(m[1]), text: m[2] }));
    expect(s.headings.map((h) => h.level)).toEqual(headings.map((h) => h.level));
    headings.forEach((h, i) => {
      // Inline markup is the inline parser's business; compare text only when neither side has any.
      if (!/[<&\\`*_]/.test(h.text) && !/[<&\\`*_]/.test(s.headings[i].text)) expect(s.headings[i].text).toBe(h.text);
    });
    expect(s.blocks.filter((b) => b.kind === 'code')).toHaveLength([...e.html.matchAll(/<pre><code[^>]*>/g)].length);
  });
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/blocks.test.ts mcp/brain/blocks.spec.test.ts`
Expected: FAIL with `Failed to resolve import ".../blocks"`.

- [ ] **Step 4: Implement**

Create `src/shared/brain/blocks.ts`:
```ts
import { GFM, parser as base } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

/**
 * Paragraphs, list items, headings, tasks and code spans of a note body, from
 * CodeMirror's own CommonMark + GFM parser, so the index and the editor
 * never disagree about structure. Offsets are into the body.
 */

const parser = base.configure(GFM);

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'code' | 'table' | 'quote' | 'html' | 'rule';
export interface Block { kind: BlockKind; from: number; to: number; text: string; section: string; level?: number }
export interface Heading { text: string; level: number; from: number; to: number }
export interface Task { text: string; done: boolean; from: number; to: number }
export interface Structure { blocks: Block[]; headings: Heading[]; tasks: Task[]; code: [number, number][] }

const KIND: Record<string, BlockKind> = {
  Paragraph: 'paragraph',
  FencedCode: 'code',
  CodeBlock: 'code',
  Table: 'table',
  Blockquote: 'quote',
  HTMLBlock: 'html',
  HorizontalRule: 'rule',
};
const LIST = new Set(['BulletList', 'OrderedList']);

function headingText(raw: string, atx: boolean): string {
  if (atx) return raw.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
  return raw.split(/\r?\n/).slice(0, -1).map((l) => l.trim()).join('\n');
}

export function structure(body: string): Structure {
  const tree = parser.parse(body);
  const s: Structure = { blocks: [], headings: [], tasks: [], code: [] };
  let section = '';

  const item = (li: SyntaxNode) => {
    let end = li.to;
    let isTask = false;
    for (let c = li.firstChild; c; c = c.nextSibling) {
      if (c.name === 'Task') isTask = true;
      if (LIST.has(c.name)) {
        end = c.from;
        break;
      }
    }
    const raw = body.slice(li.from, end).replace(/\s+$/, '');
    const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(raw)?.[0] ?? '';
    const box = isTask ? /^\[([ xX])\][ \t]*/.exec(raw.slice(marker.length)) : null;
    const text = raw.slice(marker.length + (box?.[0].length ?? 0)).trim();
    s.blocks.push({ kind: 'item', from: li.from, to: end, text, section });
    if (box) s.tasks.push({ text, done: box[1] !== ' ', from: li.from, to: end });
    // Only nested lists are their own blocks; the item's paragraphs are its text.
    for (let c = li.firstChild; c; c = c.nextSibling) if (LIST.has(c.name)) visit(c);
  };

  const visit = (parent: SyntaxNode) => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      const h = /^(ATX|Setext)Heading(\d)$/.exec(c.name);
      if (h) {
        const text = headingText(body.slice(c.from, c.to), h[1] === 'ATX');
        const level = Number(h[2]);
        section = text;
        s.headings.push({ text, level, from: c.from, to: c.to });
        s.blocks.push({ kind: 'heading', from: c.from, to: c.to, text, section, level });
      } else if (LIST.has(c.name)) visit(c);
      else if (c.name === 'ListItem') item(c);
      else if (KIND[c.name]) s.blocks.push({ kind: KIND[c.name], from: c.from, to: c.to, text: body.slice(c.from, c.to), section });
    }
  };

  visit(tree.topNode);
  tree.iterate({
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') {
        s.code.push([n.from, n.to]);
        return false;
      }
      return undefined;
    },
  });
  return s;
}
```
`@lezer/common` is installed as a dependency of `@lezer/markdown`; the import is types only.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/blocks.test.ts mcp/brain/blocks.spec.test.ts`
Expected: PASS. That is 7 unit tests, plus one per kept CommonMark example.

If a CommonMark example fails, print the parse tree:
```bash
node -e "const {parser,GFM}=require('@lezer/markdown');const t=parser.configure(GFM).parse(process.argv[1]);t.iterate({enter:n=>console.log(n.name,n.from,n.to)})" "<the example's markdown>"
```
Then decide which side is wrong:
- If the tree is right, fix `blocks.ts`.
- If `@lezer/markdown` itself disagrees with the spec, add the example number to a `PARSER_GAPS` set at the top of `blocks.spec.test.ts` with a one-line reason, and tell the user. The editor in plan 4 will show the same structure, so such gaps are recorded, not hidden.

- [ ] **Step 6: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/blocks.ts src/shared/brain/blocks.test.ts mcp/brain/blocks.spec.test.ts mcp/brain/fixtures/README.md mcp/brain/fixtures/commonmark-0.31.2.json
git commit -m "Brain core: blocks, headings, tasks and code ranges from CodeMirror's parser, checked against the CommonMark spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Links

**Files:**
- Create: `src/shared/brain/links.ts`
- Test: `src/shared/brain/links.test.ts`

**Interfaces:**
- Consumes:
  - `parseNote`, `setField`, `FmField` (Task 12)
  - `structure` (Task 13)
  - `nfc`, `titleKey` (Task 11)
- Produces:
  - `interface Link { target: string; heading: string | null; alias: string | null; embed: boolean; from: number; to: number; property: string | null }`. Offsets are into the text it was found in; property links have `from = to = -1`.
  - `interface Targets { notes: Map<string, string>; files: Map<string, string> }`. Keys are `titleKey`; values are paths.
  - `wikiLinks(text: string, code?: [number, number][]): Link[]`
  - `propertyLinks(fields: FmField[]): Link[]`
  - `resolve(link: Link, selfPath: string, t: Targets): string | null`
  - `formatLink(l): string`
  - `rewriteLinks(text, code, change: (l: Link) => Partial<Link> | null): string`
  - `retarget(text: string, match: (l: Link) => boolean, change: (l: Link) => Partial<Link>): string`. It rewrites body links (skipping code) and property links (through `setField`, so YAML quoting stays valid).
  - `overlaps(ranges: [number, number][], from: number, to: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/links.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseNote } from './frontmatter';
import { propertyLinks, resolve, retarget, wikiLinks, type Targets } from './links';
import { titleKey } from './names';

describe('wikiLinks', () => {
  it('reads every link form', () => {
    const ls = wikiLinks('[[A]] [[B|b]] [[C#H]] [[D#H|d]] ![[e.png]] ![[F#H]] [[#Own]]');
    expect(ls.map((l) => [l.target, l.heading, l.alias, l.embed])).toEqual([
      ['A', null, null, false],
      ['B', null, 'b', false],
      ['C', 'H', null, false],
      ['D', 'H', 'd', false],
      ['e.png', null, null, true],
      ['F', 'H', null, true],
      ['', 'Own', null, false],
    ]);
  });
  it('skips links inside code and ignores empty [[]]', () => {
    const text = 'x `[[No]]` [[Yes]] [[]]';
    expect(wikiLinks(text, [[2, 10]]).map((l) => l.target)).toEqual(['Yes']);
  });
  it('reads links written as property values', () => {
    const n = parseNote('---\nsources: ["[[DL Class – Lecture 3]]", "notion:abc"]\nrelated: "[[Café]]"\n---\n');
    expect(propertyLinks(n.fields).map((l) => [l.property, l.target])).toEqual([
      ['sources', 'DL Class – Lecture 3'],
      ['related', 'Café'],
    ]);
  });
});

describe('resolve', () => {
  const t: Targets = {
    notes: new Map([
      [titleKey('Sigmoid'), 'Concepts/Sigmoid.md'],
      [titleKey('Logistic function'), 'Concepts/Sigmoid.md'],
      [titleKey('Caf\u00e9'), 'Concepts/Cafe\u0301.md'],
      [titleKey('Lecture 3.5'), 'School/Lecture 3.5.md'],
    ]),
    files: new Map([[titleKey('sigmoid.png'), 'attachments/sigmoid.png']]),
  };
  const link = (s: string) => wikiLinks(s)[0];
  it('finds notes by title or alias, ignoring case', () => {
    expect(resolve(link('[[sigmoid]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Logistic Function|f]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
  });
  it('resolves an NFC link to a file macOS lists in NFD', () => {
    expect(resolve(link('[[Caf\u00e9]]'), 'x.md', t)).toBe('Concepts/Cafe\u0301.md');
  });
  it('accepts path and .md forms, prefers notes over attachments, and resolves [[#H]] to the note itself', () => {
    expect(resolve(link('[[Concepts/Sigmoid]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Sigmoid.md]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Lecture 3.5]]'), 'x.md', t)).toBe('School/Lecture 3.5.md');
    expect(resolve(link('![[sigmoid.png]]'), 'x.md', t)).toBe('attachments/sigmoid.png');
    expect(resolve(link('[[#Uses]]'), 'Concepts/Sigmoid.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Missing]]'), 'x.md', t)).toBeNull();
  });
});

describe('retarget', () => {
  const isOld = (l: { target: string }) => titleKey(l.target) === titleKey('Old');
  it('renames body and property links, keeping headings, aliases and embeds, and skipping code', () => {
    const text = "---\nrelated: '[[Old]]'\nkeep: 1\n---\n[[Old]] [[old#H|x]] ![[Old#H]] `[[Old]]` [[Other]]\n";
    expect(retarget(text, isOld, () => ({ target: "Bob's" }))).toBe(
      '---\nrelated: "[[Bob\'s]]"\nkeep: 1\n---\n[[Bob\'s]] [[Bob\'s#H|x]] ![[Bob\'s#H]] `[[Old]]` [[Other]]\n',
    );
  });
  it('keeps CRLF line endings', () => {
    expect(retarget('# N\r\n\r\nSee [[Old]].\r\n', isOld, () => ({ target: 'New' }))).toBe('# N\r\n\r\nSee [[New]].\r\n');
  });
  it('returns the same string when nothing matches', () => {
    const text = '---\nx: "[[A]]"\n---\n[[A]]\n';
    expect(retarget(text, isOld, () => ({ target: 'New' }))).toBe(text);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/links.test.ts`
Expected: FAIL with `Failed to resolve import "./links"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/links.ts`:
```ts
import { structure } from './blocks';
import { parseNote, setField, type FmField, type FmValue } from './frontmatter';
import { nfc, titleKey } from './names';

/** A wiki link. `from`/`to` are offsets into the text it was read from; -1 for links in properties. */
export interface Link { target: string; heading: string | null; alias: string | null; embed: boolean; from: number; to: number; property: string | null }
/** What links can point at: notes by title or alias, attachments by file name. Keys are titleKey()s, values paths. */
export interface Targets { notes: Map<string, string>; files: Map<string, string> }

const WIKI = /(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]/g;

export const overlaps = (ranges: [number, number][], from: number, to: number): boolean => ranges.some(([a, b]) => from < b && to > a);

function toLink(m: RegExpExecArray | RegExpMatchArray, from: number, property: string | null): Link {
  return {
    target: nfc(m[2].trim()),
    heading: m[3]?.trim() || null,
    alias: m[4] ?? null,
    embed: m[1] === '!',
    from,
    to: property === null ? from + m[0].length : -1,
    property,
  };
}

export function wikiLinks(text: string, code: [number, number][] = []): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(WIKI)) {
    const from = m.index;
    if (overlaps(code, from, from + m[0].length)) continue;
    const l = toLink(m, from, null);
    if (l.target || l.heading) out.push(l);
  }
  return out;
}

/** Obsidian reads a property value that is exactly one wiki link as a link. */
export function propertyLinks(fields: FmField[]): Link[] {
  const out: Link[] = [];
  for (const f of fields) {
    for (const v of Array.isArray(f.value) ? f.value : [f.value]) {
      if (typeof v !== 'string') continue;
      const m = /^\s*(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]\s*$/.exec(v);
      if (m && m[2].trim()) out.push({ ...toLink(m, -1, f.key), from: -1 });
    }
  }
  return out;
}

/** Notes first, as Obsidian does, so "Lecture 3.5" is a note before it is a file called "3.5". */
export function resolve(link: Link, selfPath: string, t: Targets): string | null {
  if (link.target === '') return selfPath;
  const name = link.target.slice(link.target.lastIndexOf('/') + 1);
  return t.notes.get(titleKey(name.replace(/\.md$/i, ''))) ?? t.files.get(titleKey(name)) ?? null;
}

export function formatLink(l: Pick<Link, 'target' | 'heading' | 'alias' | 'embed'>): string {
  return `${l.embed ? '!' : ''}[[${l.target}${l.heading !== null ? `#${l.heading}` : ''}${l.alias !== null ? `|${l.alias}` : ''}]]`;
}

export function rewriteLinks(text: string, code: [number, number][], change: (l: Link) => Partial<Link> | null): string {
  let out = '';
  let last = 0;
  for (const l of wikiLinks(text, code)) {
    const c = change(l);
    if (!c) continue;
    out += text.slice(last, l.from) + formatLink({ ...l, ...c });
    last = l.to;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Rewrites the links `match` picks, in the body (skipping code) and in
 * properties. Properties go through setField so YAML quoting stays valid
 * whatever the new title contains.
 */
export function retarget(text: string, match: (l: Link) => boolean, change: (l: Link) => Partial<Link>): string {
  let note = parseNote(text);
  const pick = (l: Link) => (match(l) ? change(l) : null);
  if (!note.error) {
    for (const f of note.fields) {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      let touched = false;
      const next = values.map((v) => {
        if (typeof v !== 'string') return v;
        const r = rewriteLinks(v, [], pick);
        if (r !== v) touched = true;
        return r;
      });
      if (touched) note = setField(note, f.key, (Array.isArray(f.value) ? next : next[0]) as FmValue);
    }
  }
  return note.head + rewriteLinks(note.body, structure(note.body).code, pick);
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/links.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/links.ts src/shared/brain/links.test.ts
git commit -m "Brain core: wiki links in bodies and properties, resolved and rewritten the way Obsidian reads them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Index entries, targets and backlinks

**Files:**
- Create: `src/shared/brain/entry.ts`
- Test: `src/shared/brain/entry.test.ts`

**Interfaces:**
- Consumes: Tasks 11 to 14.
- Produces:
  - `interface IndexEntry { path; title; aliases: string[]; tags: string[]; fields: FmField[]; fmError: string | null; bodyStart: number; body: string; links: Link[]; headings: Heading[]; blocks: Block[]; tasks: Task[]; code: [number, number][] }`
  - `buildEntry(path: string, text: string): IndexEntry`
  - `inlineTags(body: string, code: [number, number][]): string[]`
  - `targetsOf(entries: IndexEntry[], files: Iterable<string>): Targets`. Titles win over aliases.
  - `backlinks(entries: Iterable<IndexEntry>, t: Targets): Map<string, { from: string; link: Link }[]>`
  - `duplicateTitles(entries: IndexEntry[]): string[][]`
  - `contentHash(text: string): Promise<string>`: SHA-256 hex, the index cache key from the spec.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/entry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { backlinks, buildEntry, contentHash, duplicateTitles, inlineTags, targetsOf } from './entry';

const SIGMOID = '---\ntags: [concept, "#ml"]\naliases: Logistic function\nsources: ["[[Lecture 3]]"]\n---\n# Sigmoid\n\nSee [[Gradient descent]] and #maths, not #2026 or `#code`.\n\n- [ ] derive it\n';

describe('buildEntry', () => {
  const e = buildEntry('Concepts/Sigmoid.md', SIGMOID);
  it('reads title, aliases and tags from frontmatter and body', () => {
    expect(e.title).toBe('Sigmoid');
    expect(e.aliases).toEqual(['Logistic function']);
    expect(e.tags).toEqual(['concept', 'ml', 'maths']);
  });
  it('collects body and property links, headings and tasks, with body offsets', () => {
    expect(e.links.map((l) => [l.target, l.property])).toEqual([
      ['Gradient descent', null],
      ['Lecture 3', 'sources'],
    ]);
    expect(e.body.slice(e.links[0].from, e.links[0].to)).toBe('[[Gradient descent]]');
    expect(e.headings.map((h) => h.text)).toEqual(['Sigmoid']);
    expect(e.tasks.map((t) => t.text)).toEqual(['derive it']);
    expect(SIGMOID.slice(e.bodyStart)).toBe(e.body);
  });
  it('indexes a 1 MB note quickly', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => (i % 50 === 0 ? `## Part ${i}` : `Line ${i} links [[Note ${i % 97}]] and says something.`)).join('\n');
    const t0 = performance.now();
    const b = buildEntry('Big.md', big);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(b.links).toHaveLength(19_600);
  });
});

describe('inlineTags', () => {
  it('skips headings, numbers, code and links', () => {
    expect(inlineTags('# Title\n#tag1 [[Note#Heading]] #2026 ` #x` (#nested/tag)', [[37, 42]])).toEqual(['tag1', 'nested/tag']);
  });
});

describe('targets, backlinks and duplicates', () => {
  const a = buildEntry('Concepts/Sigmoid.md', SIGMOID);
  const b = buildEntry('School/Lecture 3.md', '# Lecture 3\n\n[[Logistic function]] and [[Missing]].\n');
  const c = buildEntry('Inbox/Logistic function.md', '# A note whose title is another note\'s alias\n');
  it('lets a title win over an alias', () => {
    expect(targetsOf([a, b, c], []).notes.get('logistic function')).toBe('Inbox/Logistic function.md');
    expect(targetsOf([a, b], []).notes.get('logistic function')).toBe('Concepts/Sigmoid.md');
  });
  it('derives backlinks, property links included, unresolved ones left out', () => {
    const bl = backlinks([a, b], targetsOf([a, b], []));
    expect(bl.get('Concepts/Sigmoid.md')?.map((x) => x.from)).toEqual(['School/Lecture 3.md']);
    expect(bl.get('School/Lecture 3.md')?.map((x) => x.link.property)).toEqual(['sources']);
  });
  it('finds two files with one title', () => {
    expect(duplicateTitles([a, buildEntry('Inbox/sigmoid.md', '')])).toEqual([['Concepts/Sigmoid.md', 'Inbox/sigmoid.md']]);
  });
  it('hashes content with SHA-256', async () => {
    expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/entry.test.ts`
Expected: FAIL with `Failed to resolve import "./entry"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/entry.ts`:
```ts
import { structure, type Block, type Heading, type Task } from './blocks';
import { asList, getField, parseNote, type FmField } from './frontmatter';
import { overlaps, propertyLinks, resolve, wikiLinks, type Link, type Targets } from './links';
import { nfc, titleKey, titleOf } from './names';

/** What the index keeps per note (spec, Index entry). Offsets in links, headings, blocks, tasks and code are into `body`. */
export interface IndexEntry {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  fields: FmField[];
  fmError: string | null;
  bodyStart: number;
  body: string;
  links: Link[];
  headings: Heading[];
  blocks: Block[];
  tasks: Task[];
  code: [number, number][];
}

const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;

/** Obsidian's inline tags: "#" after a space or line start, not all digits, not in code. */
export function inlineTags(body: string, code: [number, number][]): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(TAG)) {
    const from = m.index + m[1].length;
    if (/^\p{N}+$/u.test(m[2]) || overlaps(code, from, from + 1 + m[2].length)) continue;
    out.push(m[2]);
  }
  return out;
}

export function buildEntry(path: string, text: string): IndexEntry {
  const note = parseNote(text);
  const st = structure(note.body);
  const tags = [...new Set([...asList(getField(note, 'tags')).map((t) => t.replace(/^#/, '')), ...inlineTags(note.body, st.code)])];
  return {
    path,
    title: titleOf(path),
    aliases: asList(getField(note, 'aliases')).map(nfc),
    tags,
    fields: note.fields,
    fmError: note.error,
    bodyStart: note.head.length,
    body: note.body,
    links: [...wikiLinks(note.body, st.code), ...propertyLinks(note.fields)],
    headings: st.headings,
    blocks: st.blocks,
    tasks: st.tasks,
    code: st.code,
  };
}

export function targetsOf(entries: IndexEntry[], files: Iterable<string>): Targets {
  const notes = new Map<string, string>();
  for (const e of entries) if (!notes.has(titleKey(e.title))) notes.set(titleKey(e.title), e.path);
  for (const e of entries) for (const a of e.aliases) if (!notes.has(titleKey(a))) notes.set(titleKey(a), e.path);
  const byName = new Map<string, string>();
  for (const f of files) byName.set(titleKey(f.slice(f.lastIndexOf('/') + 1)), f);
  return { notes, files: byName };
}

export function backlinks(entries: Iterable<IndexEntry>, t: Targets): Map<string, { from: string; link: Link }[]> {
  const out = new Map<string, { from: string; link: Link }[]>();
  for (const e of entries) {
    for (const link of e.links) {
      const to = resolve(link, e.path, t);
      if (!to || to === e.path) continue;
      const list = out.get(to) ?? [];
      list.push({ from: e.path, link });
      out.set(to, list);
    }
  }
  return out;
}

/** Titles must be unique ignoring case; a file made outside the extension can break that, so it is reported, not hidden. */
export function duplicateTitles(entries: IndexEntry[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const e of entries) groups.set(titleKey(e.title), [...(groups.get(titleKey(e.title)) ?? []), e.path]);
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

export async function contentHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/entry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/entry.ts src/shared/brain/entry.test.ts
git commit -m "Brain core: one index entry per note, with targets, backlinks and duplicate titles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The Obsidian search parser

**Files:**
- Create: `src/shared/brain/query.ts`
- Test: `src/shared/brain/query.test.ts`

**Interfaces:**
- Produces:
  - `type Op = 'file' | 'path' | 'content' | 'tag' | 'line' | 'block' | 'section' | 'task' | 'task-todo' | 'task-done' | 'match-case' | 'ignore-case'`. These are the operators observed in Obsidian 1.13's bundle.
  - `OPS: readonly Op[]`
  - `type Q = { t: 'term'; v: string; phrase: boolean } | { t: 'regex'; v: string } | { t: 'and'; a: Q[] } | { t: 'or'; a: Q[] } | { t: 'not'; a: Q } | { t: 'op'; op: Op; a: Q }`
  - `class QueryError extends Error { pos: number }`
  - `parseQuery(src: string): Q`. An empty query gives `{ t: 'and', a: [] }`.
  - `printQuery(q: Q): string`
  - `normalizeQuery(q: Q): Q`
  - `hasRegex(q: Q): boolean`

Grammar:
- AND binds tighter than OR (Obsidian's own example: `meeting work OR meetup personal`).
- `-` negates only at the start of a term.
- `op:` operators apply to the next term or group.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/query.test.ts`:
```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeQuery, OPS, parseQuery, printQuery, QueryError, type Q } from './query';
import { FC } from './testing';

const term = (v: string, phrase = false): Q => ({ t: 'term', v, phrase });

describe('parseQuery', () => {
  it('reads words, phrases, OR, groups and exclusions', () => {
    expect(parseQuery('meeting work')).toEqual({ t: 'and', a: [term('meeting'), term('work')] });
    expect(parseQuery('a b OR c')).toEqual({ t: 'or', a: [{ t: 'and', a: [term('a'), term('b')] }, term('c')] });
    expect(parseQuery('"star wars" -spoiler')).toEqual({ t: 'and', a: [term('star wars', true), { t: 'not', a: term('spoiler') }] });
    expect(parseQuery('(a OR b) c')).toEqual({ t: 'and', a: [{ t: 'or', a: [term('a'), term('b')] }, term('c')] });
  });
  it('reads every operator and a regex', () => {
    expect(parseQuery('line:(mix flour)')).toEqual({ t: 'op', op: 'line', a: { t: 'and', a: [term('mix'), term('flour')] } });
    expect(parseQuery('tag:#concept task-todo:read')).toEqual({
      t: 'and',
      a: [
        { t: 'op', op: 'tag', a: term('#concept') },
        { t: 'op', op: 'task-todo', a: term('read') },
      ],
    });
    expect(parseQuery('/\\d{4}/')).toEqual({ t: 'regex', v: '\\d{4}' });
    for (const op of OPS.filter((o) => o !== 'tag')) expect(parseQuery(`${op}:x`)).toEqual({ t: 'op', op, a: term('x') });
  });
  it('leaves an unknown prefix as a word, and an empty query as no condition', () => {
    expect(parseQuery('http://example.com')).toEqual(term('http://example.com'));
    expect(parseQuery('  ')).toEqual({ t: 'and', a: [] });
  });
  it.each([
    ['(a b', 'unclosed parenthesis', 0],
    ['a OR', 'expected a search term', 4],
    ['"abc', 'unclosed quote', 0],
    ['/(/', 'invalid regular expression', 0],
    ['file:', '"file:" needs a value', 0],
    ['a )', 'unexpected ")"', 2],
    ['tag:(a b)', '"tag:" takes a tag name', 0],
    ['x -', '"-" needs something to exclude', 2],
  ])('reports %j as "%s" at %i', (src, message, pos) => {
    try {
      parseQuery(src);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      expect((e as QueryError).message).toContain(message);
      expect((e as QueryError).pos).toBe(pos);
    }
  });
});

const word = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
const leaf: fc.Arbitrary<Q> = fc.oneof(
  word.map((v) => term(v)),
  fc.string({ maxLength: 8 }).filter((s) => !/[\r\n]/.test(s)).map((v) => term(v, true)),
  fc.constantFrom('a+b', '\\d{2}', 'x\\/y', '[a-c]').map((v): Q => ({ t: 'regex', v })),
);
const { q } = fc.letrec<{ q: Q; and: Q; or: Q; not: Q; op: Q }>((tie) => ({
  q: fc.oneof({ depthSize: 'small' }, leaf, tie('and'), tie('or'), tie('not'), tie('op')),
  and: fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map((a): Q => ({ t: 'and', a })),
  or: fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map((a): Q => ({ t: 'or', a })),
  not: tie('q').map((a): Q => ({ t: 'not', a })),
  op: fc.tuple(fc.constantFrom(...OPS.filter((o) => o !== 'tag')), tie('q')).map(([op, a]): Q => ({ t: 'op', op, a })),
}));

describe('printQuery', () => {
  it('prints any query so it parses back to the same query', () => {
    fc.assert(fc.property(q, (x) => expect(parseQuery(printQuery(x))).toEqual(normalizeQuery(x))), FC);
  });
});
```
The `'x -'` case: a trailing `-` with nothing after it is a word in the tokenizer, so make the tokenizer treat a `-` at the very end as a negation that needs a value. The implementation below does this.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/query.test.ts`
Expected: FAIL with `Failed to resolve import "./query"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/query.ts`:
```ts
/**
 * Obsidian's search syntax (spec, Search): words (AND), "phrases", OR, (groups),
 * -exclude, /regex/, and operators. AND binds tighter than OR. A malformed query
 * throws QueryError with the position, never a partial parse.
 */

export type Op = 'file' | 'path' | 'content' | 'tag' | 'line' | 'block' | 'section' | 'task' | 'task-todo' | 'task-done' | 'match-case' | 'ignore-case';
export const OPS: readonly Op[] = ['file', 'path', 'content', 'tag', 'line', 'block', 'section', 'task', 'task-todo', 'task-done', 'match-case', 'ignore-case'];
export type Q =
  | { t: 'term'; v: string; phrase: boolean }
  | { t: 'regex'; v: string }
  | { t: 'and'; a: Q[] }
  | { t: 'or'; a: Q[] }
  | { t: 'not'; a: Q }
  | { t: 'op'; op: Op; a: Q };

export class QueryError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

type Tok = { k: '(' | ')' | '-' | 'OR' | 'word' | 'phrase' | 'regex' | 'op'; v: string; pos: number };
const isOp = (s: string): s is Op => (OPS as readonly string[]).includes(s);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      toks.push({ k: c, v: c, pos: i++ });
    } else if (c === '-' && (i + 1 === src.length || !/\s/.test(src[i + 1]))) {
      // A "-" negates at the start of a term; inside a word it is just a character.
      toks.push({ k: '-', v: '-', pos: i++ });
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        v += src[j++];
      }
      if (j >= src.length) throw new QueryError('unclosed quote', i);
      toks.push({ k: 'phrase', v, pos: i });
      i = j + 1;
    } else if (c === '/') {
      let j = i + 1;
      while (j < src.length && src[j] !== '/') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new QueryError('unclosed regular expression', i);
      const v = src.slice(i + 1, j);
      try {
        new RegExp(v);
      } catch (e) {
        throw new QueryError(`invalid regular expression: ${(e as Error).message}`, i);
      }
      toks.push({ k: 'regex', v, pos: i });
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()"]/.test(src[j])) {
        j++;
        // An operator ends at its colon, so "file:x" and "file:(a b)" both split there.
        if (src[j - 1] === ':' && isOp(src.slice(i, j - 1))) break;
      }
      const w = src.slice(i, j);
      if (w.endsWith(':') && isOp(w.slice(0, -1))) toks.push({ k: 'op', v: w.slice(0, -1), pos: i });
      else toks.push({ k: w === 'OR' ? 'OR' : 'word', v: w, pos: i });
      i = j;
    }
  }
  return toks;
}

export function parseQuery(src: string): Q {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const ends = (t: Tok | undefined) => !t || t.k === ')' || t.k === 'OR';

  const orExpr = (): Q => {
    const a = [andExpr()];
    while (peek()?.k === 'OR') {
      p++;
      a.push(andExpr());
    }
    return a.length === 1 ? a[0] : { t: 'or', a };
  };
  const andExpr = (): Q => {
    const a: Q[] = [];
    while (!ends(peek())) a.push(unary());
    if (!a.length) throw new QueryError('expected a search term', peek()?.pos ?? src.length);
    return a.length === 1 ? a[0] : { t: 'and', a };
  };
  const unary = (): Q => {
    if (peek()?.k !== '-') return primary();
    const dash = toks[p++];
    if (ends(peek())) throw new QueryError('"-" needs something to exclude', dash.pos);
    return { t: 'not', a: unary() };
  };
  const primary = (): Q => {
    const t = toks[p++];
    switch (t.k) {
      case '(': {
        const q = orExpr();
        if (peek()?.k !== ')') throw new QueryError('unclosed parenthesis', t.pos);
        p++;
        return q;
      }
      case 'op': {
        if (ends(peek())) throw new QueryError(`"${t.v}:" needs a value`, t.pos);
        const a = peek()?.k === '-' ? unary() : primary();
        if (t.v === 'tag' && a.t !== 'term') throw new QueryError('"tag:" takes a tag name', t.pos);
        return { t: 'op', op: t.v as Op, a };
      }
      case 'phrase':
        return { t: 'term', v: t.v, phrase: true };
      case 'regex':
        return { t: 'regex', v: t.v };
      case 'word':
        return { t: 'term', v: t.v, phrase: false };
      default:
        throw new QueryError(`unexpected "${t.v}"`, t.pos);
    }
  };

  if (!toks.length) return { t: 'and', a: [] };
  const q = orExpr();
  if (p < toks.length) throw new QueryError(`unexpected "${toks[p].v}"`, toks[p].pos);
  return q;
}

const atom = (q: Q): string => (q.t === 'and' || q.t === 'or' ? `(${printQuery(q)})` : printQuery(q));

export function printQuery(q: Q): string {
  switch (q.t) {
    case 'term':
      return q.phrase ? `"${q.v.replace(/["\\]/g, '\\$&')}"` : q.v;
    case 'regex':
      return `/${q.v}/`;
    case 'and':
      return q.a.map((x) => (x.t === 'or' ? `(${printQuery(x)})` : printQuery(x))).join(' ');
    case 'or':
      return q.a.map(printQuery).join(' OR ');
    case 'not':
      return `-${atom(q.a)}`;
    case 'op':
      return `${q.op}:${atom(q.a)}`;
  }
}

/** Flattens nested ANDs and ORs, the shape parseQuery produces. */
export function normalizeQuery(q: Q): Q {
  if (q.t === 'and' || q.t === 'or') {
    const a = q.a.map(normalizeQuery).flatMap((x) => (x.t === q.t ? (x as { a: Q[] }).a : [x]));
    return a.length === 1 ? a[0] : { t: q.t, a };
  }
  if (q.t === 'not' || q.t === 'op') return { ...q, a: normalizeQuery(q.a) };
  return q;
}

export function hasRegex(q: Q): boolean {
  if (q.t === 'regex') return true;
  if (q.t === 'and' || q.t === 'or') return q.a.some(hasRegex);
  if (q.t === 'not' || q.t === 'op') return hasRegex(q.a);
  return false;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/query.test.ts`
Expected: PASS: 3 named tests, 8 error cases and the property.

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/query.ts src/shared/brain/query.test.ts
git commit -m "Brain core: Obsidian's search syntax, with positioned errors and a printer that round-trips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Search

**Files:**
- Create: `src/shared/brain/search.ts`
- Test: `src/shared/brain/search.test.ts`

**Interfaces:**
- Consumes: `IndexEntry`, `buildEntry` (Task 15); `Q`, `parseQuery` (Task 16).
- Produces:
  - `interface SearchDoc { path; title; body; tags; headings; blocks; tasks }`
  - `interface Hit { path: string; title: string; score: number }`. Score 3 means a title match, 2 a heading match, 1 a body match.
  - `toSearchDoc(e: IndexEntry): SearchDoc`
  - `search(q: Q, docs: Iterable<SearchDoc>, opts?: { limit?: number; deadline?: number; now?: () => number }): { hits: Hit[]; partial: boolean }`
  - `rankHits(hits: Hit[]): Hit[]`

Semantics:
- A bare term matches the title or the body.
- Matching ignores case unless `match-case:` is used.
- Inside `line:`, `block:`, `section:` and the task operators, the whole sub-query must hold in one unit: one line, one block, one section or one task.
- `deadline` is checked between documents. Stopping a runaway regex inside one document is the host's job; Task 24 runs regex in a worker.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/search.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildEntry } from './entry';
import { parseQuery } from './query';
import { search, toSearchDoc } from './search';

const docs = [
  buildEntry('Concepts/Sigmoid.md', '---\ntags: [concept, ml/basics]\n---\n# Sigmoid\n\n## Definition\n\nThe logistic curve maps reals to (0, 1).\n\nSecond paragraph about gradients.\n\n- [ ] derive the gradient\n- [x] plot the curve\n'),
  buildEntry('School/DL Class/Lecture 3.md', '# Lecture 3\n\nSigmoid appears here once.\nflour and water on one line\nmix\n'),
  buildEntry('Inbox/Gradient notes.md', '# Gradient notes\n\n## Sigmoid trick\n\nNothing else.\n'),
].map(toSearchDoc);
const find = (q: string) => search(parseQuery(q), docs).hits.map((h) => h.title);

describe('search', () => {
  it('ranks a title match over a heading match over a body match', () => {
    expect(find('sigmoid')).toEqual(['Sigmoid', 'Gradient notes', 'Lecture 3']);
  });
  it('handles AND, phrases, OR, exclusion and regex', () => {
    expect(find('logistic gradients')).toEqual(['Sigmoid']);
    expect(find('"logistic curve"')).toEqual(['Sigmoid']);
    expect(find('"curve logistic"')).toEqual([]);
    expect(find('sigmoid -lecture')).toEqual(['Sigmoid', 'Gradient notes']);
    expect(find('flour OR derive').sort()).toEqual(['Lecture 3', 'Sigmoid']);
    expect(find('/\\(0, 1\\)/')).toEqual(['Sigmoid']);
  });
  it('scopes with file:, path:, content: and tag:', () => {
    expect(find('file:lecture')).toEqual(['Lecture 3']);
    expect(find('path:School')).toEqual(['Lecture 3']);
    expect(find('content:appears')).toEqual(['Lecture 3']);
    expect(find('tag:ml')).toEqual(['Sigmoid']);
    expect(find('tag:#concept')).toEqual(['Sigmoid']);
    expect(find('tag:basics')).toEqual([]);
  });
  it('keeps line:, block: and section: inside one unit', () => {
    expect(find('line:(flour water)')).toEqual(['Lecture 3']);
    expect(find('line:(flour mix)')).toEqual([]);
    expect(find('block:(logistic reals)')).toEqual(['Sigmoid']);
    expect(find('block:(logistic gradients)')).toEqual([]);
    expect(find('section:(logistic gradients)')).toEqual(['Sigmoid']);
  });
  it('reads task state', () => {
    expect(find('task:derive')).toEqual(['Sigmoid']);
    expect(find('task-todo:plot')).toEqual([]);
    expect(find('task-done:plot')).toEqual(['Sigmoid']);
  });
  it('respects match-case', () => {
    expect(find('match-case:sigmoid')).toEqual([]);
    expect(find('match-case:Sigmoid')).toHaveLength(3);
  });
  it('stops at the deadline and says the results are partial', () => {
    let t = 0;
    const r = search(parseQuery('sigmoid'), docs, { deadline: 4, now: () => (t += 5) - 5 });
    expect(r.partial).toBe(true);
    expect(r.hits.length).toBeLessThan(3);
  });
  it('searches a 1 MB note fast', () => {
    const big = toSearchDoc(buildEntry('Big.md', Array.from({ length: 20_000 }, (_, i) => `Line ${i} says something ordinary.`).join('\n') + '\nneedle at the end\n'));
    const t0 = performance.now();
    expect(search(parseQuery('needle -haystack line:(needle end)'), [big]).hits).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/search.test.ts`
Expected: FAIL with `Failed to resolve import "./search"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/search.ts`:
```ts
import type { Block, Heading, Task } from './blocks';
import type { IndexEntry } from './entry';
import type { Q } from './query';

/**
 * Linear scan, ranked title, then heading, then body (spec, Search).
 * ponytail: linear scan; move to an inverted index past about 5,000 notes or
 * when bench:brain misses the 150 ms budget.
 */

export interface SearchDoc { path: string; title: string; body: string; tags: string[]; headings: Heading[]; blocks: Block[]; tasks: Task[] }
export interface Hit { path: string; title: string; score: number }

export const toSearchDoc = (e: IndexEntry): SearchDoc => ({ path: e.path, title: e.title, body: e.body, tags: e.tags, headings: e.headings, blocks: e.blocks, tasks: e.tasks });

type Ctx = { cs: boolean };
interface Scope { raw: string; low?: string }
const low = (s: Scope) => (s.low ??= s.raw.toLowerCase());

const compiled = new Map<string, RegExp>();
function re(src: string, cs: boolean): RegExp {
  const k = (cs ? 'c:' : 'i:') + src;
  let r = compiled.get(k);
  if (!r) {
    if (compiled.size > 100) compiled.clear();
    r = new RegExp(src, cs ? '' : 'i');
    compiled.set(k, r);
  }
  return r;
}

function inScope(q: Q, s: Scope, ctx: Ctx): boolean {
  switch (q.t) {
    case 'term':
      return ctx.cs ? s.raw.includes(q.v) : low(s).includes(q.v.toLowerCase());
    case 'regex':
      return re(q.v, ctx.cs).test(s.raw);
    case 'and':
      return q.a.every((x) => inScope(x, s, ctx));
    case 'or':
      return q.a.some((x) => inScope(x, s, ctx));
    case 'not':
      return !inScope(q.a, s, ctx);
    case 'op':
      // Inside a text scope, only case operators change anything; other scopes already narrowed the text.
      return inScope(q.a, s, q.op === 'match-case' ? { cs: true } : q.op === 'ignore-case' ? { cs: false } : ctx);
  }
}

function sections(d: SearchDoc): string[] {
  const cuts = [0, ...d.headings.map((h) => h.from), d.body.length];
  const out: string[] = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push(d.body.slice(cuts[i], cuts[i + 1]));
  return out;
}

interface DocScopes { title: Scope; body: Scope }

function inDoc(q: Q, d: SearchDoc, ctx: Ctx, c: DocScopes): boolean {
  switch (q.t) {
    case 'term':
    case 'regex':
      return inScope(q, c.title, ctx) || inScope(q, c.body, ctx);
    case 'and':
      return q.a.every((x) => inDoc(x, d, ctx, c));
    case 'or':
      return q.a.some((x) => inDoc(x, d, ctx, c));
    case 'not':
      return !inDoc(q.a, d, ctx, c);
    case 'op': {
      const any = (texts: string[]) => texts.some((raw) => inScope(q.a, { raw }, ctx));
      switch (q.op) {
        case 'file':
          return inScope(q.a, c.title, ctx);
        case 'path':
          return inScope(q.a, { raw: d.path }, ctx);
        case 'content':
          return inScope(q.a, c.body, ctx);
        case 'tag': {
          const want = (q.a as { v: string }).v.replace(/^#/, '').toLowerCase();
          return d.tags.some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(want + '/'));
        }
        case 'line':
          return any(d.body.split('\n'));
        case 'block':
          return any(d.blocks.map((b) => b.text));
        case 'section':
          return any(sections(d));
        case 'task':
          return any(d.tasks.map((t) => t.text));
        case 'task-todo':
          return any(d.tasks.filter((t) => !t.done).map((t) => t.text));
        case 'task-done':
          return any(d.tasks.filter((t) => t.done).map((t) => t.text));
        case 'match-case':
          return inDoc(q.a, d, { cs: true }, c);
        case 'ignore-case':
          return inDoc(q.a, d, { cs: false }, c);
      }
    }
  }
}

/** Terms a hit is ranked by: everything not excluded and not a tag. */
function positives(q: Q, out: Q[] = []): Q[] {
  if (q.t === 'term' || q.t === 'regex') out.push(q);
  else if (q.t === 'and' || q.t === 'or') q.a.forEach((x) => positives(x, out));
  else if (q.t === 'op' && q.op !== 'tag') positives(q.a, out);
  return out;
}

function score(d: DocScopes, headings: Heading[], terms: Q[]): number {
  if (terms.some((t) => inScope(t, d.title, { cs: false }))) return 3;
  if (terms.some((t) => headings.some((h) => inScope(t, { raw: h.text }, { cs: false })))) return 2;
  return 1;
}

export const rankHits = (hits: Hit[]): Hit[] => hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

export function search(q: Q, docs: Iterable<SearchDoc>, opts: { limit?: number; deadline?: number; now?: () => number } = {}): { hits: Hit[]; partial: boolean } {
  const hits: Hit[] = [];
  if (q.t === 'and' && q.a.length === 0) return { hits, partial: false };
  const now = opts.now ?? (() => Date.now());
  const terms = positives(q);
  let partial = false;
  for (const d of docs) {
    if (opts.deadline !== undefined && now() > opts.deadline) {
      partial = true;
      break;
    }
    const c = { title: { raw: d.title }, body: { raw: d.body } };
    if (inDoc(q, d, { cs: false }, c)) hits.push({ path: d.path, title: d.title, score: score(c, d.headings, terms) });
  }
  return { hits: rankHits(hits).slice(0, opts.limit ?? hits.length), partial };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/search.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/search.ts src/shared/brain/search.test.ts
git commit -m "Brain core: search with every Obsidian operator, ranked title over heading over body

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Journaled plans, proven against a crash at every step

**Files:**
- Create: `src/shared/brain/plan.ts`
- Modify: `src/shared/brain/testing.ts`: add `MemFs` and `Crash`
- Test: `src/shared/brain/plan.test.ts`

**Interfaces:**
- Produces:
  - `type Step = { op: 'write'; path: string; text: string } | { op: 'copy'; from: string; to: string } | { op: 'remove'; path: string }`
  - `interface Plan { id: string; label: string; steps: Step[] }`
  - `interface PlanFs { readText; writeText; copy; remove; exists; list }`. `writeText` and `copy` must be atomic per file. `remove` must not fail when the path is already gone. `list(dir)` returns the file paths directly inside `dir`.
  - `JOURNAL = '.brain/journal'`
  - `newPlanId(): string`
  - `runPlan(fs, plan): Promise<void>`
  - `recover(fs): Promise<string[]>`, returning the labels of the plans it finished.
  - In `testing.ts`: `class MemFs implements PlanFs`, case-insensitive like APFS and NTFS, with `writesLeft` and `all(): [string, string][]`; and `class Crash extends Error`.

How a plan runs:
- Write the journal.
- Run each step, recording how many are done.
- Delete the journal.

How recovery works: it rolls forward from the recorded step. Every step is idempotent, so redoing the interrupted one is safe.

The property to prove: a crash at any step, during the run or during recovery, leaves either the start state (the crash came before the journal existed) or the end state.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/brain/testing.ts`:
```ts
import { JOURNAL, type PlanFs } from './plan';

export class Crash extends Error {}

const key = (p: string) => p.normalize('NFC').toLowerCase();

/**
 * In-memory PlanFs, case-insensitive like APFS and NTFS: writing "a.md" over an
 * existing "A.md" keeps the old name. `writesLeft` simulates a crash on the
 * next mutating call.
 */
export class MemFs implements PlanFs {
  private files = new Map<string, { name: string; text: string }>();
  writesLeft = Infinity;
  constructor(init: Record<string, string> = {}) {
    for (const [name, text] of Object.entries(init)) this.files.set(key(name), { name, text });
  }
  private tick() {
    if (this.writesLeft <= 0) throw new Crash('simulated crash');
    this.writesLeft--;
  }
  async readText(p: string) {
    return this.files.get(key(p))?.text ?? null;
  }
  async writeText(p: string, text: string) {
    this.tick();
    this.files.set(key(p), { name: this.files.get(key(p))?.name ?? p, text });
  }
  async copy(from: string, to: string) {
    this.tick();
    const src = this.files.get(key(from));
    if (!src) throw new Error(`no such file: ${from}`);
    this.files.set(key(to), { name: this.files.get(key(to))?.name ?? to, text: src.text });
  }
  async remove(p: string) {
    this.tick();
    this.files.delete(key(p));
  }
  async exists(p: string) {
    return this.files.has(key(p));
  }
  async list(dir: string) {
    const pre = key(dir.replace(/\/?$/, '/'));
    return [...this.files.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([, f]) => f.name).sort();
  }
  /** Every file with its stored name, journal excluded, sorted: the state a plan is judged by. */
  all(): [string, string][] {
    return [...this.files.values()].filter((f) => !key(f.name).startsWith(JOURNAL + '/')).map((f): [string, string] => [f.name, f.text]).sort(([a], [b]) => a.localeCompare(b));
  }
}
```

Create `src/shared/brain/plan.test.ts`:
```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { recover, runPlan, type Plan, type Step } from './plan';
import { Crash, FC, MemFs } from './testing';

const NAMES = ['a.md', 'b.md', 'c.md', 'd.md'];

/** A start state and a plan that is valid on it: every copy has a source when it runs. */
const scenario = fc
  .record({
    start: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1 }),
    ops: fc.array(fc.tuple(fc.constantFrom('write', 'copy', 'remove'), fc.nat(3), fc.nat(3), fc.string({ maxLength: 4 })), { maxLength: 6 }),
  })
  .map(({ start, ops }) => {
    const exists = new Set(start);
    const steps: Step[] = [];
    for (const [op, i, j, text] of ops) {
      const [p, q] = [NAMES[i], NAMES[j]];
      if (op === 'write') {
        steps.push({ op, path: p, text });
        exists.add(p);
      } else if (op === 'copy' && exists.has(p) && p !== q) {
        steps.push({ op, from: p, to: q });
        exists.add(q);
      } else if (op === 'remove') {
        steps.push({ op, path: p });
        exists.delete(p);
      }
    }
    const plan: Plan = { id: 'p1', label: 'test', steps };
    return { start: Object.fromEntries(start.map((s) => [s, `start ${s}`])), plan };
  });

async function endState(start: Record<string, string>, plan: Plan) {
  const fs = new MemFs(start);
  await runPlan(fs, plan);
  return fs.all();
}

/** Mutating calls an uninterrupted run makes: one journal write, then a step and a journal update per step, then the journal removal. */
const calls = (plan: Plan) => 2 + 2 * plan.steps.length;

describe('runPlan and recover', () => {
  it('leaves the start state or the end state after a crash at any step', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ start, plan }) => {
        const end = await endState(start, plan);
        const initial = new MemFs(start).all();
        for (let k = 0; k <= calls(plan); k++) {
          const fs = new MemFs(start);
          fs.writesLeft = k;
          await runPlan(fs, plan).catch((e) => {
            if (!(e instanceof Crash)) throw e;
          });
          fs.writesLeft = Infinity;
          await recover(fs);
          expect(fs.all()).toEqual(k === 0 ? initial : end);
        }
      }),
      { ...FC, numRuns: 100 },
    );
  });
  it('survives a second crash during recovery', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(20), fc.nat(20), async ({ start, plan }, k1, k2) => {
        const fs = new MemFs(start);
        fs.writesLeft = 1 + (k1 % calls(plan));
        await runPlan(fs, plan).catch(() => undefined);
        fs.writesLeft = k2;
        await recover(fs).catch(() => undefined);
        fs.writesLeft = Infinity;
        await recover(fs);
        expect(fs.all()).toEqual(await endState(start, plan));
      }),
      { ...FC, numRuns: 100 },
    );
  });
  it('deletes the journal when a plan finishes', async () => {
    const fs = new MemFs({ 'a.md': 'x' });
    await runPlan(fs, { id: 'p', label: 'l', steps: [{ op: 'copy', from: 'a.md', to: 'b.md' }, { op: 'remove', path: 'a.md' }] });
    expect(await fs.list('.brain/journal')).toEqual([]);
    expect(fs.all()).toEqual([['b.md', 'x']]);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/plan.test.ts`
Expected: FAIL with `Failed to resolve import "./plan"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/plan.ts`:
```ts
/**
 * Plans, not I/O (spec, Architecture). A rename, move, delete or promote is a
 * list of steps; each host runs it through its own PlanFs. The journal makes a
 * plan finish after a crash: recovery rolls forward from the step that was
 * running, and every step is safe to run twice.
 */

export type Step = { op: 'write'; path: string; text: string } | { op: 'copy'; from: string; to: string } | { op: 'remove'; path: string };
export interface Plan { id: string; label: string; steps: Step[] }

export interface PlanFs {
  readText(path: string): Promise<string | null>;
  /** Atomic per file: after a crash, the old content or the new, never a mix. */
  writeText(path: string, text: string): Promise<void>;
  /** Atomic per file; creates folders. */
  copy(from: string, to: string): Promise<void>;
  /** No error when the file is already gone. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** File paths directly inside `dir`; [] when it does not exist. */
  list(dir: string): Promise<string[]>;
}

export const JOURNAL = '.brain/journal';
interface JournalEntry { plan: Plan; done: number }

export const newPlanId = (): string => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

async function apply(fs: PlanFs, s: Step): Promise<void> {
  if (s.op === 'write') return fs.writeText(s.path, s.text);
  if (s.op === 'remove') return fs.remove(s.path);
  if (await fs.exists(s.from)) return fs.copy(s.from, s.to);
  // The copy ran, then a later step removed its source, before the crash.
  if (!(await fs.exists(s.to))) throw new Error(`cannot finish "${s.from}" -> "${s.to}": both are missing`);
}

async function finish(fs: PlanFs, rec: JournalEntry): Promise<void> {
  const path = `${JOURNAL}/${rec.plan.id}.json`;
  for (let i = rec.done; i < rec.plan.steps.length; i++) {
    await apply(fs, rec.plan.steps[i]);
    await fs.writeText(path, JSON.stringify({ plan: rec.plan, done: i + 1 }));
  }
  await fs.remove(path);
}

export async function runPlan(fs: PlanFs, plan: Plan): Promise<void> {
  await fs.writeText(`${JOURNAL}/${plan.id}.json`, JSON.stringify({ plan, done: 0 }));
  await finish(fs, { plan, done: 0 });
}

/** Finishes every plan a crash interrupted. Hosts call it on start, before anything else touches the vault. */
export async function recover(fs: PlanFs): Promise<string[]> {
  const finished: string[] = [];
  for (const path of await fs.list(JOURNAL)) {
    if (!path.endsWith('.json')) continue;
    let rec: JournalEntry | null = null;
    try {
      rec = JSON.parse((await fs.readText(path)) ?? 'null') as JournalEntry | null;
    } catch {
      rec = null;
    }
    // Journal writes are atomic, so an unreadable file was not written by us; leave it for a person.
    if (!rec?.plan?.steps) continue;
    await finish(fs, rec);
    finished.push(rec.plan.label);
  }
  return finished;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/plan.test.ts`
Expected: PASS (3 tests, the first two with 100 runs each).

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/plan.ts src/shared/brain/plan.test.ts src/shared/brain/testing.ts
git commit -m "Brain core: journaled plans that finish after a crash at any step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Rename, move, delete and heading rename, with a model-based proof that no link breaks

**Files:**
- Create: `src/shared/brain/rename.ts`
- Test: `src/shared/brain/rename.test.ts`

**Interfaces:**
- Consumes:
  - `retarget`, `Link` (Task 14)
  - `safeTitle`, `titleKey`, `titleOf`, `nfc`, `shortHash` (Task 11)
  - `Plan`, `newPlanId` (Task 18)
  - `MemFs` (Task 18)
  - `buildEntry`, `targetsOf` (Task 15)
- Produces:
  - `interface NoteText { path: string; text: string }`
  - `type Planned = { ok: true; plan: Plan; rewritten: string[] } | { ok: false; error: string }`
  - `STARRED = '.brain/starred.json'`
  - `planRename(a: { note: NoteText; newTitle: string; linkers: NoteText[]; titles: Map<string, string>; starred: string | null }): Planned`
  - `planMove(a: { note: NoteText; folder: string; paths: Set<string> }): Planned`. `paths` holds the `titleKey` of every existing path.
  - `planDelete(a: { note: NoteText; date: string; taken: Set<string> }): Planned`. `taken` holds the `titleKey` of every path in that day's trash folder.
  - `planHeadingRename(a: { note: NoteText; oldHeading: string; newHeading: string; linkers: NoteText[] }): Planned`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/rename.test.ts`:
```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildEntry, targetsOf } from './entry';
import { resolve } from './links';
import { nfc, titleKey } from './names';
import { runPlan } from './plan';
import { planDelete, planHeadingRename, planMove, planRename, STARRED, type NoteText, type Planned } from './rename';
import { FC, MemFs } from './testing';

const SIG: NoteText = { path: 'Concepts/Sigmoid.md', text: '---\naliases: [Logistic function]\n---\n# Sigmoid\n\nSelf [[Sigmoid#Uses]].\n\n## Uses\n' };
const LEC: NoteText = { path: 'School/Lecture 3.md', text: "---\nsources: ['[[Sigmoid]]']\n---\n# Lecture 3\r\n\r\n[[Sigmoid]] [[sigmoid|s]] ![[Sigmoid#Uses]] [[Logistic function]] `[[Sigmoid]]`\r\n" };
const titles = new Map([
  [titleKey('Sigmoid'), SIG.path],
  [titleKey('Logistic function'), SIG.path],
  [titleKey('Lecture 3'), LEC.path],
]);

async function apply(files: NoteText[], p: Planned) {
  if (!p.ok) throw new Error(p.error);
  const fs = new MemFs(Object.fromEntries(files.map((f) => [f.path, f.text])));
  await runPlan(fs, p.plan);
  return fs;
}

describe('planRename', () => {
  it('moves the file and rewrites body, embed and property links, keeping CRLF, aliases and code', async () => {
    const p = planRename({ note: SIG, newTitle: 'Logistic sigmoid', linkers: [LEC], titles, starred: '["Sigmoid","Other"]' });
    const fs = await apply([SIG, LEC, { path: STARRED, text: '["Sigmoid","Other"]' }], p);
    expect(fs.all().map(([n]) => n)).toEqual([STARRED, 'Concepts/Logistic sigmoid.md', LEC.path]);
    expect(await fs.readText(LEC.path)).toBe(
      '---\nsources: ["[[Logistic sigmoid]]"]\n---\n# Lecture 3\r\n\r\n[[Logistic sigmoid]] [[Logistic sigmoid|s]] ![[Logistic sigmoid#Uses]] [[Logistic function]] `[[Sigmoid]]`\r\n',
    );
    expect(await fs.readText('Concepts/Logistic sigmoid.md')).toContain('Self [[Logistic sigmoid#Uses]]');
    expect(await fs.readText(STARRED)).toBe('["Logistic sigmoid","Other"]');
    expect(p.ok && p.rewritten).toEqual([LEC.path]);
  });
  it('renames through a temporary name when only the case changes', async () => {
    const fs = await apply([SIG, LEC], planRename({ note: SIG, newTitle: 'SIGMOID', linkers: [LEC], titles, starred: null }));
    expect(fs.all().map(([n]) => n)).toEqual(['Concepts/SIGMOID.md', LEC.path]);
  });
  it('refuses a title or alias already in use, an unsafe title and no change', () => {
    expect(planRename({ note: LEC, newTitle: 'logistic FUNCTION', linkers: [], titles, starred: null })).toEqual({ ok: false, error: '"logistic FUNCTION" is already used by Concepts/Sigmoid.md' });
    expect(planRename({ note: SIG, newTitle: 'A/B', linkers: [], titles, starred: null })).toMatchObject({ ok: false, error: expect.stringContaining('try "A-B"') });
    expect(planRename({ note: SIG, newTitle: 'Sigmoid', linkers: [], titles, starred: null })).toMatchObject({ ok: false });
  });
});

describe('planMove and planDelete', () => {
  it('copies then removes, leaving links alone', async () => {
    const fs = await apply([SIG], planMove({ note: SIG, folder: 'Inbox', paths: new Set([titleKey(SIG.path)]) }));
    expect(fs.all()).toEqual([['Inbox/Sigmoid.md', SIG.text]]);
  });
  it('refuses a clash, the same folder and folders the vault reserves', () => {
    expect(planMove({ note: SIG, folder: 'Inbox', paths: new Set([titleKey('inbox/sigmoid.md')]) })).toMatchObject({ ok: false });
    expect(planMove({ note: SIG, folder: 'Concepts', paths: new Set() })).toMatchObject({ ok: false });
    for (const f of ['.brain', 'sources/notion', 'attachments', '../up']) expect(planMove({ note: SIG, folder: f, paths: new Set() })).toMatchObject({ ok: false });
  });
  it('moves a deleted note into the day\'s trash, numbering a clash', async () => {
    const p = planDelete({ note: SIG, date: '2026-10-14', taken: new Set([titleKey('.brain/trash/2026-10-14/Sigmoid.md')]) });
    const fs = await apply([SIG], p);
    expect(fs.all()).toEqual([['.brain/trash/2026-10-14/Sigmoid 2.md', SIG.text]]);
  });
});

describe('planHeadingRename', () => {
  it('rewrites links to that heading in other notes and in the note itself, and nothing else', async () => {
    const other: NoteText = { path: 'Other.md', text: '[[Sigmoid#uses]] [[Sigmoid#Definition]] [[Lecture 3#Uses]]\n' };
    const self = { ...SIG, text: SIG.text.replace('## Uses', '## Applications').replace('[[Sigmoid#Uses]]', '[[Sigmoid#Uses]] [[#Uses]]') };
    const fs = await apply([self, other], planHeadingRename({ note: self, oldHeading: 'Uses', newHeading: 'Applications', linkers: [other] }));
    expect(await fs.readText('Other.md')).toBe('[[Sigmoid#Applications]] [[Sigmoid#Definition]] [[Lecture 3#Uses]]\n');
    expect(await fs.readText(SIG.path)).toContain('[[Sigmoid#Applications]] [[#Applications]]');
  });
});

// Model-based proof (spec, Testing: Property). Notes have stable ids in the model; after any sequence of
// create, rename, move, delete and edit, every link resolves to the note the model says it should.
const TITLES = ['Sigmoid', 'sigmoid', 'Caf\u00e9', 'Cafe\u0301 notes', 'DL Class \u2013 Lecture 3', 'R\u00e9sum\u00e9', 'Notes (draft)', 'Graph theory', 'Lecture 3', 'Aa'];
const FOLDERS = ['', 'Concepts', 'School/DL Class', 'Inbox'];
interface MNote { title: string; folder: string; links: number[] }
interface Model { notes: Map<number, MNote>; dead: Map<number, string>; next: number }
const pathOf = (n: MNote) => `${n.folder ? n.folder + '/' : ''}${nfc(n.title)}.md`;
const aliveByTitle = (m: Model, title: string) => [...m.notes].find(([, n]) => titleKey(n.title) === titleKey(title))?.[0] ?? null;
const expected = (m: Model, id: number) => (m.notes.has(id) ? id : aliveByTitle(m, m.dead.get(id)!));
const alive = (m: Model) => [...m.notes.keys()];
const notesOf = (fs: MemFs) => fs.all().filter(([p]) => !p.startsWith('.brain/') && p.endsWith('.md'));

async function invariant(m: Model, fs: MemFs) {
  const entries = notesOf(fs).map(([p, t]) => buildEntry(p, t));
  const t = targetsOf(entries, []);
  const idAt = new Map([...m.notes].map(([id, n]) => [titleKey(pathOf(n)), id]));
  expect(entries).toHaveLength(m.notes.size);
  for (const [, n] of m.notes) {
    const e = entries.find((x) => titleKey(x.path) === titleKey(pathOf(n)));
    expect(e, `${pathOf(n)} exists`).toBeDefined();
    const got = e!.links.map((l) => {
      const p = resolve(l, e!.path, t);
      return p ? (idAt.get(titleKey(p)) ?? -1) : null;
    });
    expect(got.map(String).sort()).toEqual(n.links.map((id) => expected(m, id)).map(String).sort());
  }
}

const linkLine = (m: Model, id: number) => `[[${m.notes.get(id)!.title}]]`;
const textOf = (fsText: string | null) => fsText ?? '';
const all = (fs: MemFs): NoteText[] => notesOf(fs).map(([path, text]) => ({ path, text }));
const titleMap = (fs: MemFs) => targetsOf(notesOf(fs).map(([p, t]) => buildEntry(p, t)), []).notes;

class Create implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly ti: number, readonly fi: number, readonly picks: number[]) {}
  check = (m: Readonly<Model>) => aliveByTitle(m as Model, TITLES[this.ti]) === null;
  async run(m: Model, fs: MemFs) {
    const ids = alive(m);
    const links = ids.length ? this.picks.map((k) => ids[k % ids.length]) : [];
    const n: MNote = { title: nfc(TITLES[this.ti]), folder: FOLDERS[this.fi], links };
    await fs.writeText(pathOf(n), `# ${n.title}\n\n${links.map((id) => linkLine(m, id)).join('\n')}\n`);
    m.notes.set(m.next++, n);
    await invariant(m, fs);
  }
  toString = () => `create(${TITLES[this.ti]} in ${FOLDERS[this.fi]})`;
}
class Rename implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly ti: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const id = alive(m)[this.pick % m.notes.size];
    const n = m.notes.get(id)!;
    const to = nfc(TITLES[this.ti]);
    const p = planRename({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, newTitle: to, linkers: all(fs), titles: titleMap(fs), starred: null });
    const clash = aliveByTitle(m, to);
    if ((clash !== null && clash !== id) || to === n.title) {
      expect(p.ok).toBe(false);
      return;
    }
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    // Links that resolved to this note by its old title (including revived dangling ones) now follow it.
    for (const other of m.notes.values()) other.links = other.links.map((x) => (expected(m, x) === id ? id : x));
    n.title = to;
    await invariant(m, fs);
  }
  toString = () => `rename(#${this.pick} -> ${TITLES[this.ti]})`;
}
class Move implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly fi: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const n = m.notes.get(alive(m)[this.pick % m.notes.size])!;
    const p = planMove({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, folder: FOLDERS[this.fi], paths: new Set(notesOf(fs).map(([x]) => titleKey(x))) });
    if (FOLDERS[this.fi] === n.folder) {
      expect(p.ok).toBe(false);
      return;
    }
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    n.folder = FOLDERS[this.fi];
    await invariant(m, fs);
  }
  toString = () => `move(#${this.pick} -> ${FOLDERS[this.fi]})`;
}
class Delete implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const id = alive(m)[this.pick % m.notes.size];
    const n = m.notes.get(id)!;
    const taken = new Set((await fs.list('.brain/trash/2026-10-14')).map(titleKey));
    const p = planDelete({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, date: '2026-10-14', taken });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    m.dead.set(id, n.title);
    m.notes.delete(id);
    await invariant(m, fs);
  }
  toString = () => `delete(#${this.pick})`;
}
class Edit implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly target: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 1;
  async run(m: Model, fs: MemFs) {
    const ids = alive(m);
    const id = ids[this.pick % ids.length];
    const to = ids[(this.pick + 1 + (this.target % (ids.length - 1))) % ids.length];
    const n = m.notes.get(id)!;
    await fs.writeText(pathOf(n), textOf(await fs.readText(pathOf(n))) + `${linkLine(m, to)}\n`);
    n.links.push(to);
    await invariant(m, fs);
  }
  toString = () => `edit(#${this.pick} links #${this.target})`;
}

describe('model: no rename, move or delete ever breaks a link it should keep', () => {
  it('holds for any sequence of operations', async () => {
    const cmds = [
      fc.tuple(fc.nat(TITLES.length - 1), fc.nat(FOLDERS.length - 1), fc.array(fc.nat(9), { maxLength: 3 })).map(([t, f, p]) => new Create(t, f, p)),
      fc.tuple(fc.nat(9), fc.nat(TITLES.length - 1)).map(([p, t]) => new Rename(p, t)),
      fc.tuple(fc.nat(9), fc.nat(FOLDERS.length - 1)).map(([p, f]) => new Move(p, f)),
      fc.nat(9).map((p) => new Delete(p)),
      fc.tuple(fc.nat(9), fc.nat(9)).map(([p, t]) => new Edit(p, t)),
    ];
    await fc.assert(
      fc.asyncProperty(fc.commands(cmds, { maxCommands: 25 }), (c) => fc.asyncModelRun(() => ({ model: { notes: new Map(), dead: new Map(), next: 0 }, real: new MemFs() }), c)),
      FC,
    );
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/rename.test.ts`
Expected: FAIL with `Failed to resolve import "./rename"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/rename.ts`:
```ts
import { retarget, type Link } from './links';
import { nfc, safeTitle, shortHash, titleKey, titleOf } from './names';
import { newPlanId, type Plan, type Step } from './plan';

/**
 * Plans for rename, move, delete and heading rename (spec, Brain page 12, 13).
 * Links are title-only, so a move changes no link; a rename rewrites every
 * link to the old title, in bodies, embeds, properties and the starred list.
 */

export interface NoteText { path: string; text: string }
export type Planned = { ok: true; plan: Plan; rewritten: string[] } | { ok: false; error: string };
export const STARRED = '.brain/starred.json';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const linkTitle = (l: Link) => nameOf(l.target).replace(/\.md$/i, '');
const fail = (error: string): Planned => ({ ok: false, error });

function renameStarred(json: string, from: string, to: string): string {
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return json;
    return JSON.stringify(list.map((t) => (typeof t === 'string' && titleKey(t) === titleKey(from) ? to : t)));
  } catch {
    return json;
  }
}

export function planRename(a: { note: NoteText; newTitle: string; linkers: NoteText[]; titles: Map<string, string>; starred: string | null }): Planned {
  const oldTitle = titleOf(a.note.path);
  const wanted = nfc(a.newTitle).trim();
  const folder = dirOf(a.note.path);
  const safe = safeTitle(wanted, folder).title;
  if (safe !== wanted) return fail(`"${wanted}" cannot be a file name; try "${safe}"`);
  if (wanted === oldTitle) return fail('the title is unchanged');
  const owner = a.titles.get(titleKey(wanted));
  if (owner && owner !== a.note.path) return fail(`"${wanted}" is already used by ${owner}`);

  const newPath = join(folder, `${wanted}.md`);
  const isOld = (l: Link) => l.target !== '' && titleKey(linkTitle(l)) === titleKey(oldTitle);
  const rewrite = (text: string) => retarget(text, isOld, () => ({ target: wanted }));
  const own = rewrite(a.note.text);
  const caseOnly = titleKey(wanted) === titleKey(oldTitle);
  const steps: Step[] = [];
  if (caseOnly) {
    // On a case-insensitive disk, writing "SIGMOID.md" would overwrite "Sigmoid.md" and keep the old name.
    const tmp = join(folder, `.rename-${shortHash(a.note.path + wanted)}.md`);
    steps.push({ op: 'write', path: tmp, text: own }, { op: 'remove', path: a.note.path }, { op: 'write', path: newPath, text: own }, { op: 'remove', path: tmp });
  } else steps.push({ op: 'write', path: newPath, text: own });

  const rewritten: string[] = [];
  for (const l of a.linkers) {
    if (titleKey(l.path) === titleKey(a.note.path)) continue;
    const t = rewrite(l.text);
    if (t !== l.text) {
      steps.push({ op: 'write', path: l.path, text: t });
      rewritten.push(l.path);
    }
  }
  if (a.starred !== null) {
    const s = renameStarred(a.starred, oldTitle, wanted);
    if (s !== a.starred) steps.push({ op: 'write', path: STARRED, text: s });
  }
  if (!caseOnly) steps.push({ op: 'remove', path: a.note.path });
  return { ok: true, plan: { id: newPlanId(), label: `rename "${oldTitle}" to "${wanted}"`, steps }, rewritten };
}

export function planMove(a: { note: NoteText; folder: string; paths: Set<string> }): Planned {
  const folder = a.folder.replace(/^\/+|\/+$/g, '');
  const parts = folder ? folder.split('/') : [];
  if (parts.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.')) || /^(sources|attachments)$/i.test(parts[0] ?? '')) {
    return fail(`"${a.folder}" is not a folder notes can live in`);
  }
  const to = join(folder, nameOf(a.note.path));
  if (titleKey(to) === titleKey(a.note.path)) return fail(`it is already in ${folder || 'the top folder'}`);
  if (a.paths.has(titleKey(to))) return fail(`${to} already exists`);
  return {
    ok: true,
    plan: { id: newPlanId(), label: `move "${titleOf(a.note.path)}" to ${folder || 'the top folder'}`, steps: [{ op: 'copy', from: a.note.path, to }, { op: 'remove', path: a.note.path }] },
    rewritten: [],
  };
}

export function planDelete(a: { note: NoteText; date: string; taken: Set<string> }): Planned {
  const dir = `.brain/trash/${a.date}`;
  const base = nameOf(a.note.path).replace(/\.md$/i, '');
  let to = `${dir}/${base}.md`;
  for (let n = 2; a.taken.has(titleKey(to)); n++) to = `${dir}/${base} ${n}.md`;
  return {
    ok: true,
    plan: { id: newPlanId(), label: `delete "${titleOf(a.note.path)}"`, steps: [{ op: 'copy', from: a.note.path, to }, { op: 'remove', path: a.note.path }] },
    rewritten: [],
  };
}

export function planHeadingRename(a: { note: NoteText; oldHeading: string; newHeading: string; linkers: NoteText[] }): Planned {
  const title = titleOf(a.note.path);
  const sameHeading = (l: Link) => l.heading !== null && titleKey(l.heading) === titleKey(a.oldHeading);
  const toNote = (l: Link) => l.target !== '' && titleKey(linkTitle(l)) === titleKey(title);
  const change = () => ({ heading: a.newHeading.trim() });
  const steps: Step[] = [];
  const rewritten: string[] = [];
  const own = retarget(a.note.text, (l) => sameHeading(l) && (l.target === '' || toNote(l)), change);
  if (own !== a.note.text) steps.push({ op: 'write', path: a.note.path, text: own });
  for (const l of a.linkers) {
    if (titleKey(l.path) === titleKey(a.note.path)) continue;
    const t = retarget(l.text, (x) => sameHeading(x) && toNote(x), change);
    if (t !== l.text) {
      steps.push({ op: 'write', path: l.path, text: t });
      rewritten.push(l.path);
    }
  }
  return { ok: true, plan: { id: newPlanId(), label: `rename heading "${a.oldHeading}" in "${title}"`, steps }, rewritten };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/rename.test.ts`
Expected: PASS: 7 unit tests and the model-based property, 200 runs of up to 25 commands each.

On a model failure, fast-check prints the shortest command sequence that breaks it. Reproduce that sequence in a unit test, then fix `rename.ts` or `links.ts`. Never weaken the invariant.

- [ ] **Step 5: Commit**

Run `npm run typecheck`, `npm test` and `/verify` first.
```bash
git add src/shared/brain/rename.ts src/shared/brain/rename.test.ts
git commit -m "Brain core: rename, move, delete and heading rename as plans, with a model-based proof that links survive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Unlinked mentions

**Files:**
- Create: `src/shared/brain/mentions.ts`
- Test: `src/shared/brain/mentions.test.ts`

**Interfaces:**
- Consumes: `IndexEntry` (Task 15); `overlaps` (Task 14); `nfc` (Task 11).
- Produces:
  - `interface Mention { path: string; from: number; to: number; text: string }`. Offsets are into the whole file text.
  - `unlinkedMentions(target: { path: string; title: string; aliases: string[] }, entries: IndexEntry[]): Mention[]`
  - `linkMention(text: string, m: Mention, title: string): string`

What counts as a mention:
- The note's title or one of its aliases, at least 3 characters long.
- Matched ignoring case, as a whole word.
- Never inside code, a link, frontmatter, or the note itself.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/brain/mentions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildEntry } from './entry';
import { linkMention, unlinkedMentions } from './mentions';

const TARGET = { path: 'Concepts/Sigmoid.md', title: 'Sigmoid', aliases: ['Logistic function', 'σ'] };
const TEXT = '---\nnote: sigmoid in frontmatter\n---\nThe sigmoid works. Sigmoidal is another word. [[Sigmoid]] is linked, `sigmoid` is code, and the logistic Function too.\n';

describe('unlinkedMentions', () => {
  const e = buildEntry('Lecture.md', TEXT);
  const ms = unlinkedMentions(TARGET, [e, buildEntry(TARGET.path, 'Sigmoid itself mentions sigmoid.')]);
  it('finds the title and aliases as whole words, ignoring case', () => {
    expect(ms.map((m) => m.text)).toEqual(['sigmoid', 'logistic Function']);
  });
  it('gives offsets into the whole file, frontmatter included', () => {
    expect(ms.every((m) => TEXT.slice(m.from, m.to) === m.text)).toBe(true);
  });
  it('turns a mention into a link, keeping its wording', () => {
    const [first, second] = ms;
    expect(linkMention(TEXT, first, 'Sigmoid')).toContain('The [[Sigmoid|sigmoid]] works.');
    expect(linkMention(TEXT, second, 'Sigmoid')).toContain('the [[Sigmoid|logistic Function]] too.');
    expect(linkMention('Sigmoid here', { path: 'x', from: 0, to: 7, text: 'Sigmoid' }, 'Sigmoid')).toBe('[[Sigmoid]] here');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/shared/brain/mentions.test.ts`
Expected: FAIL with `Failed to resolve import "./mentions"`.

- [ ] **Step 3: Implement**

Create `src/shared/brain/mentions.ts`:
```ts
import type { IndexEntry } from './entry';
import { overlaps } from './links';
import { nfc } from './names';

/** Places a note is named but not linked (spec, Brain page 4). Offsets are into the whole file. */
export interface Mention { path: string; from: number; to: number; text: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

export function unlinkedMentions(target: { path: string; title: string; aliases: string[] }, entries: IndexEntry[]): Mention[] {
  // Longest first, so "Logistic function" wins over a shorter alias inside it.
  const names = [target.title, ...target.aliases].map(nfc).filter((n) => [...n.trim()].length >= 3).sort((a, b) => b.length - a.length);
  const out: Mention[] = [];
  for (const e of entries) {
    if (e.path === target.path) continue;
    const blocked: [number, number][] = [...e.code, ...e.links.filter((l) => l.from >= 0).map((l): [number, number] => [l.from, l.to])];
    const taken: [number, number][] = [];
    for (const name of names) {
      for (const m of e.body.matchAll(new RegExp(escape(name), 'giu'))) {
        const from = m.index;
        const to = from + m[0].length;
        if (wordChar(e.body[from - 1]) || wordChar(e.body[to]) || overlaps(blocked, from, to) || overlaps(taken, from, to)) continue;
        taken.push([from, to]);
        out.push({ path: e.path, from: e.bodyStart + from, to: e.bodyStart + to, text: m[0] });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from);
}

export function linkMention(text: string, m: Mention, title: string): string {
  return text.slice(0, m.from) + `[[${m.text === title ? title : `${title}|${m.text}`}]]` + text.slice(m.to);
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/shared/brain/mentions.test.ts && npm test`
Expected: PASS (3 tests), and the whole suite green.

- [ ] **Step 5: Commit**

Run `npm run typecheck` and `/verify` first.
```bash
git add src/shared/brain/mentions.ts src/shared/brain/mentions.test.ts
git commit -m "Brain core: unlinked mentions and the one-click link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part D: step 3, the vault MCP server

### Task 21: The disk layer: atomic writes and path guards

**Files:**
- Create:
  - `mcp/brain/guards.ts`
  - `mcp/brain/nodeFs.ts`
- Test: `mcp/brain/nodeFs.test.ts`

**Interfaces:**
- Consumes: `PlanFs` (Task 18).
- Produces:
  - In `guards.ts`:
    - `serverMayWrite(rel: string, promoting?: boolean): boolean`
    - `indexSkips(dir: string): boolean`
  - In `nodeFs.ts`:
    - `class GuardError`
    - `interface FileStat { path: string; mtimeMs: number; size: number }`
    - `interface VaultFs extends PlanFs { root; stat; readBytes; writeBytes; append; removeDir; listDirs; walk(start?, skip?): Promise<FileStat[]>; sweepTmp(): Promise<number> }`
    - `nodeFs(root: string, canWrite: (rel: string) => boolean): VaultFs`

Rules:
- Paths are vault-relative and use `/`.
- **Writes:** go to `.<name>.brain-tmp-<uuid>`, which is fsynced and then renamed into place. `sweepTmp` removes any of these left behind by a crash.
- **Refused:** `..`, absolute paths, `\`, NUL bytes, and any path with a symlink on the way.
- **`readText`:** returns null for a missing file and throws for text that is not UTF-8.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/nodeFs.test.ts`:
```ts
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSkips, serverMayWrite } from './guards';
import { GuardError, nodeFs, type VaultFs } from './nodeFs';

let root = '';
let outside = '';
let fs: VaultFs;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-fs-'));
  outside = await mkdtemp(join(tmpdir(), 'brain-out-'));
  fs = nodeFs(root, (rel) => serverMayWrite(rel));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('serverMayWrite', () => {
  it('allows notes and the server\'s own .brain folders, and nothing else', () => {
    for (const ok of ['Inbox/a.md', '.brain/staging/x/a.md', '.brain/journal/p.json', '.brain/history/2026-10-14/a.md', '.brain/trash/2026-10-14/a.md', '.brain/import/bookmarks.json', '.brain/mcp-log.jsonl', '.brain/starred.json']) {
      expect(serverMayWrite(ok), ok).toBe(true);
    }
    for (const no of ['sources/notion/a.md', 'Sources/a.md', '.brain/reports/x.md', '.BRAIN/Reports/x.md', '.brain/types.json', '.obsidian/app.json']) {
      expect(serverMayWrite(no), no).toBe(false);
    }
    expect(serverMayWrite('sources/notion/a.md', true)).toBe(true);
  });
  it('skips hidden folders, sources and attachments when indexing', () => {
    expect(['.brain', 'a/.trash', 'sources/notion', 'attachments'].every(indexSkips)).toBe(true);
    expect(indexSkips('School/DL Class')).toBe(false);
  });
});

describe('nodeFs', () => {
  it('writes atomically and leaves no temporary file', async () => {
    await fs.writeText('Inbox/a.md', 'hello');
    expect(await fs.readText('Inbox/a.md')).toBe('hello');
    expect(await readdir(join(root, 'Inbox'))).toEqual(['a.md']);
  });
  it('refuses paths that leave the vault', async () => {
    for (const bad of ['../x.md', '/etc/passwd', 'a\\b.md', 'a/./b.md', 'a\0b']) await expect(fs.writeText(bad, 'x')).rejects.toBeInstanceOf(GuardError);
    await symlink(outside, join(root, 'link'));
    await expect(fs.writeText('link/x.md', 'x')).rejects.toBeInstanceOf(GuardError);
    await expect(fs.readText('link/x.md')).rejects.toBeInstanceOf(GuardError);
  });
  it('refuses guarded writes, case-insensitively', async () => {
    await expect(fs.writeText('Sources/notion/a.md', 'x')).rejects.toThrow(/not allowed/);
    await expect(fs.remove('.brain/reports/x.md')).rejects.toThrow(/not allowed/);
  });
  it('copies bytes exactly and reads missing files as null', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    await fs.writeBytes('attachments/x.bin', bytes);
    await fs.copy('attachments/x.bin', 'Inbox/y.bin');
    expect(await fs.readBytes('Inbox/y.bin')).toEqual(bytes);
    expect(await fs.readText('nope.md')).toBeNull();
    expect(await fs.stat('nope.md')).toBeNull();
  });
  it('throws on text that is not UTF-8', async () => {
    await writeFile(join(root, 'bad.md'), new Uint8Array([0xc3, 0x28]));
    await expect(fs.readText('bad.md')).rejects.toThrow();
  });
  it('walks files, skipping junk, symlinks and skipped folders, keeping names as the disk has them', async () => {
    await mkdir(join(root, 'Concepts'), { recursive: true });
    await writeFile(join(root, 'Concepts', 'Café.md'), '# Café');
    await writeFile(join(root, '.DS_Store'), '');
    await mkdir(join(root, '.brain'), { recursive: true });
    await writeFile(join(root, '.brain', 'x.md'), '');
    await symlink(outside, join(root, 'link'));
    expect((await fs.walk('', indexSkips)).map((f) => f.path)).toEqual(['Concepts/Café.md']);
  });
  it('sweeps temporary files a crash left behind', async () => {
    await mkdir(join(root, 'Inbox'), { recursive: true });
    await writeFile(join(root, 'Inbox', '.a.md.brain-tmp-0b3f5c1e-2f4a-4d7e-9a51-6c1d2e3f4a5b'), 'half');
    expect(await fs.sweepTmp()).toBe(1);
    expect(await readdir(join(root, 'Inbox'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/nodeFs.test.ts`
Expected: FAIL with `Failed to resolve import "./guards"`.

- [ ] **Step 3: Implement**

Create `mcp/brain/guards.ts`:
```ts
/**
 * What the MCP server may write (spec, Vault MCP server: Guards). Compared
 * ignoring case and Unicode form: macOS and Windows treat "Sources/" and
 * "sources/" as one folder.
 */
const BRAIN_DIRS = ['.brain/staging/', '.brain/journal/', '.brain/history/', '.brain/trash/', '.brain/import/'];
const BRAIN_FILES = ['.brain/mcp-log.jsonl', '.brain/starred.json'];

export function serverMayWrite(rel: string, promoting = false): boolean {
  const r = rel.normalize('NFC').toLowerCase();
  if (r === '.obsidian' || r.startsWith('.obsidian/')) return false;
  if (r.startsWith('sources/')) return promoting;
  if (r.startsWith('.brain/')) return BRAIN_DIRS.some((d) => r.startsWith(d)) || BRAIN_FILES.includes(r);
  return true;
}

/** Folders the index never reads (spec, File conventions): hidden ones, sources/ and attachments/. */
export function indexSkips(dir: string): boolean {
  const parts = dir.split('/');
  return parts.some((p) => p.startsWith('.')) || /^(sources|attachments)$/i.test(parts[0]);
}
```

Create `mcp/brain/nodeFs.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { PlanFs } from '../../src/shared/brain/plan';

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export interface FileStat { path: string; mtimeMs: number; size: number }
export interface VaultFs extends PlanFs {
  readonly root: string;
  stat(rel: string): Promise<{ mtimeMs: number; size: number } | null>;
  readBytes(rel: string): Promise<Uint8Array | null>;
  writeBytes(rel: string, data: Uint8Array): Promise<void>;
  append(rel: string, text: string): Promise<void>;
  removeDir(rel: string): Promise<void>;
  listDirs(rel: string): Promise<string[]>;
  walk(start?: string, skip?: (dir: string) => boolean): Promise<FileStat[]>;
  sweepTmp(): Promise<number>;
}

const TMP = /\.brain-tmp-[0-9a-f-]{36}$/;
const JUNK = new Set(['.DS_Store', 'desktop.ini']);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The vault on disk, for the MCP server and the CLI. Paths are vault-relative with "/". */
export function nodeFs(root: string, canWrite: (rel: string) => boolean): VaultFs {
  const base = path.resolve(root);
  const abs = (rel: string): string => {
    if (rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel)) throw new GuardError(`not a vault path: ${rel}`);
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.')) throw new GuardError(`not a vault path: ${rel}`);
    return path.join(base, ...parts);
  };
  // A symlink anywhere on the way could lead out of the vault.
  const noLinks = async (rel: string) => {
    let cur = base;
    for (const p of rel.split('/').filter(Boolean)) {
      cur = path.join(cur, p);
      const st = await fsp.lstat(cur).catch((e: unknown) => {
        if (missing(e)) return null;
        throw e;
      });
      if (!st) return;
      if (st.isSymbolicLink()) throw new GuardError(`a symlink is in the way: ${rel}`);
    }
  };
  const readable = async (rel: string) => {
    const full = abs(rel);
    await noLinks(rel);
    return full;
  };
  const writable = async (rel: string) => {
    const full = abs(rel);
    if (!canWrite(rel)) throw new GuardError(`writes to ${rel} are not allowed`);
    await noLinks(rel);
    return full;
  };
  const atomic = async (rel: string, data: string | Uint8Array) => {
    const full = await writable(rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.brain-tmp-${randomUUID()}`);
    const fh = await fsp.open(tmp, 'wx');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, full);
  };
  const stat = async (rel: string) => {
    try {
      const s = await fsp.stat(await readable(rel));
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  };
  const walk = async (start = '', skip: (dir: string) => boolean = () => false): Promise<FileStat[]> => {
    const out: FileStat[] = [];
    const visit = async (rel: string) => {
      let items;
      try {
        items = await fsp.readdir(abs(rel), { withFileTypes: true });
      } catch (e) {
        if (missing(e)) return;
        throw e;
      }
      for (const d of items) {
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink() || JUNK.has(d.name)) continue;
        if (d.isDirectory()) {
          if (!skip(child)) await visit(child);
        } else if (d.isFile()) {
          const s = await fsp.stat(abs(child));
          out.push({ path: child, mtimeMs: s.mtimeMs, size: s.size });
        }
      }
    };
    await visit(start);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };
  const entries = async (dir: string) => {
    try {
      return await fsp.readdir(abs(dir), { withFileTypes: true });
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  };
  return {
    root: base,
    async readText(rel) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(await fsp.readFile(await readable(rel)));
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async readBytes(rel) {
      try {
        return new Uint8Array(await fsp.readFile(await readable(rel)));
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    writeText: (rel, text) => atomic(rel, text),
    writeBytes: (rel, data) => atomic(rel, data),
    async copy(from, to) {
      await atomic(to, await fsp.readFile(await readable(from)));
    },
    async remove(rel) {
      await fsp.rm(await writable(rel), { force: true });
    },
    async removeDir(rel) {
      await fsp.rm(await writable(rel), { recursive: true, force: true });
    },
    exists: async (rel) => (await stat(rel)) !== null,
    stat,
    async list(dir) {
      return (await entries(dir)).filter((d) => d.isFile() && !JUNK.has(d.name)).map((d) => (dir ? `${dir}/${d.name}` : d.name));
    },
    async listDirs(dir) {
      return (await entries(dir)).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    },
    async append(rel, text) {
      const full = await writable(rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.appendFile(full, text);
    },
    walk,
    async sweepTmp() {
      let n = 0;
      for (const f of await walk()) {
        if (!TMP.test(f.path)) continue;
        await fsp.rm(abs(f.path), { force: true });
        n++;
      }
      return n;
    },
  };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/nodeFs.test.ts && npm run typecheck`
Expected: PASS (9 tests), clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/guards.ts mcp/brain/nodeFs.ts mcp/brain/nodeFs.test.ts
git commit -m "Vault MCP: atomic writes, and guards against leaving the vault or touching what the server must not

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: The vault index, staleness, history and log

**Files:**
- Create: `mcp/brain/vault.ts`
- Test: `mcp/brain/vault.test.ts`

**Interfaces:**
- Consumes:
  - `nodeFs`, `VaultFs`, `serverMayWrite`, `indexSkips` (Task 21)
  - `buildEntry`, `targetsOf`, `backlinks`, `duplicateTitles` (Task 15)
  - `runPlan`, `recover` (Task 18)
  - `ymd` (Task 11)
- Produces `class Vault` with:
  - `static open(root, { now?, maintain? }): Promise<Vault>`
  - `entries: Map<path, IndexEntry>`, `fs: VaultFs`, `now: () => Date`
  - `refresh()`, `targets(): Targets`, `find(titleOrPath): IndexEntry | null`
  - `backlinksOf(path)`, `duplicates()`
  - `serial(fn)`, `markRead(path)`, `assertFresh(path)`
  - `snapshot(paths)`, `sweepHistory(days?)`
  - `execute(plan, { promoting? })`, `log(tool, detail)`, `stagingDigest(area): Promise<string>`
  - `class StaleError`

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/vault.test.ts`:
```ts
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeVault } from './testServer';
import { StaleError, Vault } from './vault';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const now = () => new Date(2026, 9, 14, 9, 30);

describe('Vault', () => {
  it('indexes notes and skips hidden folders, sources, attachments and non-UTF-8 files', async () => {
    root = await writeVault({
      'Concepts/Sigmoid.md': '---\naliases: [Logistic function]\n---\n# Sigmoid\n',
      'Concepts/Café.md': '# Café\n',
      '.brain/x.md': '',
      'sources/notion/Page (1).md': '',
      '.obsidian/workspace.md': '',
      'attachments/sigmoid.png': new Uint8Array([1, 2]),
      'bad.md': new Uint8Array([0xc3, 0x28]),
    });
    const v = await Vault.open(root, { now });
    expect([...v.entries.keys()].sort()).toEqual(['Concepts/Café.md', 'Concepts/Sigmoid.md']);
    expect(v.find('logistic function')?.path).toBe('Concepts/Sigmoid.md');
    expect(v.find('Café')?.path).toBe('Concepts/Café.md');
    expect(v.find('Concepts/Sigmoid.md')?.title).toBe('Sigmoid');
    expect(v.targets().files.get('sigmoid.png')).toBe('attachments/sigmoid.png');
  });
  it('picks up changes made outside, and deletions', async () => {
    root = await writeVault({ 'a.md': '# A\n', 'b.md': '# B\n[[A]]\n' });
    const v = await Vault.open(root, { now });
    expect(v.backlinksOf('a.md').map((x) => x.from)).toEqual(['b.md']);
    await writeFile(join(root, 'b.md'), '# B\n');
    await utimes(join(root, 'b.md'), new Date(), new Date(Date.now() + 5_000));
    await rm(join(root, 'a.md'));
    await v.refresh();
    expect([...v.entries.keys()]).toEqual(['b.md']);
    expect(v.entries.get('b.md')!.links).toEqual([]);
  });
  it('refuses an edit before a read, and after the file changed on disk', async () => {
    root = await writeVault({ 'a.md': '# A\n' });
    const v = await Vault.open(root, { now });
    expect(() => v.assertFresh('a.md')).toThrow(StaleError);
    v.markRead('a.md');
    expect(() => v.assertFresh('a.md')).not.toThrow();
    await writeFile(join(root, 'a.md'), '# A changed\n');
    await utimes(join(root, 'a.md'), new Date(), new Date(Date.now() + 5_000));
    await v.refresh();
    expect(() => v.assertFresh('a.md')).toThrow(/changed since read/);
  });
  it('snapshots into history before a plan changes a file, and sweeps old history', async () => {
    root = await writeVault({ 'a.md': 'old\n', '.brain/history/2026-10-01/090000000/a.md': 'ancient\n' });
    const v = await Vault.open(root, { now });
    await v.execute({ id: 'p', label: 'l', steps: [{ op: 'write', path: 'a.md', text: 'new\n' }] });
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new\n');
    const days = await v.fs.listDirs('.brain/history');
    expect(days).toEqual(['2026-10-14']);
    const [stamp] = await v.fs.listDirs('.brain/history/2026-10-14');
    expect(await v.fs.readText(`.brain/history/2026-10-14/${stamp}/a.md`)).toBe('old\n');
  });
  it('on open, sweeps temporary files and finishes interrupted plans', async () => {
    root = await writeVault({
      '.a.md.brain-tmp-0b3f5c1e-2f4a-4d7e-9a51-6c1d2e3f4a5b': 'half',
      '.brain/journal/p.json': JSON.stringify({ plan: { id: 'p', label: 'l', steps: [{ op: 'write', path: 'done.md', text: 'x' }] }, done: 0 }),
    });
    const v = await Vault.open(root, { now });
    expect(v.entries.has('done.md')).toBe(true);
    expect(await v.fs.list('')).toEqual(['done.md']);
  });
  it('runs serial work in order, even after a failure', async () => {
    root = await writeVault({});
    const v = await Vault.open(root, { now });
    const order: number[] = [];
    await Promise.allSettled([
      v.serial(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        throw new Error('x');
      }),
      v.serial(async () => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
  it('logs each write and gives staged content one digest', async () => {
    root = await writeVault({ '.brain/staging/pilot/Concepts/A.md': '# A\n' });
    const v = await Vault.open(root, { now });
    await v.log('create_note', { path: 'x.md' });
    expect(JSON.parse((await v.fs.readText('.brain/mcp-log.jsonl'))!.trim())).toMatchObject({ tool: 'create_note', path: 'x.md' });
    const d1 = await v.stagingDigest('pilot');
    await mkdir(join(root, '.brain/staging/pilot/Concepts'), { recursive: true });
    await writeFile(join(root, '.brain/staging/pilot/Concepts/A.md'), '# A changed\n');
    expect(await v.stagingDigest('pilot')).not.toBe(d1);
  });
});
```

- [ ] **Step 2: Create the shared test helper the tests import**

Create `mcp/brain/testServer.ts`. It holds only `writeVault` for now; Task 24 adds `testServer`.
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway vault on disk, for tests. */
export async function writeVault(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'brain-vault-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/vault.test.ts`
Expected: FAIL with `Failed to resolve import "./vault"`.

- [ ] **Step 4: Implement**

Create `mcp/brain/vault.ts`:
```ts
import { createHash } from 'node:crypto';
import { ymd } from '../../src/shared/brain/daily';
import { backlinks, buildEntry, duplicateTitles, targetsOf, type IndexEntry } from '../../src/shared/brain/entry';
import type { Link, Targets } from '../../src/shared/brain/links';
import { titleKey, titleOf } from '../../src/shared/brain/names';
import { recover, runPlan, type Plan } from '../../src/shared/brain/plan';
import { indexSkips, serverMayWrite } from './guards';
import { nodeFs, type VaultFs } from './nodeFs';

export class StaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleError';
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * The server's view of the vault: an in-memory index, refreshed before every
 * tool call (spec, Vault MCP server: Start), plus the rules around writing.
 */
export class Vault {
  readonly entries = new Map<string, IndexEntry>();
  readonly fs: VaultFs;
  private meta = new Map<string, { mtimeMs: number; size: number }>();
  private files: string[] = [];
  private readAt = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private promoting = false;

  private constructor(root: string, readonly now: () => Date) {
    this.fs = nodeFs(root, (rel) => serverMayWrite(rel, this.promoting));
  }

  /** `maintain` sweeps temp files, finishes journals and old history (spec, Start). Read-only tools pass false. */
  static async open(root: string, opts: { now?: () => Date; maintain?: boolean } = {}): Promise<Vault> {
    const v = new Vault(root, opts.now ?? (() => new Date()));
    if (opts.maintain !== false) {
      await v.fs.sweepTmp();
      await recover(v.fs);
      await v.sweepHistory();
    }
    await v.refresh();
    return v;
  }

  /** Re-reads only files whose modification time or size changed. */
  async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const f of await this.fs.walk('', indexSkips)) {
      if (!/\.md$/i.test(f.path)) continue;
      seen.add(f.path);
      const m = this.meta.get(f.path);
      if (m && m.mtimeMs === f.mtimeMs && m.size === f.size) continue;
      this.meta.set(f.path, { mtimeMs: f.mtimeMs, size: f.size });
      let text: string | null = null;
      try {
        text = await this.fs.readText(f.path);
      } catch {
        // Not UTF-8: not a note (spec, File conventions).
      }
      if (text === null) this.entries.delete(f.path);
      else this.entries.set(f.path, buildEntry(f.path, text));
    }
    for (const p of [...this.meta.keys()]) {
      if (seen.has(p)) continue;
      this.meta.delete(p);
      this.entries.delete(p);
    }
    this.files = (await this.fs.walk('attachments')).map((f) => f.path);
  }

  targets(): Targets {
    return targetsOf([...this.entries.values()], this.files);
  }

  /** By vault path, title or alias, ignoring case and Unicode form. */
  find(titleOrPath: string): IndexEntry | null {
    const key = titleKey(titleOrPath);
    for (const e of this.entries.values()) if (titleKey(e.path) === key) return e;
    const name = titleOrPath.replace(/\.md$/i, '').split('/').pop() ?? '';
    const p = this.targets().notes.get(titleKey(name));
    return p ? (this.entries.get(p) ?? null) : null;
  }

  backlinksOf(path: string): { from: string; link: Link }[] {
    return backlinks(this.entries.values(), this.targets()).get(path) ?? [];
  }

  duplicates(): string[][] {
    return duplicateTitles([...this.entries.values()]);
  }

  /** Write tools run one at a time. ponytail: one queue for the whole vault; per-path locks if parallel writes ever matter. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  markRead(path: string): void {
    const m = this.meta.get(path);
    if (m) this.readAt.set(path, m.mtimeMs);
  }

  /** Edits need a read of the version on disk now, so a change from the Brain page or Windows is never overwritten unseen. */
  assertFresh(path: string): void {
    const r = this.readAt.get(path);
    if (r === undefined) throw new StaleError(`read "${titleOf(path)}" first`);
    if (r !== this.meta.get(path)?.mtimeMs) throw new StaleError('changed since read, re-read first');
  }

  /** Copies each existing file into .brain/history/<date>/<time>/ before it changes (spec, Version history). */
  async snapshot(paths: string[]): Promise<void> {
    const d = this.now();
    const stamp = `${ymd(d)}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
    for (const p of paths) if (!p.startsWith('.brain/') && (await this.fs.exists(p))) await this.fs.copy(p, `.brain/history/${stamp}/${p}`);
  }

  async sweepHistory(days = 7): Promise<void> {
    const cutoff = ymd(new Date(this.now().getTime() - days * 86_400_000));
    for (const day of await this.fs.listDirs('.brain/history')) if (day < cutoff) await this.fs.removeDir(`.brain/history/${day}`);
  }

  /** Snapshot what the plan changes, run it through the journal, then re-read. */
  async execute(plan: Plan, opts: { promoting?: boolean } = {}): Promise<void> {
    await this.snapshot(plan.steps.map((s) => (s.op === 'copy' ? s.to : s.path)));
    this.promoting = !!opts.promoting;
    try {
      await runPlan(this.fs, plan);
    } finally {
      this.promoting = false;
    }
    await this.refresh();
  }

  async log(tool: string, detail: Record<string, unknown>): Promise<void> {
    await this.fs.append('.brain/mcp-log.jsonl', JSON.stringify({ at: this.now().toISOString(), tool, ...detail }) + '\n');
  }

  /** One hash over everything staged for an area. The audit records it, and promote refuses anything else. */
  async stagingDigest(area: string): Promise<string> {
    const dir = `.brain/staging/${area}`;
    const h = createHash('sha256');
    for (const f of await this.fs.walk(dir)) {
      const bytes = (await this.fs.readBytes(f.path)) ?? new Uint8Array();
      h.update(`${f.path.slice(dir.length + 1)}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
    }
    return h.digest('hex');
  }
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/vault.test.ts && npm run typecheck`
Expected: PASS (7 tests), clean.

- [ ] **Step 6: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/vault.ts mcp/brain/vault.test.ts mcp/brain/testServer.ts
git commit -m "Vault MCP: the index, staleness checks, history copies, the write log and the staging digest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: The fixture vault, and Obsidian as the judge of our index

**Files:**
- Create:
  - `mcp/brain/fixtures/vault/**`: the synthetic vault from Step 1
  - `mcp/brain/obsidian/dump.js`
  - `mcp/brain/diffObsidian.ts`
  - `mcp/brain/fixtures/obsidian-dump.json`, generated in Obsidian in Step 3
  - `mcp/brain/fixtures/obsidian-deviations.json`
  - `.gitattributes`
- Modify:
  - `.gitignore`
  - `mcp/brain/cli.ts`: register `diff-obsidian`
- Test: `mcp/brain/obsidian.test.ts`

**Interfaces:**
- Consumes: `Vault` (Task 22); `resolve` (Task 14); `IndexEntry` (Task 15).
- Produces:
  - `interface FileView { headings; tags; resolved: Record<string, number>; unresolved: Record<string, number> }`
  - `interface ObsidianDump { obsidian: string; at?: string; files: Record<string, FileView> }`
  - `interface Deviation { path: string; field: string; reason: string }`
  - `ourView(e, t): FileView`
  - `diffObsidian(dump, entries, targets, deviations?): Difference[]`
  - The `diff-obsidian --vault <v>` command, which plan 2 runs on the real vault at stop A.

- [ ] **Step 1: Write the fixture vault**

Run from the repo root:
```bash
V=mcp/brain/fixtures/vault
mkdir -p "$V"/{Inbox,Concepts,"School/DL Class","School/DATA 220",Research/Papers,Career/Jobs,Reference/Templates,daily,Topics,attachments}
cat > "$V/Home.md" <<'EOF'
---
tags: [moc]
---
# Home

- [[DL Class]]
- [[AI & ML]]
- [[Inbox note]]
EOF
cat > "$V/Inbox/Inbox note.md" <<'EOF'
# Inbox note

A thought about [[Sigmoid]] and a [[Missing note]] that does not exist yet.
Mentions Gradient descent without linking it.
EOF
cat > "$V/Concepts/Sigmoid.md" <<'EOF'
---
created: 2026-02-11
tags: [concept]
aliases: [Logistic function]
sources: ["[[DL Class – Lecture 3]]", "notion:305a8b0b408d800bbfcac9072e86e85c"]
---
# Sigmoid

## Definition

$$\sigma(x) = \frac{1}{1 + e^{-x}}$$

![[sigmoid.png]]

> [!question] Sources disagree
> [[DL Class – Lecture 3]]: the output is a probability.
> [[DATA 220 – Lecture 3]]: the output is only a score.

## Uses

Used in [[Gradient descent]] examples. See also [[Logistic function|the logistic form]].
EOF
cat > "$V/Concepts/Gradient descent.md" <<'EOF'
---
tags: [concept]
related: ["[[Café]]"]
---
# Gradient descent

![[Sigmoid#Definition]]

- [ ] Derive the update rule
- [x] Read the [[DL Class – Lecture 3]] notes
  - [ ] Nested task about [[Sigmoid]]

```js
// [[Not a link]] inside code
```

Inline `[[Also not a link]]` and a #optimisation tag.
EOF
cat > "$V/Concepts/Café.md" <<'EOF'
---
tags: [concept]
---
# Café

Accented title, linked from [[Gradient descent]].
EOF
cat > "$V/Concepts/Notes on 𝑥 and 𝔼.md" <<'EOF'
# Notes on 𝑥 and 𝔼

Astral-plane letters stand in for emoji here: [[Sigmoid]].
EOF
printf '# Windows note\r\n\r\nWritten on Windows, links to [[Caf\xc3\xa9]].\r\n' > "$V/Concepts/Windows note.md"
cat > "$V/School/DL Class/DL Class.md" <<'EOF'
---
tags: [moc]
---
# DL Class

1. [[DL Class – Lecture 3]]
EOF
cat > "$V/School/DL Class/DL Class – Lecture 3.md" <<'EOF'
---
tags: [lecture]
---
# DL Class – Lecture 3

Covers [[Sigmoid]] and [[Gradient descent]].

> [!note]- Raw board notes
> Collapsed by default.

See [[Sigmoid#Uses]] and [[#Summary]].

## Summary

Done.
EOF
cat > "$V/School/DATA 220/DATA 220 – Lecture 3.md" <<'EOF'
---
tags: [lecture]
---
# DATA 220 – Lecture 3

Also about [[Logistic function]].
EOF
cat > "$V/Research/Papers/Attention is all you need.md" <<'EOF'
---
tags: [paper]
url: https://arxiv.org/abs/1706.03762
---
# Attention is all you need

![[paper.pdf]]
EOF
cat > "$V/Career/Jobs/Acme.md" <<'EOF'
---
status: applied
applied: 2026-09-01
related: ["[[Gradient descent]]"]
---
# Acme
EOF
cat > "$V/Career/Jobs.base" <<'EOF'
filters:
  and:
    - file.inFolder("Career/Jobs")
views:
  - type: table
    name: All jobs
    order:
      - file.name
      - status
EOF
cat > "$V/Reference/Templates/Meeting.md" <<'EOF'
# {{title}}

Date: {{date}} {{time}}
EOF
printf '# Wednesday, 14 October 2026\n' > "$V/daily/2026-10-14.md"
cat > "$V/Topics/AI & ML.md" <<'EOF'
---
tags: [moc]
---
# AI & ML

- [[Sigmoid]]
- [[Attention is all you need]]
EOF
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 --decode > "$V/attachments/sigmoid.png"
printf '%%PDF-1.4\n%%%%EOF\n' > "$V/attachments/paper.pdf"
```

Create `.gitattributes`:
```
# The fixture vault must keep its bytes exactly, CRLF note included.
mcp/brain/fixtures/vault/** -text
```

Append to `.gitignore`:
```
# Obsidian's own files when the fixture vault is opened to regenerate its dump
mcp/brain/fixtures/vault/.obsidian/
mcp/brain/fixtures/vault/.brain/
```

- [ ] **Step 2: Write the dump script and the diff**

Create `mcp/brain/obsidian/dump.js`:
```js
// Paste into Obsidian's developer console (Cmd+Opt+I, Console) with the vault open.
// Writes what Obsidian itself resolved to <vault>/.brain/obsidian-dump.json.
(async () => {
  const files = {};
  for (const f of app.vault.getMarkdownFiles()) {
    const c = app.metadataCache.getFileCache(f) ?? {};
    const fmTags = [].concat(c.frontmatter?.tags ?? []).map((t) => String(t).replace(/^#/, ''));
    files[f.path] = {
      headings: (c.headings ?? []).map((h) => ({ text: h.heading, level: h.level })),
      tags: [...new Set([...fmTags, ...(c.tags ?? []).map((t) => t.tag.replace(/^#/, ''))])].sort(),
      resolved: app.metadataCache.resolvedLinks[f.path] ?? {},
      unresolved: app.metadataCache.unresolvedLinks[f.path] ?? {},
    };
  }
  const obsidian = navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1] ?? 'unknown';
  await app.vault.adapter.mkdir('.brain').catch(() => {});
  await app.vault.adapter.write('.brain/obsidian-dump.json', JSON.stringify({ obsidian, at: new Date().toISOString(), files }, null, 1));
  console.log(`brain: wrote ${Object.keys(files).length} notes to .brain/obsidian-dump.json (Obsidian ${obsidian})`);
})();
```

Create `mcp/brain/diffObsidian.ts`:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { IndexEntry } from '../../src/shared/brain/entry';
import { resolve, type Targets } from '../../src/shared/brain/links';
import { nfc } from '../../src/shared/brain/names';
import { reportsDir, vaultPath } from './args';
import { Vault } from './vault';

/** What Obsidian's metadata cache says about one note, in the shape mcp/brain/obsidian/dump.js writes. */
export interface FileView { headings: { text: string; level: number }[]; tags: string[]; resolved: Record<string, number>; unresolved: Record<string, number> }
export interface ObsidianDump { obsidian: string; at?: string; files: Record<string, FileView> }
export interface Difference { path: string; field: 'missing' | 'extra' | keyof FileView; ours: unknown; obsidian: unknown }
/** A difference kept on purpose. Every one needs a reason, and a deviation that no longer applies fails the test. */
export interface Deviation { path: string; field: string; reason: string }

export function ourView(e: IndexEntry, t: Targets): FileView {
  const resolved: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  for (const l of e.links) {
    const p = resolve(l, e.path, t);
    if (p) resolved[nfc(p)] = (resolved[nfc(p)] ?? 0) + 1;
    else unresolved[l.target] = (unresolved[l.target] ?? 0) + 1;
  }
  return { headings: e.headings.map((h) => ({ text: h.text, level: h.level })), tags: [...e.tags].sort(), resolved, unresolved };
}

const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function diffObsidian(dump: ObsidianDump, entries: IndexEntry[], t: Targets, deviations: Deviation[] = []): Difference[] {
  const ours = new Map(entries.map((e) => [nfc(e.path), ourView(e, t)]));
  const theirs = new Map(
    Object.entries(dump.files).map(([p, v]) => [nfc(p), { ...v, tags: [...v.tags].sort(), resolved: Object.fromEntries(Object.entries(v.resolved).map(([k, n]) => [nfc(k), n])) }]),
  );
  const kept = (path: string, field: string) => deviations.some((d) => d.path === path && d.field === field);
  const out: Difference[] = [];
  for (const [path, o] of theirs) {
    const u = ours.get(path);
    if (!u) {
      if (!kept(path, 'missing')) out.push({ path, field: 'missing', ours: null, obsidian: o });
      continue;
    }
    for (const field of ['headings', 'tags', 'resolved', 'unresolved'] as const) {
      if (canon(u[field]) !== canon(o[field]) && !kept(path, field)) out.push({ path, field, ours: u[field], obsidian: o[field] });
    }
  }
  for (const [path, u] of ours) if (!theirs.has(path) && !kept(path, 'extra')) out.push({ path, field: 'extra', ours: u, obsidian: null });
  return out;
}

/** `diff-obsidian`: compare the real vault with the dump Obsidian wrote for it (stop A in plan 2). */
export async function diffObsidianCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' } } });
  const root = vaultPath(values.vault);
  const dump = JSON.parse(await readFile(join(root, '.brain', 'obsidian-dump.json'), 'utf8')) as ObsidianDump;
  const deviations = await readFile(join(root, '.brain', 'obsidian-deviations.json'), 'utf8').then((s) => JSON.parse(s) as Deviation[], () => []);
  const v = await Vault.open(root, { maintain: false });
  const diff = diffObsidian(dump, [...v.entries.values()], v.targets(), deviations);
  await writeFile(join(await reportsDir(root), 'obsidian-diff.json'), JSON.stringify({ obsidian: dump.obsidian, at: new Date().toISOString(), diff }, null, 1));
  const unresolved = Object.values(dump.files).reduce((n, f) => n + Object.values(f.unresolved).reduce((a, b) => a + b, 0), 0);
  console.log(`${diff.length} differences from Obsidian ${dump.obsidian}; Obsidian reports ${unresolved} unresolved links.`);
  if (diff.length || unresolved) process.exitCode = 1;
}
```
In `mcp/brain/cli.ts`, add `import { diffObsidianCmd } from './diffObsidian';` and `'diff-obsidian': diffObsidianCmd,` to `commands`.

Create `mcp/brain/fixtures/obsidian-deviations.json`:
```json
[]
```

- [ ] **Step 3: Generate Obsidian's dump of the fixture vault (user, about 2 minutes)**

1. In Obsidian, choose "Open folder as vault" and pick `mcp/brain/fixtures/vault`. Trust it if asked; it has no plugins.
2. Open the developer console (Cmd+Opt+I, then Console). Paste the whole of `mcp/brain/obsidian/dump.js` and press Enter.
   - Expected: `brain: wrote 15 notes to .brain/obsidian-dump.json (Obsidian 1.13.7)`. The version is whatever is installed.
3. Close that vault in Obsidian. Then run:
   ```bash
   cp mcp/brain/fixtures/vault/.brain/obsidian-dump.json mcp/brain/fixtures/obsidian-dump.json
   rm -rf mcp/brain/fixtures/vault/.obsidian mcp/brain/fixtures/vault/.brain
   git status --short mcp/brain/fixtures/vault
   ```
   - Expected: no changes inside `fixtures/vault/`. Obsidian must not have edited any note.

Claude can do this step instead, with REA's Electron tools or computer use, if the user grants access. Either way, the dump comes from Obsidian, never from our own code.

- [ ] **Step 4: Write the oracle test**

Create `mcp/brain/obsidian.test.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { diffObsidian, type Deviation, type ObsidianDump } from './diffObsidian';
import { parseQuery } from '../../src/shared/brain/query';
import { search, toSearchDoc } from '../../src/shared/brain/search';
import deviations from './fixtures/obsidian-deviations.json';
import dump from './fixtures/obsidian-dump.json';
import { Vault } from './vault';

let vault: Vault;
beforeAll(async () => {
  vault = await Vault.open(fileURLToPath(new URL('./fixtures/vault', import.meta.url)), { maintain: false });
});

describe('oracle: Obsidian itself', () => {
  it('was generated by Obsidian', () => {
    expect((dump as ObsidianDump).obsidian).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('agrees with our index on links, headings and tags for every note', () => {
    expect(diffObsidian(dump as ObsidianDump, [...vault.entries.values()], vault.targets(), deviations as Deviation[])).toEqual([]);
  });
  it('gives the checked-in search results on the fixture vault (regression)', () => {
    const docs = [...vault.entries.values()].map(toSearchDoc);
    const find = (q: string) => search(parseQuery(q), docs).hits.map((h) => h.title);
    expect(find('sigmoid')).toEqual(['Sigmoid', 'AI & ML', 'DL Class \u2013 Lecture 3', 'Gradient descent', 'Inbox note', 'Notes on \u{1D465} and \u{1D53C}']);
    expect(find('task-todo:derive')).toEqual(['Gradient descent']);
    expect(find('tag:moc')).toEqual(['AI & ML', 'DL Class', 'Home']);
    expect(find('line:(Windows Caf\u00e9)')).toEqual(['Windows note']);
  });
  it('keeps no deviation that has stopped applying, and gives each a reason', () => {
    const raw = diffObsidian(dump as ObsidianDump, [...vault.entries.values()], vault.targets());
    for (const d of deviations as Deviation[]) {
      expect(d.reason.trim(), `${d.path} ${d.field}`).not.toBe('');
      expect(raw.some((x) => x.path === d.path && x.field === d.field), `${d.path} ${d.field} still differs`).toBe(true);
    }
  });
});
```

- [ ] **Step 5: Run it and settle every difference**

Run: `npx vitest run mcp/brain/obsidian.test.ts`

Expected: PASS. Any difference it prints is a finding. For each one:
- **Our behaviour is wrong** (for example, how `[[#Summary]]`, embeds or property links are counted): fix `links.ts`, `entry.ts` or `blocks.ts` until the difference disappears. Add a unit test in that module that pins the corrected behaviour.
- **The difference is deliberate:** add `{ "path", "field", "reason" }` to `obsidian-deviations.json`, and tell the user which and why.

Then run `npm test`. The whole suite must be green.

- [ ] **Step 6: Commit**

Run `npm run typecheck` and `/verify` first.
```bash
git add .gitattributes .gitignore mcp/brain/fixtures/vault mcp/brain/fixtures/obsidian-dump.json mcp/brain/fixtures/obsidian-deviations.json mcp/brain/obsidian/dump.js mcp/brain/diffObsidian.ts mcp/brain/obsidian.test.ts mcp/brain/cli.ts
git commit -m "Oracle: Obsidian's own metadata cache judges our index on a synthetic vault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Include any `src/shared/brain/*` fixes from Step 5, with their tests, in the same commit.

---

### Task 24: The server and its read tools

**Files:**
- Create:
  - `mcp/brain/tools/common.ts`
  - `mcp/brain/tools/read.ts`
  - `mcp/brain/regexSearch.ts`
  - `mcp/brain/searchWorker.ts`
  - `mcp/brain/server.ts`
- Modify:
  - `mcp/brain/testServer.ts`: add `testServer`
  - `package.json`: restore the full `build:mcp` entry list from Task 1
- Test:
  - `mcp/brain/server.read.test.ts`
  - `mcp/brain/regexSearch.test.ts`

**Interfaces:**
- Consumes: `Vault` (Task 22); `parseQuery`, `hasRegex`, `QueryError` (Task 16); `search`, `toSearchDoc`, `rankHits` (Task 17).
- Produces:
  - In `tools/common.ts`:
    - `ok(text)`, `fail(text)`, `guard(vault, fn)`
    - `READ`, `WRITE`, `DESTRUCTIVE`, `IDEMPOTENT`, `IDEMPOTENT_OPEN`: the annotations
  - In `regexSearch.ts`:
    - `type SearchRunner = (query: string, docs: SearchDoc[], limit: number) => Promise<{ hits: Hit[]; partial: boolean }>`
    - `workerSearch(workerUrl: URL, ms?: number): SearchRunner`
  - In `server.ts`:
    - `createServer(vault: Vault, opts?: ServerOptions): McpServer`
    - `interface ServerOptions { runRegex?: SearchRunner; fetch?: typeof fetch }`
  - Tools: `search`, `read_note`, `backlinks`, `list_moc`, `list_folder`.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/regexSearch.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerSearch } from './regexSearch';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-worker-'));
  await writeFile(join(dir, 'done.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ hits: [{ path: 'b.md', title: 'B', score: 1 }, { path: 'a.md', title: 'A', score: 3 }] }); parentPort.postMessage({ done: true });");
  await writeFile(join(dir, 'hang.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ hits: [{ path: 'a.md', title: 'A', score: 1 }] }); for (;;) {}");
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('workerSearch', () => {
  it('returns the ranked hits a worker finds', async () => {
    const r = await workerSearch(pathToFileURL(join(dir, 'done.mjs')))('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 3 }, { path: 'b.md', title: 'B', score: 1 }], partial: false });
  });
  it('stops a runaway worker and keeps what it found', async () => {
    const t0 = Date.now();
    const r = await workerSearch(pathToFileURL(join(dir, 'hang.mjs')), 300)('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 1 }], partial: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
```

Create `mcp/brain/server.read.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { testServer } from './testServer';

const FILES = {
  'Home.md': '---\ntags: [moc]\n---\n# Home\n\n- [[Sigmoid]]\n- [[Missing]]\n',
  'Concepts/Sigmoid.md': '---\naliases: [Logistic function]\n---\n# Sigmoid\n\nThe logistic curve.\n',
  'School/Lecture 3.md': '---\nsources: ["[[Sigmoid]]"]\n---\n# Lecture 3\n\nCovers [[Logistic function]] today.\n',
};
let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());

describe('read tools', () => {
  it('declares every read tool read-only', async () => {
    t = await testServer(FILES);
    const tools = (await t.client.listTools()).tools;
    for (const name of ['search', 'read_note', 'backlinks', 'list_moc', 'list_folder']) {
      expect(tools.find((x) => x.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
    }
  });
  it('searches with Obsidian syntax and points at a malformed query', async () => {
    t = await testServer(FILES);
    // Both match in the body only, so they tie and sort by title.
    expect((await t.call('search', { query: 'logistic' })).text).toBe('Lecture 3 (School/Lecture 3.md)\nSigmoid (Concepts/Sigmoid.md)');
    expect((await t.call('search', { query: 'path:School' })).text).toBe('Lecture 3 (School/Lecture 3.md)');
    expect((await t.call('search', { query: 'nothing-here' })).text).toBe('No matches.');
    expect(await t.call('search', { query: '(logistic' })).toEqual({ text: 'unclosed parenthesis at character 1', error: true });
  });
  it('reads a note by title, alias or path, with its path', async () => {
    t = await testServer(FILES);
    for (const title of ['Sigmoid', 'logistic function', 'Concepts/Sigmoid.md']) {
      expect((await t.call('read_note', { title })).text).toBe(`path: Concepts/Sigmoid.md\n\n${FILES['Concepts/Sigmoid.md']}`);
    }
    expect(await t.call('read_note', { title: 'Nope' })).toEqual({ text: 'No note titled "Nope".', error: true });
  });
  it('lists backlinks with the line or property they come from', async () => {
    t = await testServer(FILES);
    expect((await t.call('backlinks', { title: 'Sigmoid' })).text.split('\n').sort()).toEqual([
      'Home (Home.md): - [[Sigmoid]]',
      'Lecture 3 (School/Lecture 3.md): Covers [[Logistic function]] today.',
      'Lecture 3 (School/Lecture 3.md): property "sources"',
    ]);
  });
  it('lists MOCs, a MOC\'s links in order, and folders', async () => {
    t = await testServer(FILES);
    expect((await t.call('list_moc', {})).text).toBe('Home (Home.md)');
    expect((await t.call('list_moc', { title: 'Home' })).text).toBe('- Sigmoid (Concepts/Sigmoid.md)\n- Missing (no such note yet)');
    expect((await t.call('list_folder', {})).text).toBe('Concepts/\nSchool/\nHome (Home.md)');
    expect((await t.call('list_folder', { folder: 'School' })).text).toBe('Lecture 3 (School/Lecture 3.md)');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/regexSearch.test.ts mcp/brain/server.read.test.ts`
Expected: FAIL with `Failed to resolve import "./regexSearch"`, and `testServer` is not exported.

- [ ] **Step 3: Implement**

Create `mcp/brain/regexSearch.ts`:
```ts
import { Worker } from 'node:worker_threads';
import { rankHits, type Hit, type SearchDoc } from '../../src/shared/brain/search';

export type SearchRunner = (query: string, docs: SearchDoc[], limit: number) => Promise<{ hits: Hit[]; partial: boolean }>;

/**
 * A regex can backtrack for minutes inside one note, and JavaScript cannot
 * interrupt it. So regex searches run in a worker that is stopped after `ms`,
 * keeping whatever it had already found (spec, Search: cut off at 2 s).
 */
export function workerSearch(workerUrl: URL, ms = 2_000): SearchRunner {
  return (query, docs, limit) =>
    new Promise((resolveSearch, reject) => {
      const hits: Hit[] = [];
      const w = new Worker(workerUrl, { workerData: { query, docs } });
      let settled = false;
      const done = (partial: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w.terminate();
        resolveSearch({ hits: rankHits(hits).slice(0, limit), partial });
      };
      const timer = setTimeout(() => done(true), ms);
      w.on('message', (m: { hits?: Hit[]; done?: boolean }) => {
        if (m.hits) hits.push(...m.hits);
        if (m.done) done(false);
      });
      w.once('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w.terminate();
        reject(e);
      });
    });
}
```

Create `mcp/brain/searchWorker.ts`:
```ts
import { parentPort, workerData } from 'node:worker_threads';
import { parseQuery } from '../../src/shared/brain/query';
import { search, type SearchDoc } from '../../src/shared/brain/search';

const { query, docs } = workerData as { query: string; docs: SearchDoc[] };
const q = parseQuery(query);
// Small batches, so the hits found before a runaway note survive the worker being stopped.
for (let i = 0; i < docs.length; i += 50) parentPort!.postMessage({ hits: search(q, docs.slice(i, i + 50)).hits });
parentPort!.postMessage({ done: true });
```

Create `mcp/brain/tools/common.ts`:
```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { QueryError } from '../../../src/shared/brain/query';
import type { Vault } from '../vault';

export const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Hints Claude Code shows and permission rules can use (spec, Vault MCP server; taken from Gloss). */
export const READ = { readOnlyHint: true, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const IDEMPOTENT_OPEN = { ...IDEMPOTENT, openWorldHint: true };

/** Every call sees the vault as it is now, since the Brain page or Windows may have changed it; every failure is a message, never a crash. */
export async function guard(vault: Vault, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    await vault.refresh();
    return await fn();
  } catch (e) {
    if (e instanceof QueryError) return fail(`${e.message} at character ${e.pos + 1}`);
    return fail(e instanceof Error ? e.message : String(e));
  }
}
```

Create `mcp/brain/tools/read.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve } from '../../../src/shared/brain/links';
import { hasRegex, parseQuery } from '../../../src/shared/brain/query';
import { search, toSearchDoc } from '../../../src/shared/brain/search';
import type { SearchRunner } from '../regexSearch';
import type { Vault } from '../vault';
import { fail, guard, ok, READ } from './common';

const lineAt = (body: string, pos: number) => {
  const start = body.lastIndexOf('\n', pos - 1) + 1;
  const end = body.indexOf('\n', pos);
  return body.slice(start, end === -1 ? body.length : end).trim();
};
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function registerReadTools(server: McpServer, vault: Vault, runRegex: SearchRunner): void {
  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Search the vault with Obsidian search syntax: words (all must match), "exact phrase", OR, (groups), -exclude, /regex/, and the operators file:, path:, content:, tag:, line:( ), block:( ), section:( ), task:, task-todo:, task-done:, match-case:, ignore-case:. Returns note titles and paths, best match first.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    async ({ query, limit }) =>
      guard(vault, async () => {
        const q = parseQuery(query);
        const docs = [...vault.entries.values()].map(toSearchDoc);
        const n = limit ?? 20;
        const r = hasRegex(q) ? await runRegex(query, docs, n) : search(q, docs, { limit: n });
        const lines = r.hits.map((h) => `${h.title} (${h.path})`);
        if (r.partial) lines.push('Partial results: the regular expression was stopped after 2 s.');
        return ok(lines.length ? lines.join('\n') : 'No matches.');
      }),
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description: 'Read a note by title, alias or vault path. Returns its path and full text, frontmatter included. Read a note before edit_note or write_note.',
      inputSchema: { title: z.string().min(1) },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const text = await vault.fs.readText(e.path);
        vault.markRead(e.path);
        return ok(`path: ${e.path}\n\n${text ?? ''}`);
      }),
  );

  server.registerTool(
    'backlinks',
    {
      title: 'Notes that link here',
      description: 'List the notes that link to a note (by title, alias, embed or property), each with the line or property the link is in.',
      inputSchema: { title: z.string().min(1) },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const links = vault.backlinksOf(e.path);
        if (!links.length) return ok(`Nothing links to "${e.title}".`);
        return ok(
          links
            .map(({ from, link }) => {
              const src = vault.entries.get(from)!;
              return `${src.title} (${from}): ${link.property ? `property "${link.property}"` : lineAt(src.body, link.from)}`;
            })
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'list_moc',
    {
      title: 'Maps of content',
      description: 'With no title, list every map of content (notes tagged moc). With a title, list that note\'s links in order, marking those that do not exist yet.',
      inputSchema: { title: z.string().optional() },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        if (!title) {
          const mocs = [...vault.entries.values()].filter((e) => e.tags.includes('moc')).sort((a, b) => (a.path < b.path ? -1 : 1));
          return ok(mocs.length ? mocs.map((e) => `${e.title} (${e.path})`).join('\n') : 'No notes are tagged moc.');
        }
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const t = vault.targets();
        const lines = e.links.filter((l) => l.property === null && l.target !== '').map((l) => {
          const p = resolve(l, e.path, t);
          return p ? `- ${vault.entries.get(p)?.title ?? l.target} (${p})` : `- ${l.target} (no such note yet)`;
        });
        return ok(lines.length ? lines.join('\n') : `"${e.title}" has no links.`);
      }),
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List a folder',
      description: 'List the subfolders and notes in a vault folder; the top of the vault when no folder is given.',
      inputSchema: { folder: z.string().optional() },
      annotations: READ,
    },
    async ({ folder }) =>
      guard(vault, async () => {
        const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
        const dirs = (await vault.fs.listDirs(f)).filter((d) => !d.startsWith('.')).map((d) => `${d}/`);
        const notes = [...vault.entries.values()].filter((e) => dirOf(e.path) === f).sort((a, b) => (a.title < b.title ? -1 : 1)).map((e) => `${e.title} (${e.path})`);
        const all = [...dirs, ...notes];
        return ok(all.length ? all.join('\n') : `"${f}" is empty or does not exist.`);
      }),
  );
}
```

Create `mcp/brain/server.ts`:
```ts
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { workerSearch, type SearchRunner } from './regexSearch';
import { registerReadTools } from './tools/read';
import { Vault } from './vault';

export interface ServerOptions { runRegex?: SearchRunner; fetch?: typeof fetch }

/** The vault MCP server (spec, Vault MCP server). Read tools need no approval; Claude Code asks before every write. */
export function createServer(vault: Vault, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'brain', version: '1.0.0' });
  registerReadTools(server, vault, opts.runRegex ?? workerSearch(new URL('./searchWorker.mjs', import.meta.url)));
  return server;
}

async function main() {
  const root = process.env.BRAIN_VAULT;
  if (!root) {
    console.error('BRAIN_VAULT is not set: point it at the vault folder.');
    process.exit(1);
  }
  const vault = await Vault.open(root);
  await createServer(vault).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
```

Append to `mcp/brain/testServer.ts`:
```ts
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseQuery } from '../../src/shared/brain/query';
import { search } from '../../src/shared/brain/search';
import { createServer, type ServerOptions } from './server';
import { Vault } from './vault';

/** A server over a throwaway vault, talking to a real MCP client in memory. Regex runs in-process here; Task 27 tests the worker. */
export async function testServer(files: Record<string, string | Uint8Array>, opts: ServerOptions = {}) {
  const root = await writeVault(files);
  const vault = await Vault.open(root, { now: () => new Date(2026, 9, 14, 9, 30) });
  const server = createServer(vault, { runRegex: async (q, docs, limit) => search(parseQuery(q), docs, { limit }), ...opts });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: !!r.isError };
  };
  let closed = false;
  return {
    root,
    vault,
    client,
    call,
    // Safe to call twice: a model run closes each vault, and afterEach closes again.
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
```
Move the new imports to the top of `testServer.ts`, merging the `node:fs/promises` import.

In `package.json`, set `build:mcp` back to the full form given in Task 1 (entries `mcp/brain/cli.ts mcp/brain/server.ts mcp/brain/searchWorker.ts`).

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/regexSearch.test.ts mcp/brain/server.read.test.ts && npm run typecheck && npm run build:mcp && ls dist-mcp`
Expected: PASS (7 tests), clean, and `cli.mjs server.mjs searchWorker.mjs`.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/regexSearch.ts mcp/brain/regexSearch.test.ts mcp/brain/searchWorker.ts mcp/brain/tools/common.ts mcp/brain/tools/read.ts mcp/brain/server.ts mcp/brain/server.read.test.ts mcp/brain/testServer.ts package.json
git commit -m "Vault MCP: the server and its read tools, with regex search stopped at 2 s

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 25: Write tools, and proof that parallel calls never lose an edit

**Files:**
- Create: `mcp/brain/tools/write.ts`
- Modify: `mcp/brain/server.ts`: register the write tools
- Test: `mcp/brain/server.write.test.ts`

**Interfaces:**
- Consumes:
  - `Vault` (Task 22)
  - `planRename`, `planMove`, `planDelete`, `STARRED` (Task 19)
  - `safeTitle`, `nfc`, `titleKey` (Task 11)
  - `parseNote`, `setField`, `getField`, `asList`, `toText` (Task 12)
  - `dailyPath`, `dailyText`, `ymd` (Task 11)
- Produces:
  - Tools: `daily_note`, `create_note`, `write_note`, `edit_note`, `rename_note`, `move_note`, `delete_note`.
  - Each runs through `vault.serial`, re-checks the vault inside the queue, and logs to `.brain/mcp-log.jsonl`.
  - `write_note` and `edit_note` need a fresh read.
  - `rename_note`, `move_note`, `delete_note` and `write_note` are destructive.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/server.write.test.ts`:
```ts
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { FC } from '../../src/shared/brain/testing';
import { testServer } from './testServer';

let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());
const read = (rel: string) => readFile(join(t.root, rel), 'utf8');

describe('write tools', () => {
  it('marks destructive tools as destructive', async () => {
    t = await testServer({});
    const tools = (await t.client.listTools()).tools;
    for (const name of ['write_note', 'rename_note', 'move_note', 'delete_note']) expect(tools.find((x) => x.name === name)?.annotations?.destructiveHint, name).toBe(true);
    expect(tools.find((x) => x.name === 'daily_note')?.annotations?.idempotentHint).toBe(true);
  });
  it('creates today\'s daily note once, holding only its heading', async () => {
    t = await testServer({});
    expect((await t.call('daily_note')).text).toBe('path: daily/2026-10-14.md\n\n# Wednesday, 14 October 2026\n');
    expect((await t.call('daily_note')).text).toBe('path: daily/2026-10-14.md\n\n# Wednesday, 14 October 2026\n');
  });
  it('creates notes in Inbox, moves an unsafe title into aliases, and refuses a clash', async () => {
    t = await testServer({ 'Concepts/Sigmoid.md': '# Sigmoid\n' });
    expect((await t.call('create_note', { title: 'Idea', text: '# Idea\n' })).text).toBe('Created Inbox/Idea.md.');
    expect((await t.call('create_note', { title: 'A/B test', text: '# A/B\n' })).text).toContain('Created Inbox/A-B test.md');
    expect(await read('Inbox/A-B test.md')).toBe('---\naliases: [A/B test]\n---\n# A/B\n');
    expect(await t.call('create_note', { title: 'sigmoid', text: '' })).toEqual({ text: '"sigmoid" is already used by Concepts/Sigmoid.md', error: true });
  });
  it('edits only after a read, refuses a stale or ambiguous edit, and keeps history', async () => {
    t = await testServer({ 'a.md': '# A\none\ntwo\ntwo\n' });
    expect(await t.call('edit_note', { title: 'a', old_str: 'one', new_str: '1' })).toEqual({ text: 'read "a" first', error: true });
    await t.call('read_note', { title: 'a' });
    expect((await t.call('edit_note', { title: 'a', old_str: 'two', new_str: '2' })).text).toBe('old_str occurs 2 times; include more context or set replace_all');
    expect((await t.call('edit_note', { title: 'a', old_str: 'one', new_str: '$1 one' })).text).toBe('Edited a.md.');
    expect(await read('a.md')).toBe('# A\n$1 one\ntwo\ntwo\n');
    await writeFile(join(t.root, 'a.md'), '# A changed in the Brain page\n');
    await utimes(join(t.root, 'a.md'), new Date(), new Date(Date.now() + 5_000));
    expect(await t.call('edit_note', { title: 'a', old_str: 'A', new_str: 'B' })).toEqual({ text: 'changed since read, re-read first', error: true });
    const [stamp] = await t.vault.fs.listDirs('.brain/history/2026-10-14');
    expect(await t.vault.fs.readText(`.brain/history/2026-10-14/${stamp}/a.md`)).toBe('# A\none\ntwo\ntwo\n');
  });
  it('renames with links rewritten, moves, and deletes into trash', async () => {
    t = await testServer({ 'Concepts/Sigmoid.md': '# Sigmoid\n', 'School/L3.md': '---\nsources: ["[[Sigmoid]]"]\n---\nSee [[Sigmoid]].\n' });
    expect((await t.call('rename_note', { title: 'Sigmoid', new_title: 'Logistic sigmoid' })).text).toBe('Renamed "Sigmoid" to "Logistic sigmoid"; updated links in 1 note.');
    expect(await read('School/L3.md')).toBe('---\nsources: ["[[Logistic sigmoid]]"]\n---\nSee [[Logistic sigmoid]].\n');
    expect((await t.call('move_note', { title: 'Logistic sigmoid', folder: 'Inbox' })).text).toBe('Moved "Logistic sigmoid" to Inbox.');
    expect((await t.call('delete_note', { title: 'L3' })).text).toBe('Moved "L3" to .brain/trash/2026-10-14/. Restore it from there within 30 days.');
    expect([...t.vault.entries.keys()]).toEqual(['Inbox/Logistic sigmoid.md']);
    const log = (await read('.brain/mcp-log.jsonl')).trim().split('\n').map((l) => JSON.parse(l).tool);
    expect(log).toEqual(['rename_note', 'move_note', 'delete_note']);
  });
  it('never loses the note when a rename races an edit of it', async () => {
    t = await testServer({ 'a.md': '# A\nEND\n' });
    await t.call('read_note', { title: 'a' });
    const [ren, ed] = await Promise.all([t.call('rename_note', { title: 'a', new_title: 'b' }), t.call('edit_note', { title: 'a', old_str: 'END', new_str: 'token\nEND' })]);
    expect(ren.error).toBe(false);
    expect([...t.vault.entries.keys()]).toEqual(['b.md']);
    const text = await read('b.md');
    if (ed.error) expect(ed.text).toBe('No note titled "a".');
    else expect(text).toBe('# A\ntoken\nEND\n');
  });
});

describe('model: parallel calls never lose an edit', () => {
  it('keeps every successful edit exactly once, in the vault or its trash', async () => {
    const TITLES = ['N0', 'N1', 'N2', 'N3'];
    const op = fc.tuple(fc.constantFrom('edit', 'rename', 'create', 'delete'), fc.nat(3), fc.nat(3));
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
        t = await testServer({ 'Inbox/N0.md': '# N0\nEND\n', 'Inbox/N1.md': '# N1\nEND\n' });
        try {
          const kept: string[] = [];
          await Promise.all(
            ops.map(async ([kind, a, b], i) => {
              if (kind === 'edit') {
                await t.call('read_note', { title: TITLES[a] });
                const r = await t.call('edit_note', { title: TITLES[a], old_str: 'END', new_str: `token-${i}\nEND` });
                if (!r.error) kept.push(`token-${i}`);
                else expect(r.text).toMatch(/No note titled|changed since read|read ".*" first/);
              } else if (kind === 'rename') await t.call('rename_note', { title: TITLES[a], new_title: TITLES[b] });
              else if (kind === 'create') await t.call('create_note', { title: TITLES[a], text: `# ${TITLES[a]}\nEND\n` });
              else await t.call('delete_note', { title: TITLES[a] });
            }),
          );
          const files = (await t.vault.fs.walk('', (d) => /^\.brain\/(history|journal|staging)/.test(d))).filter((f) => f.path.endsWith('.md'));
          const texts = await Promise.all(files.map((f) => t.vault.fs.readText(f.path)));
          for (const tok of kept) expect(texts.join('\n').split(tok + '\n').length - 1, tok).toBe(1);
          expect(t.vault.duplicates()).toEqual([]);
          expect(await t.vault.fs.list('.brain/journal')).toEqual([]);
        } finally {
          await t.close();
        }
      }),
      { ...FC, numRuns: 30 },
    );
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/server.write.test.ts`
Expected: FAIL with `Tool daily_note not found` (or the equivalent MCP error).

- [ ] **Step 3: Implement**

Create `mcp/brain/tools/write.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { dailyPath, dailyText, ymd } from '../../../src/shared/brain/daily';
import { asList, getField, parseNote, setField, toText } from '../../../src/shared/brain/frontmatter';
import { nfc, safeTitle, titleKey } from '../../../src/shared/brain/names';
import { planDelete, planMove, planRename, STARRED } from '../../../src/shared/brain/rename';
import type { Vault } from '../vault';
import { DESTRUCTIVE, fail, guard, IDEMPOTENT, ok, WRITE } from './common';

const badFolder = (f: string) => f.split('/').some((s) => s === '..' || s.startsWith('.')) || /^(sources|attachments)$/i.test(f.split('/')[0]);

export function registerWriteTools(server: McpServer, vault: Vault): void {
  // One at a time, and re-read inside the queue: another call may have changed the vault while this one waited.
  const write = (fn: () => Promise<CallToolResult>) =>
    guard(vault, () =>
      vault.serial(async () => {
        await vault.refresh();
        return fn();
      }),
    );
  const noteOr = (title: string) => {
    const e = vault.find(title);
    if (!e) throw new Error(`No note titled "${title}".`);
    return e;
  };

  server.registerTool(
    'daily_note',
    { title: "Today's daily note", description: "Open the daily note for a date (today by default), creating it in daily/ with only its date heading.", inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }, annotations: IDEMPOTENT },
    async ({ date }) =>
      write(async () => {
        const d = date ? new Date(`${date}T12:00:00`) : vault.now();
        const path = dailyPath(d);
        if (!(await vault.fs.exists(path))) {
          await vault.fs.writeText(path, dailyText(d));
          await vault.refresh();
          await vault.log('daily_note', { path });
        }
        vault.markRead(path);
        return ok(`path: ${path}\n\n${(await vault.fs.readText(path)) ?? ''}`);
      }),
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: 'Create a new note. The title becomes the file name and must be unique in the vault; characters a file name cannot hold are replaced and the original title is kept in aliases. Goes to Inbox/ unless a folder is given.',
      inputSchema: { title: z.string().min(1), text: z.string(), folder: z.string().optional() },
      annotations: WRITE,
    },
    async ({ title, text, folder }) =>
      write(async () => {
        const f = (folder ?? 'Inbox').replace(/^\/+|\/+$/g, '');
        if (badFolder(f)) return fail(`"${f}" is not a folder notes can live in.`);
        const wanted = nfc(title).trim();
        const safe = safeTitle(wanted, f);
        const taken = vault.targets().notes;
        for (const k of new Set([safe.title, wanted])) {
          const owner = taken.get(titleKey(k));
          if (owner) return fail(`"${k}" is already used by ${owner}`);
        }
        let body = text;
        if (safe.changed) {
          const n = parseNote(text);
          if (n.error) return fail(`The frontmatter cannot be read (${n.error}); fix it or leave it out.`);
          body = toText(setField(n, 'aliases', [...asList(getField(n, 'aliases')), wanted]));
        }
        const path = f ? `${f}/${safe.title}.md` : `${safe.title}.md`;
        await vault.fs.writeText(path, body);
        await vault.refresh();
        vault.markRead(path);
        await vault.log('create_note', { path });
        return ok(`Created ${path}${safe.changed ? `; the file name cannot hold "${wanted}", so it is in aliases` : ''}.`);
      }),
  );

  server.registerTool(
    'write_note',
    { title: 'Replace a note', description: 'Replace the whole text of an existing note. Read it first; refused if it changed since.', inputSchema: { title: z.string().min(1), text: z.string() }, annotations: DESTRUCTIVE },
    async ({ title, text }) =>
      write(async () => {
        const e = noteOr(title);
        vault.assertFresh(e.path);
        await vault.snapshot([e.path]);
        await vault.fs.writeText(e.path, text);
        await vault.refresh();
        vault.markRead(e.path);
        await vault.log('write_note', { path: e.path });
        return ok(`Saved ${e.path}.`);
      }),
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit a note',
      description: 'Replace old_str with new_str in a note. old_str must occur exactly once unless replace_all is set. Read the note first; refused if it changed since.',
      inputSchema: { title: z.string().min(1), old_str: z.string().min(1), new_str: z.string(), replace_all: z.boolean().optional() },
      annotations: WRITE,
    },
    async ({ title, old_str, new_str, replace_all }) =>
      write(async () => {
        const e = noteOr(title);
        vault.assertFresh(e.path);
        const text = (await vault.fs.readText(e.path)) ?? '';
        const count = text.split(old_str).length - 1;
        if (count === 0) return fail('old_str was not found in the note.');
        if (count > 1 && !replace_all) return fail(`old_str occurs ${count} times; include more context or set replace_all`);
        const next = replace_all ? text.split(old_str).join(new_str) : text.replace(old_str, () => new_str);
        await vault.snapshot([e.path]);
        await vault.fs.writeText(e.path, next);
        await vault.refresh();
        vault.markRead(e.path);
        await vault.log('edit_note', { path: e.path, replaced: replace_all ? count : 1 });
        return ok(`Edited ${e.path}.`);
      }),
  );

  server.registerTool(
    'rename_note',
    {
      title: 'Rename a note',
      description: 'Rename a note and rewrite every link to it across the vault (bodies, embeds, properties, starred). Refused if the new title is already a title or alias.',
      inputSchema: { title: z.string().min(1), new_title: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ title, new_title }) =>
      write(async () => {
        const e = noteOr(title);
        const froms = [...new Set(vault.backlinksOf(e.path).map((b) => b.from))];
        const linkers = await Promise.all(froms.map(async (path) => ({ path, text: (await vault.fs.readText(path)) ?? '' })));
        const r = planRename({ note: { path: e.path, text: (await vault.fs.readText(e.path)) ?? '' }, newTitle: new_title, linkers, titles: vault.targets().notes, starred: await vault.fs.readText(STARRED) });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('rename_note', { from: e.path, to: new_title, rewritten: r.rewritten });
        const n = r.rewritten.length;
        return ok(`Renamed "${e.title}" to "${nfc(new_title).trim()}"; updated links in ${n} note${n === 1 ? '' : 's'}.`);
      }),
  );

  server.registerTool(
    'move_note',
    { title: 'Move a note', description: 'Move a note to another folder. Links are title-only, so no link changes.', inputSchema: { title: z.string().min(1), folder: z.string() }, annotations: DESTRUCTIVE },
    async ({ title, folder }) =>
      write(async () => {
        const e = noteOr(title);
        const r = planMove({ note: { path: e.path, text: '' }, folder, paths: new Set([...vault.entries.keys()].map(titleKey)) });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('move_note', { from: e.path, folder });
        return ok(`Moved "${e.title}" to ${folder.replace(/^\/+|\/+$/g, '') || 'the top folder'}.`);
      }),
  );

  server.registerTool(
    'delete_note',
    { title: 'Delete a note', description: "Move a note to today's folder in .brain/trash/, where it stays restorable for 30 days.", inputSchema: { title: z.string().min(1) }, annotations: DESTRUCTIVE },
    async ({ title }) =>
      write(async () => {
        const e = noteOr(title);
        const day = ymd(vault.now());
        const taken = new Set((await vault.fs.list(`.brain/trash/${day}`)).map(titleKey));
        const r = planDelete({ note: { path: e.path, text: '' }, date: day, taken });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('delete_note', { path: e.path });
        return ok(`Moved "${e.title}" to .brain/trash/${day}/. Restore it from there within 30 days.`);
      }),
  );
}
```
`planMove` and `planDelete` only read `note.path`, so they get `text: ''`. The copy step moves the bytes on disk.

In `mcp/brain/server.ts`, add `import { registerWriteTools } from './tools/write';` and call `registerWriteTools(server, vault);` after `registerReadTools(...)`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/server.write.test.ts && npm run typecheck`
Expected: PASS (6 tests plus the 30-run model), clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/tools/write.ts mcp/brain/server.ts mcp/brain/server.write.test.ts
git commit -m "Vault MCP: write tools, one at a time, history before every change, and a model run that never loses an edit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 26: Import tools: staging, attachments, and a promote gated on the fidelity audit

**Files:**
- Create: `mcp/brain/tools/import.ts`
- Modify: `mcp/brain/server.ts`: register the import tools and pass `opts.fetch`
- Test: `mcp/brain/server.import.test.ts`

**Interfaces:**
- Consumes:
  - `Vault.stagingDigest`, `Vault.execute(plan, { promoting: true })` (Task 22)
  - `safeTitle`, `titleOf`, `titleKey` (Task 11)
  - `newPlanId` (Task 18)
- Produces:
  - **`stage_note { area, path, text }`:** writes `.brain/staging/<area>/<path>`.
  - **`stage_attachment { area, url, filename }`:** https only; the file lands in `.brain/staging/<area>/attachments/<filename>`.
  - **`promote_staging { area }`:**
    - It requires `.brain/reports/<area>-audit.json` with `{ "pass": true, "digest": <stagingDigest(area)> }`. Plan 2's `brain:audit` writes that file.
    - It refuses on any title clash, any attachment overwrite with different bytes, or any mismatch.
    - It copies everything into place through one journaled plan, then empties the area's staging folder.

- [ ] **Step 1: Write the failing tests**

Create `mcp/brain/server.import.test.ts`:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testServer } from './testServer';

let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());
const fakeFetch = (async (url: string) =>
  url.endsWith('/expired') ? new Response('gone', { status: 403 }) : new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })) as unknown as typeof fetch;
const audit = async (area: string, pass = true) =>
  writeFile(join(t.root, '.brain', 'reports', `${area}-audit.json`), JSON.stringify({ pass, digest: await t.vault.stagingDigest(area) }));

describe('import tools', () => {
  it('stages notes, sources and attachments where the import expects them', async () => {
    t = await testServer({ '.brain/reports/.keep': '' }, { fetch: fakeFetch });
    expect((await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid\n' })).text).toBe('Staged Concepts/Sigmoid.md for pilot.');
    expect((await t.call('stage_note', { area: 'pilot', path: 'sources/notion/Lecture 3 (abc).md', text: 'raw' })).error).toBe(false);
    expect((await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'sigmoid.png' })).text).toMatch(/^Staged attachments\/sigmoid\.png \(4 bytes, sha256 [0-9a-f]{64}\)\.$/);
    expect(await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/expired', filename: 'a.png' })).toEqual({
      text: 'Download failed with HTTP 403; fetch a fresh signed URL from Notion and retry.',
      error: true,
    });
  });
  it('refuses unsafe areas, paths and URLs', async () => {
    t = await testServer({}, { fetch: fakeFetch });
    expect((await t.call('stage_note', { area: '../x', path: 'a.md', text: '' })).error).toBe(true);
    for (const path of ['.brain/x.md', '.obsidian/a.md', 'attachments/a.md', 'a.txt', 'A/B: c.md']) expect((await t.call('stage_note', { area: 'pilot', path, text: '' })).error, path).toBe(true);
    expect((await t.call('stage_attachment', { area: 'pilot', url: 'http://file.notion.so/x.png', filename: 'x.png' })).text).toBe('Only https URLs are fetched.');
  });
  it('promotes only what a passing audit covered, then empties staging', async () => {
    t = await testServer({ '.brain/reports/.keep': '', 'Concepts/Sigmoid.md': '# Old sigmoid\n' }, { fetch: fakeFetch });
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid, merged\n' });
    await t.call('stage_note', { area: 'pilot', path: 'sources/notion/Lecture 3 (abc).md', text: 'raw' });
    await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'sigmoid.png' });
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toMatch(/no passing fidelity audit/);
    await audit('pilot', false);
    expect((await t.call('promote_staging', { area: 'pilot' })).error).toBe(true);
    await audit('pilot');
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Late.md', text: 'added after the audit' });
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toMatch(/no passing fidelity audit/);
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('Promoted 4 files from pilot.');
    expect(await readFile(join(t.root, 'Concepts/Sigmoid.md'), 'utf8')).toBe('# Sigmoid, merged\n');
    expect(await readFile(join(t.root, 'sources/notion/Lecture 3 (abc).md'), 'utf8')).toBe('raw');
    expect([...(await readFile(join(t.root, 'attachments/sigmoid.png')))]).toEqual([137, 80, 78, 71]);
    expect(await t.vault.fs.walk('.brain/staging/pilot')).toEqual([]);
    const [stamp] = await t.vault.fs.listDirs('.brain/history/2026-10-14');
    expect(await t.vault.fs.readText(`.brain/history/2026-10-14/${stamp}/Concepts/Sigmoid.md`)).toBe('# Old sigmoid\n');
  });
  it('refuses a staged title another note owns, and an attachment with different bytes', async () => {
    t = await testServer({ '.brain/reports/.keep': '', 'Inbox/Sigmoid.md': '# Sigmoid\n', 'attachments/a.png': 'other' }, { fetch: fakeFetch });
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid\n' });
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('"Sigmoid" is already used by Inbox/Sigmoid.md');
    await t.close();
    t = await testServer({ '.brain/reports/.keep': '', 'attachments/a.png': 'other' }, { fetch: fakeFetch });
    await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'a.png' });
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('attachments/a.png already exists with different content; stage it under another name.');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run mcp/brain/server.import.test.ts`
Expected: FAIL with `Tool stage_note not found`.

- [ ] **Step 3: Implement**

Create `mcp/brain/tools/import.ts`:
```ts
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { safeTitle, titleKey, titleOf } from '../../../src/shared/brain/names';
import { newPlanId, type Step } from '../../../src/shared/brain/plan';
import type { Vault } from '../vault';
import { DESTRUCTIVE, fail, guard, IDEMPOTENT, IDEMPOTENT_OPEN, ok } from './common';

const AREA = /^[\p{L}\p{N}][\p{L}\p{N} _&-]{0,60}$/u;
const MAX_BYTES = 100 * 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Where a staged note may go: a note or .base anywhere notes live, or a verbatim page under sources/notion/. */
function stagePathProblem(path: string): string | null {
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..') || path.includes('\\')) return 'not a vault path';
  if (/^(\.brain|\.obsidian|attachments)(\/|$)/i.test(path)) return 'that folder is not staged through stage_note';
  if (!/\.(md|base)$/i.test(path)) return 'only .md and .base files are staged as notes';
  if (/\.md$/i.test(path) && !/^sources\//i.test(path)) {
    const title = titleOf(path);
    const safe = safeTitle(title, parts.slice(0, -1).join('/')).title;
    if (safe !== title) return `"${title}" cannot be a file name; use "${safe}" and keep the original in aliases`;
  }
  return null;
}

export function registerImportTools(server: McpServer, vault: Vault, fetchImpl: typeof fetch = fetch): void {
  server.registerTool(
    'stage_note',
    {
      title: 'Stage an imported note',
      description: 'Write a note for the Notion import into .brain/staging/<area>/, at the vault path it will be promoted to. Nothing in the vault changes until promote_staging.',
      inputSchema: { area: z.string().regex(AREA), path: z.string().min(1), text: z.string() },
      annotations: IDEMPOTENT,
    },
    async ({ area, path, text }) =>
      guard(vault, async () => {
        const problem = stagePathProblem(path);
        if (problem) return fail(`${path}: ${problem}.`);
        await vault.fs.writeText(`.brain/staging/${area}/${path}`, text);
        return ok(`Staged ${path} for ${area}.`);
      }),
  );

  server.registerTool(
    'stage_attachment',
    {
      title: 'Stage an attachment',
      description: 'Download a file (a Notion signed URL) into .brain/staging/<area>/attachments/<filename>. Signed URLs expire: on an HTTP error, fetch a fresh URL and retry.',
      inputSchema: { area: z.string().regex(AREA), url: z.string().url(), filename: z.string().min(1).max(200) },
      annotations: IDEMPOTENT_OPEN,
    },
    async ({ area, url, filename }) =>
      guard(vault, async () => {
        if (!url.startsWith('https://')) return fail('Only https URLs are fetched.');
        if (/[/\\]|^\.|\0/.test(filename)) return fail(`"${filename}" is not a file name.`);
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return fail(`Download failed with HTTP ${res.status}; fetch a fresh signed URL from Notion and retry.`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_BYTES) return fail(`${filename} is ${bytes.length} bytes, over the 100 MB limit.`);
        await vault.fs.writeBytes(`.brain/staging/${area}/attachments/${filename}`, bytes);
        return ok(`Staged attachments/${filename} (${bytes.length} bytes, sha256 ${sha256(bytes)}).`);
      }),
  );

  server.registerTool(
    'promote_staging',
    {
      title: 'Promote a staged area',
      description: 'Move everything staged for an area into the vault in one journaled step. Refused unless the fidelity audit passed for exactly what is staged, and on any title or attachment clash.',
      inputSchema: { area: z.string().regex(AREA) },
      annotations: DESTRUCTIVE,
    },
    async ({ area }) =>
      guard(vault, () =>
        vault.serial(async () => {
          await vault.refresh();
          const dir = `.brain/staging/${area}`;
          const staged = (await vault.fs.walk(dir)).map((f) => f.path.slice(dir.length + 1));
          if (!staged.length) return fail(`Nothing is staged for ${area}.`);
          const auditText = await vault.fs.readText(`.brain/reports/${area}-audit.json`);
          const audit = auditText ? (JSON.parse(auditText) as { pass?: boolean; digest?: string }) : null;
          if (!audit?.pass || audit.digest !== (await vault.stagingDigest(area))) {
            return fail(`${area} has no passing fidelity audit for exactly what is staged. Run the audit (npm run brain:audit) on the current staging first.`);
          }
          const owners = vault.targets().notes;
          const seen = new Map<string, string>();
          for (const rel of staged) {
            if (!/\.md$/i.test(rel) || /^sources\//i.test(rel) || /^attachments\//i.test(rel)) continue;
            const key = titleKey(titleOf(rel));
            const owner = owners.get(key);
            if (owner && titleKey(owner) !== titleKey(rel)) return fail(`"${titleOf(rel)}" is already used by ${owner}`);
            const twin = seen.get(key);
            if (twin) return fail(`"${titleOf(rel)}" is staged twice: ${twin} and ${rel}`);
            seen.set(key, rel);
          }
          for (const rel of staged.filter((r) => /^attachments\//i.test(r))) {
            const existing = await vault.fs.readBytes(rel);
            const incoming = await vault.fs.readBytes(`${dir}/${rel}`);
            if (existing && incoming && sha256(existing) !== sha256(incoming)) return fail(`${rel} already exists with different content; stage it under another name.`);
          }
          const steps: Step[] = [...staged.map((rel): Step => ({ op: 'copy', from: `${dir}/${rel}`, to: rel })), ...staged.map((rel): Step => ({ op: 'remove', path: `${dir}/${rel}` }))];
          await vault.execute({ id: newPlanId(), label: `promote ${area}`, steps }, { promoting: true });
          await vault.log('promote_staging', { area, files: staged.length });
          return ok(`Promoted ${staged.length} files from ${area}.`);
        }),
      ),
  );
}
```

In `mcp/brain/server.ts`, add `import { registerImportTools } from './tools/import';` and call `registerImportTools(server, vault, opts.fetch);` after `registerWriteTools(...)`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run mcp/brain/server.import.test.ts && npm run typecheck`
Expected: PASS (4 tests), clean.

- [ ] **Step 5: Commit**

Run `npm test` and `/verify` first.
```bash
git add mcp/brain/tools/import.ts mcp/brain/server.ts mcp/brain/server.import.test.ts
git commit -m "Vault MCP: staging and a promote that only moves what a passing fidelity audit covered

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 27: Register the server, and test the bundle over stdio

**Files:**
- Create:
  - `.mcp.json`
  - `.claude/settings.json`
  - `mcp/brain/README.md`
- Modify: `package.json`: `build` also bundles the server; add `brain:diff-obsidian`
- Test: `mcp/brain/stdio.test.ts`

**Interfaces:**
- Consumes: everything in Part D.
- Produces:
  - A registered `brain` MCP server, whose vault path comes from `$BRAIN_VAULT`.
  - The five read tools allowlisted.
  - A deny rule keeping Claude out of the recall questions.
  - CI building the bundle on every push.

- [ ] **Step 1: Write the failing test**

Create `mcp/brain/stdio.test.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeVault } from './testServer';

type Text = { content: { text: string }[] };
let out = '';
let root = '';
let client: Client;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'brain-dist-'));
  // The same bundle `npm run build:mcp` makes, so this tests what Claude Code actually runs.
  await build({
    entryPoints: ['mcp/brain/server.ts', 'mcp/brain/searchWorker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: out,
    outExtension: { '.js': '.mjs' },
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    logLevel: 'error',
  });
  root = await writeVault({ 'Concepts/Slow.md': `# Slow\n\n${'a'.repeat(32)}!\n`, 'Concepts/Fast.md': '# Fast\n\nfine\n' });
  client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(out, 'server.mjs')], env: { ...process.env, BRAIN_VAULT: root } as Record<string, string> }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  await rm(out, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe('the bundled server over stdio', () => {
  it('offers all fifteen tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'backlinks', 'create_note', 'daily_note', 'delete_note', 'edit_note', 'list_folder', 'list_moc', 'move_note',
      'promote_staging', 'read_note', 'rename_note', 'search', 'stage_attachment', 'stage_note', 'write_note',
    ]);
  });
  it('reads and writes the vault BRAIN_VAULT names', async () => {
    await client.callTool({ name: 'create_note', arguments: { title: 'Hello', text: '# Hello\n' } });
    const r = (await client.callTool({ name: 'read_note', arguments: { title: 'Hello' } })) as Text;
    expect(r.content[0].text).toBe('path: Inbox/Hello.md\n\n# Hello\n');
  });
  it('stops a catastrophic regex at 2 s and keeps answering', async () => {
    const t0 = Date.now();
    const r = (await client.callTool({ name: 'search', arguments: { query: '/(a+)+$/' } })) as Text;
    expect(r.content[0].text).toContain('Partial results');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const after = (await client.callTool({ name: 'search', arguments: { query: 'fine' } })) as Text;
    expect(after.content[0].text).toBe('Fast (Concepts/Fast.md)');
  }, 15_000);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run mcp/brain/stdio.test.ts`
Expected: PASS (3 tests). It can pass already, since Tasks 24 to 26 built the server. If the regex test fails, the worker path or the batch posting in `searchWorker.ts` is wrong; fix that, not the test.

- [ ] **Step 3: Register the server, the permissions and the scripts**

Create `.mcp.json`:
```json
{
  "mcpServers": {
    "brain": {
      "type": "stdio",
      "command": "node",
      "args": ["dist-mcp/server.mjs"],
      "env": { "BRAIN_VAULT": "${BRAIN_VAULT}" }
    }
  }
}
```

Create `.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "mcp__brain__search",
      "mcp__brain__read_note",
      "mcp__brain__backlinks",
      "mcp__brain__list_moc",
      "mcp__brain__list_folder"
    ],
    "deny": [
      "Read(~/Library/CloudStorage/**/.brain/reports/recall-questions.md)",
      "Read(//**/.brain/reports/recall-questions.md)"
    ]
  }
}
```
The write and import tools are left off the allowlist on purpose, so Claude Code asks before each one (spec, Vault MCP server: Tools). Plan 2 allowlists `stage_note` and `stage_attachment` in `.claude/settings.local.json` for the import session only.

In `package.json`, change `build` and add one script, leaving the rest as is:
```json
    "build": "tsc --noEmit && vite build && npm run build:content && npm run build:mcp",
    "brain:diff-obsidian": "npm run -s brain -- diff-obsidian",
```

Create `mcp/brain/README.md`:
```markdown
# Vault MCP server and brain tools

Lets Claude Code read and edit the second-brain vault (spec: docs/superpowers/specs/2026-10-14-second-brain-design.md, "Vault MCP server").

## Set up (Mac)

1. Build: `npm run build:mcp` (also part of `npm run build`).
2. Point it at the vault, in your shell profile: `export BRAIN_VAULT="$HOME/Library/CloudStorage/GoogleDrive-<account>/My Drive/brain"`.
3. Restart Claude Code in this repo and approve the `brain` server from `.mcp.json` when asked. `/mcp` should show it connected.

## Tools

- Read, no prompt: `search` (Obsidian syntax), `read_note`, `backlinks`, `list_moc`, `list_folder`.
- Write, Claude Code asks each time: `daily_note`, `create_note`, `write_note`, `edit_note`, `rename_note`, `move_note`, `delete_note`.
- Import: `stage_note`, `stage_attachment`, and `promote_staging`, which needs a passing fidelity audit for exactly what is staged.

## Safety

- Writes go to a temporary file that is then renamed into place, so a crash never leaves half a note.
- Every write tool copies the old file into `.brain/history/<date>/` first. Copies are kept 7 days.
- Rename, move, delete and promote run through a journal in `.brain/journal/`, which finishes them after a crash.
- The server never writes `sources/` (except when promoting), `.obsidian/`, or `.brain/` outside its own folders.
- `edit_note` and `write_note` refuse a note that changed since Claude last read it.
- Every write is logged to `.brain/mcp-log.jsonl`.

## Local tools

`node dist-mcp/cli.mjs <command>` runs these:

- `usage`, `notion-links`, `cards`, `recall`, `tree-test`, `baseline`: the step 0 baseline
- `drive-probe`: the step 1 platform measurements
- `diff-obsidian`: our index against Obsidian's own

They write only to `<vault>/.brain/reports/`.
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean. The build ends with `dist-mcp/server.mjs`, `dist-mcp/searchWorker.mjs` and `dist-mcp/cli.mjs`.

- [ ] **Step 5: Commit**

Run `/verify` first.
```bash
git add .mcp.json .claude/settings.json mcp/brain/README.md mcp/brain/stdio.test.ts package.json
git commit -m "Vault MCP: registered for Claude Code, read tools allowlisted, recall questions denied, bundle tested over stdio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Connect it for real (user)**

1. Add the `export BRAIN_VAULT=…` line from the README to `~/.zshrc`, then open a new terminal.
2. Restart Claude Code in this repo, approve the `brain` server, and run `/mcp`.
   - Expected: `brain` is connected, with 15 tools.
3. Ask Claude to call `list_folder`. It should answer without a permission prompt and list the vault's folders; hidden ones such as `.brain` are not shown. Then ask for `daily_note`: Claude Code must ask for permission first, which shows that write tools are not allowlisted. Approve it, then check that `daily/<today>.md` appears in Drive.

---

### Task 28: Checkpoint, and the hand-off to plan 2

**Files:**
- Modify: `/Users/aakashvardhan/.claude/projects/-Users-aakashvardhan-Documents-adhd-chrome-reader/memory/second-brain-plan.md`. This is Claude's memory, not the repo.

**Interfaces:**
- Consumes: the baseline report (Task 6), the measured platform (Task 10), and a green suite.
- Produces: the inputs plan 2 is written from.

- [ ] **Step 1: Prove the state**

Run: `npm run typecheck && npm test && npm run build && git status --short`
Expected:
- Everything passes.
- `git status` shows only the user's untouched Pomodoro files. They are the same list as before this plan started; compare it with the `git status` from the start of the session.

- [ ] **Step 2: Check the plan against the spec's build steps 0 to 3**

Confirm each item, with its evidence:

| Spec item | Evidence |
|---|---|
| Baseline: usage, recall benchmark run in Notion, card sort, Notion export, link measure | `baseline.md` in `.brain/reports/` with every row filled (Task 6) |
| Platform ground truth | "Measured platform" section of the spec (Task 10) |
| `src/shared/brain/*` test first: unit, property and fixture tests | Tasks 11 to 20 and 23 green |
| Oracles, part 1: parser differentials (frontmatter against `yaml`, blocks against CommonMark), the Obsidian diff of the fixture vault, crash at every journal step, model-based link and concurrency proofs | Tasks 12, 13, 18, 19, 23, 25 |
| MCP server, its concurrency and guard tests, registration | Tasks 21 to 27 |

- [ ] **Step 3: Record progress in memory**

Append to the memory file, with today's date:
```markdown
**Plan 1 done (<date>):** baseline taken (baseline.md), platform measured (spec "Measured platform"), shared core + vault MCP server built and registered (Tasks 1-27). Next: plan 2 = area map from card sort + tree test, brain:audit (fidelity audit + digest for promote_staging), Notion import pilot (Deep Learning Class) then other areas, Links handoff file, stop A (diff-obsidian on the real vault, zero unresolved).
```

- [ ] **Step 4: Tell the user, and stop**

Report to the user:
- What was measured: the baseline numbers, and any platform finding that changed the spec.
- What was built.
- Every Obsidian deviation recorded, and every CommonMark parser gap, with its reason.

Then ask to write plan 2. Plan 2 needs these, which now exist:
- The card-sort groups.
- The measured Drive behaviour.
- The Notion export path.
