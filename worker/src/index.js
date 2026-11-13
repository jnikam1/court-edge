// Court Edge logger (Cloudflare Worker).
// Every minute: read the app's own endpoints, store a price and score snapshot for each tennis match
// in play and each NBA or NFL game near its start, record new big whale adds and injury report
// changes for key players, and send a phone notification for each new one.
// It also answers a few small requests from the app so a phone can sign up for notifications.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, created INTEGER, fails INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sent (id TEXT PRIMARY KEY, last INTEGER, t INTEGER)',
  'CREATE TABLE IF NOT EXISTS alerts (t INTEGER, id TEXT, whale TEXT, cat TEXT, title TEXT, outcome TEXT, added INTEGER, paid REAL, stake INTEGER, cur REAL, last INTEGER)',
  'CREATE TABLE IF NOT EXISTS snaps (t INTEGER, event TEXT, state TEXT, a_bid REAL, a_ask REAL, b_bid REAL, b_ask REAL, pm_a REAL, sets TEXT, points TEXT, server TEXT)',
  'CREATE INDEX IF NOT EXISTS snaps_event_t ON snaps (event, t)',
  'CREATE TABLE IF NOT EXISTS gsnaps (t INTEGER, lg TEXT, event TEXT, state TEXT, a_bid REAL, a_ask REAL, b_bid REAL, b_ask REAL, a_score INTEGER, b_score INTEGER, period INTEGER, clock REAL, book_a REAL)',
  'CREATE INDEX IF NOT EXISTS gsnaps_event_t ON gsnaps (event, t)',
  'CREATE TABLE IF NOT EXISTS inj (id TEXT PRIMARY KEY, lg TEXT, team TEXT, name TEXT, tag TEXT, t INTEGER, big INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS injlog (t INTEGER, lg TEXT, team TEXT, name TEXT, was TEXT, now TEXT, event TEXT, mid REAL, lo REAL, hi REAL, pushed INTEGER)',
  'CREATE INDEX IF NOT EXISTS injlog_t ON injlog (t)',
  'CREATE INDEX IF NOT EXISTS alerts_t ON alerts (t)',
];
let ready = false;
async function ensure(env) {
  if (ready) return; await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  try { await env.DB.prepare('ALTER TABLE inj ADD COLUMN big INTEGER DEFAULT 0').run(); } catch (e) { /* already there */ }
  ready = true;
}

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

const kUsd = (x) => '$' + (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1000) + 'k');
const nul = (x) => (x === undefined || x === null || Number.isNaN(x) ? null : x);
const HOT = ['Out', 'Doubtful', 'Questionable']; // statuses worth a phone alert
const getJson = async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(url.split('/api/')[1] + ' ' + r.status); return r.json(); };

