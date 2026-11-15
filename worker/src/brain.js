// The decision engine. Pure functions: no database, no network, so every rule here can be tested on its own.
// Each setup turns "something just happened in a game" into a plan: what to buy, where to sell, when to give up.
// Every plan is opened as a paper trade and scored, so the record decides which setups are worth acting on.

export const SETUPS = {
  nfl_dog_lead: { label: 'NFL underdog takes the lead', push: true, basis: 'Past games: 137 like this, 84% reached 80¢ before the end.' },
  nba_recovery: { label: 'NBA favourite behind, priced under the score model', push: true, basis: 'New setup with no record yet. A plain "buy the favourite when it dips" lost in past games, so this one also needs the model to disagree with the price.' },
  score_follow: { label: 'Price lagging a score change', push: false, basis: 'New setup with no record yet. Checked once a minute, so most lags are gone before it sees them.' },
  tennis_reprice: { label: 'Tennis price under the live model after a set', push: true, basis: 'New setup with no record yet.' },
  injury_news: { label: 'Late injury news', push: false, basis: 'Measures how far the price moves after the report changes.' },
  ufc_fav: { label: 'UFC favourite at the bell', push: false, basis: 'Not a tip. Buys every favourite on paper when the bout before it ends and holds to the result, to keep our own record of how often favourites win at each price.' },
  ufc_flow: { label: 'UFC money piling onto one fighter, sold 15 minutes later', push: false, basis: 'A test, not a tip: when 70% or more of the last 10 minutes of Kalshi money is on one fighter, does the price keep going that way?' },
  ufc_flow_hold: { label: 'UFC money piling onto one fighter, held to the result', push: false, basis: 'The same trigger held to the end: does the fighter the money piled onto actually win more often than the price said?' },
  nfl_flow: { label: 'NFL money piling onto one team, sold 15 minutes later', push: false, basis: 'A test, not a tip: when 70% or more of the last 10 minutes of Kalshi money is on one team, does the price keep going that way?' },
  nfl_flow_hold: { label: 'NFL money piling onto one team, held to the result', push: false, basis: 'The same trigger held to the end: does the team the money piled onto win more often than the price said?' },
  whale_add: { label: 'Big whale add', push: false, basis: 'Measures whether the price moves the whale\'s way after we see the add.' },
};

const SD = { nba: 12, nfl: 13.5 };   // spread of the final margin, in points
const PLEN = { nba: 720, nfl: 900 }; // seconds in a period
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mid = (b, a) => (num(b) !== null && num(a) !== null && a > 0 ? (b + a) / 2 : null);
export const cents = (x) => Math.round(x * 100) + '¢';

