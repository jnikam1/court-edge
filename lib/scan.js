// Lists open Kalshi tennis match markets, works out the set state from Kalshi's own
// set-winner markets and Polymarket's live score, and compares the price in the break after
// set 1 with a fair value fitted on Kalshi's settled matches. Public data only, no API key.
const { kget, num, ts, fee, mid, cached } = require('./kalshi');
const { RULES, ruleFav } = require('./model');
const poly = require('./poly');
const TOURS = [
  { tour: 'ATP', label: 'ATP', match: 'KXATPMATCH', set: 'KXATPSETWINNER' },
  { tour: 'WTA', label: 'WTA', match: 'KXWTAMATCH', set: 'KXWTASETWINNER' },
  { tour: 'CH', label: 'ATP Challenger', match: 'KXATPCHALLENGERMATCH', set: null },
];
const BREAK_WINDOW_S = 420; // verdicts only count in the first 7 minutes after set 1 really ended
const MIN_EDGE = 0.03; // after fees
const Z = 1.64; // gap must also clear this many standard errors of the fair value
const SLAM = /(Australian Open|Roland Garros|French Open|Wimbledon|US Open)/i;
const tournamentOf = (rules) => { const m = /in the (?:\d{4} )?(.+?) after a ball/.exec(rules || ''); return m ? m[1].replace(/\s+(Men|Women)('s)? Singles.*$/i, '').trim() : null; };

async function openMarkets(series) {
  const out = []; let cursor;
  for (let page = 0; page < 4; page++) {
    const d = await kget('/markets', { series_ticker: series, status: 'open', limit: 1000, cursor });
    out.push(...(d.markets || []));
    cursor = d.cursor; if (!cursor) break;
  }
  return out;
}

async function byTickers(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 50) {
    const d = await kget('/markets', { tickers: tickers.slice(i, i + 50).join(','), limit: 200 });
    for (const m of d.markets || []) out[m.ticker] = m;
  }
  return out;
}

async function scan() {
  const now = Math.floor(Date.now() / 1000);
  const matches = [];
  const boardP = poly.board().catch(() => []);
  for (const T of TOURS) {
    let ms = [];
    try { ms = await openMarkets(T.match); } catch (e) { if (T.tour !== 'CH') throw e; }
    const events = {};
    for (const m of ms) (events[m.event_ticker] = events[m.event_ticker] || []).push(m);
    const list = Object.entries(events).filter(([, v]) => v.length === 2);
    const setTickers = [];
    for (const [ev, v] of list) {
      v.sort((x, y) => (x.ticker < y.ticker ? -1 : 1));
      const code = ev.split('-').slice(1).join('-');
      const suf = v[0].ticker.split('-').pop();
      if (T.set) for (const n of [1, 2, 3]) setTickers.push(`${T.set}-${code}-${n}-${suf}`);
    }
    const sets = setTickers.length ? await byTickers(setTickers) : {};
    for (const [ev, v] of list) {
      const code = ev.split('-').slice(1).join('-');
      const suf = v[0].ticker.split('-').pop();
      const side = (m) => ({ name: (m.yes_sub_title || '').trim(), ticker: m.ticker, bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars), last: num(m.last_price_dollars) });
      const A = side(v[0]); const B = side(v[1]);
      const setInfo = [1, 2, 3].map((n) => {
        const m = sets[`${T.set}-${code}-${n}-${suf}`];
        if (!m) return null;
        const res = (m.result || '').toLowerCase();
        return { winner: res === 'yes' ? 'a' : res === 'no' ? 'b' : null, closed: res ? ts(m.close_time) : null, aBid: num(m.yes_bid_dollars), aAsk: num(m.yes_ask_dollars) };
      });
      const bestOf5 = T.tour === 'ATP' && SLAM.test(v[0].rules_primary || '');
      const s1 = setInfo[0]; const s2 = setInfo[1];
      let state = 'upcoming'; let since = null;
      if (s1 && s1.winner) {
        state = 'set2'; since = s1.closed ? now - s1.closed : null;
        if (s2 && s2.winner) {
          state = s2.winner === s1.winner ? 'closing' : 'decider';
          since = s2.closed ? now - s2.closed : null;
        }
      }
      matches.push({
        tour: T.tour, tourLabel: T.label, series: T.match, event: ev, a: A, b: B, state, since, bestOf5,
        tournament: tournamentOf(v[0].rules_primary),
        volume: Math.round((num(v[0].volume_fp) || 0) + (num(v[1].volume_fp) || 0)),
        listedStart: v[0].occurrence_datetime || null,
        set1: s1 ? { winner: s1.winner, closed: s1.closed, aMid: mid(s1.aBid, s1.aAsk), ticker: `${T.set}-${code}-1-${suf}` } : null,
        set2: s2 ? { winner: s2.winner } : null,
        hasSetMarkets: !!s1,
      });
    }
  }

  // Live score from Polymarket, where it lists the same match.
  const board = await boardP;
  for (const m of matches) {
    const t = Date.parse(m.listedStart || '') / 1000;
    const e = poly.orient(poly.pick(board, m.a.name, m.b.name, Number.isFinite(t) ? t : now), m.a.name);
    if (!e || !e.start || Math.abs(Date.parse(e.start) / 1000 - (Number.isFinite(t) ? t : now)) > 36 * 3600) continue;
    m.pm = { slug: e.slug, live: e.live, ended: e.ended, period: e.period, sets: e.sets, start: e.start, price: e.price };
    if (e.live && e.sets && (m.state === 'upcoming')) {
      let sa = 0; let sb = 0;
      for (const [x, y] of e.sets.slice(0, -1)) { if (x > y) sa++; else sb++; }
      m.state = sa + sb === 0 ? 'set1' : sa === 1 && sb === 1 ? 'decider' : sa + sb === 1 ? 'set2' : 'closing';
      if (!m.set1 && sa + sb >= 1) m.set1 = { winner: e.sets[0][0] > e.sets[0][1] ? 'a' : 'b', timing: 'score' };
    }
  }

  // Is a match with no finished set already under way? Kalshi has no start flag, so look
  // at the last 20 minutes of prices: pre-match quotes barely move, in-play ones swing.
  // Kalshi's listed time is roughly when the match should be over, about two hours after the start.
  const farOff = (m) => (m.pm && m.pm.start && Date.parse(m.pm.start) / 1000 - now > 1800) || (m.listedStart && Date.parse(m.listedStart) / 1000 - now > 3.5 * 3600);
  const waiting = matches.filter((m) => m.state === 'upcoming' && !farOff(m));
  for (let i = 0; i < waiting.length; i += 25) {
    const part = waiting.slice(i, i + 25);
    let d = { markets: [] };
    try { d = await kget('/markets/candlesticks', { market_tickers: part.map((m) => m.a.ticker).join(','), start_ts: now - 20 * 60, end_ts: now, period_interval: 1 }); } catch (e) { /* state stays 'upcoming' */ }
    const byT = {}; for (const x of d.markets || []) byT[x.market_ticker] = x.candlesticks || [];
    for (const m of part) {
      const v = (byT[m.a.ticker] || []).map((c) => {
        const b = num(c.yes_bid && c.yes_bid.close_dollars); const a = num(c.yes_ask && c.yes_ask.close_dollars);
        return b !== null && a !== null && a - b <= 0.04 ? mid(b, a) : null; // ignore thin, wide quotes
      }).filter((x) => x !== null);
      const range = v.length ? Math.max(...v) - Math.min(...v) : 0;
      const s1 = m.set1 && m.set1.aMid;
      if (range >= 0.03 || (s1 !== null && s1 !== undefined && (s1 >= 0.9 || s1 <= 0.1))) m.state = 'set1';
    }
  }

  // When did set 1 really end? Kalshi settles the set market 10-15 minutes late, so its
  // close time is no use. Use the price instead: the minute from which the set-1 market
  // has stayed locked at 98.5c+ for one player. A lock must hold 3 minutes to count,
  // because a player holding set points can touch 99c and still lose the set.
  const LOCK_MIN = 3;
  const lockable = matches.filter((m) => m.set1 && m.set1.ticker && (m.set1.winner ? (m.set1.closed && now - m.set1.closed < 3 * 3600) : (m.set1.aMid !== null && (m.set1.aMid >= 0.985 || m.set1.aMid <= 0.015))));
  for (let i = 0; i < lockable.length; i += 10) {
    const part = lockable.slice(i, i + 10);
    const from = Math.min(...part.map((m) => (m.set1.closed || now))) - 45 * 60;
    let d = { markets: [] };
    try { d = await kget('/markets/candlesticks', { market_tickers: part.map((m) => m.set1.ticker).join(','), start_ts: from, end_ts: now, period_interval: 1 }); } catch (e) { /* fall back below */ }
    const byT = {}; for (const x of d.markets || []) byT[x.market_ticker] = x.candlesticks || [];
    for (const m of part) {
      const settled = !!m.set1.winner;
      const cs = (byT[m.set1.ticker] || []).filter((c) => !settled || c.end_period_ts <= m.set1.closed + 60);
      let lockTs = null; let lastTs = null; let winner = m.set1.winner;
      for (let k = cs.length - 1; k >= 0; k--) {
        const b = num(cs[k].yes_bid && cs[k].yes_bid.close_dollars); const a = num(cs[k].yes_ask && cs[k].yes_ask.close_dollars);
        if (b === null && a === null) continue;
        if (settled && b === 0 && a === 1) continue; // empty book after settlement
        const side = b !== null && b >= 0.985 ? 'a' : a !== null && a <= 0.015 ? 'b' : null;
        if (!side || (winner && side !== winner)) break;
        winner = winner || side; lockTs = cs[k].end_period_ts; if (lastTs === null) lastTs = cs[k].end_period_ts;
      }
      if (settled) {
        m.set1.ended = lockTs || m.set1.closed; m.set1.timing = lockTs ? 'price' : 'settlement';
      } else if (lockTs !== null && (lastTs - lockTs) / 60 + 1 >= LOCK_MIN) {
        m.set1.winner = winner; m.set1.ended = lockTs; m.set1.timing = 'price';
      }
      if (m.set1.winner && m.set1.ended && (m.state === 'upcoming' || m.state === 'set1' || m.state === 'set2')) { m.state = 'set2'; m.since = now - m.set1.ended; }
    }
  }

  // Pre-match price and price at the set break, from 1-minute candles (same definition as
  // the backtest: pre = 70-180 min before set 1 ended; break = 1-4 min after).
  const live = matches.filter((m) => m.set1 && m.set1.winner && m.set1.ended && now - m.set1.ended < 5 * 3600);
  if (live.length) {
    const start = Math.min(...live.map((m) => m.set1.ended)) - 180 * 60;
    const candles = {};
    for (let i = 0; i < live.length; i += 12) {
      const part = live.slice(i, i + 12);
      const d = await kget('/markets/candlesticks', { market_tickers: part.map((m) => m.a.ticker).join(','), start_ts: start, end_ts: now, period_interval: 1 });
      for (const x of d.markets || []) candles[x.market_ticker] = x.candlesticks || [];
    }
    for (const m of live) {
      const cs = candles[m.a.ticker] || [];
      const avg = (lo, hi) => {
        const v = [];
        for (const c of cs) {
          if (c.end_period_ts < lo || c.end_period_ts > hi) continue;
          const x = mid(num(c.yes_bid && c.yes_bid.close_dollars), num(c.yes_ask && c.yes_ask.close_dollars));
          if (x !== null) v.push(x);
        }
        return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
      };
      const t1 = m.set1.ended;
      const pre = avg(t1 - 180 * 60, t1 - 70 * 60);
      const brk = avg(t1 + 60, t1 + 240);
      m.pre = pre; m.atBreak = brk;
      if (pre === null || m.bestOf5) continue;
      const favA = pre >= 0.5; const pfav = favA ? pre : 1 - pre;
      const favWon = (m.set1.winner === 'a') === favA;
      const f = ruleFav(m.tour, pfav, favWon);
      if (!f) continue;
      const fairA = favA ? f.fair : 1 - f.fair;
      m.fair = { a: fairA, b: 1 - fairA, se: f.se, n: f.n, favWonSet1: favWon, fav: favA ? 'a' : 'b' };
      const inWindow = m.state === 'set2' && m.set1.timing === 'price' && m.since !== null && m.since <= BREAK_WINDOW_S;
      m.inWindow = inWindow;
      // Net edge of buying each side at its ask, live price if the window is open,
      // otherwise the price that was on screen at the break.
      const priceA = inWindow ? m.a.ask : brk; const priceB = inWindow ? m.b.ask : brk === null ? null : 1 - brk;
      const eA = priceA === null ? null : fairA - priceA - fee(priceA);
      const eB = priceB === null ? null : (1 - fairA) - priceB - fee(priceB);
      const best = eA !== null && (eB === null || eA >= eB) ? { side: 'a', edge: eA, price: priceA } : eB !== null ? { side: 'b', edge: eB, price: priceB } : null;
      if (best) {
        const need = Math.max(MIN_EDGE, Z * f.se);
        const spreadOk = !inWindow || (m[best.side].ask !== null && m[best.side].bid !== null && m[best.side].ask - m[best.side].bid <= 0.03);
        m.call = { side: best.side, edge: best.edge, price: best.price, need, live: inWindow, bet: best.edge >= need && spreadOk };
      }
    }
  }
  const rank = (m) => (m.call && m.call.bet && m.call.live ? 0 : m.inWindow ? 1 : m.state === 'set2' || m.state === 'decider' || m.state === 'closing' ? 2 : m.state === 'set1' ? 3 : 4);
  matches.sort((x, y) => rank(x) - rank(y) || (x.since ?? 1e9) - (y.since ?? 1e9) || String(x.listedStart).localeCompare(String(y.listedStart)));
  return {
    asOf: new Date().toISOString(),
    rules: RULES ? { fitted: RULES.fitted_utc, n: RULES.n_total } : null,
    thresholds: { minEdge: MIN_EDGE, z: Z, windowSeconds: BREAK_WINDOW_S },
    matches,
  };
}

module.exports = { scan: () => cached('scan', 6000, scan), TOURS };
