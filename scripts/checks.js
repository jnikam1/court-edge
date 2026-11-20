// Checks for behaviour that has gone wrong before. No network: every outside call is faked.
// Run with: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const results = [];
const check = async (name, fn) => { try { await fn(); results.push('ok    ' + name); } catch (e) { results.push('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 5).join(' / ') + ' @ ' + String(e && e.stack).split('\n').filter((l) => /checks\.js/.test(l)).slice(0, 1).join('')); process.exitCode = 1; } };
const near = (x, y, tol) => Math.abs(x - y) <= (tol || 1e-9);

(async () => {
  const { resumed } = require('../lib/scan');
  const { buildRead } = require('../lib/detail');
  const model = require('../lib/model');

  await check('set break: over once a game of set two is played', () => {
    assert.strictEqual(resumed([[6, 4], [0, 0]]), false); assert.strictEqual(resumed([[6, 4], [0, 2]]), true); assert.strictEqual(resumed(null), false);
  });
  await check('set break: the read switches to the live score after play resumes', () => {
    const m = { a: { name: 'A Player', bid: 0.69, ask: 0.70 }, b: { name: 'B Player', bid: 0.30, ask: 0.31 }, tour: 'ATP', bestOf5: false, state: 'set2', fair: { a: 0.7785, b: 0.2215 }, call: { live: true, bet: true, side: 'a', price: 0.70, edge: 0.06, need: 0.03 } };
    const x = (sets) => ({ sets, live: { a: 0.6306 }, swing: null, behind: null, srv: 'a', started: true, rating: null, midA: 0.695, flow: null, move15: 0 });
    const s = { rules: { n: 2452 } };
    assert.ok(/^Set-break gap/.test(buildRead(m, x([[6, 4], [0, 0]]), s).title), 'still a set-break call during the break');
    assert.ok(!/^Set-break gap/.test(buildRead(m, x([[6, 4], [0, 2]]), s).title), 'no set-break call at 6-4, 0-2');
  });
  await check('tennis model: a finished 7-6 or 7-5 set counts as finished', () => {
    for (const set of [[7, 6], [7, 5], [6, 3]]) {
      const now = model.liveFair('ATP', 0.5, [set], false, null); const next = model.liveFair('ATP', 0.5, [set, [0, 0]], false, null);
      assert.ok(now && next && near(now.a, next.a), set.join('-') + ' gives ' + (now && now.a) + ' against ' + (next && next.a));
      assert.ok(now.a > 0.7, 'the set winner should be well ahead, got ' + now.a);
    }
    assert.ok(near(model.liveFair('ATP', 0.5, [[6, 6]], false, null).a, 0.5, 0.02), 'a tiebreak in progress stays near even');
  });

  await check('tennis model: point scores match an independent implementation', () => {
    // Values from a separate Python model: equal players winning 64% on serve, one set all.
    const pct = (x) => Math.round(x * 1000) / 10; const f = (...a) => pct(model.matchFrom(0.64, 0.64, 1, 1, ...a));
    assert.strictEqual(f(4, 4, 'b'), 50.0); assert.strictEqual(f(4, 4, 'b', [3, 0]), 80.7, 'receiver at 0-40'); assert.strictEqual(f(5, 4, 'a'), 90.6); assert.strictEqual(f(4, 5, 'a'), 40.6); assert.strictEqual(f(5, 4, 'b'), 59.4);
    assert.strictEqual(pct(model.setFrom(0.64, 0.64, 6, 6, true, [5, 3])), 82.3, 'tiebreak at 5-3');
    assert.deepStrictEqual(model.pointCounts('40', 'A'), [3, 4]); assert.deepStrictEqual(model.pointCounts('15', '0'), [1, 0]); assert.strictEqual(model.pointCounts('50', '0'), null);
    assert.strictEqual(model.firstServer('a', [1, 0]), 'b'); assert.strictEqual(model.firstServer('a', [2, 1]), 'a');
  });
  await check('tennis paths: each next step sits on the right side of the current value', () => {
    const P = model.paths('ATP', 0.5, [[6, 4], [4, 6], [4, 4]], 'b', null); const v = (k) => P.rows.find((r) => r.k === k).a;
    assert.ok(v('game_a') > P.now && v('game_b') < P.now && v('bp3') > P.now && v('gp3') < P.now); assert.strictEqual(v('set_a'), 1); assert.strictEqual(v('set_b'), 0);
    const Q = model.paths('ATP', 0.62, [[6, 4], [2, 3]], null, null); assert.ok(Q.rows.every((r) => r.k !== 'bp3'), 'no break-point rows without a server');
    assert.strictEqual(model.paths('ATP', 0.6, [[6, 4], [6, 3]], null, null), null, 'a finished match has no paths');
  });

  // whale alerts, with Polymarket faked
  await check('whale alerts: a whale that sold out is not reported as holding', async () => {
    const realFetch = global.fetch; const now = Math.floor(Date.now() / 1000);
    const buy = { type: 'TRADE', side: 'BUY', timestamp: now - 600, condition_id: '0xabc', outcome_index: 0, slug: 'nba-aaa-bbb-2026-11-13', title: 'A v B', usdc_size: 60000, size: 100000, price: 0.6 };
    let positions = []; let trades = [buy];
    global.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/activity') ? { data: trades, pagination: { has_more: false } } : { data: positions }) });
    try {
      delete require.cache[require.resolve('../lib/alerts')]; const { check: scanOne } = require('../lib/alerts');
      const w = { w: '0xwhale', name: 'Whale', cats: [{ k: 'NBA', grade: 'strong', net: 100000, n: 50, roi: 0.05 }] }; const o = { minutes: 180, minStake: 50000, minAdd: 10000, maxPages: 2 };
      positions = []; assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'no open position, so no alert');
      positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 20000, total_size: 100000, avg_price: 0.6, current_price: 0.62, first_entry_at: now - 600 }];
      assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'most of it sold: $12k left is under the $50k bar');
      positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 100000, total_size: 100000, avg_price: 0.6, current_price: 0.62, first_entry_at: now - 600 }];
      const a = (await scanOne(w, now - 10800, o)).alerts; assert.strictEqual(a.length, 1); assert.strictEqual(a[0].stake, 60000);
      trades = [buy, Object.assign({}, buy, { side: 'SELL', timestamp: now - 300 })]; assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'bought and sold the same amount: not an add');
      // selling more than it bought is reported as a sale, an exit or a switch
      const sell = Object.assign({}, buy, { side: 'SELL', usdc_size: 40000, size: 60000, price: 0.66, outcome: 'A', timestamp: now - 200 });
      trades = [sell]; positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 40000, total_size: 100000, avg_price: 0.6, current_price: 0.66 }];
      let sl = (await scanOne(w, now - 10800, o)).alerts; assert.strictEqual(sl.length, 1); assert.strictEqual(sl[0].sell, true); assert.strictEqual(sl[0].kind, 'trim'); assert.strictEqual(sl[0].sold, 40000); assert.strictEqual(sl[0].left, 24000); assert.ok(Math.abs(sl[0].price - 0.667) < 0.001);
      positions = []; sl = (await scanOne(w, now - 10800, o)).alerts; assert.strictEqual(sl[0].kind, 'exit', 'nothing left: it is out');
      trades = [sell, Object.assign({}, buy, { outcome_index: 1, outcome: 'B', usdc_size: 50000, timestamp: now - 100 })]; positions = [{ status: 'OPEN', outcome_index: 1, outcome: 'B', current_size: 100000, total_size: 100000, avg_price: 0.4, current_price: 0.4, first_entry_at: now - 100 }];
      sl = (await scanOne(w, now - 10800, o)).alerts.filter((x) => x.sell); assert.strictEqual(sl[0].kind, 'switch'); assert.strictEqual(sl[0].to, 'B'); assert.strictEqual(sl[0].bought, 50000);
      trades = [Object.assign({}, sell, { usdc_size: 9000 })]; assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'a small sale is not news');
      positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 100000, total_size: 100000, avg_price: 0.6, current_price: 0.62, first_entry_at: now - 600 }];
      trades = [buy, Object.assign({}, buy, { side: 'SELL', usdc_size: 20000, timestamp: now - 300 })]; assert.strictEqual((await scanOne(w, now - 10800, o)).alerts[0].added, 40000, 'the add is what it bought less what it sold');
    } finally { global.fetch = realFetch; }
  });

  // the cost box in the page
  await check('cost box: a resting order never reaches the ask', () => {
    const html = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8'); const src = (/function restPrice\(p\) \{.*\}/.exec(html) || [])[0];
    assert.ok(src, 'restPrice not found'); const restPrice = new Function('has', src + '; return restPrice;')((x) => x !== null && x !== undefined);
    assert.strictEqual(restPrice({ bid: 0.49, ask: 0.50 }), 0.49); assert.strictEqual(restPrice({ bid: 0.45, ask: 0.50 }), 0.46); assert.strictEqual(restPrice({ bid: null, ask: 0.5 }), null);
  });

  await check('whale alerts: a buy smaller than what the wallet holds against it is called a hedge', () => {
    const { netExposure } = require('../lib/alerts'); const O = (o) => Object.assign({ status: 'OPEN' }, o);
    // the real case: bought Gen.G in the final while holding more "Gen.G does not win Worlds" and Bilibili
    const p = O({ condition_id: 'm', outcome: 'Gen.G', outcome_index: 1, opposite_outcome: 'Bilibili Gaming', current_size: 202635, current_price: 0.565 });
    const book = [p, O({ condition_id: 'm', outcome: 'Bilibili Gaming', outcome_index: 0, current_size: 123653, current_price: 0.435, title: 'LoL: Bilibili Gaming vs Gen.G (BO5)' }),
      O({ condition_id: 'w1', title: 'Will Gen.G win Worlds 2026?', outcome: 'No', current_size: 330104, current_price: 0.435 }), O({ condition_id: 'w1', title: 'Will Gen.G win Worlds 2026?', outcome: 'Yes', current_size: 3288, current_price: 0.565 }),
      O({ condition_id: 'w2', title: 'Will Bilibili Gaming win Worlds 2026?', outcome: 'Yes', current_size: 11338, current_price: 0.4435 }), O({ condition_id: 'w2', title: 'Will Bilibili Gaming win Worlds 2026?', outcome: 'No', current_size: 15880, current_price: 0.5565 }),
      O({ condition_id: 'old', title: 'Will Gen.G win Worlds 2026?', outcome: 'No', current_size: 999999, current_price: 0.4, status: 'REDEEMABLE' })];
    const n = netExposure(p, book); assert.strictEqual(n.for, 202635 + 3288); assert.strictEqual(n.against, 123653 + 330104 + 11338); assert.strictEqual(n.lean, 'against'); assert.strictEqual(n.legs[0].outcome, 'No');
    assert.strictEqual(netExposure(p, [p]).lean, 'for', 'nothing held the other way');
    assert.strictEqual(netExposure(p, [p, book[1]]).lean, 'hedged', 'more than half covered, but still net for');
    // a title future far from the match price is a different bet, not a hedge of tonight's game
    const lal = O({ condition_id: 'g', outcome: 'Lakers', outcome_index: 0, opposite_outcome: 'Suns', current_size: 100000, current_price: 0.6 });
    assert.strictEqual(netExposure(lal, [lal, O({ condition_id: 'f', title: 'Will Los Angeles Lakers win the 2027 NBA Finals?', outcome: 'No', current_size: 500000, current_price: 0.95 })]).lean, 'for');
    assert.strictEqual(netExposure(O({ outcome: 'Yes', current_size: 1 }), []), null, 'yes or no markets are left alone');
  });

  await check('whale alerts: one wallet buying both sides of a match becomes one card with its net position', () => {
    const { seriesBook, group } = require('../lib/alerts'); const ev = 'lol-blg-gen-2026-11-14'; const O = (o) => Object.assign({ status: 'OPEN', avg_price: 0.5 }, o);
    const book = [O({ condition_id: 'm', event_slug: ev, slug: ev, title: 'LoL: Bilibili Gaming vs Gen.G (BO5)', outcome: 'Gen.G', opposite_outcome: 'Bilibili Gaming', current_size: 313044, current_price: 0.585 }),
      O({ condition_id: 'm', event_slug: ev, slug: ev, title: 'LoL: Bilibili Gaming vs Gen.G (BO5)', outcome: 'Bilibili Gaming', opposite_outcome: 'Gen.G', current_size: 252575, current_price: 0.415 }),
      O({ event_slug: 'worlds-2026-winner', slug: 'will-genptg-win-worlds-2026', title: 'Will Gen.G win Worlds 2026?', outcome: 'No', current_size: 330627, current_price: 0.42 }), O({ event_slug: 'worlds-2026-winner', slug: 'will-genptg-win-worlds-2026', title: 'Will Gen.G win Worlds 2026?', outcome: 'Yes', current_size: 14004, current_price: 0.58 }),
      O({ event_slug: 'worlds-2026-winner', slug: 'b', title: 'Will Bilibili Gaming win Worlds 2026?', outcome: 'No', current_size: 16838, current_price: 0.593 }), O({ event_slug: 'worlds-2026-winner', slug: 'b', title: 'Will Bilibili Gaming win Worlds 2026?', outcome: 'Yes', current_size: 15915, current_price: 0.407 }),
      O({ event_slug: ev, slug: ev + '-game2', title: 'Game 2 Winner', outcome: 'Bilibili Gaming', opposite_outcome: 'Gen.G', current_size: 760131, current_price: 1 })];
    const sb = seriesBook(book, ev); assert.strictEqual(Math.round(sb.pay['Gen.G']), 313044 + 14004 + 16838); assert.strictEqual(Math.round(sb.pay['Bilibili Gaming']), 252575 + 330627 + 15915, 'single games stay out'); assert.strictEqual(sb.lead, 'Bilibili Gaming');
    const w = { w: '0xw', name: 'W' }; const A = (o) => Object.assign({ ev, main: true, cat: 'Esports', rec: { net: 1, n: 1 }, fresh: false }, o);
    const both = group(w, [A({ outcome: 'Bilibili Gaming', added: 90000, paid: 0.37, last: 200 }), A({ outcome: 'Gen.G', added: 85000, paid: 0.76, last: 100 })], book);
    assert.strictEqual(both.length, 1, 'two buys, one card'); assert.strictEqual(both[0].outcome, 'Bilibili Gaming'); assert.strictEqual(both[0].added, 90000); assert.strictEqual(both[0].lean, 'hedged'); assert.strictEqual(both[0].quiet, false); assert.strictEqual(both[0].net.both, true); assert.strictEqual(both[0].id, '0xw|' + ev);
    const trim = group(w, [A({ outcome: 'Gen.G', added: 85000, paid: 0.76, last: 100 })], book); assert.strictEqual(trim[0].outcome, 'Bilibili Gaming'); assert.strictEqual(trim[0].quiet, true, 'buying only the smaller side is a trim, and is not pushed');
    const sideM = group(w, [A({ main: false, outcome: 'Gen.G', added: 78000, paid: 0.56, last: 50, id: 'x' })], book); assert.strictEqual(sideM[0].grouped, undefined); assert.strictEqual(sideM[0].series.lead, 'Bilibili Gaming');
    assert.deepStrictEqual(both[0].net.also, [], 'a finished single game is not listed beside the match');
    const more = book.concat([O({ event_slug: ev, slug: ev + '-spread', title: 'Gen.G -1.5 games', outcome: 'No', current_size: 100000, current_price: 0.6 }), O({ event_slug: ev, slug: ev + '-tiny', title: 'Total kills', outcome: 'Over', current_size: 500, current_price: 0.5 })]);
    const withAlso = group(w, [A({ outcome: 'Bilibili Gaming', added: 90000, paid: 0.37, last: 200 })], more)[0].net.also;
    assert.deepStrictEqual(withAlso, [{ title: 'Gen.G -1.5 games', outcome: 'No', usd: 50000 }], 'a live spread on the same match is listed with what it cost, small change is not');
  });

  await check('whale alerts: a wallet that looks like a market maker, or loses over its life, is labelled, and others are left alone', async () => {
    const { makerRead, withRef } = require('../lib/alerts'); const T = (cond, idx, usd, side) => ({ condition_id: cond, outcome_index: idx, usdc_size: usd, side: side || 'BUY' });
    const sharp = makerRead({ pnl: 9.8e6, volume: 411e6 }, [T('a', 0, 50000)], { merges: 0, fills: 1 }); assert.strictEqual(sharp.is, false, '2.4% on volume, one side, no merges: not flagged'); assert.strictEqual(sharp.kind, null);
    const thin = makerRead({ pnl: 5.5e6, volume: 1402e6 }, [], {}); assert.strictEqual(thin.is, true); assert.strictEqual(thin.kind, 'thin', 'a thin margin alone is called thin, not a market maker'); assert.ok(/0\.4% of the \$1\.4B/.test(thin.why[0]), thin.why[0]);
    const loser = makerRead({ pnl: -4.75e6, volume: 266e6 }, [], {}); assert.strictEqual(loser.kind, 'losing'); assert.strictEqual(makerRead({ pnl: -4.75e6, volume: 266e6 }, [], { merges: 2 }).kind, 'maker', 'seen merging outranks the lifetime figure'); assert.ok(/down \$4\.8M over its life on \$266M/.test(loser.why[0]), loser.why[0]);
    assert.strictEqual(makerRead({ pnl: 66000, volume: 15000 }, [], {}).is, false, 'a small wallet is not judged on its ratio');
    assert.strictEqual(makerRead({ pnl: 9e6, volume: 100e6 }, [], { merges: 3 }).kind, 'maker', 'merging pairs back into cash is what a market maker does');
    const two = [T('a', 0, 20000), T('a', 1, 18000), T('b', 0, 9000), T('b', 1, 9000)];
    assert.strictEqual(makerRead({ pnl: 9e6, volume: 100e6 }, two, {}).both, 2); assert.strictEqual(makerRead({ pnl: 9e6, volume: 100e6 }, two, {}).is, true, 'both sides of two markets in the window');
    assert.strictEqual(makerRead({ pnl: 9e6, volume: 100e6 }, two.slice(0, 2), {}).is, false, 'both sides of one market can be a hedge, so it takes two');
    assert.strictEqual(makerRead({ pnl: 9e6, volume: 100e6 }, [T('a', 0, 20000), T('a', 1, 18000, 'SELL'), T('b', 0, 9000), T('b', 1, 100)], {}).is, false, 'sales and dust do not count as buying both sides');
    // the reference price lands on the right team whichever way round the venues list them
    const S = require('../lib/sports'); const real = S.refBySlug;
    S.refBySlug = async (slug) => (slug === 'nfl-min-gb-2026-11-15' ? { event: 'E', state: 'upcoming', book: 'DraftKings', a: { name: 'Vikings', full: 'Minnesota Vikings', fair: 0.41, bid: 0.4, ask: 0.42 }, b: { name: 'Packers', full: 'Green Bay Packers', fair: 0.59, bid: 0.58, ask: 0.6 } } : null);
    try {
      const d = await withRef({ alerts: [{ grouped: true, slug: 'nfl-min-gb-2026-11-15', outcome: 'Packers' }, { grouped: true, slug: 'nfl-min-gb-2026-11-15', outcome: 'Minnesota' }, { grouped: true, slug: 'lol-blg-gen-2026-11-14', outcome: 'Gen.G' }, { sell: true, slug: 'nfl-min-gb-2026-11-15', outcome: 'Packers' }] });
      assert.deepStrictEqual(d.alerts[0].ref, { event: 'E', state: 'upcoming', book: 'DraftKings', fair: 0.59, kalshi: 0.6, kalshiBid: 0.58 }); assert.strictEqual(d.alerts[1].ref.fair, 0.41, 'a city name finds its team');
      assert.strictEqual(d.alerts[2].ref, undefined, 'no reference outside the NBA and NFL'); assert.strictEqual(d.alerts[3].ref, undefined, 'none on a sale');
    } finally { S.refBySlug = real; }
  });

  await check('engine: wallet grades carry markouts and a size-weighted count, and the market-maker label is scored on its own', async () => {
    const { whaleGrades, whaleSplit } = await import(path.join(root, 'worker/src/brain.js'));
    const R = (name, net, entry, m15, usd, mm) => ({ setup: 'whale_add', status: 'deadline', lg: 'NFL', name, net, entry, m5: entry, m15, ctx: JSON.stringify(mm === undefined ? { usd } : { usd, mm }) });
    const rows = [R('A', 2, 0.5, 0.53, 2000000, false), R('A', -1, 0.5, 0.49, 20000, false), R('A', -1, 0.5, 0.49, 20000, false), R('B', -3, 0.6, 0.58, 50000, 'maker'), R('B', -1, 0.6, 0.6, 50000, 'maker'), R('C', 1, 0.4, 0.41, 10000)];
    const g = whaleGrades(rows); const a = g.find((x) => x.whale === 'A'); const b = g.find((x) => x.whale === 'B');
    assert.strictEqual(a.n, 3); assert.strictEqual(a.m15, 0.3, 'average move after 15 minutes, in cents'); assert.strictEqual(a.m5, 0); assert.strictEqual(a.effN, 1, 'one $2M bet and two of $20k count as about one bet');
    assert.strictEqual(b.effN, 2); assert.strictEqual(b.maker, 'maker'); assert.strictEqual(b.m15, -1);
    const sp = whaleSplit(rows); const by = {}; for (const x of sp) by[x.group] = x;
    assert.strictEqual(by['not flagged'].n, 3); assert.strictEqual(by['not flagged'].avg, 0); assert.strictEqual(by['flagged: maker'].avg, -2); assert.strictEqual(by['before the label existed'].n, 1);
  });

  // alerts and tracked positions in the page
  await check('page: a stop needs a real two-sided quote, and a position is valued on its own venue', () => {
    const js = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8'); const line = (re) => { const m = re.exec(js); assert.ok(m, 'not found: ' + re); return m[0]; };
    const has = (x) => x !== null && x !== undefined;
    const ruleHit = new Function('has', line(/var ruleHit = function \(r, s\) \{.*\};/) + ' return ruleHit;')(has);
    assert.strictEqual(ruleHit({ op: 'bid<=', price: 0.5 }, { bid: 0.48, ask: 0.5 }), true); assert.strictEqual(ruleHit({ op: 'bid<=', price: 0.5 }, { bid: 0, ask: null }), false, 'no asks means no quote');
    assert.strictEqual(ruleHit({ op: 'bid>=', price: 0.8 }, { bid: 0.8, ask: 0.82 }), true); assert.strictEqual(ruleHit({ op: 'ask<=', price: 0.3 }, { bid: 0.2, ask: 0 }), false);
    const fns = new Function('has', [line(/var takerFee = function \(p, n\) \{.*?\};/), line(/var venueOf = function \(x\) \{.*?\};/), line(/var feeAt = function \(venue, p, n\) \{.*?\};/), line(/function pnlOf\(x\) \{.*\}/)].join('\n') + ' return { feeAt: feeAt, pnlOf: pnlOf, venueOf: venueOf };')(has);
    assert.strictEqual(fns.feeAt('kalshi', 0.5, 100), 1.75); assert.strictEqual(fns.feeAt('polymarket', 0.5, 100), 0, 'Kalshi fees are never applied to another venue');
    assert.strictEqual(fns.venueOf({}), 'kalshi', 'positions saved before venues existed are Kalshi');
    const k = { venue: 'kalshi', status: 'sold', qty: 100, exit: 0.8, cost: 100 * 0.5 + 1.75 }; assert.strictEqual(Math.round(fns.pnlOf(k) * 100), Math.round((80 - 1.12 - 51.75) * 100));
    const pm = { venue: 'polymarket', status: 'sold', qty: 100, exit: 0.8, cost: 50 }; assert.strictEqual(Math.round(fns.pnlOf(pm) * 100), 3000);
  });

  // the decision engine: its rules on their own, then a whole game through the logger with a real SQLite database
  await check('engine: setups fire only on their conditions, and paper trades close at target, deadline or settlement', async () => {
    const B = await import(path.join(root, 'worker/src/brain.js')); const now = 1000000;
    assert.strictEqual(B.gameModel('nba', 0.5, 0, 1, 720), 0.5); assert.ok(B.gameModel('nba', 0.5, 10, 4, 120) > 0.97); assert.ok(Math.abs(B.gameModel('nfl', 0.7, 0, 1, 900) - 0.7) < 0.005, 'at kick-off the model is the pre-game price');
    const g = { lg: 'nfl', event: 'E', state: 'live', a: 'NYG', b: 'DAL', an: 'Giants', bn: 'Cowboys', ab: 0.63, aa: 0.64, bb: 0.36, ba: 0.37, sa: 14, sb: 3, period: 2, clock: 400 };
    const prev = { t: now - 60, a_bid: 0.57, a_ask: 0.58, b_bid: 0.42, b_ask: 0.43, a_score: 14, b_score: 3, period: 2, clock: 460 };
    const dog = B.gameSignals(g, prev, 0.455, now).filter((x) => x.setup === 'nfl_dog_lead'); assert.strictEqual(dog.length, 1); assert.strictEqual(dog[0].side, 'a'); assert.strictEqual(dog[0].target, 0.8);
    assert.strictEqual(B.gameSignals(g, Object.assign({}, prev, { a_ask: 0.63 }), 0.455, now).filter((x) => x.setup === 'nfl_dog_lead').length, 0, 'already above 62¢ a minute ago: not a fresh cross');
    assert.strictEqual(B.gameSignals(g, prev, 0.30, now).filter((x) => x.setup === 'nfl_dog_lead').length, 0, 'a 70¢ favourite before the game is not a close game');
    assert.strictEqual(B.gameSignals(g, null, 0.455, now).length, 0, 'no earlier minute, no signal');
    const nba = { lg: 'nba', event: 'N', state: 'live', a: 'SAS', b: 'MEM', an: 'Spurs', bn: 'Grizzlies', ab: 0.29, aa: 0.30, bb: 0.70, ba: 0.71, sa: 30, sb: 38, period: 2, clock: 600 };
    const rec = B.gameSignals(nba, null, 0.70, now).filter((x) => x.setup === 'nba_recovery'); assert.strictEqual(rec.length, 1); assert.strictEqual(rec[0].side, 'a'); assert.strictEqual(rec[0].target, 0.42);
    assert.strictEqual(B.gameSignals(Object.assign({}, nba, { aa: 0.36 }), null, 0.70, now).filter((x) => x.setup === 'nba_recovery').length, 0, 'price at or above the model: no trade');
    assert.strictEqual(B.gameSignals(Object.assign({}, nba, { period: 4, clock: 300 }), null, 0.70, now).filter((x) => x.setup === 'nba_recovery').length, 0, 'too little game left');
    // the pre-game underdog that is level around halftime: bought once, held to the result
    const hd = { lg: 'nba', event: 'H', state: 'live', a: 'ORL', b: 'BOS', an: 'Magic', bn: 'Celtics', ab: 0.44, aa: 0.45, bb: 0.55, ba: 0.56, sa: 58, sb: 57, period: 3, clock: 600 };
    const h1 = B.gameSignals(hd, null, 0.35, now).filter((x) => x.setup === 'half_dog'); assert.strictEqual(h1.length, 1); assert.strictEqual(h1[0].name, 'Magic'); assert.strictEqual(h1[0].entry, 0.45); assert.strictEqual(h1[0].target, null); assert.strictEqual(h1[0].deadline, null);
    assert.strictEqual(B.gameSignals(hd, null, 0.46, now).filter((x) => x.setup === 'half_dog').length, 0, 'not an underdog before the game');
    assert.strictEqual(B.gameSignals(Object.assign({}, hd, { period: 2, clock: 600 }), null, 0.35, now).filter((x) => x.setup === 'half_dog').length, 0, 'too early');
    assert.strictEqual(B.gameSignals(Object.assign({}, hd, { period: 4, clock: 600 }), null, 0.35, now).filter((x) => x.setup === 'half_dog').length, 0, 'too late');
    assert.strictEqual(B.gameSignals(Object.assign({}, hd, { ab: 0.57, aa: 0.58, bb: 0.42, ba: 0.43 }), null, 0.35, now).filter((x) => x.setup === 'half_dog').length, 0, 'already past 50¢');
    const sig = { setup: 'nba_recovery', t: now, entry: 0.44, target: 0.56, deadline: now + 2400, ctx: { maxBehind: 20 } };
    assert.deepStrictEqual(B.manage(sig, { bid: 0.5, ask: 0.51, behind: 8 }, now + 60), { last: 0.5, hi: 0.5, lo: 0.5 });
    const hit = B.manage(sig, { bid: 0.57, ask: 0.58, behind: 2 }, now + 600); assert.strictEqual(hit.status, 'target'); assert.strictEqual(hit.exit, 0.56); assert.strictEqual(hit.net, 9.8); // 12¢ less 1.7¢ to get in and 0.4¢ to get out
    assert.strictEqual(B.manage(sig, { bid: 0.3, ask: 0.31, behind: 21 }, now + 600).status, 'invalid'); assert.strictEqual(B.manage(sig, { bid: 0.4, ask: 0.41, behind: 9 }, now + 2400).status, 'deadline');
    // a result is only ever taken from the exchange
    assert.strictEqual(B.manage(Object.assign({}, sig, { target: null, deadline: null }), { bid: 0.98, ask: 0.99, state: 'closing' }, now + 900).status, undefined, 'a 98¢ bid is not a win');
    const won = B.manage(sig, { bid: 0.98, ask: 0.99, result: 'yes' }, now + 900); assert.strictEqual(won.status, 'settled'); assert.strictEqual(won.exit, 1);
    const draw = B.manage(sig, { bid: null, ask: null, result: 'scalar', settle: 0.5 }, now + 900); assert.strictEqual(draw.status, 'settled'); assert.strictEqual(draw.exit, 0.5, 'a draw pays what the exchange says');
    const lost = B.manage(sig, { bid: null, ask: null, result: 'no' }, now + 900); assert.strictEqual(lost.status, 'settled'); assert.strictEqual(lost.exit, 0); assert.ok(lost.net < -44);
    assert.deepStrictEqual(B.manage(sig, null, now + 300), {}, 'a missing quote is waited out');
    assert.strictEqual(B.manage(Object.assign({ last: 0.95 }, sig), null, now + 3100).status, 'void', 'a last price of 95¢ and no result is thrown out, not booked as a win');
    assert.deepStrictEqual(B.manage(Object.assign({ last: 0.95 }, sig, { deadline: null }), null, now + 86400), {}, 'a hold-to-result trade stays pending until the exchange answers');
    const tn = { event: 'T', state: 'set2', live: { a: 0.74, known: true, srv: 'a', at: now - 40 }, pm: { sets: [[6, 3], [1, 0]] }, a: { name: 'A One', ask: 0.63, bid: 0.62 }, b: { name: 'B Two', ask: 0.38, bid: 0.37 } };
    const ts = B.tennisSignals(tn, now); assert.strictEqual(ts.length, 1); assert.strictEqual(ts[0].side, 'a'); assert.strictEqual(ts[0].target, 0.73); assert.strictEqual(B.tennisSignals(Object.assign({}, tn, { state: 'set1' }), now).length, 0);
    assert.strictEqual(B.tennisSignals(Object.assign({}, tn, { live: { a: 0.74, known: false, at: now - 40 } }), now).length, 0, 'server or point score unknown: no entry');
    assert.strictEqual(B.tennisSignals(Object.assign({}, tn, { live: { a: 0.74, known: true, at: now - 400 } }), now).length, 0, 'a score older than two and a half minutes: no entry');
    const grades = B.whaleGrades([{ setup: 'whale_add', lg: 'NBA', name: 'w1', status: 'deadline', net: 6 }, { setup: 'whale_add', lg: 'NBA', name: 'w2', status: 'deadline', net: -2 }]);
    assert.strictEqual(grades[0].whale, 'w1'); assert.ok(grades[0].grade < 6 && grades[0].grade > 2, 'one good add is pulled toward the category average');
  });
  await check('UFC: a Kalshi fight picks up its round, records and weight class from ESPN, and is never called live without it', () => {
    const { withEspn } = require('../lib/ufc'); const G = () => ({ state: 'upcoming', a: { name: 'Ciryl Gane', record: null }, b: { name: 'Josh Hokit', record: null } });
    const bout = (state, round, clock) => ({ card: 'UFC 334: Gane vs. Hokit', f: [{ name: 'Josh Hokit', record: '10-0-0' }, { name: 'Ciryl Gane', record: '14-2-0' }], state, round, clock, weight: 'Heavyweight', rounds: 5 });
    let g = G(); assert.strictEqual(withEspn(g, [bout('pre', 0, null)]), true); assert.strictEqual(g.state, 'upcoming'); assert.strictEqual(g.a.record, '14-2-0'); assert.strictEqual(g.b.record, '10-0-0'); assert.strictEqual(g.weight, 'Heavyweight');
    g = G(); withEspn(g, [bout('in', 2, '3:15')]); assert.strictEqual(g.state, 'live'); assert.strictEqual(g.text, 'Round 2 of 5 · 3:15');
    g = G(); withEspn(g, [bout('post', 3, null)]); assert.strictEqual(g.state, 'closing');
    g = G(); g.state = 'closing'; withEspn(g, [bout('in', 1, '5:00')]); assert.strictEqual(g.state, 'closing', 'a decided price is not reopened by a late feed');
    g = G(); assert.strictEqual(withEspn(g, [{ f: [{ name: 'Someone Else' }, { name: 'Another Fighter' }], state: 'in' }]), false); assert.strictEqual(g.state, 'upcoming');
    g = { state: 'upcoming', a: { name: 'Waldo Cortes-Acosta' }, b: { name: 'Jim Miller' } }; assert.strictEqual(withEspn(g, [{ f: [{ name: 'Waldo Cortes Acosta', record: '1-0-0' }, { name: 'Jim Miller', record: '2-0-0' }], state: 'pre' }]), true, 'names that differ only in punctuation still match');
  });
  await check('UFC: money flow counts each trade on the fighter the buyer backed, and says when one page does not reach an hour', async () => {
    const { flow } = require('../lib/ufc'); const realFetch = global.fetch; const iso = (secsAgo) => new Date(Date.now() - secsAgo * 1000).toISOString();
    const T = (taker, n, yes, secsAgo) => ({ count_fp: String(n), taker_side: taker, yes_price_dollars: String(yes), no_price_dollars: String(Math.round((1 - yes) * 100) / 100), created_time: iso(secsAgo) });
    let tape = { 'F1-AAA': [T('yes', 100, 0.67, 60), T('no', 50, 0.67, 120), T('yes', 1000, 0.60, 1800)], 'F1-BBB': [T('yes', 10, 0.34, 30)] };
    global.fetch = async (u) => { const t = /ticker=([^&]+)/.exec(String(u)); return { ok: true, status: 200, json: async () => ({ trades: tape[t ? decodeURIComponent(t[1]) : ''] || [] }) }; };
    try {
      const f = await flow({ a: { ticker: 'F1-AAA' }, b: { ticker: 'F1-BBB' } });
      assert.deepStrictEqual(f.m10, { a: 67, b: 20, n: 3 }, 'Yes on A is A; No on A and Yes on B are B'); assert.deepStrictEqual(f.m60, { a: 667, b: 20, n: 4 }); assert.strictEqual(f.big[0].usd, 600); assert.strictEqual(f.since, null);
      tape = { 'F2-AAA': Array.from({ length: 1000 }, (x, i) => T('yes', 1, 0.5, i)), 'F2-BBB': [] };
      const busy = await flow({ a: { ticker: 'F2-AAA' }, b: { ticker: 'F2-BBB' } }); assert.strictEqual(busy.m60, null, 'a full page that only reaches back 17 minutes cannot speak for the hour'); assert.ok(busy.m10.n >= 599 && busy.m10.n <= 602); assert.ok(busy.since >= 998 && busy.since <= 1001); assert.strictEqual(busy.all.a, 500);
    } finally { global.fetch = realFetch; }
  });
  await check('engine: the UFC money test opens only on a large one-sided ten minutes, once per fighter per phase, both ways', async () => {
    const B = await import(path.join(root, 'worker/src/brain.js')); const now = 3000000;
    const g = { lg: 'ufc', event: 'KXUFCFIGHT-26NOV14GANHOK', card: '26NOV14', state: 'upcoming', an: 'Ciryl Gane', bn: 'Josh Hokit', at: 'T-GAN', bt: 'T-HOK', ab: 0.66, aa: 0.67, bb: 0.33, ba: 0.34, f10: [42000, 9000] };
    const s = B.flowSignals(g, now); assert.deepStrictEqual(s.map((x) => x.setup), ['ufc_flow', 'ufc_flow_hold']); assert.strictEqual(s[0].name, 'Ciryl Gane'); assert.strictEqual(s[0].entry, 0.67); assert.strictEqual(s[0].deadline, now + 900); assert.strictEqual(s[1].deadline, null); assert.strictEqual(s[0].id, 'ufc_flow|KXUFCFIGHT-26NOV14GANHOK|a|pre');
    assert.strictEqual(B.flowSignals(Object.assign({}, g, { f10: [39000, 37000] }), now).length, 0, 'an even split is not a signal'); assert.strictEqual(B.flowSignals(Object.assign({}, g, { f10: [4000, 500] }), now).length, 0, 'too little money to mean anything');
    assert.strictEqual(B.flowSignals(Object.assign({}, g, { f10: null }), now).length, 0); assert.strictEqual(B.flowSignals(Object.assign({}, g, { state: 'closing' }), now).length, 0);
    const live = B.flowSignals(Object.assign({}, g, { state: 'live', period: 2, f10: [5000, 30000] }), now); assert.strictEqual(live[0].name, 'Josh Hokit'); assert.strictEqual(live[0].id, 'ufc_flow|KXUFCFIGHT-26NOV14GANHOK|b|r2'); assert.strictEqual(live[0].entry, 0.34);
    assert.strictEqual(B.flowSignals(Object.assign({}, g, { aa: 0.95, ab: 0.94 }), now).length, 0, 'nothing to learn at 95¢');
    assert.strictEqual(B.manage(Object.assign({ last: null }, s[0]), { bid: 0.7, ask: 0.71 }, now + 900).status, 'deadline'); assert.deepStrictEqual(Object.keys(B.manage(Object.assign({ last: 0.7, hi: 0.7, lo: 0.7, m5: 0.7, m15: 0.7 }, s[1]), { bid: 0.7, ask: 0.71 }, now + 5000)), [], 'the held version waits for the result');
  });
  await check('engine: UFC favourites are bought once at the scheduled start, and the record and two-favourite roll add up', async () => {
    const B = await import(path.join(root, 'worker/src/brain.js')); const now = 2000000;
    const g = { lg: 'ufc', event: 'KXUFCFIGHT-26NOV14GANHOK', card: '26NOV14', state: 'upcoming', start: now + 9000, an: 'Ciryl Gane', bn: 'Josh Hokit', at: 'T-GAN', bt: 'T-HOK', ab: 0.66, aa: 0.67, bb: 0.33, ba: 0.34 };
    const s = B.fightSignals(g, now); assert.strictEqual(s.length, 1); assert.strictEqual(s[0].name, 'Ciryl Gane'); assert.strictEqual(s[0].entry, 0.67); assert.strictEqual(s[0].target, null); assert.strictEqual(s[0].ctx.card, '26NOV14');
    assert.strictEqual(B.fightSignals(Object.assign({}, g, { state: 'closing' }), now).length, 0, 'not once the price says it is decided'); assert.strictEqual(B.fightSignals(Object.assign({}, g, { ab: 0.97, aa: 0.98 }), now).length, 0);
    assert.strictEqual(B.fightSignals(Object.assign({}, g, { ab: 0.3, aa: 0.31, bb: 0.69, ba: 0.7 }), now)[0].name, 'Josh Hokit', 'the favourite is whoever is priced higher');
    assert.deepStrictEqual(Object.keys(B.manage(Object.assign({ last: null }, s[0]), { bid: 0.98, ask: 0.99, state: 'closing' }, now + 900)).includes('status'), false, 'no result yet: still open');
    const won = B.manage(Object.assign({ last: null }, s[0]), { bid: 0.98, ask: 0.99, result: 'yes' }, now + 900); assert.strictEqual(won.status, 'settled'); assert.strictEqual(won.exit, 1); assert.strictEqual(won.net, Math.round((33 - 7 * 0.67 * 0.33) * 10) / 10);
    const lost = B.manage(Object.assign({ last: null }, s[0]), null, now + 900); assert.deepStrictEqual(lost, {});
    const R = (card, entry, exit) => ({ setup: 'ufc_fav', status: 'settled', entry, exit, ctx: JSON.stringify({ card }) });
    const st = B.favStats([R('A', 0.8, 1), R('A', 0.7, 1), R('A', 0.55, 0), R('B', 0.85, 1), R('B', 0.75, 0), R('C', 0.9, 1), { setup: 'ufc_fav', status: 'open', entry: 0.6 }]);
    assert.strictEqual(st.fights, 6); assert.strictEqual(st.won, 4); assert.deepStrictEqual(st.buckets.map((b) => [b.n, b.won]), [[1, 0], [0, 0], [2, 1], [3, 3]]);
    assert.strictEqual(st.roll.cards, 2, 'a card needs two finished favourites'); assert.strictEqual(st.roll.hit, 1); assert.ok(st.roll.avgReturn < 0 && st.roll.avgReturn > -0.2, 'one card paid about 1.7x, the other lost the stake');
  });
  await check('engine: a full NFL game through the logger opens one paper trade, closes it at the target and scores it', async () => {
    let sqlite; try { sqlite = require('node:sqlite'); } catch (e) { console.log('      (skipped: this Node has no built-in SQLite)'); return; }
    const db = new sqlite.DatabaseSync(':memory:');
    const st = (sql, args) => ({ bind: (...a) => st(sql, a), first: async () => db.prepare(sql).get(...args) || null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => db.prepare(sql).run(...args), go: () => db.prepare(sql).run(...args) });
    const env = { APP_URL: 'https://app.test', DB: { prepare: (sql) => st(sql, []), batch: async (list) => list.map((x) => x.go()) } };
    const mod = await import(path.join(root, 'worker/src/index.js') + '?engine'); const worker = mod.default;
    let feed = {}; const realFetch = global.fetch; const realNow = Date.now; let clock = 1794700000000;
    global.fetch = async (u) => { const k = Object.keys(feed).find((x) => String(u).indexOf(x) >= 0); return { ok: true, status: 200, json: async () => (k ? feed[k] : {}) }; };
    Date.now = () => clock;
    const run = async (games, alerts) => { feed = { '/api/sports': { games, inj: [], teams: [], feeds: {} }, '/api/alerts': { alerts: alerts || [] }, '/api/scan': { matches: [] } }; let p; await worker.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p; clock += 60000; };
    const g = (state, ab, aa, sa, sb, clockLeft) => [{ lg: 'nfl', event: 'KXNFLGAME-26NOV15NYGDAL', state, a: 'NYG', b: 'DAL', an: 'Giants', bn: 'Cowboys', at: 'KXNFLGAME-26NOV15NYGDAL-NYG', bt: 'KXNFLGAME-26NOV15NYGDAL-DAL', ab, aa, bb: Math.round((1 - aa) * 100) / 100, ba: Math.round((1 - ab) * 100) / 100, sa, sb, period: state === 'upcoming' ? null : 2, clock: clockLeft, book: null }];
    const whale = { id: 'w|c|0', whale: 'bigfish', cat: 'NFL', title: 'Giants vs. Cowboys', outcome: 'Giants', added: 60000, paid: 0.6, stake: 60000, cur: 0.62, last: 5 };
    try {
      await run(g('upcoming', 0.45, 0.46, null, null, null));           // Giants 45.5¢ before kick-off: the underdog in a close game
      await run(g('live', 0.57, 0.58, 7, 3, 600));
      await run(g('live', 0.63, 0.64, 14, 3, 540), [whale]);            // crosses 62¢
      const open = db.prepare("SELECT * FROM signals WHERE setup = 'nfl_dog_lead'").all(); assert.strictEqual(open.length, 1); assert.strictEqual(open[0].status, 'open'); assert.strictEqual(open[0].entry, 0.64); assert.strictEqual(open[0].side, 'a');
      assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM signals WHERE setup = 'whale_add' AND status = 'open'").get().n, 1, 'the whale add is tracked too');
      const note = JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'notes'").get().v).find((n) => n.kind === 'signal'); assert.ok(note && /Giants 64¢/.test(note.title), 'the phone is told about the setup');
      await run(g('live', 0.66, 0.67, 14, 3, 480), [Object.assign({}, whale, { cur: 0.66 })]);
      assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM signals WHERE setup = 'nfl_dog_lead'").get().n, 1, 'one trade per game, not one per minute');
      await run(g('live', 0.81, 0.82, 21, 3, 300), [Object.assign({}, whale, { cur: 0.8 })]);
      const done = db.prepare("SELECT * FROM signals WHERE setup = 'nfl_dog_lead'").get(); assert.strictEqual(done.status, 'target'); assert.strictEqual(done.exit, 0.8); assert.strictEqual(done.net, 14.1); assert.strictEqual(done.hi, 0.81);
      assert.strictEqual(JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'last'").get().v).brainError, undefined);
      const res = await (await worker.fetch(new Request('https://logger.test/signals'), env)).json(); const row = res.summary.find((x) => x.setup === 'nfl_dog_lead');
      assert.deepStrictEqual([row.n, row.won, row.avg, row.open], [1, 1, 14.1, 0]); assert.strictEqual(res.signals.filter((x) => x.setup === 'nfl_dog_lead').length, 1); assert.strictEqual(res.tracked.length, 1); assert.ok(res.signals.every((x) => x.status !== 'open' || x.setup === 'score_follow'));
    } finally { global.fetch = realFetch; Date.now = realNow; }
  });

  await check('engine: on a UFC card the next favourite is bought when the bout before it ends, and settled from Kalshi', async () => {
    let sqlite; try { sqlite = require('node:sqlite'); } catch (e) { return; }
    const db = new sqlite.DatabaseSync(':memory:');
    const st = (sql, args) => ({ bind: (...a) => st(sql, a), first: async () => db.prepare(sql).get(...args) || null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => db.prepare(sql).run(...args), go: () => db.prepare(sql).run(...args) });
    const env = { APP_URL: 'https://app.test', DB: { prepare: (sql) => st(sql, []), batch: async (list) => list.map((x) => x.go()) } };
    const worker = (await import(path.join(root, 'worker/src/index.js') + '?ufc')).default;
    let feed = {}; let result = null; const realFetch = global.fetch; const realNow = Date.now; let clock = 1794700000000;
    global.fetch = async (u) => { if (String(u).indexOf('kalshi.com') >= 0) return { ok: true, status: 200, json: async () => ({ market: { result } }) }; const k = Object.keys(feed).find((x) => String(u).indexOf(x) >= 0); return { ok: true, status: 200, json: async () => (k ? feed[k] : {}) }; };
    Date.now = () => clock;
    const F = (code, an, bn, ab, start) => ({ lg: 'ufc', card: '26NOV14', event: 'KXUFCFIGHT-26NOV14' + code, state: 'upcoming', start, a: code.slice(0, 3), b: code.slice(3), an, bn, at: 'T-' + code.slice(0, 3), bt: 'T-' + code.slice(3), ab, aa: ab + 0.01, bb: Math.round((0.99 - ab) * 100) / 100, ba: Math.round((1 - ab) * 100) / 100, sa: null, sb: null, period: null, clock: null, book: null });
    const run = async (games) => { feed = { '/api/sports': { games, inj: [], teams: [], feeds: {} }, '/api/alerts': { alerts: [] }, '/api/scan': { matches: [] } }; let p; await worker.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p; clock += 60000; };
    const one = F('MILMCK', 'Jim Miller', 'Terrance McKinney', 0.32, 1000); const two = F('GANHOK', 'Ciryl Gane', 'Josh Hokit', 0.66, 2000); const n = () => db.prepare("SELECT COUNT(*) n FROM signals WHERE setup = 'ufc_fav'").get().n;
    try {
      await run([one, two]); await run([one, two]); assert.strictEqual(n(), 0, 'nothing is bought while the card just sits there');
      await run([two]);                                                 // the first bout's market closed: Gane v Hokit is next
      const s = db.prepare("SELECT * FROM signals WHERE setup = 'ufc_fav'").get(); assert.strictEqual(s.name, 'Ciryl Gane'); assert.strictEqual(s.entry, 0.67); assert.strictEqual(s.status, 'open');
      await run([two]); assert.strictEqual(n(), 1, 'bought once');
      result = 'no'; await run([]);                                     // its market is gone too: Kalshi says the favourite lost
      const d = db.prepare("SELECT * FROM signals WHERE setup = 'ufc_fav'").get(); assert.strictEqual(d.status, 'settled'); assert.strictEqual(d.exit, 0); assert.ok(d.net < -67);
      const res = await (await worker.fetch(new Request('https://logger.test/signals'), env)).json(); assert.strictEqual(res.ufc.fights, 1); assert.strictEqual(res.ufc.won, 0); assert.strictEqual(res.signals.length, 0, 'record keeping stays out of the trade list');
      assert.strictEqual(JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'last'").get().v).brainError, undefined);
    } finally { global.fetch = realFetch; Date.now = realNow; }
  });

  await check('engine: a whale add is priced on its own market after the wallet switches sides, and a timed exit is announced', async () => {
    let sqlite; try { sqlite = require('node:sqlite'); } catch (e) { return; }
    const db = new sqlite.DatabaseSync(':memory:');
    const st = (sql, args) => ({ bind: (...a) => st(sql, a), first: async () => db.prepare(sql).get(...args) || null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => db.prepare(sql).run(...args), go: () => db.prepare(sql).run(...args) });
    const env = { APP_URL: 'https://app.test', DB: { prepare: (sql) => st(sql, []), batch: async (list) => list.map((x) => x.go()) } };
    const worker = (await import(path.join(root, 'worker/src/index.js') + '?pins')).default;
    let feed = {}; let prices = ['0.60', '0.40']; const realFetch = global.fetch; const realNow = Date.now; let clock = 1794800000000;
    global.fetch = async (u) => { u = String(u);
      if (u.indexOf('gamma-api') >= 0) return { ok: true, status: 200, json: async () => [{ conditionId: '0xc0', outcomes: '["Gen.G", "Bilibili Gaming"]', outcomePrices: JSON.stringify(prices) }] };
      if (u.indexOf('kalshi.com') >= 0) return { ok: true, status: 200, json: async () => ({ market: { result: '' } }) };
      const k = Object.keys(feed).find((x) => u.indexOf(x) >= 0); return { ok: true, status: 200, json: async () => (k ? feed[k] : {}) }; };
    Date.now = () => clock;
    const run = async (games, alerts, mins) => { feed = { '/api/sports': { games: games || [], inj: [], teams: [], feeds: {} }, '/api/alerts': { alerts: alerts || [] }, '/api/scan': { matches: [] } }; let p; await worker.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p; clock += (mins || 1) * 60000; };
    const add = (outcome, cur, last) => ({ id: '0xw|lol-final', grouped: true, whale: 'flipper', w: '0xw', cat: 'Esports', title: 'Final', cond: '0xc0', outcome, other: 'x', added: 60000, paid: cur, stake: 60000, cur, last, lean: 'for', net: { for: 100000, against: 0 } });
    const nbaG = (sa, sb, aa) => [{ lg: 'nba', event: 'KXNBAGAME-26NOV15SASMEM', state: sa === null ? 'upcoming' : 'live', a: 'SAS', b: 'MEM', an: 'Spurs', bn: 'Grizzlies', at: 'T-SAS', bt: 'T-MEM', ab: aa - 0.01, aa, bb: Math.round((0.99 - aa) * 100) / 100, ba: Math.round((1.01 - aa) * 100) / 100, sa, sb, period: sa === null ? null : 2, clock: 600, book: null }];
    try {
      await run(nbaG(null, null, 0.71));                                // start-up minute: nothing is alerted
      await run(nbaG(null, null, 0.71), [add('Gen.G', 0.6, 10)]);       // the whale buys Gen.G at 60¢
      const w0 = db.prepare("SELECT * FROM signals WHERE setup = 'whale_add'").get(); assert.strictEqual(w0.side, 'Gen.G'); assert.strictEqual(JSON.parse(w0.ctx).cond, '0xc0');
      prices = ['0.45', '0.55'];                                        // Gen.G falls to 45¢, and the wallet's card now leads with Bilibili at 55¢
      await run(nbaG(30, 38, 0.30), [add('Bilibili Gaming', 0.55, 20)], 61); // also: a Spurs recovery trade opens here
      const rec = db.prepare("SELECT * FROM signals WHERE setup = 'nba_recovery'").get(); assert.ok(rec && rec.status === 'open', 'the NBA recovery trade is open');
      await run(nbaG(32, 40, 0.31), [add('Bilibili Gaming', 0.55, 20)]);    // an hour on: the whale add and the NBA trade both reach their deadline
      const w1 = db.prepare("SELECT * FROM signals WHERE id = ?").get(w0.id); assert.strictEqual(w1.status, 'deadline'); assert.strictEqual(w1.exit, 0.45, 'valued on Gen.G, the side it was opened on'); assert.strictEqual(w1.net, -15);
      const r1 = db.prepare("SELECT * FROM signals WHERE setup = 'nba_recovery'").get(); assert.strictEqual(r1.status, 'deadline');
      const notes = JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'notes'").get().v); const out = notes.find((n) => n.id === 'x-' + r1.id); assert.ok(out && /time is up/.test(out.title), 'the timed exit reaches the phone');
      assert.strictEqual(JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'last'").get().v).brainError, undefined);
    } finally { global.fetch = realFetch; Date.now = realNow; }
  });

  await check('logger: a whale topping up the same position is announced once, then again only when it has grown a lot', async () => {
    let sqlite; try { sqlite = require('node:sqlite'); } catch (e) { return; }
    const db = new sqlite.DatabaseSync(':memory:');
    const st = (sql, args) => ({ bind: (...a) => st(sql, a), first: async () => db.prepare(sql).get(...args) || null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => db.prepare(sql).run(...args), go: () => db.prepare(sql).run(...args) });
    const env = { APP_URL: 'https://app.test', DB: { prepare: (sql) => st(sql, []), batch: async (list) => list.map((x) => x.go()) } };
    const worker = (await import(path.join(root, 'worker/src/index.js') + '?repeat')).default;
    let feed = {}; const realFetch = global.fetch; const realNow = Date.now; let clock = 1794900000000;
    global.fetch = async (u) => { u = String(u); if (u.indexOf('gamma-api') >= 0) return { ok: true, status: 200, json: async () => [] }; const k = Object.keys(feed).find((x) => u.indexOf(x) >= 0); return { ok: true, status: 200, json: async () => (k ? feed[k] : {}) }; };
    Date.now = () => clock;
    const run = async (alerts) => { feed = { '/api/sports': { games: [], inj: [], teams: [], feeds: {} }, '/api/alerts': { alerts }, '/api/scan': { matches: [] } }; let p; await worker.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p; clock += 60000; };
    const A = (stake, last) => ({ id: '0xbtb|nfl-min-gb', grouped: true, whale: 'BreakTheBank', w: '0xbtb', cat: 'NFL', title: 'Vikings vs. Packers', cond: '0xc1', outcome: 'Vikings', other: 'Packers', added: stake, paid: 0.43, stake, cur: 0.43, last, lean: 'for', net: { for: stake * 2, against: 0 } });
    const sentNotes = () => JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'notes'").get().v).filter((n) => n.kind === 'whale').length;
    try {
      await run([]); await run([A(112000, 100)]); assert.strictEqual(sentNotes(), 1, 'the first buy is announced');
      for (let i = 1; i <= 10; i++) await run([A(112000 + i * 2000, 100 + i)]);   // ten small top-ups, each with a newer timestamp
      assert.strictEqual(sentNotes(), 1, 'ten top-ups of $2k each: nothing more is sent'); assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM signals WHERE setup = 'whale_add'").get().n, 1, 'and they are one tracked add, not eleven');
      await run([A(175000, 200)]); assert.strictEqual(sentNotes(), 2, 'up by more than a quarter and $25k: announced again');
      await run([A(180000, 201)]); assert.strictEqual(sentNotes(), 2);
      const plog = JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'pushlog'").get().v); assert.strictEqual(plog.length, 2, 'each send is logged'); assert.strictEqual(plog[0].told, 1); assert.ok(/BreakTheBank/.test(plog[0].titles[0])); assert.strictEqual(plog[0].phones, 0);
      // a wallet flagged as a market maker: recorded and tracked, with the label saved, but the phone stays quiet, for buys and for sales
      const mm = { is: true, kind: 'maker', why: ['x'] };
      await run([Object.assign(A(300000, 300), { id: '0xmm|nfl-kc-den', whale: 'RN1', w: '0xmm', maker: mm })]); assert.strictEqual(sentNotes(), 2, 'a market maker buying is not sent');
      const tracked = db.prepare("SELECT ctx FROM signals WHERE setup = 'whale_add' AND name = 'RN1'").get(); assert.ok(tracked, 'it is still tracked'); assert.strictEqual(JSON.parse(tracked.ctx).mm, 'maker'); assert.strictEqual(JSON.parse(tracked.ctx).usd, 300000);
      await run([{ id: 'sell|0xmm|c|0', sell: true, kind: 'exit', whale: 'RN1', w: '0xmm', cat: 'NFL', title: 'Chiefs vs. Broncos', outcome: 'Chiefs', sold: 90000, price: 0.6, left: 0, last: 400, added: 0, maker: mm }]); assert.strictEqual(sentNotes(), 2, 'nor is a market maker selling');
      await run([{ id: 'sell|0xbtb|c|0', sell: true, kind: 'exit', whale: 'BreakTheBank', w: '0xbtb', cat: 'NFL', title: 'Chiefs vs. Broncos', outcome: 'Chiefs', sold: 90000, price: 0.6, left: 0, last: 401, added: 0, maker: { is: false, why: [] } }]); assert.strictEqual(sentNotes(), 3, 'a sale by a wallet that is not flagged still is');
    } finally { global.fetch = realFetch; Date.now = realNow; }
  });

  // the logger, with its database and the push services faked
  await check('logger: tests and price alerts reach one signed-up phone only, and sign-ups must be real push addresses', async () => {
    const mod = await import(path.join(root, 'worker/src/index.js')); const worker = mod.default;
    const kv = new Map(); const subs = new Map(); const rules = new Map(); const sent = []; let quote = { bid: '0.6000', ask: '0.6200', status: 'active' };
    const stmt = (sql, args) => ({
      bind: (...a) => stmt(sql, a),
      first: async () => {
        if (/FROM kv WHERE k/.test(sql)) return kv.has(args[0]) ? { v: kv.get(args[0]) } : null;
        if (/SELECT 1 x FROM subs/.test(sql)) return subs.has(args[0]) ? { x: 1 } : null;
        if (/SELECT tested FROM subs/.test(sql)) return subs.has(args[0]) ? { tested: subs.get(args[0]).tested || null } : null;
        if (/COUNT\(\*\) n FROM subs/.test(sql)) return { n: subs.size };
        if (/COUNT\(\*\) n FROM rules/.test(sql)) return { n: [...rules.values()].filter((r) => r.endpoint === args[0] && r.fired === null).length };
        return { n: 0, t: null };
      },
      run: async () => {
        if (/INSERT INTO kv/.test(sql)) kv.set(args[0], args[1]);
        else if (/INSERT INTO subs/.test(sql)) subs.set(args[0], subs.get(args[0]) || {});
        else if (/UPDATE subs SET tested/.test(sql)) subs.get(args[1]).tested = args[0];
        else if (/DELETE FROM subs/.test(sql)) subs.delete(args[0]);
        else if (/INSERT INTO rules/.test(sql)) rules.set(args[0], { id: args[0], endpoint: args[1], ticker: args[2], title: args[3], op: args[4], price: args[5], url: args[6], created: args[7], fired: null });
        else if (/UPDATE rules SET fired/.test(sql)) rules.get(args[1]).fired = args[0];
        else if (/DELETE FROM rules/.test(sql)) rules.delete(args[0]);
        return {};
      },
      all: async () => ({ results: /SELECT endpoint FROM subs/.test(sql) ? [...subs.keys()].map((endpoint) => ({ endpoint })) : /FROM rules WHERE fired IS NULL/.test(sql) ? [...rules.values()].filter((r) => r.fired === null) : /FROM rules WHERE endpoint/.test(sql) ? [...rules.values()].filter((r) => r.endpoint === args[0]) : [] }),
    });
    const env = { APP_URL: 'https://app.example', DB: { prepare: (sql) => stmt(sql, []), batch: async () => [] } };
    const realFetch = global.fetch; global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('kalshi.com')) return { status: 200, ok: true, json: async () => ({ markets: [{ ticker: 'KXNBAGAME-26NOV13NYKIND-NYK', yes_bid_dollars: quote.bid, yes_ask_dollars: quote.ask, status: quote.status }] }) };
      if (u.startsWith('https://app.example')) return { status: 200, ok: true, json: async () => ({}) };
      sent.push(u); return { status: 201, ok: true, json: async () => ({}) };
    };
    const post = async (p, body) => { const r = await worker.fetch(new Request('https://logger.example' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env); return { status: r.status, body: await r.json() }; };
    try {
      const phone = 'https://web.push.apple.com/QAbc123'; const other = 'https://web.push.apple.com/QOther456';
      assert.strictEqual((await post('/subscribe', { endpoint: 'https://attacker.example/hook' })).status, 400, 'an arbitrary address is refused');
      assert.strictEqual((await post('/subscribe', { endpoint: 'http://web.push.apple.com/x' })).status, 400, 'plain http is refused');
      assert.strictEqual(subs.size, 0);
      assert.strictEqual((await post('/subscribe', { endpoint: phone })).status, 200); assert.strictEqual((await post('/subscribe', { endpoint: other })).status, 200);
      assert.strictEqual((await post('/test', {})).status, 403, 'a test with no phone named is refused');
      assert.strictEqual((await post('/test', { endpoint: 'https://web.push.apple.com/Unknown' })).status, 403, 'a test for a phone that never signed up is refused');
      assert.strictEqual(sent.length, 0, 'nothing was sent by the refused requests');
      const ok = await post('/test', { endpoint: phone }); assert.strictEqual(ok.status, 200); assert.deepStrictEqual(sent, [phone], 'only the phone that asked was pushed');
      assert.strictEqual((await post('/test', { endpoint: phone })).status, 429, 'a second test straight away is refused');
      const mine = await post('/latest', { endpoint: phone }); const theirs = await post('/latest', { endpoint: other });
      assert.strictEqual(mine.body.notes.filter((n) => n.kind === 'test').length, 1, 'the asking phone sees its test note'); assert.strictEqual(theirs.body.notes.length, 0, 'another phone does not');
      // price alerts: only a signed-up phone can set one, it fires once when the bid gets there, and only that phone hears
      const rule = { id: 'r1', ticker: 'KXNBAGAME-26NOV13NYKIND-NYK', title: 'Knicks bid reaches 80¢', op: 'bid>=', price: 0.8, url: '/#m=KXNBAGAME-26NOV13NYKIND' };
      assert.strictEqual((await post('/rules', Object.assign({ endpoint: 'https://web.push.apple.com/Unknown' }, rule))).status, 403, 'a phone that is not signed up cannot set an alert');
      assert.strictEqual((await post('/rules', Object.assign({ endpoint: phone }, rule, { ticker: 'not a ticker' }))).status, 400);
      assert.strictEqual((await post('/rules', Object.assign({ endpoint: phone }, rule))).status, 200);
      const run = async () => { const jobs = []; await worker.scheduled({}, env, { waitUntil: (x) => jobs.push(x) }); await Promise.all(jobs); };
      sent.length = 0; await run(); assert.strictEqual(sent.length, 0, 'bid at 60¢: nothing sent');
      quote = { bid: '0.8100', ask: '0.8300', status: 'active' }; await run(); assert.deepStrictEqual(sent, [phone], 'bid at 81¢: this phone is told, and only this phone');
      await run(); assert.strictEqual(sent.length, 1, 'it does not fire twice');
      const list = await post('/rules/list', { endpoint: phone }); assert.strictEqual(list.body.rules.length, 1); assert.strictEqual(list.body.rules[0].id, 'r1'); assert.ok(list.body.rules[0].fired > 0);
      assert.strictEqual((await post('/rules/list', { endpoint: other })).body.rules.length, 0, 'another phone cannot see it');
      const note = (await post('/latest', { endpoint: phone })).body.notes.find((n) => n.kind === 'price'); assert.ok(note && /81¢ bid/.test(note.body), 'the alert text carries the price');
      // a stop: fires when the sell price falls to the level, never on an empty book
      assert.strictEqual((await post('/rules', Object.assign({ endpoint: phone }, rule, { id: 'r2', op: 'bid<=', price: 0.5, title: 'Knicks sell price falls to 50¢' }))).status, 200, 'a stop alert is accepted');
      assert.strictEqual((await post('/rules', Object.assign({ endpoint: phone }, rule, { id: 'r3', op: 'bid==' }))).status, 400, 'an unknown direction is refused');
      sent.length = 0; await run(); assert.strictEqual(sent.length, 0, 'bid at 81¢: the stop stays quiet');
      quote = { bid: '0.0000', ask: '1.0000', status: 'active' }; await run(); assert.strictEqual(sent.length, 0, 'an empty book is not a fall to the stop');
      quote = { bid: '0.4800', ask: '0.5000', status: 'active' }; await run(); assert.deepStrictEqual(sent, [phone], 'bid at 48¢: the stop fires once, to this phone');
    } finally { global.fetch = realFetch; }
  });

  console.log(results.join('\n')); console.log(process.exitCode ? '\nSome checks failed.' : '\nAll checks passed.');
})();
