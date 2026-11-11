import { parentPort } from 'node:worker_threads';
import { parseQuery } from './lib/query';
import { search, type SearchDoc } from './lib/search';

/** One message per search: the docs that changed since the last one, then the query (regexSearch.ts). */
export interface SearchRequest { id: number; query: string; put: SearchDoc[]; drop: string[] }

const docs = new Map<string, SearchDoc>();
parentPort!.on('message', ({ id, query, put, drop }: SearchRequest) => {
  for (const d of put) docs.set(d.path, d);
  for (const p of drop) docs.delete(p);
  const q = parseQuery(query);
  const all = [...docs.values()];
  // Small batches, so the hits found before a runaway note survive the worker being stopped.
  for (let i = 0; i < all.length; i += 50) parentPort!.postMessage({ id, hits: search(q, all.slice(i, i + 50)) });
  parentPort!.postMessage({ id, done: true });
});
