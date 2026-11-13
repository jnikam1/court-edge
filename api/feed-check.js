// Does the tennis feed cover what Kalshi lists, and does it carry server and point score?
const { live } = require('../lib/feed');
const { scan } = require('../lib/scan');
const { send } = require('../lib/http');
const { lastName } = require('../lib/kalshi');
module.exports = (req, res) => send(res, 60, async () => {
  const [f, s] = await Promise.all([live(), scan().catch(() => ({ matches: [] }))]);
  if (f.off) return { ok: false, reason: f.reason, status: f.status || null, limits: f.limits || null };
  const inPlay = s.matches.filter((m) => m.state !== 'upcoming');
  const find = (m) => f.matches.find((x) => (x.k1 === lastName(m.a.name) && x.k2 === lastName(m.b.name)) || (x.k1 === lastName(m.b.name) && x.k2 === lastName(m.a.name)));
  const rows = inPlay.map((m) => { const x = find(m); return { match: m.a.name + ' v ' + m.b.name, found: !!x, server: x ? x.server : null, points: x ? x.points : null, games: x ? x.games : null, kalshiScore: m.pm ? m.pm.sets : null, feedTime: x ? x.t : null }; });
  return { ok: true, asOf: f.asOf, ttlSeconds: f.ttl, limits: f.limits, feedLiveSingles: f.matches.length, withServer: f.matches.filter((x) => x.server).length, withPoints: f.matches.filter((x) => x.points).length,
    kalshiInPlay: inPlay.length, matched: rows.filter((r) => r.found).length, rows: rows.slice(0, 12), tours: [...new Set(f.matches.map((x) => x.tour))] };
});
