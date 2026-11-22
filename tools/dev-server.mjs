// Development server: serves the app's web UI and the same /api/proxy route
// the Android shell provides, so the UI can be run and tested in a desktop
// browser.   node tools/dev-server.mjs [port]
//
// Behind an HTTPS proxy, start it with NODE_USE_ENV_PROXY=1.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/src/main/assets/www');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);

// Keep in sync with ApiProxy.kt.
const HOSTS = {
  'freeserv.dukascopy.com': { Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' },
  'forex-data-feed.swissquote.com': {},
  'api.twelvedata.com': {},
};
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

async function proxy(target, res) {
  let u;
  try {
    u = new URL(target);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  if (u.protocol !== 'https:' || !(u.hostname in HOSTS)) {
    res.writeHead(403).end('host not allowed');
    return;
  }
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...HOSTS[u.hostname] },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    const body = Buffer.from(await r.arrayBuffer());
    // Same as AppWebClient.kt: feed answers are always served as plain text,
    // with only the feed's Date (as X-Upstream-Date) and Retry-After passed on.
    // (The shared cooldown of ApiProxy.kt is not repeated here.)
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (r.headers.get('date')) headers['X-Upstream-Date'] = r.headers.get('date');
    if (r.headers.get('retry-after')) headers['Retry-After'] = r.headers.get('retry-after');
    res.writeHead(r.status, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(e.message || e));
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/proxy') return proxy(url.searchParams.get('u') || '', res);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`dev server on http://127.0.0.1:${PORT}`));
