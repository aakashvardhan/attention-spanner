import { createServer } from 'node:http';
import { Laya } from '@receptron/laya';

/**
 * Laya on localhost for the extension (src/shared/llm/laya.ts). Laya runs on
 * onnxruntime-node, which an extension page cannot load, so it lives here the
 * way Ollama does on :11434. Loopback only: nothing it is asked leaves the
 * machine, and nothing else on the network can ask it.
 *
 * The first start downloads ~1.7 GB of weights; /health says ready:false
 * until they are loaded.
 */

const PORT = Number(process.env.LAYA_PORT ?? 11435);
const MAX_BODY = 256 * 1024;

let laya = null;
Laya.load()
  .then((model) => {
    laya = model;
    console.log(`Laya ready on http://127.0.0.1:${PORT}`);
  })
  .catch((err) => {
    console.error('Laya failed to load:', err);
    process.exit(1);
  });

function send(res, status, body, origin) {
  const headers = { 'content-type': 'application/json' };
  // Only extension pages may read answers; a web page's fetch gets no CORS grant.
  if (origin?.startsWith('chrome-extension://')) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type';
  }
  res.writeHead(status, headers);
  res.end(body === null ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ready: laya !== null }, origin);
  if (req.method !== 'POST' || req.url !== '/systemOne') return send(res, 404, { error: 'Not found' }, origin);
  if (!laya) return send(res, 503, { error: 'Model is still loading' }, origin);

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { error: err.message }, origin);
  }
  try {
    send(res, 200, await laya.systemOne(body.state, body.questions), origin);
  } catch (err) {
    // Laya throws on malformed questions or options over its 192-token limit.
    send(res, 400, { error: err.message }, origin);
  }
}).listen(PORT, '127.0.0.1');
