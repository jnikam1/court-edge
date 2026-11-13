// Polymarket public data: live scores (gamma) and who holds what (data-api).
const { getJson, qs, norm, lastName, cached } = require('./kalshi');
const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com/v2';
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const pget = (url, params, timeout) => getJson(url + qs(params), { label: 'Polymarket', ua: UA, timeout: timeout || 8000 });

// "6-7(2-7), 2-1" -> [[6,7],[2,1]]
function parseScore(s) {
  if (!s || typeof s !== 'string') return null;
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)-(\d+)/);
    if (m) out.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  return out.length ? out : null;
}

function slim(e) {
  const ml = (e.markets || []).find((m) => m.sportsMarketType === 'moneyline');
  let names = null; let prices = null; let tokens = null;
  if (ml) { try { names = JSON.parse(ml.outcomes); prices = JSON.parse(ml.outcomePrices).map(Number); tokens = JSON.parse(ml.clobTokenIds); } catch (e2) { /* leave null */ } }
  return {
    id: e.id, slug: e.slug, title: e.title, start: e.startTime || null, live: !!e.live, ended: !!e.ended,
    score: e.score || null, period: e.period || null, sets: parseScore(e.score),
    cond: ml ? ml.conditionId : null, names, prices, tokens,
    bid: ml ? Number(ml.bestBid) : null, ask: ml ? Number(ml.bestAsk) : null,
    volume: ml ? Number(ml.volume || 0) : null, key: norm(e.title),
  };
}

// All tennis matches Polymarket lists as not closed (live ones carry a score).
const page = (off) => pget(GAMMA + '/events', { tag_slug: 'tennis', closed: false, limit: 100, offset: off, order: 'startTime', ascending: false }).catch(() => []);
const upcoming = () => cached('pm-upcoming', 5 * 60 * 1000, async () => [].concat(...(await Promise.all([0, 100, 200].map(page))).map((x) => (Array.isArray(x) ? x : []))));
function board() {
  return cached('pm-board', 8000, async () => {
    const [live, soon] = await Promise.all([
      pget(GAMMA + '/events', { tag_slug: 'tennis', live: true, limit: 100 }).catch(() => []),
      upcoming().catch(() => []),
    ]);
    const seen = new Map();
    for (const e of [...(Array.isArray(live) ? live : []), ...soon]) {
      if (!e || !e.startTime || seen.has(e.id) || /doubles/i.test(e.slug || '')) continue;
      seen.set(e.id, slim(e));
    }
    return [...seen.values()];
  });
}

function pick(list, nameA, nameB, around) {
  const la = lastName(nameA); const lb = lastName(nameB);
  if (!la || !lb) return null;
  const hits = list.filter((e) => (' ' + e.key + ' ').includes(' ' + la + ' ') && (' ' + e.key + ' ').includes(' ' + lb + ' ') && e.names && e.names.length === 2);
  if (!hits.length) return null;
  const t = around || Date.now() / 1000;
  hits.sort((x, y) => Math.abs(Date.parse(x.start) / 1000 - t) - Math.abs(Date.parse(y.start) / 1000 - t));
  return hits[0];
}

// Orient a Polymarket event to Kalshi's player order (a first).
function orient(e, nameA) {
  if (!e) return null;
  const aFirst = lastName(e.names[0]) === lastName(nameA);
  const flip = (p) => (aFirst ? p : [p[1], p[0]]);
  return {
    slug: e.slug, cond: e.cond, live: e.live, ended: e.ended, period: e.period, start: e.start,
    sets: e.sets ? e.sets.map(flip) : null,
    price: e.prices ? flip(e.prices) : null,
    bid: e.bid > 0 && e.bid < 1 && e.ask > 0 && e.ask < 1 ? flip([e.bid, Math.round((1 - e.ask) * 1000) / 1000]) : null, // what each outcome sells for
    tokens: e.tokens ? flip(e.tokens) : null, volume: e.volume,
  };
}

async function find(nameA, nameB, around) {
  const hit = pick(await board(), nameA, nameB, around);
  if (hit) return orient(hit, nameA);
  const key = 'pm-find-' + norm(nameA) + '|' + norm(nameB);
  return cached(key, 60000, async () => {
    const d = await pget(GAMMA + '/public-search', { q: lastName(nameA) + ' ' + lastName(nameB), limit_per_type: 6 }).catch(() => null);
    const list = ((d && d.events) || []).filter((e) => !e.closed && e.startTime).map(slim);
    return orient(pick(list, nameA, nameB, around), nameA);
  });
}

// ---- who holds the match on Polymarket, split by each wallet's lifetime profit ----
const pnlCache = new Map();
async function lifetime(wallet) {
  if (pnlCache.has(wallet)) return pnlCache.get(wallet);
  let v = { pnl: null, volume: null, name: null };
  try {
    const d = await pget(DATA + '/leaderboard', { time_period: 'all', user: wallet }, 6000);
    const o = d && d.data && !Array.isArray(d.data) ? d.data : null;
    if (o) v = { pnl: typeof o.pnl === 'number' ? o.pnl : Number(o.pnl), volume: Number(o.volume || 0), name: o.user_name || null };
    if (!Number.isFinite(v.pnl)) v.pnl = null;
    pnlCache.set(wallet, v);
  } catch (e) { /* not cached, retried next time */ }
  return v;
}

