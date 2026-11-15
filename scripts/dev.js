// Local development server: the real Worker code on a SQLite file (D1 stand-in), plus static files from /public.
// Run: npm run dev   (then open http://localhost:8787)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, migrate } from './d1-shim.js';
import { handleApi } from '../src/index.js';
import { runJobs } from '../src/services/jobs.js';
import { SECURITY_HEADERS } from '../src/lib/http.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(root, 'public');
mkdirSync(join(root, '.dev'), { recursive: true });
const DB = createD1(process.env.DB_FILE || join(root, '.dev', 'bonashub.sqlite'));
migrate(DB);
const env = { DB, DEV_MODE: true };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const r = await handleApi(new Request(url, { method: req.method, headers: req.headers, body }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) || extname(file) === '') file = join(PUBLIC, 'index.html');
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Frontend not built yet. The API is live at /api.'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...Object.fromEntries(Object.entries(SECURITY_HEADERS).filter(([k]) => k !== 'Cache-Control')), 'cache-control': 'no-cache' });
    res.end(data);
  } catch (e) { console.error(e); res.writeHead(500); res.end('Server error'); }
});
const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`BonasHub dev server: http://localhost:${port}  (payments: SANDBOX, DEV_MODE on)`));
setInterval(() => runJobs(env).catch((e) => console.error('jobs', e)), 60_000).unref();
