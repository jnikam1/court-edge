// UFC fights from Kalshi (series KXUFCFIGHT). No score or clock: a fight is a price until it ends.
// Kalshi's time on each bout is when it expects a result, hours after the walkouts, so it only gives the order of the card.
// Nothing here claims a bout is under way: a fight is "upcoming" until its price says it is decided.
const { getJson, kget, num, mid, cached } = require('./kalshi');

const SERIES = 'KXUFCFIGHT';
const PROPS = [['KXUFCDISTANCE', 'Goes the distance'], ['KXUFCMOV', 'How it ends'], ['KXUFCROUNDS', 'Rounds']];
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const r3 = (x) => Math.round(x * 1000) / 1000;

// How Kalshi's own pre-fight favourites have done, by price (684 bouts, May 2025 to Nov 2026, from Kalshi's published UFC record).
// Shown as context next to a price. It is a record, not a forecast.
const RECORD = [
  { lo: 0.5, hi: 0.6, won: 0.61, avg: 0.55, n: 161 },
  { lo: 0.6, hi: 0.7, won: 0.64, avg: 0.65, n: 219 },
  { lo: 0.7, hi: 0.8, won: 0.71, avg: 0.74, n: 175 },
  { lo: 0.8, hi: 1.01, won: 0.89, avg: 0.85, n: 129 },
];
const bucket = (p) => (num(p) === null ? null : RECORD.find((b) => p >= b.lo && p < b.hi) || null);

const side = (m) => {
  const b = num(m.yes_bid_dollars); const a = num(m.yes_ask_dollars);
  return { code: String(m.ticker).split('-').pop(), name: m.yes_sub_title || m.title, full: m.yes_sub_title || m.title, ticker: m.ticker,
    bid: b !== null && b > 0 ? b : null, ask: a !== null && a > 0 && a < 1 ? a : null, bidSize: b !== null && b > 0 ? num(m.yes_bid_size_fp) : null, last: num(m.last_price_dollars), score: null, record: null, vol: num(m.volume_fp) || 0 };
};

// ESPN's free MMA scoreboard: one event with every bout, each with its status (not started, round and clock, finished),
// the fighters' records, the weight class and the scheduled rounds. It has no ages and no strike counts.
const nk = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
const lastOf = (s) => nk(s).split(' ').pop();
async function espnBouts() {
  return cached('ufc:espn', 15000, async () => {
    const d = await getJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', { label: 'ESPN', ua: UA, timeout: 6000, tries: 1 });
    const out = [];
    for (const ev of d.events || []) for (const c of ev.competitions || []) {
      const f = (c.competitors || []).map((x) => ({ name: x.athlete && x.athlete.displayName, record: x.records && x.records[0] ? x.records[0].summary : null, winner: x.winner === true }));
      if (f.length !== 2 || !f[0].name || !f[1].name) continue; const st = c.status || {}; const ty = st.type || {};
      out.push({ card: ev.name || null, f, state: ty.state || null, round: num(st.period), clock: st.displayClock && st.displayClock !== '-' ? st.displayClock : null, desc: ty.description || null,
        weight: c.type && c.type.abbreviation ? c.type.abbreviation : null, rounds: c.format && c.format.regulation ? num(c.format.regulation.periods) : null });
    }
    return out;
  }).catch(() => []);
}
function withEspn(g, bouts) {
  const hit = bouts.find((b) => { const n = b.f.map((x) => nk(x.name)); const l = b.f.map((x) => lastOf(x.name)); const A = nk(g.a.name); const B = nk(g.b.name);
    return (n.includes(A) || l.includes(lastOf(A))) && (n.includes(B) || l.includes(lastOf(B))); });
  if (!hit) return false;
  const pick = (name) => hit.f.find((x) => nk(x.name) === nk(name)) || hit.f.find((x) => lastOf(x.name) === lastOf(name));
  const ea = pick(g.a.name); const eb = pick(g.b.name); if (ea) g.a.record = ea.record; if (eb) g.b.record = eb.record;
  g.weight = hit.weight; g.rounds = hit.rounds; g.cardName = hit.card; g.espn = true;
  if (g.state !== 'closing') {
    if (hit.state === 'in') { g.state = 'live'; g.period = hit.round; g.text = hit.round ? 'Round ' + hit.round + (hit.rounds ? ' of ' + hit.rounds : '') + (hit.clock ? ' · ' + hit.clock : '') : 'Under way'; }
    else if (hit.state === 'post') { g.state = 'closing'; g.text = 'Finished'; }
  }
  return true;
}

