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

// Is this wallet making markets rather than picking winners? A market maker's position is what other people traded
// against it, not an opinion, so its buys are not a signal. Three tells, any one is enough:
// lifetime profit under 1% of everything it has traded, merging Yes and No pairs back into cash, or buying both
// outcomes of the same market (in two or more markets) inside the window. A wallet that has lost money over its
// life on large volume is flagged too, as 'losing': not a market maker, but no reason to follow it either.
// 'maker' means it was seen merging or buying both sides; 'thin' means only the margin says so, which could also be
// a bettor near break-even. On a check of all 43 wallets (Nov 16) the thin-margin ones still trading were mostly
// also buying both sides of 5 to 29 markets a day, and two wallets above 1% were caught by hundreds of merges.
// The profit and volume figures are the ones saved when the wallet list was built, so they lag by days.
const money = (x) => (x >= 1e9 ? '$' + Math.round(x / 1e8) / 10 + 'B' : x >= 1e6 ? '$' + (x >= 1e7 ? Math.round(x / 1e6) : Math.round(x / 1e5) / 10) + 'M' : '$' + Math.round(x / 1000) + 'k');
function makerRead(w, trades, stats) {
  const why = []; const ratio = w.volume > 0 && typeof w.pnl === 'number' ? w.pnl / w.volume : null; const big = w.volume >= 20e6;
  const losing = ratio !== null && big && ratio < 0;
  if (losing) why.push('it is down ' + money(-w.pnl) + ' over its life on ' + money(w.volume) + ' traded');
  else if (ratio !== null && big && ratio < 0.01) why.push('its lifetime profit is ' + (Math.round(ratio * 1000) / 10) + '% of the ' + money(w.volume) + ' it has traded');
  if (stats.merges > 0) why.push('it merged Yes and No pairs back into cash ' + stats.merges + (stats.merges === 1 ? ' time' : ' times') + ' in the last 3 hours');
  const conds = {}; for (const b of trades || []) if (b.side === 'BUY' && Number(b.usdc_size) >= 500) (conds[b.condition_id] = conds[b.condition_id] || new Set()).add(String(b.outcome_index));
  const both = Object.values(conds).filter((s) => s.size > 1).length; if (both >= 2) why.push('it bought both sides of ' + both + ' markets in the last 3 hours');
  const is = why.length > 0; const acts = stats.merges > 0 || both >= 2; // seen doing it, not just a thin margin
  return { is, kind: !is ? null : acts ? 'maker' : losing ? 'losing' : 'thin', why, ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000, fills: stats.fills || 0, merges: stats.merges || 0, both };
}

async function recentBuys(wallet, cutoff, maxPages) {
  const out = []; let cursor; let partial = false; const stats = { merges: 0, fills: 0 };
  for (let page = 0; page < maxPages; page++) {
    const d = await get('/activity', { user: wallet, limit: 500, cursor });
    const rows = (d && d.data) || []; let older = false;
    for (const r of rows) { if (r.timestamp < cutoff) { older = true; continue; } if (r.type === 'MERGE') stats.merges++; if (r.type === 'TRADE' && (r.side === 'BUY' || r.side === 'SELL')) { stats.fills++; out.push(r); } }
    const pg = (d && d.pagination) || {}; cursor = pg.next_cursor;
    if (older || !rows.length || !pg.has_more || !cursor) return { out, partial, stats };
  }
  partial = true; return { out, partial, stats };
}

