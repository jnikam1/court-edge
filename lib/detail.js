// Everything the match page shows for one Kalshi match.
const { kget, num, ts, fee, mid, cached } = require('./kalshi');
const { scan } = require('./scan');
const model = require('./model');
const poly = require('./poly');

const cents = (x) => Math.round(x * 100) + '¢';
const short = (n) => { const p = String(n || '').trim().split(' '); return p[p.length - 1] || n; };

async function findMatch(event) {
  const s = await scan();
  return { s, m: s.matches.find((x) => x.event === event) || null };
}

async function pricePath(m, now, start) {
  // once the match is on, show from 30 minutes before the start; before that, the last 3 hours
  const from = start && start < now ? Math.max(now - 8 * 3600, start - 30 * 60) : now - 3 * 3600;
  const d = await kget(`/series/${m.series}/markets/${m.a.ticker}/candlesticks`, { start_ts: from, end_ts: now, period_interval: 1 });
  const pts = [];
  for (const c of d.candlesticks || []) {
    const b = num(c.yes_bid && c.yes_bid.close_dollars); const a = num(c.yes_ask && c.yes_ask.close_dollars);
    let x = b !== null && a !== null && a - b <= 0.06 ? mid(b, a) : null;
    if (x === null && c.price && num(c.volume_fp) > 0) x = num(c.price.close_dollars);
    if (x !== null && x > 0 && x < 1) pts.push([c.end_period_ts, Math.round(x * 1000) / 1000]);
  }
  return pts;
}

async function flow(m, now) {
  const get = async (t) => {
    const out = []; let cursor;
    try { for (let page = 0; page < 3; page++) { const d = await kget('/markets/trades', { ticker: t, limit: 1000, cursor }); out.push(...(d.trades || [])); cursor = d.cursor; if (!cursor || (d.trades || []).length < 1000) break; } } catch (e) { /* keep what we have */ }
    return out;
  };
  const [ta, tb] = await Promise.all([get(m.a.ticker), get(m.b.ticker)]);
  const rows = [];
  const push = (list, own) => {
    for (const t of list) {
      const n = num(t.count_fp) || 0; const yes = num(t.yes_price_dollars);
      if (!n || yes === null) continue;
      const takerYes = (t.taker_side || t.taker_outcome_side) === 'yes';
      const price = takerYes ? yes : 1 - yes;
      const side = takerYes ? own : own === 'a' ? 'b' : 'a';
      rows.push({ t: ts(t.created_time), side, usd: n * price, price });
    }
  };
  push(ta, 'a'); push(tb, 'b');
  rows.sort((x, y) => y.t - x.t);
  const oldest = Math.max(ta.length ? ts(ta[ta.length - 1].created_time) : 0, tb.length ? ts(tb[tb.length - 1].created_time) : 0);
  const win = (sec) => {
    const lo = Math.max(now - sec, oldest); const o = { a: 0, b: 0, n: 0, covered: now - sec >= oldest };
    for (const r of rows) if (r.t >= lo) { o[r.side] += r.usd; o.n++; }
    o.a = Math.round(o.a); o.b = Math.round(o.b); return o;
  };
  const big = rows.filter((r) => r.usd >= 2000 && r.t >= oldest).slice(0, 8).map((r) => ({ t: r.t, side: r.side, usd: Math.round(r.usd), price: r.price }));
  return { m5: win(300), m15: win(900), m60: win(3600), all: win(now - oldest), big, since: oldest || null, trades: rows.length };
}

