// Small self-check: do the live sources answer from this server?
const { polymarket, kalshi } = require('../lib/whaleboard');
const { scan } = require('../lib/scan');
const { send } = require('../lib/http');
const { form } = require('../lib/detail');
module.exports = (req, res) => send(res, 30, async () => {
  const t = Date.now();
  const part = async (fn) => { const s = Date.now(); try { return Object.assign(await fn(), { ms: Date.now() - s }); } catch (e) { return { error: String(e.message || e), ms: Date.now() - s }; } };
  const [f, m, p, k] = await Promise.all([
    part(async () => { const s = await scan(); const pick = s.matches.find((x) => x.tour !== 'CH') || s.matches[0]; if (!pick) return { skipped: true }; const r = await form(pick.event); return { event: pick.event, h2hTableLoaded: !r.h2h.missing, meetings: r.h2h.meetings.length, resultsA: r.a.results.length, withScores: r.a.results.filter((x) => x.score).length }; }),
    part(async () => { const s = await scan(); return { matches: s.matches.length, withScore: s.matches.filter((x) => x.pm).length }; }),
    part(async () => { const d = await polymarket(); return { whales: d.whales.length, failed: d.whales.filter((w) => !w.ok).length, bets: d.bets.length, strongBets: d.bets.filter((b) => b.grade === 'strong').length }; }),
    part(async () => { const d = await kalshi(); return { profiles: d.profiles.length, withTrades: d.profiles.filter((x) => x.trades.length).length, withHoldings: d.profiles.filter((x) => x.holdCount).length, names: Object.keys(d.names).length }; }),
  ]);
  return { asOf: new Date().toISOString(), ms: Date.now() - t, matches: m, polymarket: p, kalshi: k, form: f };
});
