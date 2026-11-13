// Live Tennis API: point score and who is serving. Needs LIVETENNIS_API_KEY in the environment.
// LIVETENNIS_TTL (seconds) sets how often we call it. Default 900 keeps a free key under its
// 100-requests-a-day cap; a paid key can run at 10.
const { cached, lastName } = require('./kalshi');
const BASE = 'https://api.livetennisapi.com/api/public/v1';
const ttl = () => { const t = parseInt(process.env.LIVETENNIS_TTL || '900', 10); return Math.max(5, Number.isFinite(t) ? t : 900); };

async function call(path, key, scheme) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const headers = { Accept: 'application/json', 'User-Agent': 'court-edge/1.0' };
    if (scheme === 'bearer') headers.Authorization = 'Bearer ' + key; else headers['X-API-Key'] = key;
    const r = await fetch(BASE + path, { headers, signal: ctl.signal });
    const limits = { limit: r.headers.get('x-ratelimit-limit'), remaining: r.headers.get('x-ratelimit-remaining') };
    let body = null; try { body = await r.json(); } catch (e) { /* not json */ }
    return { status: r.status, body, limits };
  } finally { clearTimeout(timer); }
}

function slim(m) {
  const s = m.score || {}; const g = Array.isArray(s.games) ? s.games : [];
  const p1 = m.players && m.players.p1 ? m.players.p1.name : null; const p2 = m.players && m.players.p2 ? m.players.p2.name : null;
  return { id: m.id, p1, p2, k1: lastName(p1), k2: lastName(p2), tour: m.tour || null, tournament: m.tournament || null, surface: m.surface || null, indoor: !!m.indoor, round: m.round || null,
    games: [Array.isArray(g[0]) ? g[0] : [], Array.isArray(g[1]) ? g[1] : []], points: Array.isArray(s.points) ? s.points.map(String) : null,
    server: s.server === 1 || s.server === 2 ? s.server : null, tb: !!s.is_tiebreak, t: s.timestamp || null };
}

function live() {
  const key = process.env.LIVETENNIS_API_KEY;
  if (!key) return Promise.resolve({ off: true, reason: 'No LIVETENNIS_API_KEY set on the server.' });
  return cached('lt-live', ttl() * 1000, async () => {
    let r = await call('/matches?status=live&limit=200', key, 'bearer');
    if (r.status === 401 || r.status === 403) { const r2 = await call('/matches?status=live&limit=200', key, 'apikey'); if (r2.status === 200) r = r2; }
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data)) {
      return { off: true, status: r.status, reason: r.status === 429 ? 'The tennis feed says the daily request limit is used up.' : 'The tennis feed answered ' + r.status + '.', limits: r.limits, asOf: new Date().toISOString(), ttl: ttl() };
    }
    const matches = r.body.data.filter((m) => !m.is_doubles && m.players && m.players.p1 && m.players.p2).map(slim);
    return { asOf: new Date().toISOString(), ttl: ttl(), limits: r.limits, matches };
  });
}

module.exports = { live, ttl };
