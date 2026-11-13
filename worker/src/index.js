// Court Edge logger (Cloudflare Worker).
// Every minute: read the app's own endpoints, store a price and score snapshot for each match in
// play, record new big whale adds, and send a phone notification for each new one.
// It also answers a few small requests from the app so a phone can sign up for notifications.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, created INTEGER, fails INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sent (id TEXT PRIMARY KEY, last INTEGER, t INTEGER)',
  'CREATE TABLE IF NOT EXISTS alerts (t INTEGER, id TEXT, whale TEXT, cat TEXT, title TEXT, outcome TEXT, added INTEGER, paid REAL, stake INTEGER, cur REAL, last INTEGER)',
  'CREATE TABLE IF NOT EXISTS snaps (t INTEGER, event TEXT, state TEXT, a_bid REAL, a_ask REAL, b_bid REAL, b_ask REAL, pm_a REAL, sets TEXT, points TEXT, server TEXT)',
  'CREATE INDEX IF NOT EXISTS snaps_event_t ON snaps (event, t)',
  'CREATE INDEX IF NOT EXISTS alerts_t ON alerts (t)',
];
let ready = false;
async function ensure(env) { if (ready) return; await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))); ready = true; }

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kvGet = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
const lastKey = (n) => { const t = String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' '); return t[t.length - 1] || ''; };

// The key pair that proves pushes come from this logger. Made once, kept in the database.
async function vapid(env) {
  const saved = await kvGet(env, 'vapid');
  if (saved) return JSON.parse(saved);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { priv: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  await kvSet(env, 'vapid', JSON.stringify(v));
  return v;
}

// A push with no body: the phone wakes the app's service worker, which fetches the alert text itself.
async function push(env, endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.APP_URL });
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const r = await fetch(endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + keys.pub } });
  return r.status;
}

async function pushAll(env) {
  const keys = await vapid(env);
  const { results } = await env.DB.prepare('SELECT endpoint FROM subs').all();
  let ok = 0; const statuses = [];
  for (const s of results || []) {
    let st = 0; try { st = await push(env, s.endpoint, keys); } catch (e) { st = -1; }
    statuses.push(st);
    if (st >= 200 && st < 300) ok++;
    else if (st === 404 || st === 410) await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(s.endpoint).run();
    else await env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE endpoint = ?').bind(s.endpoint).run();
  }
  return { phones: (results || []).length, delivered: ok, statuses };
}

const getJson = async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(url.split('/api/')[1] + ' ' + r.status); return r.json(); };

