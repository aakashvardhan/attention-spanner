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
