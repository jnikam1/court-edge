// Point-level tennis model (points -> games -> sets -> match) and the player table.
const { sig, logit, norm } = require('./kalshi');
const RULES = require('./rules.json');
const PLAYERS = require('./players.json');

function memo(fn) { const m = new Map(); return (...a) => { const k = a.join(','); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); }; }

// P(the player who wins each point with chance p wins the game) from i points to j. Points are counts: 0, 1, 2, 3 for love, 15, 30, 40.
function game(p, i0, j0) {
  const f = memo((i, j) => {
    if (i >= 4 && i - j >= 2) return 1;
    if (j >= 4 && j - i >= 2) return 0;
    if (i >= 3 && j >= 3 && i === j) return (p * p) / (p * p + (1 - p) * (1 - p));
    return p * f(i + 1, j) + (1 - p) * f(i, j + 1);
  });
  return f(i0 || 0, j0 || 0);
}
const hold = (p) => game(p, 0, 0);

function tiebreak(pa, pb, aFirst, a0, b0) {
  const f = memo((a, b) => {
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
    if (a >= 6 && b >= 6 && a === b) { const w = pa * (1 - pb); const l = (1 - pa) * pb; return w / (w + l); }
    const first = Math.floor((a + b + 1) / 2) % 2 === 0;
    const aSrv = aFirst ? first : !first;
    const p = aSrv ? pa : 1 - pb;
    return p * f(a + 1, b) + (1 - p) * f(a, b + 1);
  });
  return f(a0 || 0, b0 || 0);
}

// P(A wins the set) from games ga-gb, with A serving this game or not. pts = [A's points, B's points] in the game
// being played, if known. In a tiebreak aServing means A served its first point.
function setFrom(pa, pb, ga, gb, aServing, pts) {
  const ha = hold(pa); const hb = hold(pb);
  const g = memo((a, b, s) => {
    if ((a >= 6 && a - b >= 2) || a === 7) return 1;
    if ((b >= 6 && b - a >= 2) || b === 7) return 0;
    if (a === 6 && b === 6) return tiebreak(pa, pb, !!s);
    const h = s ? ha : 1 - hb;
    return h * g(a + 1, b, s ? 0 : 1) + (1 - h) * g(a, b + 1, s ? 0 : 1);
  });
  if (!pts || (!pts[0] && !pts[1])) return g(ga, gb, aServing ? 1 : 0);
  if (ga === 6 && gb === 6) return tiebreak(pa, pb, !!aServing, pts[0], pts[1]);
  const q = aServing ? game(pa, pts[0], pts[1]) : 1 - game(pb, pts[1], pts[0]); // chance A takes the game in progress
  return q * g(ga + 1, gb, aServing ? 0 : 1) + (1 - q) * g(ga, gb + 1, aServing ? 0 : 1);
}
const setAvg = (pa, pb, ga, gb) => 0.5 * (setFrom(pa, pb, ga, gb, true) + setFrom(pa, pb, ga, gb, false));

// Best of three. Server unknown, so average over who serves next.
function matchFrom(pa, pb, sa, sb, ga, gb, srv, pts) {
  const now = srv === 'a' ? setFrom(pa, pb, ga, gb, true, pts) : srv === 'b' ? setFrom(pa, pb, ga, gb, false, pts) : setAvg(pa, pb, ga, gb);
  const fresh = setAvg(pa, pb, 0, 0);
  const after = (x, y) => {
    if (x === 2) return 1;
    if (y === 2) return 0;
    if (x === 1 && y === 1) return fresh;
    if (x === 1) return fresh + (1 - fresh) * fresh;
    if (y === 1) return fresh * fresh;
    return fresh * fresh + 2 * fresh * fresh * (1 - fresh);
  };
  return now * after(sa + 1, sb) + (1 - now) * after(sa, sb + 1);
}

