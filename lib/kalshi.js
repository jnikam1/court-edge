// Kalshi public market data. No API key.
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

async function getJson(url, opts) {
  const o = opts || {};
  for (let attempt = 0; attempt < (o.tries || 5); attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeout || 7000);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': o.ua || 'court-edge/1.0' }, signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 350 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error((o.label || 'HTTP') + ' ' + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === (o.tries || 5) - 1) throw e;
    } finally { clearTimeout(timer); }
  }
  throw new Error((o.label || 'HTTP') + ' rate limit');
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? '?' + s : '';
}

const kget = (path, params) => getJson(BASE + path + qs(params), { label: 'Kalshi' });

const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
const ts = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const sig = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const fee = (p) => 0.07 * p * (1 - p); // Kalshi taker fee per contract, before cent rounding
const mid = (b, a) => (b !== null && a !== null && a >= b && a > 0 && b < 1 ? (a + b) / 2 : null);
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const lastName = (s) => { const p = norm(s).split(' '); return p[p.length - 1] || ''; };

// tiny in-memory cache with shared in-flight promises
const store = new Map();
function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.p;
  const p = Promise.resolve().then(fn);
  store.set(key, { at: now, p });
  p.catch(() => { if (store.get(key) && store.get(key).p === p) store.delete(key); });
  return p;
}

module.exports = { BASE, getJson, qs, kget, num, ts, sig, logit, fee, mid, norm, lastName, cached };
