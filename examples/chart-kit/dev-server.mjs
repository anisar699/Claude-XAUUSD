// Runs the chart in a desktop browser:  node dev-server.mjs   ->  http://127.0.0.1:8770
// It serves ./web and answers /api/proxy the same way android/ApiProxy.kt does.
// Needs Node 18 or newer. Behind an HTTPS proxy, start it with NODE_USE_ENV_PROXY=1.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const PORT = Number(process.argv[2] || 8770);

// Allowed host -> extra headers. Keep in sync with ApiProxy.kt.
const HOSTS = {
  'freeserv.dukascopy.com': { Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' },
};
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

async function proxy(target, res) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return res.writeHead(400).end('bad url');
  }
  if (u.protocol !== 'https:' || !(u.hostname in HOSTS)) return res.writeHead(403).end('host not allowed');
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: '*/*', ...HOSTS[u.hostname] }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502).end(String(e.message || e));
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/proxy') return proxy(url.searchParams.get('u') || '', res);
    const rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const file = path.join(ROOT, decodeURIComponent(rel));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`chart on http://127.0.0.1:${PORT}`));