function fitGap(target, sum, fn) {
  let lo = -0.5; let hi = 0.5;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fn(sum / 2 + m / 2, sum / 2 - m / 2) < target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

const CAT = { ATP: 'ATP tour', WTA: 'WTA tour', CH: 'ATP Challenger' };
const SURFACE = [
  [/\b(roland garros|french open|monte.?carlo|madrid|rome|internazionali|barcelona|hamburg|munich|geneva|lyon|estoril|marrakech|bucharest|buenos aires|rio de janeiro|rio open|santiago|cordoba|bastad|gstaad|umag|kitzbuhel|charleston|bogota|rabat|strasbourg|palermo|prague|iasi|budapest|lima|montevideo|guayaquil|sao paulo|clay)\b/i, 'c'],
  [/\b(wimbledon|halle|queen'?s|hertogenbosch|eastbourne|mallorca|nottingham|birmingham|bad homburg|berlin|newport|grass)\b/i, 'g'],
];
function surfaceOf(tournament) { for (const [re, s] of SURFACE) if (re.test(tournament || '')) return s; return 'h'; }
const SURF_NAME = { h: 'hard', c: 'clay', g: 'grass' };

function player(name) { return PLAYERS.players[norm(name)] || null; }

// Pre-match P(A wins) from overall and surface ratings. Ratings stop at PLAYERS.through.
function ratingProb(tour, nameA, nameB, surf) {
  const a = player(nameA); const b = player(nameB);
  if (!a || !b) return null;
  const bl = PLAYERS.blend[CAT[tour]] || PLAYERS.blend['ATP tour'];
  const sa = a.s[surf] ? a.s[surf][0] : 1500; const sb = b.s[surf] ? b.s[surf][0] : 1500;
  const z = ((bl[0] * (a.e - b.e) + bl[1] * (sa - sb)) / 400) * Math.LN10;
  return sig(z);
}

function ruleFav(tour, pfav, favWonS1) {
  const t = RULES.tours[tour === 'CH' ? 'ATP' : tour];
  const r = t && t[favWonS1 ? 'fav_won_s1' : 'fav_lost_s1'];
  if (!r) return null;
  const p = Math.min(0.97, Math.max(0.5, pfav));
  const f = sig(r.a + r.b * logit(p));
  return { fair: f, se: f * (1 - f) * r.se, n: r.n };
}

// Fair P(A wins the match) from the live score. sets = [[a,b],...] with the set in play last.
// Anchors: before any set is done, the pre-match price. After set 1, how Kalshi matches with
// this pre-match price and this set-1 winner really finished. At one set each, tour history.
// Feeds show a finished set (6-3, 7-5, 7-6) for a moment before the next one appears. Treat it as done.
function settle(sets) {
  const c = sets[sets.length - 1]; const hi = Math.max(c[0], c[1]); const lo = Math.min(c[0], c[1]);
  return (hi >= 6 && hi - lo >= 2) || hi >= 7 ? sets.concat([[0, 0]]) : sets;
}
function liveFair(tour, pre, sets, ended, srv, pts) {
  if (pre === null || pre === undefined || !sets || !sets.length || ended) return null;
  sets = settle(sets);
  const sum = 2 * (PLAYERS.tour_serve[CAT[tour]] || 0.62);
  const done = sets.slice(0, -1); const cur = sets[sets.length - 1];
  let sa = 0; let sb = 0;
  for (const [x, y] of done) { if (x > y) sa++; else sb++; }
  if (sa >= 2 || sb >= 2) return null;
  const ga = Math.min(cur[0], 6); const gb = Math.min(cur[1], 6);
  const favA = pre >= 0.5; const pfav = favA ? pre : 1 - pre;
  let anchor; let basis;
  if (sa + sb === 0) {
    anchor = pre; basis = 'pre-match price';
    const d = fitGap(anchor, sum, (x, y) => matchFrom(x, y, 0, 0, 0, 0));
    return { a: matchFrom(sum / 2 + d / 2, sum / 2 - d / 2, 0, 0, ga, gb, srv, pts), anchor, basis };
  }
  if (sa + sb === 1) {
    const favWon = (sa === 1) === favA;
    const r = ruleFav(tour, pfav, favWon);
    if (!r) return null;
    anchor = favA ? r.fair : 1 - r.fair; basis = 'Kalshi matches after set 1 (n=' + r.n + ')';
    const d = fitGap(anchor, sum, (x, y) => matchFrom(x, y, sa, sb, 0, 0));
    return { a: matchFrom(sum / 2 + d / 2, sum / 2 - d / 2, sa, sb, ga, gb, srv, pts), anchor, basis, se: r.se };
  }
  const k = RULES.decider[tour] || RULES.decider.ATP;
  const favWonS2 = (done[1][0] > done[1][1]) === favA;
  const pf = sig(k.a + k.b * logit(Math.min(0.97, pfav)) + (favWonS2 ? k.c : 0));
  anchor = favA ? pf : 1 - pf; basis = 'tour deciding sets since 2015 (n=' + k.n + ')';
  const d = fitGap(anchor, sum, (x, y) => setAvg(x, y, 0, 0));
  const pa = sum / 2 + d / 2; const pb = sum / 2 - d / 2;
  return { a: srv === 'a' ? setFrom(pa, pb, ga, gb, true, pts) : srv === 'b' ? setFrom(pa, pb, ga, gb, false, pts) : setAvg(pa, pb, ga, gb), anchor, basis };
}

// Point score as the feed writes it ("40", "15", "A") to counts. In a tiebreak the numbers are already counts.
function pointCounts(a, b, tiebreak) {
  if (tiebreak) { const x = parseInt(a, 10); const y = parseInt(b, 10); return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < 60 && y < 60 ? [x, y] : null; }
  const M = { 0: 0, 15: 1, 30: 2, 40: 3 }; const A = String(a).toUpperCase(); const B = String(b).toUpperCase(); const adv = (s) => s === 'A' || s === 'AD';
  if (adv(A) && B === '40') return [4, 3]; if (adv(B) && A === '40') return [3, 4];
  return A in M && B in M ? [M[A], M[B]] : null;
}
// In a tiebreak the feed names who serves the next point. The model wants who served the first one.
function firstServer(srv, pts) { if (!srv) return null; const n = pts[0] + pts[1]; const firstNow = Math.floor((n + 1) / 2) % 2 === 0; return firstNow ? srv : srv === 'a' ? 'b' : 'a'; }

// What the fair value becomes after the things that can happen next. Each entry is P(A wins the match).
function paths(tour, pre, sets, srv, pts) {
  if (!sets || !sets.length) return null;
  sets = settle(sets);
  const now = liveFair(tour, pre, sets, false, srv, pts); if (!now) return null;
  const done = sets.slice(0, -1); const cur = sets[sets.length - 1]; const other = srv === 'a' ? 'b' : srv === 'b' ? 'a' : null;
  const val = (ss, sv, pp) => { // a finished match has no fair value from liveFair, so read the set count
    const s2 = settle(ss); let x = 0; let y = 0; for (const [p, q] of s2.slice(0, -1)) { if (p > q) x++; else y++; }
    if (x >= 2) return 1; if (y >= 2) return 0; const f = liveFair(tour, pre, s2, false, sv, pp); return f ? f.a : null;
  };
  const withGame = (ss, k) => { const c = ss[ss.length - 1]; return ss.slice(0, -1).concat([k === 'a' ? [c[0] + 1, c[1]] : [c[0], c[1] + 1]]); };
  const tb = cur[0] === 6 && cur[1] === 6;
  const out = { now: now.a, basis: now.basis, server: srv || null, tiebreak: tb, rows: [] };
  const add = (k, v) => { if (v !== null && v !== undefined) out.rows.push({ k, a: v }); };
  if (!tb) {
    add('game_a', val(withGame(sets, 'a'), other)); add('game_b', val(withGame(sets, 'b'), other));
    add('games2_a', val(withGame(withGame(sets, 'a'), 'a'), srv || null)); add('games2_b', val(withGame(withGame(sets, 'b'), 'b'), srv || null));
    if (srv && (!pts || (!pts[0] && !pts[1]))) { // the game is about to start: where three break points or three game points would put it
      add('bp3', liveFair(tour, pre, sets, false, srv, srv === 'a' ? [0, 3] : [3, 0]).a); add('gp3', liveFair(tour, pre, sets, false, srv, srv === 'a' ? [3, 0] : [0, 3]).a);
    }
  }
  add('set_a', val(done.concat([[7, 5]]), null)); add('set_b', val(done.concat([[5, 7]]), null));
  return out;
}

module.exports = { RULES, PLAYERS, player, ratingProb, ruleFav, liveFair, settle, paths, pointCounts, firstServer, game, setFrom, surfaceOf, SURF_NAME, matchFrom, setAvg, fitGap, hold };
