// Big adds: a tracked whale bought into one of its winning categories recently and now holds
// a large stake in that market. Used by /api/alerts (the app polls it every minute) and by
// scripts/whale-alerts.js.
const { getJson, qs, cached } = require('./kalshi');
const W = require('./whales.json');
const DATA = 'https://data-api.polymarket.com/v2';
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const get = (path, params) => getJson(DATA + path + qs(params), { label: 'Polymarket', ua: UA, timeout: 9000, tries: 3 });
const catOf = (slug) => W.prefix[String(slug || '').split('-')[0]] || 'Other';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC = new Set(['yes', 'no', 'over', 'under']);
// One buy is not the whole bet. This adds up everything the wallet holds that the same winner settles:
// shares that pay if this side wins, and shares that pay if it does not. A buy smaller than what is held
// against it is a hedge, and the wallet's real position is on the other side.
function netExposure(p, all) {
  const side = norm(p.outcome); if (!side || GENERIC.has(side)) return null;
  const opp = norm(p.opposite_outcome); const here = Number(p.current_price);
  let f = 0; let a = 0; const legs = [];
  for (const q of all || []) {
    if (q.status !== 'OPEN') continue; const sh = Number(q.current_size || 0); if (!(sh >= 1)) continue;
    let dir = 0; const out = norm(q.outcome);
    if (q.condition_id === p.condition_id) dir = Number(q.outcome_index) === Number(p.outcome_index) ? 1 : -1;
    else {
      // "Will X win the title?" counts only when this match decides it: the title price sits next to the match price.
      const m = /^will (.+?) win /i.exec(q.title || ''); const subj = m ? norm(m[1]) : null; if (!subj || (out !== 'yes' && out !== 'no')) continue;
      const yes = out === 'yes' ? Number(q.current_price) : 1 - Number(q.current_price);
      const isSide = subj === side || subj.endsWith(' ' + side); const isOpp = opp && (subj === opp || subj.endsWith(' ' + opp));
      if (isSide && Math.abs(yes - here) <= 0.12) dir = out === 'yes' ? 1 : -1;
      else if (isOpp && Math.abs(yes - (1 - here)) <= 0.12 && out === 'yes') dir = -1;
    }
    if (!dir) continue; if (dir > 0) f += sh; else a += sh;
    if (dir < 0 || q.condition_id !== p.condition_id) legs.push({ title: q.title, outcome: q.outcome, shares: Math.round(sh), dir });
  }
  return { for: Math.round(f), against: Math.round(a), lean: a > f ? 'against' : a >= 0.5 * f ? 'hedged' : 'for', legs: legs.sort((x, y) => y.shares - x.shares).slice(0, 4) };
}

// One wallet's whole position on one match, read the same way from either side: what it is paid if each team wins.
// Counts only markets the series winner settles: the match market itself, and "Will X win the title?" when this match decides it.
// Single games, handicaps and totals are different bets and stay out.
function seriesBook(all, eventSlug) {
  const open = (all || []).filter((q) => q.status === 'OPEN' && Number(q.current_size) >= 1);
  const main = open.filter((q) => q.event_slug === eventSlug && q.slug === eventSlug); if (!eventSlug || !main.length) return null;
  const A = main[0].outcome; const B = main[0].opposite_outcome; if (!A || !B || GENERIC.has(norm(A))) return null;
  const price = { [A]: Number(main[0].current_price), [B]: 1 - Number(main[0].current_price) };
  const pay = { [A]: 0, [B]: 0 }; const cost = { [A]: 0, [B]: 0 }; const legs = [];
  const put = (team, q) => { const sh = Number(q.current_size); pay[team] += sh; cost[team] += sh * Number(q.avg_price || 0); legs.push({ team, title: q.title, outcome: q.outcome, shares: Math.round(sh) }); };
  for (const q of open) {
    if (q.event_slug === eventSlug) { if (q.slug === eventSlug) put(norm(q.outcome) === norm(A) ? A : B, q); continue; }
    const m = /^will (.+?) win /i.exec(q.title || ''); const out = norm(q.outcome); if (!m || (out !== 'yes' && out !== 'no')) continue;
    const subj = norm(m[1]); const team = [A, B].find((t) => subj === norm(t) || subj.endsWith(' ' + norm(t))); if (!team) continue;
    const yes = out === 'yes' ? Number(q.current_price) : 1 - Number(q.current_price);
    if (Math.abs(yes - price[team]) > 0.12) continue; // a title this match does not decide
    put(out === 'yes' ? team : (team === A ? B : A), q);
  }
  const lead = pay[A] >= pay[B] ? A : B; const other = lead === A ? B : A;
  return { a: A, b: B, lead, other, pay, cost, price, cond: main[0].condition_id, title: main[0].title, legs: legs.sort((x, y) => y.shares - x.shares).slice(0, 6) };
}

