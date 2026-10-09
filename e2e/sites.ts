import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Sites {
  port: number;
  /** `http://<host>.e2e.test:<port>` */
  origin(host: string): string;
  setRoute(host: string, path: string, handler: Handler): void;
  close(): Promise<void>;
}

export const html = (body: string, head = ''): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`);
};

export const rss = (title: string, items: string[]): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>http://x/</link>` +
      items.map((t, i) => `<item><title>${t}</title><link>http://x/${i}</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>`).join('') +
      `</channel></rss>`,
  );
};

export const status = (code: number): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(String(code));
};

export async function startSites(): Promise<Sites> {
  const routes = new Map<string, Handler>();
  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0].replace(/\.e2e\.test$/, '');
    const path = (req.url ?? '/').split('?')[0];
    (routes.get(`${host}${path}`) ?? status(404))(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    origin: (host) => `http://${host}.e2e.test:${port}`,
    setRoute: (host, path, handler) => routes.set(`${host}${path}`, handler),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
