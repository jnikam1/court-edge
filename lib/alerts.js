// Big adds: a tracked whale bought into one of its winning categories recently and now holds
// a large stake in that market. Used by /api/alerts (the app polls it every minute) and by
// scripts/whale-alerts.js.
const { getJson, qs, cached } = require('./kalshi');
const W = require('./whales.json');
const DATA = 'https://data-api.polymarket.com/v2';
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const get = (path, params) => getJson(DATA + path + qs(params), { label: 'Polymarket', ua: UA, timeout: 9000, tries: 3 });
const catOf = (slug) => W.prefix[String(slug || '').split('-')[0]] || 'Other';

async function recentBuys(wallet, cutoff, maxPages) {
  const out = []; let cursor; let partial = false;
  for (let page = 0; page < maxPages; page++) {
    const d = await get('/activity', { user: wallet, limit: 500, cursor });
    const rows = (d && d.data) || []; let older = false;
    for (const r of rows) { if (r.timestamp < cutoff) { older = true; continue; } if (r.type === 'TRADE' && r.side === 'BUY') out.push(r); }
    const pg = (d && d.pagination) || {}; cursor = pg.next_cursor;
    if (older || !rows.length || !pg.has_more || !cursor) return { out, partial };
  }
  partial = true; return { out, partial };
}

async function check(w, cutoff, o) {
  const strong = {}; for (const c of w.cats) if (c.grade === 'strong') strong[c.k] = c;
  const { out: buys, partial } = await recentBuys(w.w, cutoff, o.maxPages);
  const by = new Map();
  for (const b of buys) {
    const cat = catOf(b.slug); if (!strong[cat]) continue;
    const key = b.condition_id + '|' + b.outcome_index;
    const x = by.get(key) || { cond: b.condition_id, idx: b.outcome_index, title: b.title, slug: b.slug, cat, usd: 0, shares: 0, last: 0, first: Infinity };
    x.usd += Number(b.usdc_size || 0); x.shares += Number(b.size || 0); x.last = Math.max(x.last, b.timestamp); x.first = Math.min(x.first, b.timestamp); by.set(key, x);
  }
  const cands = [...by.values()].filter((x) => x.usd >= o.minAdd);
  if (!cands.length) return { alerts: [], partial };
  const alerts = [];
  for (const c of cands) {
    // Ask for this one market, so a wallet with hundreds of open bets cannot push it off the page.
    const pos = ((await get('/positions', { user: w.w, condition: c.cond, limit: 50 })) || {}).data || [];
    const p = pos.find((q) => Number(q.outcome_index) === Number(c.idx) && q.status === 'OPEN');
    if (!p) continue; // nothing held now: sold out, or not confirmed. Either way there is no stake to report.
    const stake = Number(p.current_size || 0) * Number(p.avg_price || 0); // what is still held, at cost
    const paid = c.shares ? c.usd / c.shares : null;
    if (stake < o.minStake || paid === null || paid < 0.05 || paid > 0.95) continue; // skip near-certain parking bets
    const g = strong[c.cat];
    alerts.push({ id: w.w + '|' + c.cond + '|' + c.idx, whale: w.name, w: w.w, cond: c.cond, cat: c.cat, rec: { net: g.net, n: g.n, roi: g.roi },
      title: c.title, outcome: p.outcome, added: Math.round(c.usd), paid, stake: Math.round(stake), avg: Number(p.avg_price), cur: Number(p.current_price),
      fresh: p.first_entry_at >= cutoff, last: c.last, slug: p.event_slug || p.slug || c.slug });
  }
  return { alerts, partial };
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

// one shared scan per instance per ~50 seconds, however many phones are polling
const board = () => cached('alerts', 50000, () => scanAlerts());

module.exports = { scanAlerts, board, check };