async function tick(env) {
  await ensure(env);
  const now = Math.floor(Date.now() / 1000); const note = { t: now };
  const [scan, feed, al, sp] = await Promise.all([
    getJson(env.APP_URL + '/api/scan').catch((e) => ({ error: e.message })),
    getJson(env.APP_URL + '/api/feed').catch(() => ({ off: true })),
    getJson(env.APP_URL + '/api/alerts').catch((e) => ({ error: e.message })),
    getJson(env.APP_URL + '/api/sports?view=watch').catch((e) => ({ error: e.message })),
  ]);
  const notes = []; // what the phone should be told this minute
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
      notes.push({ id: 'w-' + a.id + '-' + a.last, t: now, kind: 'whale', url: '/#whales', title: a.whale + (a.fresh ? ' opened ' : ' added ') + kUsd(a.added) + ' on ' + (a.outcome || 'one side'), body: a.title + ' (' + a.cat + '). Bought at ' + Math.round(a.paid * 100) + '¢, stake now ' + kUsd(a.stake) + '.' });
    }
    note.alerts = al.alerts.length; note.fresh = fresh;
  } else note.alertError = al && al.error;
  const first = !(await kvGet(env, 'started'));
  if (first) await kvSet(env, 'started', now);
  if (first) notes.length = 0; // on the very first run everything looks new
  // 3) NBA and NFL: a price and score row per game near its start, and injury report changes for key players
  if (sp && sp.games) {
    for (const g of sp.games) stmts.push(env.DB.prepare('INSERT INTO gsnaps (t, lg, event, state, a_bid, a_ask, b_bid, b_ask, a_score, b_score, period, clock, book_a) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(now, g.lg, g.event, g.state, nul(g.ab), nul(g.aa), nul(g.bb), nul(g.ba), nul(g.sa), nul(g.sb), nul(g.period), nul(g.clock), nul(g.book)));
    note.games = sp.games.length;
    const firstInj = !(await kvGet(env, 'inj_started'));
    const known = new Map(((await env.DB.prepare('SELECT id, lg, team, name, tag, big FROM inj').all()).results || []).map((r) => [r.id, r]));
    const seen = new Set(); const hot = (t) => HOT.indexOf(t) >= 0; let changes = 0;
    for (const i of sp.inj || []) {
      if (!sp.feeds || !sp.feeds[i.lg] || seen.has(i.id)) continue; // a team with two games coming up is listed twice
      seen.add(i.id); const was = known.get(i.id); if (was && was.tag === i.tag) continue;
      stmts.push(env.DB.prepare('INSERT INTO inj (id, lg, team, name, tag, t, big) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tag = excluded.tag, t = excluded.t, big = excluded.big').bind(i.id, i.lg, i.team, i.name, i.tag, now, i.hi >= 4 ? 1 : 0));
      if (firstInj) continue;
      // a status change always counts. A name we have not seen before only counts if the report itself is recent.
      // Only players worth about 2.5 points or more reach the phone: top NBA scorers and starting quarterbacks. The rest is logged.
      const big = i.hi >= 4;
      const tell = big && (was ? hot(was.tag) || hot(i.tag) : hot(i.tag) && i.t && now - i.t < 3 * 3600);
      stmts.push(env.DB.prepare('INSERT INTO injlog (t, lg, team, name, was, now, event, mid, lo, hi, pushed) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(now, i.lg, i.team, i.name, was ? was.tag : null, i.tag, i.event, nul(i.mid), nul(i.lo), nul(i.hi), tell ? 1 : 0));
      changes++;
      if (tell) {
        const mins = i.start ? Math.round((i.start - now) / 60) : null; const when = mins === null ? '' : mins >= 90 ? ', starts in ' + Math.round(mins / 60) + 'h' : ', starts in ' + Math.max(0, mins) + ' min';
        notes.push({ id: 'i-' + i.id + '-' + i.tag + '-' + now, t: now, kind: 'injury', url: '/#m=' + i.event,
          title: i.lg.toUpperCase() + ': ' + i.name + ' ' + (i.tag === 'Out' ? 'OUT' : (was && !hot(i.tag) ? 'upgraded to ' : '') + i.tag.toLowerCase()) + (was && hot(i.tag) ? ' (was ' + was.tag.toLowerCase() + ')' : ''),
          body: i.teamName + ' v ' + i.vs + when + '. ' + (i.mid !== null && i.mid !== undefined ? i.teamName + ' ' + Math.round(i.mid * 100) + '¢ on Kalshi now. ' : '') + 'Rough worth ' + i.lo + ' to ' + i.hi + ' points (' + i.why + ').' });
      }
    }
    // gone from the report while the team is still about to play: cleared to play
    const teams = new Set(sp.teams || []);
    for (const [id, r] of known) {
      if (seen.has(id) || !sp.feeds || !sp.feeds[r.lg] || !teams.has(r.lg + '|' + r.team)) continue;
      stmts.push(env.DB.prepare('DELETE FROM inj WHERE id = ?').bind(id));
      if (firstInj) continue;
      stmts.push(env.DB.prepare('INSERT INTO injlog (t, lg, team, name, was, now, event, mid, lo, hi, pushed) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(now, r.lg, r.team, r.name, r.tag, 'Off the report', null, null, null, null, hot(r.tag) ? 1 : 0));
      changes++;
      if (hot(r.tag) && r.big) notes.push({ id: 'i-' + id + '-off-' + now, t: now, kind: 'injury', url: '/#' + r.lg, title: r.lg.toUpperCase() + ': ' + r.name + ' is off the injury report', body: r.team + '. Was ' + r.tag.toLowerCase() + '. Check the price before it moves.' });
    }
    if (firstInj && sp.feeds && (sp.feeds.nba || sp.feeds.nfl)) await kvSet(env, 'inj_started', now);
    note.injuries = (sp.inj || []).length; note.injuryChanges = changes;
  } else note.sportsError = sp && sp.error;
  for (let k = 0; k < stmts.length; k += 50) await env.DB.batch(stmts.slice(k, k + 50));
  // 4) tell the phone. The push itself is empty, so the text is left where the phone can fetch it.
  if (notes.length) {
    const old = JSON.parse((await kvGet(env, 'notes')) || '[]');
    await kvSet(env, 'notes', JSON.stringify(notes.concat(old).slice(0, 12)));
    note.push = await pushAll(env); note.told = notes.length;
  }
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
        const [last, subs, snaps, snaps24, alerts, firstSnap, gs, il, tracked] = await Promise.all([
          kvGet(env, 'last'), env.DB.prepare('SELECT COUNT(*) n FROM subs').first(), env.DB.prepare('SELECT COUNT(*) n FROM snaps').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM snaps WHERE t >= ?').bind(day).first(), env.DB.prepare('SELECT COUNT(*) n FROM alerts').first(), env.DB.prepare('SELECT MIN(t) t FROM snaps').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM gsnaps').first(), env.DB.prepare('SELECT COUNT(*) n FROM injlog').first(), env.DB.prepare('SELECT COUNT(*) n FROM inj').first(),
        ]);
        return json({ ok: true, now: Math.floor(Date.now() / 1000), last: last ? JSON.parse(last) : null, phones: subs.n, snapshots: snaps.n, snapshots24h: snaps24.n, alertsLogged: alerts.n, since: firstSnap ? firstSnap.t : null, gameSnapshots: gs.n, injuryChanges: il.n, injuriesTracked: tracked.n });
      }
      if (url.pathname === '/subscribe' && req.method === 'POST') {
        const b = await req.json(); const ep = b && b.endpoint;
        if (typeof ep !== 'string' || !/^https:\/\//.test(ep) || ep.length > 1000) return json({ error: 'bad subscription' }, 400);
        await env.DB.prepare('INSERT INTO subs (endpoint, created) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET fails = 0').bind(ep, Math.floor(Date.now() / 1000)).run();
        return json({ ok: true });
      }
      if (url.pathname === '/unsubscribe' && req.method === 'POST') { const b = await req.json(); await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(String(b && b.endpoint)).run(); return json({ ok: true }); }
      if (url.pathname === '/test' && req.method === 'POST') {
        const now = Math.floor(Date.now() / 1000); const old = JSON.parse((await kvGet(env, 'notes')) || '[]');
        await kvSet(env, 'notes', JSON.stringify([{ id: 'test-' + now, t: now, kind: 'test', url: '/#whales', title: 'Court Edge test', body: 'Phone alerts are working. Whale adds and key injury changes will arrive like this.' }].concat(old).slice(0, 12)));
        return json(await pushAll(env));
      }
      if (url.pathname === '/latest') { const now = Math.floor(Date.now() / 1000); return json({ now, notes: JSON.parse((await kvGet(env, 'notes')) || '[]').filter((n) => now - n.t < 900) }); }
      if (url.pathname === '/injuries') { const r = await env.DB.prepare('SELECT * FROM injlog ORDER BY t DESC LIMIT 200').all(); return json({ changes: r.results || [] }); }
      if (url.pathname === '/games') { // price and score history for one NBA or NFL game
        const ev = url.searchParams.get('event'); if (!ev) return json({ error: 'event required' }, 400);
        const r = await env.DB.prepare('SELECT * FROM gsnaps WHERE event = ? ORDER BY t LIMIT 3000').bind(ev).all(); return json({ snaps: r.results || [] });
      }
      if (url.pathname === '/alerts') { const r = await env.DB.prepare('SELECT * FROM alerts ORDER BY t DESC LIMIT 100').all(); return json({ alerts: r.results || [] }); }
      if (url.pathname === '/snaps') { // price history for one match
        const ev = url.searchParams.get('event'); if (!ev) return json({ error: 'event required' }, 400);
        const r = await env.DB.prepare('SELECT * FROM snaps WHERE event = ? ORDER BY t LIMIT 2000').bind(ev).all(); return json({ snaps: r.results || [] });
      }
      return json({ ok: true, what: 'Court Edge logger. See /status.' });
    } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); }
  },
};
