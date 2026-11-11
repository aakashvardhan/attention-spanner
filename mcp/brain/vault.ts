import { createHash } from 'node:crypto';
import { ymd } from './lib/daily';
import { backlinks, buildEntry, duplicateTitles, targetsOf, type IndexEntry } from './lib/entry';
import type { Link, Targets } from './lib/links';
import { titleKey, titleOf } from './lib/names';
import { recover, runPlan, type Plan } from './lib/plan';
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
  private refreshing: Promise<void> = Promise.resolve();
  private promoting = false;

  private constructor(
    root: string,
    readonly now: () => Date,
  ) {
    this.fs = nodeFs(root, (rel) => serverMayWrite(rel, this.promoting));
  }

  /** `maintain` sweeps temp files, finishes journals and old history (spec, Start). Read-only tools pass false. */
  static async open(root: string, opts: { now?: () => Date; maintain?: boolean } = {}): Promise<Vault> {
    const v = new Vault(root, opts.now ?? (() => new Date()));
    if (opts.maintain !== false) {
      await v.fs.sweepTmp();
      // Only this server writes journals, for plans it already checked; an interrupted promote must be able to finish into sources/.
      v.promoting = true;
      try {
        await recover(v.fs);
      } finally {
        v.promoting = false;
      }
      await v.sweepHistory();
    }
    await v.refresh();
    return v;
  }

  /**
   * Re-reads only files whose modification time or size changed. One at a time: a read tool's
   * refresh runs outside the write queue, and an older walk finishing last would drop newer files.
   */
  refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.reindex());
    this.refreshing = run.catch(() => undefined);
    return run;
  }

  private async reindex(): Promise<void> {
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
