// NBA and NFL game markets.
// Prices come from Kalshi. Scores, sportsbook lines, injuries and standings come from ESPN's public
// feeds (unofficial, so every ESPN call is allowed to fail and the page still shows Kalshi prices).
// NFL team efficiency comes from the open nflverse data. Nothing here needs a key.
const fs = require('fs');
const path = require('path');
const { getJson, kget, num, ts, mid, fee, cached } = require('./kalshi');

const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const LEAGUES = {
  nba: { key: 'nba', label: 'NBA', series: 'KXNBAGAME', spread: 'KXNBASPREAD', total: 'KXNBATOTAL', espn: 'basketball/nba', sd: 12, periods: 4, plen: 720, ot: 300, horizon: 3, watchH: 36 },
  nfl: { key: 'nfl', label: 'NFL', series: 'KXNFLGAME', spread: 'KXNFLSPREAD', total: 'KXNFLTOTAL', espn: 'football/nfl', sd: 13.5, periods: 4, plen: 900, ot: 600, horizon: 9, watchH: 100 }, // NFL statuses are set from Wednesday on
};
// Kalshi's team codes, where the other sources spell them differently.
const ESPN_CODE = { nba: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' }, nfl: { JAC: 'JAX', WAS: 'WSH' } };
const PM_CODE = { nba: {}, nfl: { JAC: 'jax', LAR: 'la' } };
const NFLVERSE_CODE = { JAC: 'JAX', LAR: 'LA' };
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

// ---------- small maths ----------
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function Phi(x) { // normal distribution function
  const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989422804 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
function PhiInv(p) { // its inverse (Acklam)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// American odds to the chance they imply, bookmaker margin still in.
function american(o) {
  if (o === null || o === undefined || o === '') return null;
  const s = String(o).trim().toUpperCase(); if (s === 'EVEN' || s === 'EV') return 0.5;
  const v = parseFloat(s.replace('+', '')); if (!Number.isFinite(v) || v === 0) return null;
  return v > 0 ? 100 / (v + 100) : -v / (-v + 100);
}
// Take the bookmaker's margin out of a two-way price.
const novig = (x, y) => (x === null || y === null || !(x + y > 0) ? null : [x / (x + y), y / (x + y)]);
const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).replace(/-/g, '');
const nameKey = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]+/g, '');

// ---------- ESPN ----------
// Set ESPN_FIXTURES to a folder to read saved answers instead of the network (used for local checks).
async function espnGet(url, ttlMs) {
  return cached('espn:' + url, ttlMs, async () => {
    if (process.env.ESPN_FIXTURES) {
      const f = path.join(process.env.ESPN_FIXTURES, url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 150) + '.json');
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    return getJson(url, { label: 'ESPN', ua: UA, timeout: 6000, tries: 2 });
  });
}
const site = (L, rest, ttl) => espnGet('https://site.api.espn.com/apis/site/v2/sports/' + L.espn + '/' + rest, ttl);

function parseOdds(o, homeAbbr, awayAbbr) {
  if (!o) return null;
  const pick = (x) => (x && x.close && x.close.odds !== undefined ? x.close.odds : x && x.open ? x.open.odds : undefined);
  const first = (...xs) => { for (const x of xs) if (x !== null && x !== undefined) return x; return null; };
  const ml = o.moneyline || {}; const ps = o.pointSpread || {}; const tot = o.total || {};
  const hT = o.homeTeamOdds || {}; const aT = o.awayTeamOdds || {};
  const h = first(american(pick(ml.home)), american(hT.moneyLine)); const a = first(american(pick(ml.away)), american(aT.moneyLine));
  const nv = novig(a, h);
  // home line: negative when the home team is favoured. Read it from the text when possible ("NY -8.5").
  let line = typeof o.spread === 'number' ? o.spread : null;
  const m = /^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/.exec(String(o.details || '').trim());
  if (m) { const v = -Math.abs(parseFloat(m[2])); if (m[1] === homeAbbr) line = v; else if (m[1] === awayAbbr) line = -v; }
  const cover = novig(first(american(pick(ps.home)), american(hT.spreadOdds)), first(american(pick(ps.away)), american(aT.spreadOdds)));
  const ou = novig(first(american(pick(tot.over)), american(o.overOdds)), first(american(pick(tot.under)), american(o.underOdds)));
  if (!nv && line === null && typeof o.overUnder !== 'number') return null;
  return {
    name: (o.provider && (o.provider.displayName || o.provider.name)) || 'Sportsbook', text: o.details || null,
    line, total: typeof o.overUnder === 'number' ? o.overUnder : null,
    a: nv ? r3(nv[0]) : null, b: nv ? r3(nv[1]) : null, mlA: first(pick(ml.away), aT.moneyLine), mlB: first(pick(ml.home), hT.moneyLine),
    coverB: cover ? r3(cover[0]) : null, over: ou ? r3(ou[0]) : null,
  };
}