async function recentBuys(wallet, cutoff, maxPages) {
  const out = []; let cursor; let partial = false;
  for (let page = 0; page < maxPages; page++) {
    const d = await get('/activity', { user: wallet, limit: 500, cursor });
    const rows = (d && d.data) || []; let older = false;
    for (const r of rows) { if (r.timestamp < cutoff) { older = true; continue; } if (r.type === 'TRADE' && (r.side === 'BUY' || r.side === 'SELL')) out.push(r); }
    const pg = (d && d.pagination) || {}; cursor = pg.next_cursor;
    if (older || !rows.length || !pg.has_more || !cursor) return { out, partial };
  }
  partial = true; return { out, partial };
}

async function check(w, cutoff, o) {
  const strong = {}; for (const c of w.cats) if (c.grade === 'strong') strong[c.k] = c;
  const { out: buys, partial } = await recentBuys(w.w, cutoff, o.maxPages);
  const by = new Map();
  for (const b of buys) {
    const cat = catOf(b.slug); if (!strong[cat]) continue;
    const key = b.condition_id + '|' + b.outcome_index;
    const x = by.get(key) || { cond: b.condition_id, idx: b.outcome_index, title: b.title, slug: b.slug, cat, usd: 0, shares: 0, sold: 0, last: 0, first: Infinity };
    if (b.side === 'SELL') x.sold += Number(b.usdc_size || 0); // selling in the same window is the opposite of adding
    else { x.usd += Number(b.usdc_size || 0); x.shares += Number(b.size || 0); x.last = Math.max(x.last, b.timestamp); x.first = Math.min(x.first, b.timestamp); }
    by.set(key, x);
  }
  const cands = [...by.values()].filter((x) => x.usd - x.sold >= o.minAdd); // net of what it sold
  if (!cands.length) return { alerts: [], partial };
  const alerts = []; let book = null; // the wallet's largest open positions, read once
  for (const c of cands) {
    // Ask for this one market, so a wallet with hundreds of open bets cannot push it off the page.
    const pos = ((await get('/positions', { user: w.w, condition: c.cond, limit: 50 })) || {}).data || [];
    const p = pos.find((q) => Number(q.outcome_index) === Number(c.idx) && q.status === 'OPEN');
    if (!p) continue; // nothing held now: sold out, or not confirmed. Either way there is no stake to report.
    const stake = Number(p.current_size || 0) * Number(p.avg_price || 0); // what is still held, at cost
    const paid = c.shares ? c.usd / c.shares : null;
    if (stake < o.minStake || paid === null || paid < 0.05 || paid > 0.95) continue; // skip near-certain parking bets
    const g = strong[c.cat];
    if (book === null) book = await get('/positions', { user: w.w, limit: 500 }).then((d) => (d && d.data) || []).catch(() => false);
    // within this one market only: the other outcome held against it
    const me = Object.assign({ condition_id: c.cond }, p); const same = book ? book.filter((q) => q.condition_id === c.cond && Number(q.outcome_index) !== Number(c.idx)) : [];
    const net = book ? netExposure(me, [me].concat(same)) : null;
    if (Number(p.current_price) <= 0.02 || Number(p.current_price) >= 0.98) continue; // already decided
    alerts.push({ id: w.w + '|' + c.cond + '|' + c.idx, whale: w.name, w: w.w, cond: c.cond, cat: c.cat, rec: { net: g.net, n: g.n, roi: g.roi },
      title: c.title, outcome: p.outcome, added: Math.round(c.usd - c.sold), paid, stake: Math.round(stake), avg: Number(p.avg_price), cur: Number(p.current_price),
      fresh: p.first_entry_at >= cutoff, last: c.last, slug: p.event_slug || p.slug || c.slug, net, lean: net ? net.lean : null, ev: p.event_slug || null, main: !!p.event_slug && p.slug === p.event_slug });
  }
  return { alerts: group(w, alerts, book || []), partial };
}

