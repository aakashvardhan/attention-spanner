import { createServer } from 'node:http';

/**
 * Just enough of Ollama for the triage card: /api/tags and /api/show for the
 * health check, /api/embed for vectors. Text containing a key of `clusters`
 * gets that vector; everything else gets its own, unrelated one.
 */
export async function startOllamaMock(clusters: Record<string, number[]>): Promise<{ url: string; close(): Promise<void> }> {
  const DIM = 8;
  const own = (text: string) => {
    const v = Array.from({ length: DIM }, () => 0);
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] = 1;
    v[(h >>> 8) % DIM] += 0.5;
    return v;
  };
  const vectorFor = (text: string) => {
    const key = Object.keys(clusters).find((k) => text.toLowerCase().includes(k));
    return key ? clusters[key] : own(text);
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }));
      if (req.url === '/api/show') return res.end('{}');
      if (req.url === '/api/embed') {
        const input = (JSON.parse(body) as { input: string[] }).input;
        return res.end(JSON.stringify({ embeddings: input.map(vectorFor) }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