function slimTeam(c) {
  const t = c.team || {}; const rec = (type) => { const r = (c.records || []).find((x) => x.type === type); return r ? r.summary : null; };
  const leaders = [];
  for (const cat of c.leaders || []) for (const l of cat.leaders || []) if (l.athlete) leaders.push({ cat: cat.name, name: l.athlete.displayName || l.athlete.fullName, value: l.value });
  return { id: t.id, abbr: t.abbreviation, nick: t.name || t.shortDisplayName || t.abbreviation, full: t.displayName, score: c.score !== undefined && c.score !== '' ? Number(c.score) : null, record: rec('total'), homeRec: rec('home'), roadRec: rec('road'), leaders };
}
function slimEvent(e) {
  const c = (e.competitions || [])[0] || {}; const st = c.status || e.status || {}; const ty = st.type || {};
  const home = (c.competitors || []).find((x) => x.homeAway === 'home'); const away = (c.competitors || []).find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const H = slimTeam(home); const A = slimTeam(away); const sit = c.situation || null;
  return {
    id: e.id, start: ts(e.date), state: ty.state || 'pre', text: ty.shortDetail || ty.detail || ty.description || '', done: !!ty.completed,
    period: st.period || 0, clock: typeof st.clock === 'number' ? st.clock : null, home: H, away: A,
    odds: parseOdds((c.odds || [])[0], H.abbr, A.abbr), note: (c.notes || []).map((n) => n.headline).filter(Boolean)[0] || null,
    weather: e.weather ? { text: e.weather.displayValue, temp: e.weather.temperature } : null, indoor: c.venue ? !!c.venue.indoor : null,
    sit: sit ? { text: sit.downDistanceText || sit.shortDownDistanceText || null, poss: sit.possession || null, red: !!sit.isRedZone, last: sit.lastPlay && sit.lastPlay.text ? String(sit.lastPlay.text).slice(0, 160) : null } : null,
  };
}
function scoreboard(L, day, fast) {
  return site(L, 'scoreboard?dates=' + day, fast ? 12000 : 300000).then((d) => (d.events || []).map(slimEvent).filter(Boolean)).catch(() => null);
}

