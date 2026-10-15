import { parentPort, workerData } from 'node:worker_threads';
import { parseQuery } from '../../src/shared/brain/query';
import { search, type SearchDoc } from '../../src/shared/brain/search';

const { query, docs } = workerData as { query: string; docs: SearchDoc[] };
const q = parseQuery(query);
// Small batches, so the hits found before a runaway note survive the worker being stopped.
for (let i = 0; i < docs.length; i += 50) parentPort!.postMessage({ hits: search(q, docs.slice(i, i + 50)).hits });
parentPort!.postMessage({ done: true });