// Several buys by one wallet on one match become one alert that states the net position.
// Without this, a wallet working both sides shows up as a row of cards that contradict each other.
function group(w, alerts, book) {
  const out = []; const books = {}; const bookOf = (ev) => (ev in books ? books[ev] : (books[ev] = seriesBook(book, ev)));
  const mains = {};
  for (const a of alerts) {
    const sb = a.ev ? bookOf(a.ev) : null;
    if (a.main && sb) { (mains[a.ev] = mains[a.ev] || []).push(a); continue; }
    if (sb) a.series = { lead: sb.lead, other: sb.other, for: Math.round(sb.pay[sb.lead]), against: Math.round(sb.pay[sb.other]) }; // a side market: say where the wallet stands on the match itself
    out.push(a);
  }
  for (const ev of Object.keys(mains)) {
    const sb = bookOf(ev); const g = mains[ev]; const adds = g.map((x) => ({ outcome: x.outcome, usd: x.added, paid: x.paid, last: x.last })).sort((x, y) => y.last - x.last);
    const mine = adds.filter((x) => norm(x.outcome) === norm(sb.lead)); const use = mine.length ? mine : adds; const usd = use.reduce((s, x) => s + x.usd, 0);
    const f = Math.round(sb.pay[sb.lead]); const ag = Math.round(sb.pay[sb.other]);
    out.push({ id: w.w + '|' + ev, whale: w.name, w: w.w, cond: sb.cond, cat: g[0].cat, rec: g[0].rec, title: sb.title, slug: ev, grouped: true,
      outcome: sb.lead, other: sb.other, added: usd, paid: usd ? use.reduce((s, x) => s + x.usd * x.paid, 0) / usd : null, stake: Math.round(sb.cost[sb.lead]), avg: sb.pay[sb.lead] ? sb.cost[sb.lead] / sb.pay[sb.lead] : null, cur: sb.price[sb.lead],
      fresh: mine.length > 0 && g.every((x) => x.fresh), last: Math.max(...use.map((x) => x.last)),
      quiet: !mine.length, // the only recent buying was on its lighter side: it trimmed, it did not add to its position
      lean: f >= 2 * ag ? 'for' : 'hedged', net: { for: f, against: ag, lean: f >= 2 * ag ? 'for' : 'hedged', legs: sb.legs, adds, both: adds.some((x) => norm(x.outcome) !== norm(sb.lead)) } });
  }
  return out;
}

async function scanAlerts(opts) {
  const o = Object.assign({ minutes: 180, minStake: 50000, minAdd: 10000, maxPages: 4 }, opts || {});
  const cutoff = Math.floor(Date.now() / 1000) - o.minutes * 60;
  const all = []; let failed = 0; let partial = 0; let i = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (i < W.wallets.length) { const w = W.wallets[i++]; try { const r = await check(w, cutoff, o); all.push(...r.alerts); if (r.partial) partial++; } catch (e) { failed++; } }
  }));
  all.sort((a, b) => b.last - a.last);
  return { asOf: new Date().toISOString(), minutes: o.minutes, minStake: o.minStake, minAdd: o.minAdd, wallets: W.wallets.length, failed, partial, alerts: all };
}

// one shared scan per instance per ~50 seconds, however many phones are polling
const board = () => cached('alerts', 50000, () => scanAlerts());

module.exports = { scanAlerts, board, check, netExposure, seriesBook, group };
