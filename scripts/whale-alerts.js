#!/usr/bin/env node
// Prints an alert for every tracked whale that added to a big position in one of its
// winning categories recently. Stateless: looks back a fixed window, so run it once per window.
//
//   node scripts/whale-alerts.js [--minutes 70] [--min-stake 50000] [--min-add 10000]
//
// Behind a proxy: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle> node scripts/whale-alerts.js
const { getJson, qs } = require('../lib/kalshi');
const W = require('../lib/whales.json');
const DATA = 'https://data-api.polymarket.com/v2';
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const MINUTES = arg('minutes', 70); const MIN_STAKE = arg('min-stake', 50000); const MIN_ADD = arg('min-add', 10000);
const get = (path, params) => getJson(DATA + path + qs(params), { label: 'Polymarket', ua: UA, timeout: 12000, tries: 4 });
const catOf = (slug) => W.prefix[String(slug || '').split('-')[0]] || 'Other';
const money = (x) => (Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : '$' + Math.round(x / 1000) + 'k');
const cents = (x) => Math.round(x * 100) + 'c';

async function recentBuys(wallet, cutoff) {
  const out = []; let cursor;
  for (let page = 0; page < 8; page++) {
    const d = await get('/activity', { user: wallet, limit: 500, cursor });
    const rows = (d && d.data) || [];
    let older = false;
    for (const r of rows) { if (r.timestamp < cutoff) { older = true; continue; } if (r.type === 'TRADE' && r.side === 'BUY') out.push(r); }
    const pg = (d && d.pagination) || {}; cursor = pg.next_cursor;
    if (older || !rows.length || !pg.has_more || !cursor) break;
  }
  return out;
}

async function check(w, cutoff) {
  const strong = {}; for (const c of w.cats) if (c.grade === 'strong') strong[c.k] = c;
  const buys = await recentBuys(w.w, cutoff);
  const by = new Map();
  for (const b of buys) {
    const cat = catOf(b.slug); if (!strong[cat]) continue;
    const key = b.condition_id + '|' + b.outcome_index;
    const x = by.get(key) || { cond: b.condition_id, idx: b.outcome_index, title: b.title, slug: b.slug, cat, usd: 0, shares: 0, last: 0 };
    x.usd += Number(b.usdc_size || 0); x.shares += Number(b.size || 0); x.last = Math.max(x.last, b.timestamp); by.set(key, x);
  }
  const cands = [...by.values()].filter((x) => x.usd >= MIN_ADD);
  if (!cands.length) return [];
  const pos = ((await get('/positions', { user: w.w, limit: 200 })) || {}).data || [];
  const alerts = [];
  for (const c of cands) {
    const p = pos.find((q) => q.condition_id === c.cond && Number(q.outcome_index) === Number(c.idx));
    const stake = p ? Number(p.total_size || 0) * Number(p.avg_price || 0) : c.usd;
    const avg = c.shares ? c.usd / c.shares : null; const now = p ? Number(p.current_price) : null;
    if (stake < MIN_STAKE || avg === null || avg < 0.05 || avg > 0.95) continue; // skip near-certain "parking" bets
    const g = strong[c.cat];
    alerts.push({ whale: w.name, wallet: w.w, cat: c.cat, record: money(g.net) + (g.n ? ' over ' + g.n + ' markets' : '') + ' (' + (g.roi * 100).toFixed(1) + '%)',
      market: c.title, outcome: p ? p.outcome : 'outcome ' + c.idx, added: Math.round(c.usd), addedAt: avg, stake: Math.round(stake), now, fresh: p && p.first_entry_at >= cutoff, last: c.last,
      url: 'https://polymarket.com/event/' + (p ? p.event_slug || p.slug : c.slug) });
  }
  return alerts;
}

(async () => {
  const cutoff = Math.floor(Date.now() / 1000) - MINUTES * 60;
  const all = []; let failed = 0; let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < W.wallets.length) { const w = W.wallets[i++]; try { all.push(...(await check(w, cutoff))); } catch (e) { failed++; } } }));
  all.sort((a, b) => b.added - a.added);
  console.log('WHALE ALERTS: ' + all.length + ' (window ' + MINUTES + ' min, stake ' + money(MIN_STAKE) + '+, added ' + money(MIN_ADD) + '+, ' + W.wallets.length + ' wallets, ' + failed + ' failed)');
  for (const a of all) {
    console.log('- ' + a.whale + ' ' + (a.fresh ? 'opened' : 'added to') + ' ' + a.outcome + ' | ' + a.market + ' [' + a.cat + ']');
    console.log('  bought ' + money(a.added) + ' at ' + cents(a.addedAt) + ', stake now ' + money(a.stake) + (a.now !== null ? ', price now ' + cents(a.now) : '') + ', ' + Math.round((Date.now() / 1000 - a.last) / 60) + ' min ago');
    console.log('  their ' + a.cat + ' record: ' + a.record + ' | ' + a.url);
  }
  if (failed > W.wallets.length / 2) process.exitCode = 2;
})().catch((e) => { console.error('whale-alerts failed: ' + (e && e.message)); process.exit(1); });