function buildRead(m, x, s) {
  const A = short(m.a.name); const B = short(m.b.name);
  const out = { level: 'pass', title: 'No bet', why: [], side: null };
  const edge = (fairA) => {
    const ea = m.a.ask === null ? null : fairA - m.a.ask - fee(m.a.ask);
    const eb = m.b.ask === null ? null : 1 - fairA - m.b.ask - fee(m.b.ask);
    if (ea === null && eb === null) return null;
    return ea !== null && (eb === null || ea >= eb) ? { side: 'a', edge: ea, price: m.a.ask, fair: fairA } : { side: 'b', edge: eb, price: m.b.ask, fair: 1 - fairA };
  };
  const name = (k) => (k === 'a' ? A : B);
  if (m.bestOf5) { out.why.push('Best-of-five matches are not covered by the rules yet.'); return out; }
  if (m.call && m.call.live && m.call.bet) {
    out.level = 'lean'; out.side = m.call.side;
    out.title = 'Set-break gap: ' + name(m.call.side) + ' at ' + cents(m.call.price) + ', small stake';
    out.why.push('Fair ' + cents(m.fair[m.call.side]) + ' from Kalshi matches with this pre-match price and set-1 winner. Gap ' + (m.call.edge * 100).toFixed(1) + '¢ after fees.');
    out.why.push('Across ' + s.rules.n + ' settled Kalshi matches the set-break price was fair on average, so a gap here is usually the set score talking, not free money.');
  } else if (x.live) {
    const e = edge(x.live.a);
    if (x.swing) {
      out.title = 'Set who is serving first';
      out.why.push('At this score the server matters. ' + A + ' is fair at ' + cents(x.swing.a) + ' if ' + A + ' serves next and ' + cents(x.swing.b) + ' if ' + B + ' does. Tap the server under Fair value to get a call.');
    } else if (e && (e.price < 0.15 || e.price > 0.85)) {
      out.why.push('No call at ' + cents(e.price) + '. The model is not reliable at extreme prices, and cheap longshots lose money: players bought at 5¢ or less won 3% of 117 cases in the Kalshi backtest, and at 10¢ or less they won 8.5% of 622.');
    } else if (e && e.edge >= 0.02 && x.behind === e.side) {
      out.why.push('Model has ' + name(e.side) + ' at ' + cents(e.fair) + ' against a ' + cents(e.price) + ' ask, but ' + name(e.side) + ' is the one behind. The model ignores bad-day form and overrates the trailing player. In the Kalshi backtest, players who fell behind were priced fairly (27% won at an average 28¢), so this gap is the model, not the market.');
    } else if (e) {
      const gap = (e.edge * 100).toFixed(1) + '¢';
      if (e.edge >= 0.05) { out.level = 'lean'; out.side = e.side; out.title = 'Lean ' + name(e.side) + ' at ' + cents(e.price) + ', small stake'; out.why.push('Live model fair ' + cents(e.fair) + ', gap ' + gap + ' after fees. This in-play gap is not backtested, so small stake only.'); }
      else if (e.edge >= 0.02) { out.level = 'watch'; out.side = e.side; out.title = 'Small bet on ' + name(e.side) + ' only if serve stats agree'; out.why.push('Live model fair ' + cents(e.fair) + ' vs ' + cents(e.price) + ' ask. Gap ' + gap + ' is inside the noise unless the serve numbers back it.'); }
      else out.why.push('Live model fair ' + cents(x.live.a) + ' on ' + A + '. Best gap ' + gap + ' after fees. Price is about right.');

    }
  } else if (x.started) {
    out.why.push('No live score for this match, so there is no in-play fair value. Price and money flow only.');
  } else {
    if (x.rating !== null && x.midA !== null) {
      const d = x.rating - x.midA;
      out.why.push('Ratings say ' + A + ' ' + cents(x.rating) + ', Kalshi says ' + cents(x.midA) + '. Ratings stop in ' + x.through + ', so a pre-match gap is not a bet on its own.');
      if (Math.abs(d) >= 0.08) { out.level = 'watch'; out.side = d > 0 ? 'a' : 'b'; out.title = 'Pass pre-match. Watch ' + name(out.side) + ' in play'; }
    } else out.why.push('No call before the match starts.');
    if (out.level === 'pass') out.title = 'Pass pre-match';
  }
  const f = x.flow && x.flow.m15;
  if (f && f.a + f.b >= 1000) { const sh = f.a / (f.a + f.b); out.why.push('Kalshi takers, last 15 min: ' + Math.round(100 * Math.max(sh, 1 - sh)) + '% of $' + Math.round((f.a + f.b) / 1000) + 'k on ' + (sh >= 0.5 ? A : B) + '.'); }
  if (x.move15 !== null && Math.abs(x.move15) >= 0.03) out.why.push((x.move15 > 0 ? A : B) + ' up ' + Math.round(Math.abs(x.move15) * 100) + '¢ in the last 15 minutes.');
  return out;
}