async function fights() {
  return cached('ufc:fights', 8000, async () => {
    const d = await kget('/markets', { series_ticker: SERIES, status: 'open', limit: 200 });
    const by = new Map(); for (const m of d.markets || []) { if (!by.has(m.event_ticker)) by.set(m.event_ticker, []); by.get(m.event_ticker).push(m); }
    const now = Date.now() / 1000; const out = [];
    for (const [event, ms] of by) {
      if (ms.length !== 2) continue;
      const code = event.split('-').pop().replace(/^\d{2}[A-Z]{3}\d{2}/, ''); // GANHOK
      ms.sort((x, y) => (String(x.ticker).endsWith('-' + code.slice(0, 3)) ? -1 : String(y.ticker).endsWith('-' + code.slice(0, 3)) ? 1 : x.ticker < y.ticker ? -1 : 1));
      const a = side(ms[0]); const b = side(ms[1]); const start = Math.floor(Date.parse(ms[0].occurrence_datetime || ms[0].expected_expiration_time) / 1000) || null;
      const decided = (a.bid !== null && a.bid >= 0.97) || (b.bid !== null && b.bid >= 0.97);
      const state = decided ? 'closing' : 'upcoming'; const cardCode = (event.split('-').pop().match(/^\d{2}[A-Z]{3}\d{2}/) || [''])[0];
      const cd = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(cardCode); const when = cd ? cd[2].charAt(0) + cd[2].slice(1).toLowerCase() + ' ' + Number(cd[3]) + ' card' : 'Upcoming card';
      const mA = mid(a.bid, a.ask); const midA = mA !== null ? r3(mA) : a.last;
      const favA = midA === null ? true : midA >= 0.5; const fp = midA === null ? null : favA ? midA : 1 - midA; const bk = bucket(fp);
      out.push({ league: 'ufc', event, card: cardCode, start, when, state, text: null, period: null, clock: null,
        a, b, midA, favA, volume: Math.round(a.vol + b.vol), book: null, gap: null, sit: null, inj: null, note: null,
        hist: bk ? { won: bk.won, avg: bk.avg, n: bk.n } : null,
        blurb: bk && fp !== null ? (favA ? a.name : b.name) + ' ' + Math.round(fp * 100) + '¢. Favourites priced here have won ' + Math.round(bk.won * 100) + '% (' + bk.n + ' Kalshi bouts).' : null });
    }
    out.sort((x, y) => (x.start || 0) - (y.start || 0));
    // order on the card: the last bout of a night is the main event
    const cards = {}; for (const f of out) (cards[f.card] = cards[f.card] || []).push(f);
    for (const list of Object.values(cards)) list.forEach((f, i) => { f.note = i === list.length - 1 ? 'Main event' : i === list.length - 2 && list.length > 2 ? 'Co-main event' : null; });
    const bouts = await espnBouts(); for (const f of out) { withEspn(f, bouts); if (f.weight) f.note = [f.note, f.weight + (f.rounds ? ', ' + f.rounds + ' rounds' : '')].filter(Boolean).join(' · '); }
    return out;
  });
}

async function board() {
  const games = await fights();
  return { asOf: new Date().toISOString(), league: 'ufc', label: 'UFC', games, watch: [], scores: true, rounds: games.some((g) => g.espn), injuries: false };
}

async function pricePath(ticker, from, to) {
  const d = await kget('/series/' + SERIES + '/markets/' + ticker + '/candlesticks', { start_ts: from, end_ts: to, period_interval: 1 });
  const pts = [];
  for (const c of d.candlesticks || []) {
    const b = num(c.yes_bid && c.yes_bid.close_dollars); const a = num(c.yes_ask && c.yes_ask.close_dollars);
    let x = b !== null && a !== null && a - b <= 0.06 ? mid(b, a) : null;
    if (x === null && c.price && num(c.volume_fp) > 0) x = num(c.price.close_dollars);
    if (x !== null && x > 0 && x < 1) pts.push([c.end_period_ts, r3(x)]);
  }
  return pts;
}
// Other Kalshi markets on the same bout (distance, method, rounds), when they are listed.
async function props(event) {
  const key = event.split('-').pop(); const out = [];
  await Promise.all(PROPS.map(async ([series, label]) => {
    try {
      const d = await cached('ufc:props:' + series, 30000, () => kget('/markets', { series_ticker: series, status: 'open', limit: 500 }));
      for (const m of d.markets || []) if (String(m.event_ticker).endsWith(key)) { const b = num(m.yes_bid_dollars); const a = num(m.yes_ask_dollars); out.push({ group: label, title: m.yes_sub_title || m.title, ticker: m.ticker, bid: b > 0 ? b : null, ask: a > 0 && a < 1 ? a : null }); }
    } catch (e) { /* that series is not listed for this bout */ }
  }));
  return out.sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : (y.bid || 0) - (x.bid || 0)));
}