async function check(w, cutoff, o) {
  const strong = {}; for (const c of w.cats) if (c.grade === 'strong') strong[c.k] = c;
  const { out: buys, partial, stats } = await recentBuys(w.w, cutoff, o.maxPages);
  const by = new Map();
  for (const b of buys) {
    const cat = catOf(b.slug); if (!strong[cat]) continue;
    const key = b.condition_id + '|' + b.outcome_index;
    const x = by.get(key) || { cond: b.condition_id, idx: b.outcome_index, title: b.title, slug: b.slug, cat, outcome: b.outcome, usd: 0, shares: 0, sold: 0, soldShares: 0, lastSell: 0, last: 0, first: Infinity };
    if (b.side === 'SELL') { x.sold += Number(b.usdc_size || 0); x.soldShares += Number(b.size || 0); x.lastSell = Math.max(x.lastSell, b.timestamp); } // selling in the same window is the opposite of adding
    else { x.usd += Number(b.usdc_size || 0); x.shares += Number(b.size || 0); x.last = Math.max(x.last, b.timestamp); x.first = Math.min(x.first, b.timestamp); }
    by.set(key, x);
  }
  const cands = [...by.values()].filter((x) => x.usd - x.sold >= o.minAdd); // net of what it sold
  // The other direction: a strong wallet selling more than it bought. Reported as a trim, a full exit, or a switch to the other side.
  const sells = []; const minSell = o.minSell || 25000;
  for (const c of [...by.values()].filter((x) => x.sold - x.usd >= minSell)) {
    const pos = ((await get('/positions', { user: w.w, condition: c.cond, limit: 50 })) || {}).data || [];
    const p = pos.find((q) => Number(q.outcome_index) === Number(c.idx) && q.status === 'OPEN'); const held = p ? Number(p.current_size || 0) : 0;
    const other = [...by.values()].find((x) => x.cond === c.cond && Number(x.idx) !== Number(c.idx) && x.usd - x.sold >= minSell); // bought the opposite outcome in the same window
    const g = strong[c.cat];
    sells.push({ id: 'sell|' + w.w + '|' + c.cond + '|' + c.idx, sell: true, kind: other ? 'switch' : c.soldShares >= 0.8 * (c.soldShares + held) ? 'exit' : 'trim', whale: w.name, w: w.w, cond: c.cond, cat: c.cat, rec: { net: g.net, n: g.n, roi: g.roi },
      title: c.title, outcome: c.outcome || (p && p.outcome) || 'one side', to: other ? other.outcome : null, bought: other ? Math.round(other.usd - other.sold) : null, sold: Math.round(c.sold - c.usd), price: c.soldShares ? c.sold / c.soldShares : null,
      left: Math.round(held * Number(p ? p.avg_price || 0 : 0)), cur: p ? Number(p.current_price) : null, last: c.lastSell, slug: c.slug, added: 0, lean: null });
  }
  if (!cands.length) { const mk0 = makerRead(w, buys, stats || {}); for (const a of sells) a.maker = mk0; return { alerts: sells, partial }; }
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
  const mk = makerRead(w, buys, stats || {}); const all = group(w, alerts, book || []).concat(sells); for (const a of all) a.maker = mk;
  return { alerts: all, partial };
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
      lean: f >= 2 * ag ? 'for' : 'hedged', net: { for: f, against: ag, lean: f >= 2 * ag ? 'for' : 'hedged', legs: sb.legs, adds, both: adds.some((x) => norm(x.outcome) !== norm(sb.lead)),
        // spreads, totals and props it holds on the same game: part of the same book, shown so one leg is never read alone
        also: book.filter((q) => q.status === 'OPEN' && q.event_slug === ev && q.slug !== ev && Number(q.current_size) >= 1 && Number(q.current_price) > 0.02 && Number(q.current_price) < 0.98).map((q) => ({ title: q.title, outcome: q.outcome, usd: Math.round(Number(q.current_size) * Number(q.avg_price || 0)) })).filter((x) => x.usd >= 1000).sort((x, y) => y.usd - x.usd).slice(0, 4) } });
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

// For NBA and NFL game winners: the sportsbook line with its margin taken out (before the start only) and Kalshi's price
// for the same team, so the price a wallet paid can be judged against something. Skipped quietly when the game is not found.
async function withRef(d) {
  const want = d.alerts.filter((a) => !a.sell && (a.grouped || a.main) && /^(nba|nfl)-/.test(String(a.slug || '')));
  if (!want.length) return d;
  const S = require('./sports'); const seen = {};
  await Promise.all(want.map(async (a) => {
    try {
      const r = await (seen[a.slug] = seen[a.slug] || S.refBySlug(a.slug)); if (!r) return;
      const o = norm(a.outcome); const k = ['a', 'b'].find((x) => o && (norm(r[x].name) === o || (' ' + norm(r[x].full) + ' ').includes(' ' + o + ' '))); if (!k) return;
      a.ref = { event: r.event, state: r.state, book: r.book, fair: r[k].fair, kalshi: r[k].ask, kalshiBid: r[k].bid };
    } catch (e) { /* the reference is a nice-to-have */ }
  }));
  return d;
}

// one shared scan per instance per ~50 seconds, however many phones are polling
const board = () => cached('alerts', 50000, () => scanAlerts().then(withRef));

module.exports = { scanAlerts, board, check, netExposure, seriesBook, group, makerRead, withRef };