export function phi(x) { // normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
export function phiInv(p) { // inverse normal CDF (Acklam)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425; let q; let r;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Share of the game still to play, from the period and the seconds left in it.
export function fracLeft(lg, period, clock) {
  const pl = PLEN[lg]; if (!pl || !num(period) || num(clock) === null) return null;
  const left = period <= 4 ? (4 - period) * pl + clock : clock;
  return Math.max(0.004, Math.min(1, left / (4 * pl)));
}
// Chance the away side (a) wins from here: the pre-game price sets how strong it is, the lead and clock do the rest.
export function gameModel(lg, preA, leadA, period, clock) {
  const f = fracLeft(lg, period, clock); if (f === null || num(preA) === null || num(leadA) === null) return null;
  const sd = SD[lg]; const mu = sd * phiInv(Math.min(0.98, Math.max(0.02, preA)));
  return r3(phi((leadA + mu * f) / (sd * Math.sqrt(f))));
}

// g: this minute's row from the app. prev: the same game a minute ago (or null). preA: a's price just before the start.
export function gameSignals(g, prev, preA, now) {
  const out = []; if (!g || g.state !== 'live' || num(preA) === null || num(g.sa) === null || num(g.sb) === null) return out;
  const mA = gameModel(g.lg, preA, g.sa - g.sb, g.period, g.clock); if (mA === null) return out;
  const f = fracLeft(g.lg, g.period, g.clock);
  const S = (k) => ({ bid: k === 'a' ? num(g.ab) : num(g.bb), ask: k === 'a' ? num(g.aa) : num(g.ba), name: (k === 'a' ? g.an : g.bn) || (k === 'a' ? g.a : g.b), ticker: k === 'a' ? g.at : g.bt, model: k === 'a' ? mA : r3(1 - mA), lead: k === 'a' ? g.sa - g.sb : g.sb - g.sa });
  const P = (k) => (prev ? { bid: k === 'a' ? num(prev.a_bid) : num(prev.b_bid), ask: k === 'a' ? num(prev.a_ask) : num(prev.b_ask) } : null);
  const base = (setup, k, extra) => Object.assign({ setup, lg: g.lg, event: g.event, side: k, name: S(k).name, ticker: S(k).ticker || null, title: (g.an || g.a) + ' v ' + (g.bn || g.b), url: '/#m=' + g.event, entry: S(k).ask, model: S(k).model, t: now }, extra);
  const score = g.sa + '-' + g.sb + ', ' + (g.period > 4 ? 'OT' : 'Q' + g.period);
  const pfav = Math.max(preA, 1 - preA); const fav = preA >= 0.5 ? 'a' : 'b'; const dog = fav === 'a' ? 'b' : 'a';

  // 1) NFL: a game priced close before kick-off, and the underdog's price has just crossed 62¢.
  if (g.lg === 'nfl' && pfav <= 0.62) {
    const s = S(dog); const p = P(dog);
    if (s.ask !== null && s.ask >= 0.62 && s.ask <= 0.72 && p && p.ask !== null && p.ask < 0.62) {
      out.push(base('nfl_dog_lead', dog, { id: 'nfl_dog_lead|' + g.event, target: 0.8, deadline: null, why: s.name + ' were ' + cents(1 - pfav) + ' before the game and are now ' + cents(s.ask) + ' (' + score + '). Plan: sell at 80¢, otherwise hold to the end.' }));
    }
  }
  // 2) NBA: a clear pre-game favourite is behind with plenty of game left, and the price is under what the score model says.
  if (g.lg === 'nba' && pfav >= 0.62 && f !== null && f >= 0.4) {
    const s = S(fav); const behind = -s.lead;
    if (s.ask !== null && behind >= 6 && behind <= 14 && s.model - s.ask >= 0.04) {
      out.push(base('nba_recovery', fav, { id: 'nba_recovery|' + g.event, target: Math.min(0.95, r2(s.ask + 0.12)), deadline: now + 40 * 60, ctx: { maxBehind: 20 },
        why: s.name + ' were ' + cents(pfav) + ' before the game, trail by ' + behind + ' (' + score + ') and cost ' + cents(s.ask) + '. Score model says ' + Math.round(s.model * 100) + '%. Plan: sell 12¢ higher, out if the gap reaches 20 points or after 40 minutes.' }));
    }
  }
  // 3) Either league: the score changed since last minute and the price moved less than half of what the model did.
  if (prev && num(prev.a_score) !== null && num(prev.b_score) !== null && now - prev.t <= 150 && (prev.a_score !== g.sa || prev.b_score !== g.sb)) {
    const mPrevA = gameModel(g.lg, preA, prev.a_score - prev.b_score, prev.period, prev.clock);
    if (mPrevA !== null && mPrevA !== mA) {
      const k = mA > mPrevA ? 'a' : 'b'; const s = S(k); const p = P(k); const dM = Math.abs(mA - mPrevA);
      const m0 = mid(p.bid, p.ask); const m1 = mid(s.bid, s.ask);
      if (s.ask !== null && m0 !== null && m1 !== null && dM >= 0.04 && m1 - m0 <= 0.5 * dM && s.model - s.ask >= 0.03) {
        const target = r2(Math.min(s.model, s.ask + 0.6 * (dM - Math.max(0, m1 - m0))));
        if (target >= s.ask + 0.02) out.push(base('score_follow', k, { id: 'score_follow|' + g.event + '|' + g.sa + '-' + g.sb, target, deadline: now + 6 * 60,
          why: 'Score went to ' + score + '. Model moved ' + Math.round(dM * 100) + ' points for ' + s.name + ', price moved ' + Math.round((m1 - m0) * 100) + '¢. Plan: sell at ' + cents(target) + ' or after 6 minutes.' }));
      }
    }
  }
  return out;
}

// UFC: no score to model, so the engine keeps the record instead. Every favourite is bought on paper when it is next up.
export function fightSignals(g, now) {
  if (!g || g.lg !== 'ufc' || g.state === 'closing') return []; // the logger calls this once, when the bout before it on the card has just ended
  const mA = mid(g.ab, g.aa); if (mA === null) return [];
  const k = mA >= 0.5 ? 'a' : 'b'; const ask = k === 'a' ? num(g.aa) : num(g.ba); const name = k === 'a' ? g.an : g.bn;
  if (ask === null || ask < 0.5 || ask >= 0.97) return [];
  return [{ id: 'ufc_fav|' + g.event, setup: 'ufc_fav', lg: 'ufc', event: g.event, side: k, name, ticker: k === 'a' ? g.at : g.bt, title: g.an + ' v ' + g.bn, url: '/#m=' + g.event,
    entry: ask, model: null, target: null, deadline: null, t: now, ctx: { card: g.card || null }, why: name + ' is the favourite at ' + cents(ask) + ' as the bout before it ends. Held to the result.' }];
}
// UFC money test: at least $10k traded on a bout in the last 10 minutes with 70% or more of it on one fighter.
// Opened once per fighter before the fight and once per round, two ways: sold after 15 minutes, and held to the result.
export function flowSignals(g, now) {
  if (!g || (g.lg !== 'ufc' && g.lg !== 'nfl') || g.state === 'closing' || !Array.isArray(g.f10)) return [];
  const nfl = g.lg === 'nfl'; const a = num(g.f10[0]) || 0; const b = num(g.f10[1]) || 0; const tot = a + b; if (tot < (nfl ? 25000 : 10000)) return []; // NFL games trade far more, so the bar is higher
  const k = a >= b ? 'a' : 'b'; const share = Math.max(a, b) / tot; if (share < 0.7) return [];
  const ask = k === 'a' ? num(g.aa) : num(g.ba); if (ask === null || ask < 0.1 || ask > 0.9) return [];
  const name = k === 'a' ? g.an : g.bn; const phase = g.state === 'live' ? (nfl ? 'q' : 'r') + (g.period || 0) : 'pre';
  const base = { lg: g.lg, event: g.event, side: k, name, ticker: k === 'a' ? g.at : g.bt, title: g.an + ' v ' + g.bn, url: '/#m=' + g.event, entry: ask, model: null, target: null, t: now, ctx: { card: g.card || null, share: r2(share), usd: Math.round(tot), phase },
    why: '$' + Math.round(Math.max(a, b) / 1000) + 'k of the $' + Math.round(tot / 1000) + 'k traded on Kalshi in the last 10 minutes was on ' + name + ' (' + Math.round(share * 100) + '%), ' + (phase === 'pre' ? 'before the start' : (nfl ? 'in quarter ' : 'in round ') + (g.period || '?')) + '. Bought at ' + cents(ask) + '.' };
  return [Object.assign({ id: g.lg + '_flow|' + g.event + '|' + k + '|' + phase, setup: g.lg + '_flow', deadline: now + 15 * 60 }, base), Object.assign({ id: g.lg + '_flow_hold|' + g.event + '|' + k + '|' + phase, setup: g.lg + '_flow_hold', deadline: null }, base)];
}
// Our own UFC record from those paper trades: how often favourites won at each price, and what rolling the two
// biggest favourites of each card into each other ("a 2x parlay") actually returned.
export function favStats(rows) {
  const done = rows.filter((r) => r.setup === 'ufc_fav' && r.status === 'settled' && (r.exit === 0 || r.exit === 1));
  const edges = [0.5, 0.6, 0.7, 0.8, 1.01];
  const buckets = edges.slice(0, -1).map((lo, i) => { const x = done.filter((r) => r.entry >= lo && r.entry < edges[i + 1]); return { lo, hi: Math.min(1, edges[i + 1]), n: x.length, won: x.filter((r) => r.exit === 1).length, avg: x.length ? r3(x.reduce((s, r) => s + r.entry, 0) / x.length) : null }; });
  const cards = {}; for (const r of done) { let c = null; try { c = r.ctx ? (typeof r.ctx === 'string' ? JSON.parse(r.ctx) : r.ctx).card : null; } catch (e) { c = null; } if (c) (cards[c] = cards[c] || []).push(r); }
  let n = 0; let hit = 0; let ret = 0; let pay = 0;
  for (const list of Object.values(cards)) {
    if (list.length < 2) continue; const two = list.slice().sort((x, y) => y.entry - x.entry).slice(0, 2);
    const cost = (p) => p + 0.07 * p * (1 - p); const payout = 1 / (cost(two[0].entry) * cost(two[1].entry)); // $1 rolled through both, fees in
    n++; pay += payout; if (two[0].exit === 1 && two[1].exit === 1) { hit++; ret += payout - 1; } else ret -= 1;
  }
  return { fights: done.length, won: done.filter((r) => r.exit === 1).length, buckets, roll: { cards: n, hit, avgPayout: n ? r2(pay / n) : null, avgReturn: n ? r3(ret / n) : null } };
}

// Tennis, after the first set: the live model against the price to buy. One look per set.
export function tennisSignals(m, now) {
  const out = []; if (!m || !m.live || num(m.live.a) === null || !m.pm || !m.pm.sets || (m.state !== 'set2' && m.state !== 'decider')) return out;
  // The estimate moves by ten points or more with the server and the point score. Without both, and without a score
  // read in the last two and a half minutes, an apparent gap can be the wrong way round, so nothing is opened.
  if (!m.live.known || !num(m.live.at) || now - m.live.at > 150) return out;
  const nSets = m.pm.sets.length;
  for (const k of ['a', 'b']) {
    const fair = k === 'a' ? m.live.a : 1 - m.live.a; const ask = num(m[k].ask); if (ask === null || ask <= 0.05 || ask >= 0.93) continue;
    const fee = 0.07 * ask * (1 - ask);
    if (fair - ask - fee < 0.06) continue;
    const target = r2(fair - 0.01); if (target < ask + 0.03) continue;
    out.push({ id: 'tennis_reprice|' + m.event + '|' + nSets, setup: 'tennis_reprice', lg: 'tennis', event: m.event, side: k, name: m[k].name, ticker: m[k].ticker || null, title: m.a.name + ' v ' + m.b.name, url: '/#m=' + m.event,
      entry: ask, model: r3(fair), target, deadline: now + 45 * 60, t: now, ctx: { sets: nSets },
      why: m[k].name + ' cost ' + cents(ask) + ' in set ' + nSets + '. Live model says ' + Math.round(fair * 100) + '%. Plan: sell at ' + cents(target) + ', out when this set ends or after 45 minutes.' });
  }
  return out;
}

// What one contract made or lost, in cents, after Kalshi's fees. Whale adds are on Polymarket and carry no fee here.
export function netCents(sig, status, exit) {
  if (num(sig.entry) === null || num(exit) === null) return null;
  if (sig.setup === 'whale_add') return Math.round((exit - sig.entry) * 1000) / 10;
  const feeIn = 7 * sig.entry * (1 - sig.entry);
  const feeOut = status === 'settled' ? 0 : (status === 'target' ? 1.75 : 7) * exit * (1 - exit); // a resting sell at the target pays the smaller fee
  return Math.round(((exit - sig.entry) * 100 - feeIn - feeOut) * 10) / 10;
}

// One open paper trade against this minute's quote. Returns what to store, and whether it is finished.
// q: { bid, ask, state, behind, sets } or null when the market is not in the feed this minute.
export function manage(sig, q, now) {
  const up = {}; const done = (status, exit) => Object.assign(up, { status, exit, exit_t: now, net: netCents(sig, status, exit) });
  const age = now - sig.t; const ctx = sig.ctx || {};
  // A result only counts when the exchange has confirmed it. A 97¢ bid or a vanished quote proves nothing.
  if (q && (q.result === 'yes' || q.result === 'no')) return done('settled', q.result === 'yes' ? 1 : 0);
  if (q && q.result === 'scalar' && num(q.settle) !== null) return done('settled', q.settle); // a draw or no contest: the exchange pays a set amount, usually 50¢
  if (!q || num(q.bid) === null && num(q.ask) === null) {
    // No quote and no confirmed result: keep waiting. A timed trade that cannot be priced at its deadline is thrown out,
    // not guessed, and a hold-to-result trade is thrown out only after three days without an answer.
    if (sig.deadline ? now >= sig.deadline + 600 : age > 3 * 86400) return done('void', sig.entry);
    return up;
  }
  const bid = num(q.bid) !== null ? q.bid : 0; const ask = num(q.ask);
  if (num(sig.last) === null || Math.abs(bid - sig.last) >= 0.01) up.last = bid;
  if (num(sig.hi) === null || bid > sig.hi) up.hi = bid;
  if (num(sig.lo) === null || bid < sig.lo) up.lo = bid;
  if (num(sig.m5) === null && age >= 300) up.m5 = bid;
  if (num(sig.m15) === null && age >= 900) up.m15 = bid;
  if (num(sig.target) !== null && bid >= sig.target - 1e-9) return done('target', sig.target);
  if (ctx.maxBehind && num(q.behind) !== null && q.behind >= ctx.maxBehind) return done('invalid', bid);
  if (ctx.sets && num(q.sets) !== null && q.sets > ctx.sets) return done('deadline', bid);
  if (sig.deadline && now >= sig.deadline) return done('deadline', bid);
  return up;
}

// The scoreboard: how each setup has done on closed paper trades.
export function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const s = by[r.setup] = by[r.setup] || { setup: r.setup, label: (SETUPS[r.setup] || {}).label || r.setup, basis: (SETUPS[r.setup] || {}).basis || '', open: 0, n: 0, target: 0, net: 0, m15: 0, m15n: 0 };
    if (r.status === 'open') { s.open++; continue; }
    if (r.status === 'void' || num(r.net) === null) continue;
    s.n++; s.net += r.net; if (r.status === 'target' || r.status === 'settled' && r.exit === 1) s.target++;
    if (num(r.m15) !== null && num(r.entry) !== null) { s.m15 += (r.m15 - r.entry) * 100; s.m15n++; }
  }
  return Object.keys(SETUPS).map((k) => by[k] || { setup: k, label: SETUPS[k].label, basis: SETUPS[k].basis, open: 0, n: 0, target: 0, net: 0, m15: 0, m15n: 0 })
    .map((s) => ({ setup: s.setup, label: s.label, basis: s.basis, open: s.open, n: s.n, won: s.target, avg: s.n ? Math.round(s.net / s.n * 10) / 10 : null, total: Math.round(s.net * 10) / 10, m15: s.m15n ? Math.round(s.m15 / s.m15n * 10) / 10 : null }));
}

// Whale grades: does the price move the whale's way in the hour after we see the add? Small samples are pulled toward that category's average.
export function whaleGrades(rows) {
  const closed = rows.filter((r) => r.setup === 'whale_add' && r.status !== 'open' && num(r.net) !== null);
  const cat = {}; for (const r of closed) { const c = cat[r.lg] = cat[r.lg] || { n: 0, sum: 0 }; c.n++; c.sum += r.net; }
  const by = {}; for (const r of closed) { const k = r.name + '|' + r.lg; const w = by[k] = by[k] || { whale: r.name, cat: r.lg, n: 0, sum: 0 }; w.n++; w.sum += r.net; }
  const K = 10; // an add counts fully only after about ten of them
  return Object.values(by).map((w) => { const base = cat[w.cat].sum / cat[w.cat].n; return { whale: w.whale, cat: w.cat, n: w.n, avg: Math.round(w.sum / w.n * 10) / 10, grade: Math.round((w.sum + K * base) / (w.n + K) * 10) / 10 }; })
    .sort((x, y) => y.grade - x.grade);
}