// Where the money went on Kalshi: every trade is one side crossing the spread to get in. Buying a fighter's Yes, or the
// other fighter's No, is money on that fighter. Summed over the last 10 and 60 minutes, with the largest single trades.
async function flow(g) {
  const now = Date.now() / 1000; const rows = [];
  await Promise.all([['a', g.a.ticker], ['b', g.b.ticker]].map(async ([k, ticker]) => {
    const d = await cached('ufc:trades:' + ticker, 20000, () => kget('/markets/trades', { ticker, limit: 1000 }));
    for (const t of d.trades || []) {
      const n = num(t.count_fp); const yes = t.taker_side === 'yes'; const price = num(yes ? t.yes_price_dollars : t.no_price_dollars); const at = Date.parse(t.created_time) / 1000;
      if (!(n > 0) || price === null || !at) continue;
      rows.push({ side: yes ? k : (k === 'a' ? 'b' : 'a'), usd: n * price, price, t: at, full: (d.trades || []).length >= 1000 });
    }
  }));
  if (!rows.length) return null;
  const oldest = Math.min(...rows.map((r) => r.t)); const capped = rows.some((r) => r.full); // a busy fight can have more trades than one page holds
  const sum = (secs) => { const o = { a: 0, b: 0, n: 0 }; for (const r of rows) if (now - r.t <= secs) { o[r.side] += r.usd; o.n++; } return { a: Math.round(o.a), b: Math.round(o.b), n: o.n }; };
  const covers = (secs) => !capped || now - oldest >= secs;
  return { m10: covers(600) ? sum(600) : null, m60: covers(3600) ? sum(3600) : null, since: capped ? Math.round(now - oldest) : null, all: capped ? sum(now - oldest) : null,
    big: rows.filter((r) => now - r.t <= 3600).sort((x, y) => y.usd - x.usd).slice(0, 6).map((r) => ({ side: r.side, usd: Math.round(r.usd), price: r.price, t: Math.round(r.t) })) };
}
// The same bout on Polymarket, found by both fighters' names, so the page can show its price and who holds each side there.
async function polyFight(g) {
  const evs = await cached('ufc:pm', 60000, () => getJson('https://gamma-api.polymarket.com/events?limit=60&closed=false&tag_slug=ufc&order=volume24hr&ascending=false', { label: 'Polymarket', ua: UA, timeout: 7000, tries: 2 }));
  const A = nk(g.a.name); const B = nk(g.b.name);
  for (const e of Array.isArray(evs) ? evs : []) {
    const m = (e.markets || []).find((x) => x.slug === e.slug); if (!m) continue;
    let o; let p; try { o = JSON.parse(m.outcomes); p = JSON.parse(m.outcomePrices).map(Number); } catch (err) { continue; }
    if (!Array.isArray(o) || o.length !== 2) continue; const n = o.map(nk); const l = o.map(lastOf);
    const ia = n.indexOf(A) >= 0 ? n.indexOf(A) : l.indexOf(lastOf(A)); const ib = n.indexOf(B) >= 0 ? n.indexOf(B) : l.indexOf(lastOf(B));
    if (ia < 0 || ib < 0 || ia === ib) continue;
    return { slug: e.slug, cond: m.conditionId, title: e.title, price: [p[ia], p[ib]].every((x) => x >= 0 && x <= 1) ? [p[ia], p[ib]] : null, bid: null, volume: num(m.volume) };
  }
  return null;
}