function tagOf(i) {
  const s = String(i.status || ''); const c = String(i.shortComment || '').toLowerCase();
  if (/^(out|injured reserve|suspension|physically unable|non-football)/i.test(s)) return 'Out';
  if (/^doubtful/i.test(s) || /\bdoubtful\b/.test(c)) return 'Doubtful';
  if (/^questionable/i.test(s) || /\bquestionable\b/.test(c)) return 'Questionable';
  if (/\b(ruled out|won't play|will not play|will miss|will sit)\b/.test(c)) return 'Out';
  if (/\bprobable\b/.test(c)) return 'Probable';
  if (/\b(available|will play|cleared to play|is good to go|will return)\b/.test(c)) return 'Available';
  return /day/i.test(s) ? 'Day-to-day' : s || 'Listed';
}
function slimInj(i) {
  const a = i.athlete || {}; const det = i.details || {};
  return { name: a.displayName || [a.firstName, a.lastName].filter(Boolean).join(' '), pos: a.position ? a.position.abbreviation : null, status: i.status || null, tag: tagOf(i), part: det.type || null, t: ts(i.date), note: String(i.shortComment || '').slice(0, 220) || null, back: det.returnDate || null };
}
// Every listed injury in the league, by ESPN team code.
function injuries(L) {
  return site(L, 'injuries', 45000).then((d) => {
    const by = {};
    for (const t of d.injuries || []) for (const i of t.injuries || []) {
      const ab = (i.athlete && i.athlete.team && i.athlete.team.abbreviation) || null; if (!ab) continue;
      (by[ab] = by[ab] || []).push(slimInj(i));
    }
    return by;
  }).catch(() => null);
}
// NBA scoring leaders, used only to decide whose absence is worth a mention.
function stars() {
  return espnGet('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=220&sort=offensive.avgPoints%3Adesc', 6 * 3600 * 1000).then((d) => {
    const idx = (cat, name) => { const c = (d.categories || []).find((x) => x.name === cat); return c ? (c.names || []).indexOf(name) : -1; };
    const iP = idx('offensive', 'avgPoints'); const iM = idx('general', 'avgMinutes'); const iG = idx('general', 'gamesPlayed');
    const out = {};
    for (const row of d.athletes || []) {
      const val = (cat, i) => { const c = (row.categories || []).find((x) => x.name === cat); const v = c && i >= 0 ? (c.values || c.totals || [])[i] : null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const a = row.athlete || {}; const ppg = val('offensive', iP); if (ppg === null) continue;
      out[nameKey(a.displayName)] = { ppg, mpg: val('general', iM), gp: val('general', iG), team: a.teamShortName || null };
    }
    return out;
  }).catch(() => ({}));
}
// How much a missing player is roughly worth, in points of spread. A guide, not a measurement.
function worth(L, inj, team, starMap) {
  if (L.key === 'nba') {
    const s = starMap && starMap[nameKey(inj.name)];
    if (s && s.gp >= 2) {
      if (s.ppg >= 26) return { lo: 4, hi: 6, why: Math.round(s.ppg) + ' points a game' };
      if (s.ppg >= 21) return { lo: 2.5, hi: 4, why: Math.round(s.ppg) + ' points a game' };
      if (s.ppg >= 16) return { lo: 1, hi: 2.5, why: Math.round(s.ppg) + ' points a game' };
      if (s.mpg >= 31) return { lo: 0.5, hi: 1.5, why: Math.round(s.mpg) + ' minutes a game' };
    }
    if (team && team.leaders.some((l) => nameKey(l.name) === nameKey(inj.name) && /points|rating/i.test(l.cat))) return { lo: 1.5, hi: 4, why: 'team scoring leader' };
    return null;
  }
  const lead = team ? team.leaders.find((l) => nameKey(l.name) === nameKey(inj.name)) : null;
  if (lead && /pass/i.test(lead.cat)) return { lo: 3, hi: 7, why: 'starting quarterback' };
  if (inj.pos === 'QB' && !team) return { lo: 3, hi: 7, why: 'quarterback' };
  if (lead) return { lo: 0.5, hi: 1.5, why: /rush/i.test(lead.cat) ? 'lead runner' : 'lead receiver' };
  return null;
}

function standings(L) {
  return espnGet('https://site.api.espn.com/apis/v2/sports/' + L.espn + '/standings', 30 * 60000).then((d) => {
    const rows = []; let names = null;
    const walk = (n) => { if (n.standings && n.standings.entries) for (const e of n.standings.entries) rows.push(e); for (const c of n.children || []) walk(c); };
    walk(d);
    const by = {};
    for (const e of rows) {
      const S = {}; for (const s of e.stats || []) if (s.name) S[s.name] = typeof s.value === 'number' ? s.value : s.displayValue;
      names = names || Object.keys(S);
      const w = Number(S.wins) || 0; const l = Number(S.losses) || 0; const t = Number(S.ties) || 0; const gp = w + l + t;
      const pf = typeof S.avgPointsFor === 'number' ? S.avgPointsFor : gp ? Number(S.pointsFor) / gp : null;
      const pa = typeof S.avgPointsAgainst === 'number' ? S.avgPointsAgainst : gp ? Number(S.pointsAgainst) / gp : null;
      if (e.team && e.team.abbreviation) by[e.team.abbreviation] = { w, l, t, gp, pf: r1(pf), pa: r1(pa), net: pf !== null && pa !== null ? r1(pf - pa) : null, streak: typeof S.streak === 'number' ? S.streak : null };
    }
    const rank = (key, hiGood, out) => { const list = Object.keys(by).filter((k) => by[k][key] !== null).sort((x, y) => (hiGood ? by[y][key] - by[x][key] : by[x][key] - by[y][key])); list.forEach((k, i) => { by[k][out] = i + 1; }); };
    rank('pf', true, 'offRank'); rank('pa', false, 'defRank'); rank('net', true, 'netRank');
    return { by, n: Object.keys(by).length, names };
  }).catch(() => null);
}

// ---------- NFL efficiency from nflverse ----------
function csvRows(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function nflStrength() {
  return cached('nflverse-team', 6 * 3600 * 1000, async () => {
    const year = new Date().getUTCMonth() >= 7 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1; // season starts in September
    const url = 'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + year + '.csv';
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' }); if (!r.ok) throw new Error('nflverse ' + r.status);
    const rows = csvRows(await r.text()); const head = rows.shift(); const col = (n) => head.indexOf(n);
    const C = { team: col('team'), opp: col('opponent_team'), game: col('game_id'), type: col('season_type'), week: col('week'), att: col('attempts'), sk: col('sacks_suffered'), car: col('carries'), pe: col('passing_epa'), re: col('rushing_epa') };
    const games = {}; let maxWeek = 0;
    for (const x of rows) {
      if (x.length < head.length || x[C.type] !== 'REG') continue;
      const drop = (Number(x[C.att]) || 0) + (Number(x[C.sk]) || 0); const car = Number(x[C.car]) || 0;
      games[x[C.game] + '|' + x[C.team]] = { team: x[C.team], opp: x[C.opp], game: x[C.game], drop, car, pe: Number(x[C.pe]) || 0, re: Number(x[C.re]) || 0 };
      maxWeek = Math.max(maxWeek, Number(x[C.week]) || 0);
    }
    const T = {}; const get = (k) => (T[k] = T[k] || { g: 0, oDrop: 0, oCar: 0, oPe: 0, oRe: 0, dDrop: 0, dCar: 0, dPe: 0, dRe: 0 });
    for (const g of Object.values(games)) {
      const t = get(g.team); t.g++; t.oDrop += g.drop; t.oCar += g.car; t.oPe += g.pe; t.oRe += g.re;
      const o = get(g.opp); o.dDrop += g.drop; o.dCar += g.car; o.dPe += g.pe; o.dRe += g.re; // what this team did is what its opponent allowed
    }
    const by = {};
    for (const [k, t] of Object.entries(T)) {
      const div = (x, y) => (y > 0 ? x / y : null);
      by[k] = { g: t.g, off: div(t.oPe + t.oRe, t.oDrop + t.oCar), offPass: div(t.oPe, t.oDrop), offRush: div(t.oRe, t.oCar), def: div(t.dPe + t.dRe, t.dDrop + t.dCar), defPass: div(t.dPe, t.dDrop), defRush: div(t.dRe, t.dCar) };
    }
    const rank = (key, hiGood) => { const list = Object.keys(by).filter((k) => by[k][key] !== null).sort((x, y) => (hiGood ? by[y][key] - by[x][key] : by[x][key] - by[y][key])); list.forEach((k, i) => { by[k][key + 'Rank'] = i + 1; }); };
    ['off', 'offPass', 'offRush'].forEach((k) => rank(k, true)); ['def', 'defPass', 'defRush'].forEach((k) => rank(k, false)); // for a defence, fewer points allowed per play is better
    for (const t of Object.values(by)) for (const k of ['off', 'offPass', 'offRush', 'def', 'defPass', 'defRush']) t[k] = r3(t[k]);
    return { by, week: maxWeek, n: Object.keys(by).length };
  }).catch(() => null);
}

// ---------- Kalshi ----------
function parseEvent(ev) {
  const m = /^KX[A-Z]+-(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$/.exec(String(ev || '')); if (!m || !MON[m[2]]) return null;
  return { day: '20' + m[1] + MON[m[2]] + m[3], teams: m[4], suffix: ev.slice(ev.indexOf('-') + 1) };
}
const px = (m) => { const b = num(m.yes_bid_dollars); const a = num(m.yes_ask_dollars); return { bid: b !== null && b > 0 ? b : null, ask: a !== null && a > 0 && a < 1 ? a : null }; };
function kalshiGames(L) {
  return cached('kx-' + L.key, 4000, async () => {
    const d = await kget('/markets', { series_ticker: L.series, status: 'open', limit: 200 });
    const by = new Map();
    for (const m of d.markets || []) {
      const p = parseEvent(m.event_ticker); if (!p) continue;
      const code = m.ticker.split('-').pop();
      const e = by.get(m.event_ticker) || { event: m.event_ticker, day: p.day, teams: p.teams, suffix: p.suffix, occ: ts(m.occurrence_datetime), sides: {} };
      e.sides[code] = Object.assign({ code, city: m.yes_sub_title, ticker: m.ticker, last: num(m.last_price_dollars), vol: Math.round(num(m.volume_fp) || 0) }, px(m));
      by.set(m.event_ticker, e);
    }
    const out = [];
    for (const e of by.values()) {
      const codes = Object.keys(e.sides); if (codes.length !== 2) continue;
      // the ticker lists the visiting team first
      let away = codes.find((c) => e.teams.startsWith(c) && e.teams.slice(c.length) === codes.find((x) => x !== c));
      if (!away) away = codes.find((c) => e.teams.startsWith(c)) || codes[0];
      const home = codes.find((c) => c !== away);
      out.push({ event: e.event, day: e.day, suffix: e.suffix, occ: e.occ, a: e.sides[away], b: e.sides[home] });
    }
    return out;
  });
}
const seriesFee = (series) => cached('fee-' + series, 6 * 3600 * 1000, () => kget('/series/' + series).then((d) => ({ maker: /maker/.test(String(d.series && d.series.fee_type)), mult: Number(d.series && d.series.fee_multiplier) || 1 }))).catch(() => ({ maker: true, mult: 1 }));

// ---------- the list of games ----------
async function enrich(L) {
  const now = Date.now(); const today = etDay(now); const yest = etDay(now - 86400000);
  const games = await kalshiGames(L);
  const lastDay = etDay(now + L.horizon * 86400000);
  const days = [...new Set(games.map((g) => g.day))].filter((d) => d >= yest && d <= lastDay).sort();
  const [boards, inj, starMap] = await Promise.all([
    Promise.all(days.map((d) => scoreboard(L, d, d === today || d === yest))),
    injuries(L), L.key === 'nba' ? stars() : null,
  ]);
  const byDay = {}; days.forEach((d, i) => { byDay[d] = boards[i]; });
  const ec = ESPN_CODE[L.key];
  const out = [];
  for (const g of games) {
    const ea = ec[g.a.code] || g.a.code; const eb = ec[g.b.code] || g.b.code;
    let e = (byDay[g.day] || []).find((x) => x.home.abbr === eb && x.away.abbr === ea) || null;
    let flipped = false;
    if (!e) { e = (byDay[g.day] || []).find((x) => x.home.abbr === ea && x.away.abbr === eb) || null; flipped = !!e; }
    // Kalshi lists the visitor first. If ESPN disagrees, trust ESPN.
    const A = flipped ? g.b : g.a; const B = flipped ? g.a : g.b;
    const start = e ? e.start : g.occ ? g.occ - 3 * 3600 : null;
    const state = e ? (e.state === 'in' ? 'live' : e.state === 'post' ? 'closing' : 'upcoming') : (start && start < now / 1000 ? 'live' : 'upcoming');
    const side = (k, t) => ({ code: k.code, name: t ? t.nick : k.code, full: t ? t.full : k.city, ticker: k.ticker, bid: k.bid, ask: k.ask, last: k.last, score: t && state !== 'upcoming' ? t.score : null, record: t ? t.record : null });
    const a = side(A, e ? e.away : null); const b = side(B, e ? e.home : null);
    const midA = mid(a.bid, a.ask); const midB = mid(b.bid, b.ask);
    const book = e && e.odds && state === 'upcoming' ? e.odds : null;
    // is either side cheaper on Kalshi than the sportsbook's price with the margin removed?
    let gap = null;
    if (book && book.a !== null) for (const [k, fair] of [['a', book.a], ['b', book.b]]) {
      const ask = (k === 'a' ? a : b).ask; if (ask === null || ask < 0.15 || ask > 0.85) continue;
      const edge = fair - ask - fee(ask); if (!gap || edge > gap.edge) gap = { side: k, edge: r3(edge), fair, ask };
    }
    const listInj = (abbr, team) => {
      const all = (inj && inj[abbr]) || []; const key = [];
      for (const i of all) { const w = worth(L, i, team, starMap); if (w) key.push(Object.assign({}, i, { lo: w.lo, hi: w.hi, why: w.why, fresh: i.t ? now / 1000 - i.t < 86400 : false })); }
      key.sort((x, y) => y.hi - x.hi || (y.t || 0) - (x.t || 0));
      return { key, others: all.length - key.length };
    };
    out.push({
      league: L.key, event: g.event, suffix: g.suffix, day: g.day, espnId: e ? e.id : null, start, state, text: e ? e.text : null, period: e ? e.period : 0, clock: e ? e.clock : null,
      a, b, midA: r3(midA !== null ? midA : midB !== null ? 1 - midB : null), volume: A.vol + B.vol, book, gap,
      inj: { a: listInj(e ? e.away.abbr : ea, e ? e.away : null), b: listInj(e ? e.home.abbr : eb, e ? e.home : null) },
      note: e ? e.note : null, weather: e && !e.indoor ? e.weather : null, sit: e ? e.sit : null, teams: e ? { a: e.away, b: e.home } : null, hasInj: !!inj,
    });
  }
  out.sort((x, y) => (x.start || 0) - (y.start || 0));
  return out;
}
const rich = (L) => cached('rich-' + L.key, 5000, () => enrich(L));
const showInj = (i) => /^(Out|Doubtful|Questionable|Day-to-day)$/.test(i.tag);
const injLite = (i) => ({ name: i.name, pos: i.pos, tag: i.tag, part: i.part, t: i.t, fresh: i.fresh, lo: i.lo, hi: i.hi, why: i.why });

async function board(league) {
  const L = LEAGUES[league]; if (!L) throw new Error('Unknown league.');
  const all = await rich(L); const now = Date.now() / 1000;
  const games = all.filter((g) => !(g.state === 'upcoming' && g.start && g.start - now > L.horizon * 86400)).map((g) => ({
    league: g.league, event: g.event, start: g.start, state: g.state, text: g.text, period: g.period, clock: g.clock, a: g.a, b: g.b, midA: g.midA, volume: g.volume,
    book: g.book ? { name: g.book.name, a: g.book.a, b: g.book.b, line: g.book.line, total: g.book.total, text: g.book.text } : null, gap: g.gap, note: g.note, sit: g.sit ? { text: g.sit.text } : null,
    inj: { a: g.inj.a.key.filter(showInj).slice(0, 3).map(injLite), b: g.inj.b.key.filter(showInj).slice(0, 3).map(injLite) },
  }));
  // injury watch: important players listed for teams that play soon
  const watch = [];
  for (const g of all) {
    if (!(g.state === 'upcoming' && g.start && g.start - now < L.watchH * 3600)) continue;
    for (const k of ['a', 'b']) for (const i of g.inj[k].key.filter(showInj)) watch.push(Object.assign(injLite(i), { team: g[k].code, event: g.event, note: i.note }));
  }
  watch.sort((x, y) => (y.t || 0) - (x.t || 0));
  return { asOf: new Date().toISOString(), league: L.key, label: L.label, games, watch: watch.slice(0, 40), scores: all.some((g) => g.espnId), injuries: all.some((g) => g.hasInj) };
}

// ---------- one game ----------
async function pricePath(L, ticker, from, to) {
  const d = await kget('/series/' + L.series + '/markets/' + ticker + '/candlesticks', { start_ts: from, end_ts: to, period_interval: 1 });
  const pts = [];
  for (const c of d.candlesticks || []) {
    const b = num(c.yes_bid && c.yes_bid.close_dollars); const a = num(c.yes_ask && c.yes_ask.close_dollars);
    let x = b !== null && a !== null && a - b <= 0.06 ? mid(b, a) : null;
    if (x === null && c.price && num(c.volume_fp) > 0) x = num(c.price.close_dollars);
    if (x !== null && x > 0 && x < 1) pts.push([c.end_period_ts, Math.round(x * 1000) / 1000]);
  }
  return pts;
}
// Chance the home team wins from here: the score gap as a random walk around the pre-game expectation
// (Stern 1994). It knows the score, the clock and the pre-game price. It does not know who has the ball.
function liveModel(L, preHome, lead, period, clock) {
  const total = L.periods * L.plen; if (clock === null || !period) return null;
  let rem = period <= L.periods ? (L.periods - period) * L.plen + clock : clock;
  rem = clamp(rem, 0, total);
  if (rem <= 0) return lead > 0 ? 0.995 : lead < 0 ? 0.005 : 0.5;
  const f = rem / total; const mu = period <= L.periods ? L.sd * PhiInv(clamp(preHome, 0.02, 0.98)) : 0;
  return clamp(Phi((lead + mu * f) / (L.sd * Math.sqrt(f))), 0.005, 0.995);
}
function ladder(markets) {
  return (markets || []).map((m) => Object.assign({ code: (/-([A-Z]+)\d+$/.exec(m.ticker) || [])[1] || null, strike: typeof m.floor_strike === 'number' ? m.floor_strike : num(m.floor_strike), vol: Math.round(num(m.volume_fp) || 0) }, px(m))).filter((x) => x.strike !== null);
}
function polyGame(L, g) {
  const day = g.day.slice(0, 4) + '-' + g.day.slice(4, 6) + '-' + g.day.slice(6, 8);
  const alt = (c) => [...new Set([PM_CODE[L.key][c], c.toLowerCase(), (ESPN_CODE[L.key][c] || c).toLowerCase()].filter(Boolean))];
  const slugs = []; for (const x of alt(g.a.code)) for (const y of alt(g.b.code)) slugs.push(L.key + '-' + x + '-' + y + '-' + day);
  return cached('pm-game-' + g.event, 30000, async () => {
    for (const slug of slugs.slice(0, 4)) {
      const d = await getJson('https://gamma-api.polymarket.com/events?slug=' + slug, { label: 'Polymarket', ua: UA, timeout: 6000, tries: 2 }).catch(() => null);
      const e = d && d[0]; if (!e) continue;
      const m = (e.markets || []).find((x) => x.sportsMarketType === 'moneyline') || null; if (!m) continue;
      let prices = null; try { prices = JSON.parse(m.outcomePrices).map(Number); } catch (err) { prices = null; }
      let names = null; try { names = JSON.parse(m.outcomes); } catch (err) { names = null; }
      return { slug, cond: m.conditionId, title: e.title, price: prices && prices.length === 2 ? prices : null, names, volume: Math.round(Number(m.volume) || 0) };
    }
    return null;
  }).catch(() => null);
}

function buildRead(L, g, x) {
  const out = { level: 'none', title: '', why: [], side: null };
  const nm = (k) => g[k].name; const c = (v) => Math.round(v * 100) + '¢';
  if (g.state === 'closing') { out.title = 'Game over. The market is settling.'; return out; }
  const fresh = [];
  for (const k of ['a', 'b']) for (const i of g.inj[k].key) if (i.fresh && showInj(i)) fresh.push(g[k].code + ': ' + i.name + ' ' + i.tag.toLowerCase() + (i.part ? ' (' + i.part.toLowerCase() + ')' : '') + ', updated in the last day. Rough worth ' + i.lo + ' to ' + i.hi + ' points.');
  if (g.state === 'upcoming') {
    if (g.book && g.book.a !== null && g.midA !== null) {
      const diff = Math.abs(g.midA - g.book.a);
      if (g.gap && g.gap.edge >= 0.03) {
        out.level = 'lean'; out.side = g.gap.side;
        out.title = 'Kalshi is cheaper than ' + g.book.name + ' on ' + nm(g.gap.side) + ': ask ' + c(g.gap.ask) + ', sportsbook fair ' + c(g.gap.fair);
        out.why.push('Gap of ' + (g.gap.edge * 100).toFixed(1) + '¢ after the Kalshi fee. That is one sportsbook with its margin removed, not a sharp consensus.');
        out.why.push('Most gaps like this are news: check for a late injury or a line that has just moved before treating it as a price error.');
      } else {
        out.title = 'No gap. Kalshi and ' + g.book.name + ' agree to within ' + Math.max(1, Math.round(diff * 100)) + '¢.';
        out.why.push(nm('a') + ': Kalshi ' + c(g.midA) + ', sportsbook fair ' + c(g.book.a) + '. ' + nm('b') + ': Kalshi ' + c(1 - g.midA) + ', sportsbook fair ' + c(g.book.b) + '.');
      }
    } else { out.title = 'No sportsbook line to compare with yet.'; }
    if (fresh.length) { if (out.level === 'none') out.level = 'watch'; fresh.forEach((f) => out.why.push(f)); out.why.push('Injury news is the main thing that moves these prices before the game. The moneyline usually reprices within a minute or two. Spreads and totals are slower.'); }
    return out;
  }
  // in play
  if (x.model === null) { out.title = 'In play. No score model without a live clock and a pre-game price.'; return out; }
  const fairA = 1 - x.model; let best = null;
  for (const [k, fair] of [['a', fairA], ['b', x.model]]) {
    const ask = g[k].ask; if (ask === null || ask < 0.15 || ask > 0.85) continue;
    const edge = fair - ask - fee(ask); if (!best || edge > best.edge) best = { k, fair, ask, edge };
  }
  if (best && best.edge >= 0.05) {
    out.level = 'watch'; out.side = best.k;
    out.title = 'Score model has ' + nm(best.k) + ' at ' + Math.round(best.fair * 100) + '%. Kalshi asks ' + c(best.ask) + '.';
    out.why.push('Gap of ' + (best.edge * 100).toFixed(1) + '¢ after the fee, on a model that only knows the score, the clock and the pre-game price.');
    if (L.key === 'nba') out.why.push('A 2026 study of 1,438 Kalshi NBA games found live prices move about 64% of what the score implies and drift the rest of the way later. Buying at the ask and selling at the bid still lost money in that study. If you act, rest an order.');
    else out.why.push('The model does not know who has the ball, field position or timeouts, and those matter a lot late in a football game. Treat this as a prompt to look, not a price.');
  } else {
    out.title = 'Kalshi is in line with the score.';
    out.why.push('Score model: ' + nm('a') + ' ' + Math.round(fairA * 100) + '%, ' + nm('b') + ' ' + Math.round(x.model * 100) + '%. Kalshi: ' + c(g.midA !== null ? g.midA : fairA) + ' and ' + c(g.midA !== null ? 1 - g.midA : x.model) + '.');
  }
  if (x.espn !== null) out.why.push("ESPN's own win probability has " + nm('b') + ' at ' + Math.round(x.espn * 100) + '%.');
  return out;
}

async function detail(league, event) {
  const L = LEAGUES[league]; if (!L) throw new Error('Unknown league.');
  const all = await rich(L); const g = all.find((x) => x.event === event);
  if (!g) throw new Error('This game is no longer listed on Kalshi. It has probably settled.');
  const now = Math.floor(Date.now() / 1000); const live = g.state !== 'upcoming';
  const from = live && g.start ? Math.max(now - 8 * 3600, g.start - 45 * 60) : now - 12 * 3600;
  const [path, sum, spreadM, totalM, pm, st, eff, feeInfo] = await Promise.all([
    pricePath(L, g.a.ticker, from, now).catch(() => []),
    g.espnId ? site(L, 'summary?event=' + g.espnId, live ? 8000 : 60000).catch(() => null) : null,
    cached('lad-' + L.spread + g.suffix, 10000, () => kget('/markets', { event_ticker: L.spread + '-' + g.suffix, limit: 200 })).then((d) => ladder(d.markets)).catch(() => []),
    cached('lad-' + L.total + g.suffix, 10000, () => kget('/markets', { event_ticker: L.total + '-' + g.suffix, limit: 200 })).then((d) => ladder(d.markets)).catch(() => []),
    polyGame(L, g), standings(L), L.key === 'nfl' ? nflStrength() : null, seriesFee(L.series),
  ]);
  // pre-game price: the last Kalshi price at or before the start
  let pre = null;
  if (live && g.start) { for (const p of path) { if (p[0] <= g.start + 60) pre = p[1]; else break; } if (pre === null && path.length && path[0][0] - g.start < 1200) pre = path[0][1]; }
  const lastP = path.length ? path[path.length - 1] : null;
  const midA = g.midA !== null ? g.midA : lastP ? lastP[1] : null;
  const mv = (sec) => { if (!lastP || midA === null) return null; let ref = null; for (const p of path) { if (p[0] <= now - sec) ref = p[1]; else break; } return ref === null ? null : r3(midA - ref); };
  const step = Math.max(1, Math.ceil(path.length / 180)); const chart = path.filter((p, i) => i % step === 0 || i === path.length - 1);

  // sportsbook line: the scoreboard has it before the game, the summary keeps it afterwards
  const pc = sum && sum.pickcenter && sum.pickcenter[0] ? parseOdds(sum.pickcenter[0], g.teams ? g.teams.b.abbr : null, g.teams ? g.teams.a.abbr : null) : null;
  const book = g.book || pc;
  const wp = sum && Array.isArray(sum.winprobability) && sum.winprobability.length ? sum.winprobability[sum.winprobability.length - 1] : null;
  const espn = wp && typeof wp.homeWinPercentage === 'number' ? r3(wp.homeWinPercentage) : null;
  const preHome = pre !== null ? 1 - pre : book && book.b !== null ? book.b : null;
  const model = g.state === 'live' && preHome !== null && g.a.score !== null && g.b.score !== null ? r3(liveModel(L, preHome, g.b.score - g.a.score, g.period, g.clock)) : null;
  const proj = sum && sum.predictor && sum.predictor.homeTeam && sum.predictor.homeTeam.gameProjection !== undefined ? num(sum.predictor.homeTeam.gameProjection) : null;

  // spread and total ladders next to the sportsbook's line
  const lines = { spread: null, total: null };
  if (spreadM.length && book && book.line !== null && book.line !== 0) {
    const favK = book.line < 0 ? 'b' : 'a'; const pts = Math.abs(book.line); const fair = book.coverB === null ? null : favK === 'b' ? book.coverB : r3(1 - book.coverB);
    const rows = spreadM.filter((m) => m.code === g[favK].code).sort((x, y) => Math.abs(x.strike - pts) - Math.abs(y.strike - pts) || x.strike - y.strike).slice(0, 3).sort((x, y) => x.strike - y.strike)
      .map((m) => ({ strike: m.strike, bid: m.bid, ask: m.ask, vol: m.vol, fair: m.strike === pts ? fair : null }));
    lines.spread = { team: g[favK].name, code: g[favK].code, line: pts, book: book.name, rows };
  }
  if (totalM.length && book && book.total !== null) {
    const rows = totalM.slice().sort((x, y) => Math.abs(x.strike - book.total) - Math.abs(y.strike - book.total) || x.strike - y.strike).slice(0, 3).sort((x, y) => x.strike - y.strike)
      .map((m) => ({ strike: m.strike, bid: m.bid, ask: m.ask, vol: m.vol, fair: m.strike === book.total ? book.over : null }));
    lines.total = { line: book.total, book: book.name, rows };
  }
  for (const set of [lines.spread, lines.total]) if (set) for (const r of set.rows) {
    r.gap = null; if (r.fair === null) continue;
    const yes = r.ask !== null ? r.fair - r.ask - fee(r.ask) : null; const no = r.bid !== null ? (1 - r.fair) - (1 - r.bid) - fee(1 - r.bid) : null;
    if (yes !== null && yes >= 0.03) r.gap = { side: 'yes', at: r.ask, edge: r3(yes) }; else if (no !== null && no >= 0.03) r.gap = { side: 'no', at: r3(1 - r.bid), edge: r3(no) };
  }

  // team strength
  const strength = { a: null, b: null, notes: [], source: null, week: null };
  const ea = g.teams ? g.teams.a.abbr : ESPN_CODE[L.key][g.a.code] || g.a.code; const eb = g.teams ? g.teams.b.abbr : ESPN_CODE[L.key][g.b.code] || g.b.code;
  const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10]);
  for (const [k, ab] of [['a', ea], ['b', eb]]) {
    const s = st && st.by[ab] ? Object.assign({}, st.by[ab]) : null; const t = g.teams ? g.teams[k] : null;
    strength[k] = s ? Object.assign(s, { homeRec: t ? t.homeRec : null, roadRec: t ? t.roadRec : null }) : null;
    if (eff) { const e = eff.by[NFLVERSE_CODE[g[k].code] || g[k].code]; if (e) strength[k] = Object.assign(strength[k] || {}, { epa: e }); }
  }
  if (L.key === 'nfl' && eff && strength.a && strength.b && strength.a.epa && strength.b.epa) {
    strength.source = 'nflverse'; strength.week = eff.week;
    for (const [o, d] of [['a', 'b'], ['b', 'a']]) {
      const O = strength[o].epa; const D = strength[d].epa;
      strength.notes.push(g[o].name + ' passing ' + ord(O.offPassRank) + ' against the ' + g[d].name + ' pass defence ' + ord(D.defPassRank) + '. Running ' + ord(O.offRushRank) + ' against the run defence ' + ord(D.defRushRank) + '.');
    }
  } else if (strength.a && strength.b && strength.a.pf !== null && strength.b.pf !== null) {
    for (const [o, d] of [['a', 'b'], ['b', 'a']]) strength.notes.push(g[o].name + ' score ' + strength[o].pf + ' a game (' + ord(strength[o].offRank) + ') against the ' + g[d].name + ' allowing ' + strength[d].pa + ' (' + ord(strength[d].defRank) + ').');
  }

  // last five and rest
  const form = { a: [], b: [] }; const rest = { a: null, b: null };
  if (sum && Array.isArray(sum.lastFiveGames)) for (const blk of sum.lastFiveGames) {
    const k = g.teams && blk.team && blk.team.id === g.teams.a.id ? 'a' : g.teams && blk.team && blk.team.id === g.teams.b.id ? 'b' : null; if (!k) continue;
    const evs = (blk.events || []).map((e) => ({ t: ts(e.gameDate), res: e.gameResult, score: e.score, at: e.atVs === '@' ? '@' : 'v', opp: e.opponent ? e.opponent.abbreviation : '' })).filter((e) => e.t).sort((x, y) => y.t - x.t);
    form[k] = evs.slice(0, 5);
    if (evs.length && g.start) rest[k] = Math.max(0, Math.round((g.start - evs[0].t) / 86400));
  }
  // injuries: the summary's list for this game if it has one, else the league list
  const inj = { a: g.inj.a.key.filter(showInj).map((i) => Object.assign(injLite(i), { note: i.note })), b: g.inj.b.key.filter(showInj).map((i) => Object.assign(injLite(i), { note: i.note })), othersA: g.inj.a.others, othersB: g.inj.b.others };

  const x = { model, espn };
  const gg = Object.assign({}, g, { midA });
  const read = buildRead(L, gg, x);
  return {
    asOf: new Date().toISOString(), kind: 'game', league: L.key, label: L.label, event: g.event, state: g.state, text: g.text, period: g.period, clock: g.clock, start: g.start, note: g.note, weather: g.weather, sit: g.sit,
    a: g.a, b: g.b, midA, pre, favA: (pre !== null ? pre : midA !== null ? midA : 0.5) >= 0.5, volume: g.volume, score: g.start ? { start: new Date(g.start * 1000).toISOString() } : null,
    book: book ? { name: book.name, a: book.a, b: book.b, line: book.line, total: book.total, text: book.text, mlA: book.mlA, mlB: book.mlB, stale: !g.book } : null,
    model: { live: model !== null ? { a: r3(1 - model), basis: pre !== null ? 'Kalshi price at the start' : 'sportsbook line' } : null, espn: espn !== null ? r3(1 - espn) : null, proj: proj !== null ? r3(1 - proj / 100) : null },
    pm: pm ? { price: pm.price, cond: pm.cond, slug: pm.slug, volume: pm.volume } : null,
    read, chart, move: { m5: mv(300), m15: mv(900), m60: mv(3600) }, lines, strength, form, rest, inj, makerFee: feeInfo.maker, hasScores: !!g.espnId,
  };
}

// ---------- compact feed for the logger ----------
async function watch() {
  const now = Date.now() / 1000; const games = []; const inj = []; const teams = []; const feeds = {};
  for (const L of Object.values(LEAGUES)) {
    const all = await rich(L).catch(() => []);
    // the logger only trusts a league's injury list when its sources answered
    feeds[L.key] = all.some((g) => g.hasInj) && (L.key !== 'nba' || Object.keys(await stars()).length > 50);
    for (const g of all) {
      const soon = g.state === 'upcoming' && g.start && g.start - now < L.watchH * 3600;
      if (!(soon || g.state === 'live')) continue;
      if (g.state === 'live' || (g.start && g.start - now < 3 * 3600)) games.push({ lg: L.key, event: g.event, start: g.start, state: g.state, a: g.a.code, b: g.b.code, ab: g.a.bid, aa: g.a.ask, bb: g.b.bid, ba: g.b.ask, sa: g.a.score, sb: g.b.score, period: g.period, clock: g.clock, book: g.book ? g.book.a : null });
      if (!soon) continue;
      teams.push(L.key + '|' + g.a.code, L.key + '|' + g.b.code);
      for (const k of ['a', 'b']) for (const i of g.inj[k].key) inj.push({ t: i.t, id: L.key + '|' + g[k].code + '|' + nameKey(i.name), lg: L.key, team: g[k].code, teamName: g[k].name, event: g.event, start: g.start, name: i.name, tag: i.tag, part: i.part, lo: i.lo, hi: i.hi, why: i.why, mid: k === 'a' ? g.midA : g.midA !== null ? r3(1 - g.midA) : null, vs: g[k === 'a' ? 'b' : 'a'].name });
    }
  }
  return { t: Math.floor(now), games, inj, teams, feeds };
}

// ---------- self-check ----------
async function diag() {
  const out = {};
  for (const L of Object.values(LEAGUES)) {
    const t0 = Date.now();
    try {
      const all = await rich(L); const st = await standings(L); const eff = L.key === 'nfl' ? await nflStrength() : null; const sm = L.key === 'nba' ? await stars() : null;
      const soon = all.filter((g) => g.start && g.start - Date.now() / 1000 < 4 * 86400);
      const sample = soon.find((g) => g.book) || soon[0] || null;
      out[L.key] = {
        kalshiGames: all.length, withScores: all.filter((g) => g.espnId).length, withBook: all.filter((g) => g.book).length, live: all.filter((g) => g.state === 'live').length, gaps: all.filter((g) => g.gap && g.gap.edge >= 0.03).length,
        injuryFeed: all.some((g) => g.hasInj), keyInjuries: all.reduce((n, g) => n + g.inj.a.key.length + g.inj.b.key.length, 0), standingsTeams: st ? st.n : 0, standingsStats: st ? st.names : null,
        stars: sm ? Object.keys(sm).length : undefined, efficiencyTeams: eff ? eff.n : undefined, efficiencyWeek: eff ? eff.week : undefined,
        sample: sample ? { event: sample.event, state: sample.state, a: sample.a.code + ' ' + sample.a.bid + '/' + sample.a.ask, b: sample.b.code + ' ' + sample.b.bid + '/' + sample.b.ask, book: sample.book ? { text: sample.book.text, line: sample.book.line, a: sample.book.a, b: sample.book.b } : null, gap: sample.gap } : null,
        ms: Date.now() - t0,
      };
    } catch (e) { out[L.key] = { error: String(e && e.message ? e.message : e), ms: Date.now() - t0 }; }
  }
  return out;
}

module.exports = { board, detail, watch, diag, seriesFee, LEAGUES, _test: { Phi, PhiInv, american, novig, liveModel, parseOdds, parseEvent, csvRows, tagOf } };
