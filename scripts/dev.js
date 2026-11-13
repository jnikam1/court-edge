// Local stand-in for Vercel: serves the static files and the api/ handlers.  node scripts/dev.js  (PORT=4173)
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const f = path.join(root, 'api', path.basename(u.pathname) + '.js');
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('{}'); }
    try { return require(f)(req, res); } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: String(e.message) })); }
  }
  const rel = path.normalize(u.pathname).replace(/^([/\\])+/, ''); const f = path.join(root, rel);
  const ok = rel && f.startsWith(root) && !/^(api|lib|worker|scripts|node_modules)[/\\]/.test(rel) && TYPES[path.extname(f)] && fs.existsSync(f) && fs.statSync(f).isFile();
  const file = ok ? f : path.join(root, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(file)]); res.setHeader('Cache-Control', 'no-store'); res.end(fs.readFileSync(file));
}).listen(process.env.PORT || 4173, () => console.log('Court Edge on http://localhost:' + (process.env.PORT || 4173)));
