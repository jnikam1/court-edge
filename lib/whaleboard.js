// Whale tracker. Who is profitable where comes from lib/whales.json and lib/kalshi_profiles.json
// (built offline from full trade histories). What they hold right now is fetched live.
const { getJson, qs, kget, num, cached } = require('./kalshi');
const W = require('./whales.json');
const KP = require('./kalshi_profiles.json');
const DATA = 'https://data-api.polymarket.com/v2';
const KSOCIAL = 'https://api.elections.kalshi.com/v1/social';
const UA = 'Mozilla/5.0 (compatible; court-edge/1.0)';

async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
const catOf = (slug) => W.prefix[String(slug || '').split('-')[0]] || 'Other';

function polymarket() {
  return cached('whaleboard-pm', 60000, async () => {
    const lists = await pool(W.wallets, 10, (w) => getJson(DATA + '/positions' + qs({ user: w.w, limit: 100 }), { label: 'Polymarket', ua: UA, timeout: 9000 }).then((d) => (d && d.data) || []));
    const bets = []; const whales = [];
    W.wallets.forEach((w, k) => {
      const grades = {}; for (const c of w.cats) grades[c.k] = c;
      // skip dust and bets that are already decided in all but name
      const open = (lists[k] || []).filter((p) => p.status === 'OPEN' && Number(p.current_value || 0) >= 1000 && Number(p.current_price) > 0.03 && Number(p.current_price) < 0.97);
      let openUsd = 0; let inStrong = 0;
      for (const p of open) {
        const cat = catOf(p.event_slug || p.slug); const g = grades[cat];
        const usd = Number(p.current_value || 0); openUsd += usd;
        if (g && g.grade === 'strong') inStrong++;
        bets.push({
          who: k, title: p.title, outcome: p.outcome, cat, grade: g ? g.grade : 'none', rec: g ? { net: g.net, n: g.n, roi: g.roi } : null,
          usd: Math.round(usd), cost: Math.round(Number(p.total_cost_usdc || 0)), avg: Number(p.avg_price || 0), cur: Number(p.current_price || 0),
          first: p.first_entry_at || null, last: p.last_event_at || null, slug: p.event_slug || p.slug,
        });
      }
      whales.push({ name: w.name, pnl: w.pnl, month: w.month, complete: w.complete, strong: w.cats.filter((c) => c.grade === 'strong'), weak: w.cats.filter((c) => c.grade === 'weak'), open: open.length, openUsd: Math.round(openUsd), inStrong, ok: lists[k] !== null });
    });
    bets.sort((a, b) => (b.last || 0) - (a.last || 0));
    // whales with live bets in a strong category first
    const order = whales.map((w, k) => k).sort((x, y) => (whales[y].inStrong > 0) - (whales[x].inStrong > 0) || (whales[y].open > 0) - (whales[x].open > 0) || whales[y].pnl - whales[x].pnl);
    const pos = {}; order.forEach((k, i) => { pos[k] = i; });
    const kept = bets.slice(0, 400); kept.forEach((b) => { b.who = pos[b.who]; });
    return { asOf: new Date().toISOString(), built: W.built, whales: order.map((k) => whales[k]), bets: kept };
  });
}

const kso = (path, params) => getJson(KSOCIAL + path + qs(params), { label: 'Kalshi', timeout: 8000, tries: 3 });
function kalshi() {
  return cached('whaleboard-kalshi', 90000, async () => {
    const raw = await pool(KP.profiles, 6, async (p) => {
      const [h, t] = await Promise.all([
        p.holdings ? kso('/profile/holdings', { nickname: p.nick, limit: 40 }).catch(() => null) : null,
        p.trades ? kso('/trades', { nickname: p.nick, limit: 60 }).catch(() => null) : null,
      ]);
      return { h: (h && h.holdings) || [], t: (t && t.trades) || [] };
    });
    const profiles = []; const tickers = new Set();
    KP.profiles.forEach((p, k) => {
      const r = raw[k] || { h: [], t: [] };
      const holds = [];
      for (const ev of r.h) for (const m of ev.market_holdings || []) {
        if (!m.signed_open_position) continue;
        holds.push({ ticker: m.market_ticker, side: m.signed_open_position > 0 ? 'YES' : 'NO', qty: Math.abs(m.signed_open_position), pnl: Math.round((m.pnl || 0) / 10000) });
      }
      holds.sort((a, b) => b.qty - a.qty);
      // group recent trades by market and direction
      const g = new Map();
      for (const t of r.t) {
        const mine = t.taker_nickname === p.nick; const yes = num(t.price_dollars); const n = num(t.count_fp) || 0;
        if (yes === null || !n) continue;
        const takerBuysYes = (t.taker_side === 'yes') === (t.taker_action === 'buy');
        const buysYes = mine ? takerBuysYes : !takerBuysYes;
        const key = t.ticker + '|' + (buysYes ? 'YES' : 'NO');
        const x = g.get(key) || { ticker: t.ticker, side: buysYes ? 'YES' : 'NO', qty: 0, usd: 0, t: 0, resting: 0 };
        const price = buysYes ? yes : 1 - yes;
        x.qty += n; x.usd += n * price; x.t = Math.max(x.t, Math.floor(Date.parse(t.create_date) / 1000) || 0); if (!mine) x.resting += n;
        g.set(key, x);
      }
      const trades = [...g.values()].filter((x) => x.usd >= 100).sort((a, b) => b.t - a.t).slice(0, 8).map((x) => ({ ticker: x.ticker, side: x.side, qty: Math.round(x.qty), usd: Math.round(x.usd), avg: x.qty ? x.usd / x.qty : null, t: x.t, resting: x.resting > x.qty / 2 }));
      holds.slice(0, 8).forEach((x) => tickers.add(x.ticker)); trades.forEach((x) => tickers.add(x.ticker));
      profiles.push({ nick: p.nick, pnl: p.pnl, markets: p.markets || null, bot: (p.markets || 0) >= 5000, cats: p.cats, recent: p.recent, top: p.top, holds: holds.slice(0, 8), holdCount: holds.length, trades, last: trades.length ? trades[0].t : null });
    });
    // market names
    const names = {}; const list = [...tickers];
    const chunks = []; for (let i = 0; i < list.length; i += 60) chunks.push(list.slice(i, i + 60));
    await pool(chunks.slice(0, 8), 3, async (c) => {
      const d = await kget('/markets', { tickers: c.join(','), limit: 100 });
      for (const m of d.markets || []) names[m.ticker] = { title: String(m.title || '').slice(0, 110), sub: String(m.yes_sub_title || '').slice(0, 60), status: m.status, bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars) };
    });
    profiles.sort((a, b) => (a.bot - b.bot) || (b.pnl - a.pnl));
    return { asOf: new Date().toISOString(), built: KP.built, scanned: KP.scanned, visible: KP.visible, profiles, names };
  });
}

module.exports = { polymarket, kalshi };
