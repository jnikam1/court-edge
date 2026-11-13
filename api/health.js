// Small self-check: do the live sources answer from this server?
const { polymarket, kalshi } = require('../lib/whaleboard');
const { scan } = require('../lib/scan');
const { send } = require('../lib/http');
const { form } = require('../lib/detail');
const feed = require('../lib/feed');
const { lastName } = require('../lib/kalshi');
const sports = require('../lib/sports');
const { param } = require('../lib/http');
module.exports = (req, res) => send(res, 30, async () => {
  const t = Date.now();
  if (param(req, 'only') === 'sports') return { asOf: new Date().toISOString(), sports: await sports.diag() }; // NBA and NFL sources on their own
  const part = async (fn) => { const s = Date.now(); try { return Object.assign(await fn(), { ms: Date.now() - s }); } catch (e) { return { error: String(e.message || e), ms: Date.now() - s }; } };
  const [f, m, p, k] = await Promise.all([
    part(async () => { const s = await scan(); const pick = s.matches.find((x) => x.tour !== 'CH') || s.matches[0]; if (!pick) return { skipped: true }; const r = await form(pick.event); return { event: pick.event, h2hTableLoaded: !r.h2h.missing, meetings: r.h2h.meetings.length, resultsA: r.a.results.length, withScores: r.a.results.filter((x) => x.score).length }; }),
    part(async () => { const s = await scan(); return { matches: s.matches.length, withScore: s.matches.filter((x) => x.pm).length }; }),
    part(async () => { const d = await polymarket(); return { whales: d.whales.length, failed: d.whales.filter((w) => !w.ok).length, bets: d.bets.length, strongBets: d.bets.filter((b) => b.grade === 'strong').length }; }),
    part(async () => { const d = await kalshi(); return { profiles: d.profiles.length, withTrades: d.profiles.filter((x) => x.trades.length).length, withHoldings: d.profiles.filter((x) => x.holdCount).length, names: Object.keys(d.names).length }; }),
  ]);
  // tennis feed: does it cover what Kalshi lists, and does it carry server and point score?
  const fd = await part(async () => {
    const [x, s] = await Promise.all([feed.live(), scan()]);
    if (x.off) return { on: false, reason: x.reason, status: x.status || null, limits: x.limits || null };
    const inPlay = s.matches.filter((q) => q.state !== 'upcoming');
    const find = (q) => x.matches.find((y) => (y.k1 === lastName(q.a.name) && y.k2 === lastName(q.b.name)) || (y.k1 === lastName(q.b.name) && y.k2 === lastName(q.a.name)));
    const rows = inPlay.map((q) => { const y = find(q); return { match: lastName(q.a.name) + ' v ' + lastName(q.b.name), found: !!y, server: y ? y.server : null, points: y ? y.points : null, feedGames: y ? y.games : null, appScore: q.pm ? q.pm.sets : null }; });
    return { on: true, ttlSeconds: x.ttl, limits: x.limits, feedLiveSingles: x.matches.length, withServer: x.matches.filter((y) => y.server).length, withPoints: x.matches.filter((y) => y.points).length, kalshiInPlay: inPlay.length, matched: rows.filter((r) => r.found).length, rows: rows.slice(0, 8), tours: [...new Set(x.matches.map((y) => y.tour))] };
  });
  // the background logger on Cloudflare
  const lg = await part(async () => { const r = await fetch('https://court-edge-logger.jnikam1.workers.dev/status', { headers: { Accept: 'application/json' } }); const d = await r.json(); return { http: r.status, lastRun: d.last, secondsSinceLastRun: d.last ? d.now - d.last.t : null, phones: d.phones, snapshots: d.snapshots, alertsLogged: d.alertsLogged, error: d.error || null }; });
  const sp = await part(async () => { const d = await sports.diag(); const o = {}; for (const k of Object.keys(d)) o[k] = d[k].error ? { error: d[k].error } : { games: d[k].kalshiGames, withScores: d[k].withScores, withBook: d[k].withBook, injuryFeed: d[k].injuryFeed, keyInjuries: d[k].keyInjuries }; return o; });
  return { asOf: new Date().toISOString(), ms: Date.now() - t, matches: m, sports: sp, polymarket: p, kalshi: k, form: f, feed: fd, logger: lg };
});