async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// A wallet's recent tennis record: match-winner markets among its last 2,000 closed positions,
// plus settled positions it has not redeemed yet. Losing bets are rarely redeemed, so leaving
// those out would make every wallet look better than it is.
const TENNIS_PAGES = 4;
async function recent(wallet, status, pages) {
  const rows = []; let cursor; let complete = false;
  for (let page = 0; page < pages; page++) {
    const d = await pget(DATA + '/positions', { user: wallet, status, sort_by: 'TIMESTAMP', limit: 500, cursor }, 9000);
    const data = (d && d.data) || [];
    rows.push(...data);
    const pg = (d && d.pagination) || {};
    cursor = pg.next_cursor;
    if (!data.length || !pg.has_more || !cursor) { complete = true; break; }
  }
  return { rows, complete };
}
function tennisRecord(wallet) {
  return cached('pm-tennis-' + wallet, 6 * 3600 * 1000, async () => {
    const [closed, unredeemed] = await Promise.all([recent(wallet, 'CLOSED', TENNIS_PAGES), recent(wallet, 'REDEEMABLE', 2)]);
    let since = null; let name = null;
    for (const r of closed.rows) { name = name || r.name || null; if (r.last_event_at && (since === null || r.last_event_at < since)) since = r.last_event_at; }
    const from = closed.complete ? 0 : since || 0;
    const by = new Map();
    for (const r of [...closed.rows, ...unredeemed.rows.filter((x) => (x.last_event_at || 0) >= from)]) {
      if (!/^(atp|wta)-/.test(r.slug || '') || r.slug !== r.event_slug) continue;
      const m = by.get(r.condition_id) || { net: 0, stake: 0 };
      m.net += Number(r.total_pnl || 0) - Number(r.entry_fees_usdc || 0);
      m.stake += Number(r.total_size || 0) * Number(r.avg_price || 0);
      by.set(r.condition_id, m);
    }
    let net = 0; let stake = 0; let won = 0;
    for (const m of by.values()) { net += m.net; stake += m.stake; if (m.net > 0) won++; }
    return { matches: by.size, net: Math.round(net), stake: Math.round(stake), won, scanned: closed.rows.length, since: from || null, complete: closed.complete, name };
  });
}
const grade = (t) => (!t || t.matches < 15 ? 'thin' : t.net >= 2000 ? 'winner' : t.net <= -2000 ? 'loser' : 'flat');

const MIN_STAKE = 200; const GRADED = 30;
function whales(pm) {
  if (!pm || !pm.cond || !pm.tokens) return Promise.resolve(null);
  return cached('pm-whales-' + pm.cond, 120000, async () => {
    const idx = { [String(pm.tokens[0])]: 0, [String(pm.tokens[1])]: 1 };
    const w = new Map(); let cursor; let complete = false;
    for (let page = 0; page < 14; page++) {
      const d = await pget(DATA + '/positions', { condition: pm.cond, limit: 500, cursor }, 9000);
      const data = (d && d.data) || [];
      for (const p of data) {
        const i = idx[String(p.token_id)]; const size = Number(p.current_size || 0);
        if (i === undefined || !(size > 0)) continue;
        const x = w.get(p.proxy_wallet) || { shares: [0, 0], cost: [0, 0], name: p.name || null };
        x.shares[i] += size; x.cost[i] += size * Number(p.avg_price || 0.5);
        w.set(p.proxy_wallet, x);
      }
      const pg = (d && d.pagination) || {};
      cursor = pg.next_cursor;
      if (!data.length || !pg.has_more || !cursor) { complete = true; break; }
    }
    const list = [];
    for (const [wallet, x] of w) {
      const net = x.shares[0] - x.shares[1]; const side = net >= 0 ? 0 : 1;
      const avg = x.shares[side] ? x.cost[side] / x.shares[side] : 0.5;
      const usd = Math.abs(net) * avg;
      if (usd >= MIN_STAKE) list.push({ wallet, side, usd, avg, hedged: Math.min(x.shares[0], x.shares[1]) > 0, name: x.name });
    }
    list.sort((a, b) => b.usd - a.usd);
    const top = list.slice(0, GRADED);
    const [recs, life] = await Promise.all([
      pool(top, 10, (r) => tennisRecord(r.wallet).catch(() => null)),
      pool(top, 10, (r) => lifetime(r.wallet)),
    ]);
    const groups = { winner: [0, 0, 0, 0], loser: [0, 0, 0, 0], flat: [0, 0, 0, 0], thin: [0, 0, 0, 0], rest: [0, 0, 0, 0] };
    const add = (g, r) => { groups[g][r.side] += r.usd; groups[g][2 + r.side] += 1; };
    top.forEach((r, k) => { r.tennis = recs[k]; r.grade = recs[k] ? grade(recs[k]) : 'thin'; r.pnl = life[k].pnl; add(r.grade, r); });
    list.slice(GRADED).forEach((r) => add('rest', r));
    const nm = (r) => { const n = r.name || (r.tennis && r.tennis.name); return !n || /^0x[0-9a-f]{20,}/i.test(n) ? r.wallet.slice(0, 6) + '…' + r.wallet.slice(-4) : String(n).slice(0, 22); };
    const rows = top.slice(0, 12).map((r) => ({
      side: r.side ? 'b' : 'a', usd: Math.round(r.usd), avg: r.avg, name: nm(r), hedged: r.hedged, grade: r.grade, lifetime: r.pnl,
      tennis: r.tennis ? { matches: r.tennis.matches, net: r.tennis.net, won: r.tennis.won, since: r.tennis.since, complete: r.tennis.complete } : null,
    }));
    return { asOf: new Date().toISOString(), slug: pm.slug, wallets: w.size, counted: list.length, graded: top.length, minStake: MIN_STAKE, complete, groups, rows };
  });
}

module.exports = { board, pick, orient, find, whales, parseScore, tennisRecord };