async function detail(event, srv) {
  const { s, m } = await findMatch(event);
  if (!m) return { error: 'That match is not open on Kalshi any more.' };
  const now = Math.floor(Date.now() / 1000);
  let pm = null;
  try { pm = await poly.find(m.a.name, m.b.name, Date.parse(m.listedStart || '') / 1000 || now); } catch (e) { /* no Polymarket match */ }
  const start = pm && pm.start ? Math.floor(Date.parse(pm.start) / 1000) : null;
  const [path, fl] = await Promise.all([pricePath(m, now, start).catch(() => []), flow(m, now).catch(() => null)]);
  const at = (sec) => { let v = null; for (const p of path) { if (p[0] <= now - sec) v = p[1]; else break; } return v; };
  const midA = mid(m.a.bid, m.a.ask) !== null ? mid(m.a.bid, m.a.ask) : path.length ? path[path.length - 1][1] : null;
  const started = m.state !== 'upcoming' || !!(pm && pm.live);
  let pre = m.pre !== undefined && m.pre !== null ? m.pre : null;
  if (pre === null) {
    if (!started) pre = midA;
    else if (start) { const v = path.filter((p) => p[0] >= start - 30 * 60 && p[0] <= start - 5 * 60).map((p) => p[1]); if (v.length) pre = v.reduce((q, y) => q + y, 0) / v.length; }
  }
  const surf = model.surfaceOf(m.tournament);
  const rating = model.ratingProb(m.tour, m.a.name, m.b.name, surf);
  const sets = pm && pm.live && pm.sets ? pm.sets : null;
  const live = sets && !m.bestOf5 ? model.liveFair(m.tour, pre, sets, pm.ended, srv) : null;
  // With an odd number of games played in the set, who serves next changes the fair value a lot.
  let swing = null;
  if (live && !srv) { const fa = model.liveFair(m.tour, pre, sets, pm.ended, 'a'); const fb = model.liveFair(m.tour, pre, sets, pm.ended, 'b'); if (fa && fb && Math.abs(fa.a - fb.a) >= 0.04) swing = { a: fa.a, b: fb.a }; }
  const mv = (sec) => { const p = at(sec); return p === null || midA === null ? null : midA - p; };
  let behind = null;
  if (sets) { let sa = 0; let sb = 0; for (const [p, q] of sets.slice(0, -1)) { if (p > q) sa++; else sb++; } const c = sets[sets.length - 1]; behind = sa !== sb ? (sa < sb ? 'a' : 'b') : c[0] !== c[1] ? (c[0] < c[1] ? 'a' : 'b') : null; }
  const x = { live, swing, behind, srv, started, rating, midA, through: String(model.PLAYERS.through).replace(/^(\d{4})(\d{2}).*$/, '$2/$1'), flow: fl, move15: mv(900) };
  const pl = (name) => { const p = model.player(name); return p ? { pt: p.pt || null, elo: p.e, surf: p.s[surf] ? p.s[surf][0] : null, surfN: p.s[surf] ? p.s[surf][1] : 0, w: p.w, l: p.l, sv: p.sv || null, rt: p.rt || null } : null; };
  // thin the path to ~180 points for the chart
  const step = Math.max(1, Math.ceil(path.length / 180));
  const chart = path.filter((p, i) => i % step === 0 || i === path.length - 1);
  return {
    asOf: new Date().toISOString(), event: m.event, tour: m.tourLabel, tournament: m.tournament, surface: model.SURF_NAME[surf],
    a: m.a, b: m.b, state: m.state, since: m.since, inWindow: !!m.inWindow, volume: m.volume, listedStart: m.listedStart,
    set1: m.set1 ? { winner: m.set1.winner || null, ended: m.set1.ended || null } : null,
    score: pm ? { live: pm.live, ended: pm.ended, period: pm.period, sets: pm.sets, start: pm.start } : null,
    polymarket: pm ? { slug: pm.slug, price: pm.price, volume: pm.volume } : null,
    pre, midA, move: { m5: mv(300), m15: mv(900), m60: mv(3600) }, chart,
    model: { rating, live: live ? { a: live.a, anchor: live.anchor, basis: live.basis } : null, rule: m.fair || null, call: m.call || null, srv: srv || null, through: x.through },
    stats: { a: pl(m.a.name), b: pl(m.b.name) },
    flow: fl, read: buildRead(m, x, s), rules: s.rules, history: history(m, pre, pm && pm.sets ? pm.sets : [[0, 0]]), historyN: PAT.n,
  };
}