async function detail(event) {
  const g = (await fights()).find((x) => x.event === event);
  if (!g) throw new Error('This fight is no longer listed on Kalshi. It has probably settled.');
  const now = Math.floor(Date.now() / 1000); const live = false;
  const from = now - 12 * 3600;
  const [chart, pr, fl, pm] = await Promise.all([pricePath(g.a.ticker, from, now).catch(() => []), props(event).catch(() => []), flow(g).catch(() => null), polyFight(g).catch(() => null)]);
  const at = (secs) => { const t = now - secs; let v = null; for (const p of chart) { if (p[0] <= t) v = p[1]; else break; } return v; };
  const cur = g.midA; const mv = (s) => (cur !== null && at(s) !== null ? r3(cur - at(s)) : null);
  const pre = cur;
  const fav = g.favA ? g.a : g.b; const fp = cur === null ? null : g.favA ? cur : 1 - cur; const bk = bucket(fp);
  const why = [];
  if (bk) why.push('Favourites Kalshi priced between ' + Math.round(bk.lo * 100) + '¢ and ' + Math.round(Math.min(bk.hi, 1) * 100) + '¢ before the card won ' + Math.round(bk.won * 100) + '% of ' + bk.n + ' bouts, against an average price of ' + Math.round(bk.avg * 100) + '¢.');
  why.push('UFC prices have matched results closely over thousands of fights. The engine paper-trades every favourite at its last price before the card and keeps its own record under Alerts.');
  why.push(g.espn ? 'Round and clock come from ESPN\'s free scoreboard and can run a minute or so behind the cage. There are no live strike or judge counts.' : 'This bout is not matched to a live round feed, so the app cannot tell you when it starts. Kalshi lists the card in order; a sharp price move means it is under way.');
  const read = { level: 'none', title: fp !== null ? fav.name + ' is the favourite at ' + Math.round(fp * 100) + '¢. No tested setup on this fight.' : 'No price yet.', why, side: null };
  return Object.assign({}, g, { asOf: new Date().toISOString(), kind: 'game', label: 'UFC', pre, chart, move: { m5: mv(300), m15: mv(900), m60: mv(3600) }, read, props: pr, flow: fl,
    lines: null, strength: null, form: null, rest: null, model: { live: null, espn: null, proj: null }, pm, makerFee: false, hasScores: true });
}

// Rows for the logger: every listed bout from six hours before its scheduled start until its market closes.
async function watchRows() {
  const now = Date.now() / 1000; const rows = [];
  for (const g of await fights().catch(() => [])) {
    if (!(g.start && g.start - now < 10 * 3600)) continue; // Kalshi's time runs hours late, so this starts well before the card
    rows.push({ lg: 'ufc', event: g.event, start: g.start, state: g.state, a: g.a.code, b: g.b.code, an: g.a.name, bn: g.b.name, at: g.a.ticker, bt: g.b.ticker,
      ab: g.a.bid, aa: g.a.ask, bb: g.b.bid, ba: g.b.ask, sa: null, sb: null, period: null, clock: null, book: null, card: g.card });
  }
  return rows;
}

// What ESPN's free MMA feed returns, trimmed, so its shape can be checked from a deployment before anything relies on it.
async function espnProbe() {
  const out = {};
  try {
    const d = await getJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', { label: 'ESPN', ua: UA, timeout: 6000, tries: 1 });
    const ev = (d.events || [])[0]; out.events = (d.events || []).length;
    if (ev) {
      const comps = ev.competitions || []; const c = comps[comps.length - 1] || {};
      out.event = { id: ev.id, name: ev.name, date: ev.date, keys: Object.keys(ev), bouts: comps.length };
      out.bout = { keys: Object.keys(c), date: c.date, type: c.type, status: c.status, format: c.format,
        fighters: (c.competitors || []).map((x) => ({ keys: Object.keys(x), id: x.id, order: x.order, winner: x.winner, name: x.athlete && x.athlete.displayName, athleteKeys: x.athlete ? Object.keys(x.athlete) : null, age: x.athlete && x.athlete.age, dob: x.athlete && x.athlete.dateOfBirth, record: x.records || x.record || null })) };
    }
  } catch (e) { out.error = String(e && e.message); }
  return out;
}

async function diag() {
  const t0 = Date.now(); const out = {};
  try { const f = await fights(); out.fights = f.length; out.live = f.filter((x) => x.state === 'live').length; out.sample = f[0] ? { event: f[0].event, state: f[0].state, a: f[0].a.name + ' ' + f[0].a.bid + '/' + f[0].a.ask, b: f[0].b.name + ' ' + f[0].b.bid + '/' + f[0].b.ask, note: f[0].note } : null; } catch (e) { out.error = String(e && e.message); }
  out.espn = await espnProbe(); out.ms = Date.now() - t0; return out;
}

module.exports = { board, detail, watchRows, diag, fights, bucket, RECORD, withEspn, flow, polyFight };
