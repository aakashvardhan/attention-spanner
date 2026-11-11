import { Worker } from 'node:worker_threads';
import { rankHits, type Hit, type SearchDoc } from './lib/search';
import type { SearchRequest } from './searchWorker';

export type SearchRunner = (query: string, docs: SearchDoc[], limit: number) => Promise<{ hits: Hit[]; partial: boolean }>;

/**
 * A regex can backtrack for minutes inside one note, and JavaScript cannot
 * interrupt it. So regex searches run in a worker that is stopped after `ms`,
 * keeping whatever it had already found (spec, Search: cut off at 2 s).
 *
 * The worker stays up between searches and keeps its own copy of the docs, so a
 * search sends only the docs that changed (toSearchDoc keeps one object per
 * index entry) instead of cloning the whole vault. A stopped worker is replaced
 * by a new one, which gets everything again. Searches run one at a time.
 */
export function workerSearch(workerUrl: URL, ms = 2_000): SearchRunner {
  let worker: Worker | null = null;
  let sent = new Map<string, SearchDoc>();
  let turn: Promise<unknown> = Promise.resolve();
  let nextId = 0;

  const start = () => {
    const w = new Worker(workerUrl);
    // An idle worker must not keep the server alive after stdin closes.
    w.unref();
    w.once('exit', () => {
      if (worker !== w) return;
      worker = null;
      sent = new Map();
    });
    sent = new Map();
    return (worker = w);
  };

  const run = (query: string, docs: SearchDoc[], limit: number) =>
    new Promise<{ hits: Hit[]; partial: boolean }>((resolveSearch, reject) => {
      const w = worker ?? start();
      const live = new Set(docs.map((d) => d.path));
      const req: SearchRequest = { id: ++nextId, query, put: docs.filter((d) => sent.get(d.path) !== d), drop: [...sent.keys()].filter((p) => !live.has(p)) };
      const hits: Hit[] = [];
      let settled = false;
      const finish = (partial: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onMessage).off('error', onError).off('exit', onExit);
        if (partial || error !== undefined) {
          // Stopped or broken: the next search starts a fresh worker.
          if (worker === w) worker = null;
          void w.terminate();
        }
        if (error !== undefined) reject(error);
        else resolveSearch({ hits: rankHits(hits).slice(0, limit), partial });
      };
      const onMessage = (m: { id: number; hits?: Hit[]; done?: boolean }) => {
        if (m.id !== req.id) return;
        if (m.hits) hits.push(...m.hits);
        if (m.done) finish(false);
      };
      const onError = (e: unknown) => finish(false, e);
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(true), ms);
      w.on('message', onMessage).on('error', onError).on('exit', onExit);
      for (const d of req.put) sent.set(d.path, d);
      for (const p of req.drop) sent.delete(p);
      w.postMessage(req);
    });

  return (query, docs, limit) => {
    const r = turn.then(() => run(query, docs, limit));
    turn = r.catch(() => undefined);
    return r;
  };
}