// ---- what the Kalshi backtest and tour history say about this exact spot ----
const PAT = require('./patterns.json');
function history(m, pre, sets) {
  if (pre === null || pre === undefined || m.bestOf5) return [];
  const out = []; const pc = (x) => Math.round(x * 100) + '%'; const cc = (x) => Math.round(x * 100) + '¢';
  const favA = pre >= 0.5; const pf = favA ? pre : 1 - pre; const fav = short(favA ? m.a.name : m.b.name);
  const tk = m.tour === 'CH' ? 'ATP' : m.tour; const T = PAT.setbreak[tk]; const tourName = m.tour === 'WTA' ? 'WTA' : 'ATP';
  const bi = PAT.buckets.findIndex((b) => pf >= b[0] && pf < b[1]); const band = bi >= 0 ? Math.round(PAT.buckets[bi][0] * 100) + ' to ' + Math.round(PAT.buckets[bi][1] * 100) + '¢' : null;
  const row = (won) => (T && bi >= 0 ? T[won ? 'won' : 'lost'][String(bi)] : null);
  let sa = 0; let sb = 0; const done = sets ? sets.slice(0, -1) : [];
  for (const [x, y] of done) { if (x > y) sa++; else sb++; }
  const line = (won, lead) => { const r = row(won); if (r && r.n >= 20) out.push(lead + ' ' + pc(r.actual) + ' of ' + r.n + ' ' + tourName + ' matches. Kalshi priced them ' + cc(r.price) + ' at the break.'); };
  if (sa + sb === 0) {
    line(true, 'If ' + fav + ' takes set 1: favourites priced ' + band + ' who won it went on to win');
    line(false, 'If ' + fav + ' drops set 1: favourites priced ' + band + ' who lost it came back in');
    const d = PAT.dips['30'];
    out.push('A player who falls to 30¢ or less during set 1 still wins ' + pc(d.won) + ' of the time (' + d.n + ' cases, average price paid ' + cc(d.paid) + '). The dip is priced fairly.');
  } else if (sa + sb === 1) {
    const favWon = (sa === 1) === favA;
    line(favWon, favWon ? 'Favourites priced ' + band + ' who won set 1 went on to win' : 'Favourites priced ' + band + ' who lost set 1 came back in');
    if (!favWon) out.push('Tour history since 2011: a favourite who drops set 1 wins less often than a model frozen at the pre-match odds expects (29% against 37% on the ATP tour).');
    else if (m.tour === 'WTA') out.push('The player who wins set 1 of an evenly priced WTA match wins it about 80% of the time.');
  } else if (sa === 1 && sb === 1) {
    const k = model.RULES.decider[m.tour] || model.RULES.decider.ATP;
    const favWonS2 = (done[1][0] > done[1][1]) === favA;
    const z = k.a + k.b * Math.log(Math.min(0.97, pf) / (1 - Math.min(0.97, pf))) + (favWonS2 ? k.c : 0);
    out.push('Deciding sets since 2015 (' + k.n + ' matches at this level): a favourite like ' + fav + ' who ' + (favWonS2 ? 'won' : 'lost') + ' set 2 wins the match ' + pc(1 / (1 + Math.exp(-z))) + ' of the time.');
    out.push('The set 2 winner takes the decider only slightly more often than not: 53% on the WTA tour, 56% after a one-sided set 2.');
    out.push('Up a break at 2-1 in a women\'s deciding set wins about 70%. The break is handed back a third of the time, and early decider breaks have looked overpriced on Kalshi.');
  }
  return out;
}