async function tick(env) {
  await ensure(env);
  const now = Math.floor(Date.now() / 1000); const note = { t: now };
  const [scan, feed, al] = await Promise.all([
    getJson(env.APP_URL + '/api/scan').catch((e) => ({ error: e.message })),
    getJson(env.APP_URL + '/api/feed').catch(() => ({ off: true })),
    getJson(env.APP_URL + '/api/alerts').catch((e) => ({ error: e.message })),
  ]);
  // 1) one row per match in play
  const stmts = [];
  if (scan && scan.matches) {
    const fm = feed && feed.matches ? feed.matches : [];
    for (const m of scan.matches) {
      if (m.state === 'upcoming') continue;
      const la = lastKey(m.a.name); const lb = lastKey(m.b.name);
      let x = null; let flip = false;
      for (const q of fm) { if (q.k1 === la && q.k2 === lb) { x = q; flip = false; } else if (q.k1 === lb && q.k2 === la) { x = q; flip = true; } }
      const sets = m.pm && m.pm.sets ? m.pm.sets : null;
      let points = null; let server = null;
      if (x && sets && sets.length) { // only keep feed data that agrees with the game score
        const ga = flip ? x.games[1] : x.games[0]; const gb = flip ? x.games[0] : x.games[1]; const n = sets.length - 1;
        if (ga.length === sets.length && ga[n] === sets[n][0] && gb[n] === sets[n][1]) { points = x.points ? (flip ? [x.points[1], x.points[0]] : x.points).join('-') : null; server = x.server ? ((x.server === 1) !== flip ? 'a' : 'b') : null; }
      }
      stmts.push(env.DB.prepare('INSERT INTO snaps (t, event, state, a_bid, a_ask, b_bid, b_ask, pm_a, sets, points, server) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(now, m.event, m.state, m.a.bid, m.a.ask, m.b.bid, m.b.ask, m.pm && m.pm.price ? m.pm.price[0] : null, sets ? JSON.stringify(sets) : null, points, server));
    }
    note.snaps = stmts.length;
  } else note.scanError = scan && scan.error;
  // 2) new big whale adds
  let fresh = 0;
  if (al && al.alerts) {
    for (const a of al.alerts) {
      const seen = await env.DB.prepare('SELECT last FROM sent WHERE id = ?').bind(a.id).first();
      if (seen && seen.last >= a.last) continue;
      fresh++;
      stmts.push(env.DB.prepare('INSERT INTO sent (id, last, t) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last = excluded.last, t = excluded.t').bind(a.id, a.last, now));
      stmts.push(env.DB.prepare('INSERT INTO alerts (t, id, whale, cat, title, outcome, added, paid, stake, cur, last) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(now, a.id, a.whale, a.cat, a.title, a.outcome, a.added, a.paid, a.stake, a.cur, a.last));
    }
    note.alerts = al.alerts.length; note.fresh = fresh;
  } else note.alertError = al && al.error;
  if (stmts.length) await env.DB.batch(stmts);
  // 3) tell the phone, but not on the very first run (everything looks new then)
  const first = !(await kvGet(env, 'started'));
  if (first) await kvSet(env, 'started', now);
  if (fresh && !first) note.push = await pushAll(env);
  await kvSet(env, 'last', JSON.stringify(note));
  return note;
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env).catch((e) => console.log('tick failed', e && e.message))); },
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      await ensure(env);
      if (url.pathname === '/vapid') return json({ key: (await vapid(env)).pub });
      if (url.pathname === '/status') {
        const day = Math.floor(Date.now() / 1000) - 86400;
        const [last, subs, snaps, snaps24, alerts, firstSnap] = await Promise.all([
          kvGet(env, 'last'), env.DB.prepare('SELECT COUNT(*) n FROM subs').first(), env.DB.prepare('SELECT COUNT(*) n FROM snaps').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM snaps WHERE t >= ?').bind(day).first(), env.DB.prepare('SELECT COUNT(*) n FROM alerts').first(), env.DB.prepare('SELECT MIN(t) t FROM snaps').first(),
        ]);
        return json({ ok: true, now: Math.floor(Date.now() / 1000), last: last ? JSON.parse(last) : null, phones: subs.n, snapshots: snaps.n, snapshots24h: snaps24.n, alertsLogged: alerts.n, since: firstSnap ? firstSnap.t : null });
      }
      if (url.pathname === '/subscribe' && req.method === 'POST') {
        const b = await req.json(); const ep = b && b.endpoint;
        if (typeof ep !== 'string' || !/^https:\/\//.test(ep) || ep.length > 1000) return json({ error: 'bad subscription' }, 400);
        await env.DB.prepare('INSERT INTO subs (endpoint, created) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET fails = 0').bind(ep, Math.floor(Date.now() / 1000)).run();
        return json({ ok: true });
      }
      if (url.pathname === '/unsubscribe' && req.method === 'POST') { const b = await req.json(); await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(String(b && b.endpoint)).run(); return json({ ok: true }); }
      if (url.pathname === '/test' && req.method === 'POST') return json(await pushAll(env));
      if (url.pathname === '/run' && req.method === 'POST') return json(await tick(env)); // one pass on demand, for checking
      if (url.pathname === '/alerts') { const r = await env.DB.prepare('SELECT * FROM alerts ORDER BY t DESC LIMIT 100').all(); return json({ alerts: r.results || [] }); }
      if (url.pathname === '/snaps') { // price history for one match
        const ev = url.searchParams.get('event'); if (!ev) return json({ error: 'event required' }, 400);
        const r = await env.DB.prepare('SELECT * FROM snaps WHERE event = ? ORDER BY t LIMIT 2000').bind(ev).all(); return json({ snaps: r.results || [] });
      }
      return json({ ok: true, what: 'Court Edge logger. See /status.' });
    } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); }
  },
};
