import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const routes = new Map([
  ['/api/parseExpense', new URL('../api/parseExpense.js', import.meta.url)],
  ['/api/previewExpense', new URL('../api/previewExpense.js', import.meta.url)],
  ['/api/expenses', new URL('../api/expenses.js', import.meta.url)],
  ['/api/analytics', new URL('../api/analytics.js', import.meta.url)],
  ['/api/auth', new URL('../api/auth.js', import.meta.url)],
  ['/api/reports', new URL('../api/reports.js', import.meta.url)],
]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (routes.has(url.pathname)) {
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
      req.query = Object.fromEntries(url.searchParams);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) {
          res.status(413).json({ success: false, data: null, message: 'Request too large.', error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request too large.' } });
          return;
        }
        chunks.push(chunk);
      }
      req.body = Buffer.concat(chunks).toString('utf8');
      const { default: handler } = await import(routes.get(url.pathname));
      await handler(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(publicRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
    const content = await readFile(path);
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    res.statusCode = error.code === 'ENOENT' ? 404 : 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(res.statusCode === 404 ? 'Not found' : 'Could not complete this request.');
    if (res.statusCode === 500) console.error(error.name, error.message);
  }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Penny is ready at http://localhost:${server.address().port}`));