// ---- recent results from Kalshi's settled match markets ----
const tournamentOf = (rules) => { const k = /in the (?:\d{4} )?(.+?) after a ball/.exec(rules || ''); return k ? k[1].replace(/\s+(Men|Women)('s)? Singles.*$/i, '').trim() : null; };
function settled(series) {
  return cached('settled-' + series, 15 * 60 * 1000, async () => {
    const since = Math.floor(Date.now() / 1000) - 75 * 86400;
    const ev = new Map(); let cursor;
    for (let page = 0; page < 6; page++) {
      const d = await kget('/markets', { series_ticker: series, status: 'settled', limit: 1000, min_close_ts: since, cursor });
      for (const k of d.markets || []) { const e = ev.get(k.event_ticker) || []; e.push(k); ev.set(k.event_ticker, e); }
      cursor = d.cursor; if (!cursor) break;
    }
    const out = [];
    for (const [, v] of ev) {
      if (v.length !== 2) continue;
      const w = v.find((k) => (k.result || '').toLowerCase() === 'yes'); const l = v.find((k) => (k.result || '').toLowerCase() === 'no');
      if (!w || !l) continue;
      out.push({ t: ts(w.close_time), winner: (w.yes_sub_title || '').trim(), loser: (l.yes_sub_title || '').trim(), tournament: tournamentOf(w.rules_primary) });
    }
    return out.sort((p, q) => q.t - p.t);
  });
}

// Past matches for one player from Polymarket's search, which carries set scores.
const { getJson, qs, norm, lastName } = require('./kalshi');
function pmHistory(query) {
  return cached('pm-hist-' + norm(query), 10 * 60 * 1000, async () => {
    const d = await getJson('https://gamma-api.polymarket.com/public-search' + qs({ q: query, limit_per_type: 50 }), { label: 'Polymarket', ua: 'Mozilla/5.0 (compatible; court-edge/1.0)', timeout: 8000 }).catch(() => null);
    const out = [];
    for (const e of (d && d.events) || []) {
      if (!e.startTime || !e.closed || !/^(atp|wta)-/.test(e.slug || '') || /doubles/.test(e.slug)) continue;
      const ml = (e.markets || []).find((k) => k.sportsMarketType === 'moneyline'); if (!ml) continue;
      let names; let prices; try { names = JSON.parse(ml.outcomes); prices = JSON.parse(ml.outcomePrices).map(Number); } catch (err) { continue; }
      if (!names || names.length !== 2 || !(prices[0] === 1 || prices[1] === 1)) continue;
      out.push({ t: Math.floor(Date.parse(e.startTime) / 1000), names, winner: prices[0] === 1 ? 0 : 1, sets: poly.parseScore(e.score), title: String(e.title || '').split(':')[0] });
    }
    return out;
  });
}
const scoreFor = (ev, idx) => (ev && ev.sets ? ev.sets.map((x) => x[idx] + '-' + x[1 - idx]).join(' ') : null);
let H2H = null;

async function form(event) {
  const { m } = await findMatch(event);
  if (!m) return { error: 'That match is not open on Kalshi any more.' };
  const series = m.tour === 'WTA' ? ['KXWTAMATCH'] : ['KXATPMATCH', 'KXATPCHALLENGERMATCH'];
  const [lists, ha, hb, hboth] = await Promise.all([
    Promise.all(series.map((x) => settled(x).catch(() => []))),
    pmHistory(m.a.name).catch(() => []), pmHistory(m.b.name).catch(() => []), pmHistory(lastName(m.a.name) + ' ' + lastName(m.b.name)).catch(() => []),
  ]);
  const all = [].concat(...lists).sort((p, q) => q.t - p.t);
  const one = (name, hist) => {
    const me = lastName(name);
    const r = all.filter((k) => k.winner === name || k.loser === name).slice(0, 10).map((k) => {
      const vs = k.winner === name ? k.loser : k.winner; const opp = lastName(vs);
      const ev = hist.find((h) => Math.abs(h.t - k.t) < 3 * 86400 && h.names.some((n) => lastName(n) === opp) && h.names.some((n) => lastName(n) === me));
      const idx = ev ? (lastName(ev.names[0]) === me ? 0 : 1) : 0;
      return { t: k.t, won: k.winner === name, vs, tournament: k.tournament, score: scoreFor(ev, idx) };
    });
    let streak = 0; for (const k of r) { if (k.won === r[0].won) streak++; else break; }
    const three = r.filter((k) => k.score && k.score.split(' ').length === 3);
    return { w: r.filter((k) => k.won).length, l: r.filter((k) => !k.won).length, streak: r.length ? (r[0].won ? 'W' : 'L') + streak : null, results: r,
      threeSet: three.length ? { played: three.length, won: three.filter((k) => k.won).length } : null };
  };
  // head to head: tour results to mid 2026 from the built-in table, later meetings from Polymarket
  if (!H2H) { try { H2H = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, 'h2h.json.gz'))).toString('utf8')); } catch (e) { H2H = { pairs: {}, through: 0, missing: true }; } }
  const na = norm(m.a.name); const nb = norm(m.b.name); const key = [na, nb].sort().join('|'); const rec = H2H.pairs[key];
  const flip = na > nb; const meetings = []; const wins = [0, 0];
  if (rec) {
    wins[0] = rec.w[flip ? 1 : 0]; wins[1] = rec.w[flip ? 0 : 1];
    for (const x of rec.m) { const aWon = (x[1] === 0) !== flip; const d = String(x[0]); meetings.push({ t: Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 1000), winner: aWon ? 'a' : 'b', tournament: x[3], surface: { H: 'hard', C: 'clay', G: 'grass' }[x[2]] || null, score: x[4] }); }
  }
  const thr = String(H2H.through || 0); const cut = H2H.through ? Date.UTC(+thr.slice(0, 4), +thr.slice(4, 6) - 1, +thr.slice(6, 8)) / 1000 + 6 * 86400 : 0;
  const la = lastName(m.a.name); const lb = lastName(m.b.name); const seen = new Set();
  for (const h of [...hboth, ...ha]) {
    if (h.t <= cut || !h.names.some((n) => lastName(n) === la) || !h.names.some((n) => lastName(n) === lb)) continue;
    const dayKey = Math.round(h.t / 86400); if (seen.has(dayKey)) continue; seen.add(dayKey);
    const ai = lastName(h.names[0]) === la ? 0 : 1; const aWon = h.winner === ai; wins[aWon ? 0 : 1]++;
    meetings.push({ t: h.t, winner: aWon ? 'a' : 'b', tournament: h.title, surface: null, score: scoreFor(h, aWon ? ai : 1 - ai) });
  }
  meetings.sort((p, q) => q.t - p.t);
  return { asOf: new Date().toISOString(), days: 75, a: one(m.a.name, ha), b: one(m.b.name, hb), h2h: { wins, meetings: meetings.slice(0, 6), since: 2015, missing: !!H2H.missing } };
}

async function whales(event) {
  const { m } = await findMatch(event);
  if (!m) return { error: 'That match is not open on Kalshi any more.' };
  const pm = await poly.find(m.a.name, m.b.name, Date.parse(m.listedStart || '') / 1000 || Date.now() / 1000);
  if (!pm) return { none: true };
  return poly.whales(pm);
}

module.exports = { detail, form, whales };
