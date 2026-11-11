import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { PlanFs } from './lib/plan';

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
          // Gone since readdir: a temp file renamed into place, or a sync client's own.
          const s = await fsp.stat(abs(child)).catch((e: unknown) => {
            if (missing(e)) return null;
            throw e;
          });
          if (s) out.push({ path: child, mtimeMs: s.mtimeMs, size: s.size });
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
