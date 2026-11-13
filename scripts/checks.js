// Checks for behaviour that has gone wrong before. No network: every outside call is faked.
// Run with: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const results = [];
const check = async (name, fn) => { try { await fn(); results.push('ok    ' + name); } catch (e) { results.push('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n')[0]); process.exitCode = 1; } };
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
    let positions = [];
    global.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/activity') ? { data: [buy], pagination: { has_more: false } } : { data: positions }) });
    try {
      delete require.cache[require.resolve('../lib/alerts')]; const { check: scanOne } = require('../lib/alerts');
      const w = { w: '0xwhale', name: 'Whale', cats: [{ k: 'NBA', grade: 'strong', net: 100000, n: 50, roi: 0.05 }] }; const o = { minutes: 180, minStake: 50000, minAdd: 10000, maxPages: 2 };
      positions = []; assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'no open position, so no alert');
      positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 20000, total_size: 100000, avg_price: 0.6, current_price: 0.62, first_entry_at: now - 600 }];
      assert.strictEqual((await scanOne(w, now - 10800, o)).alerts.length, 0, 'most of it sold: $12k left is under the $50k bar');
      positions = [{ status: 'OPEN', outcome_index: 0, outcome: 'A', current_size: 100000, total_size: 100000, avg_price: 0.6, current_price: 0.62, first_entry_at: now - 600 }];
      const a = (await scanOne(w, now - 10800, o)).alerts; assert.strictEqual(a.length, 1); assert.strictEqual(a[0].stake, 60000);
    } finally { global.fetch = realFetch; }
  });

  // the cost box in the page
  await check('cost box: a resting order never reaches the ask', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'); const src = (/function restPrice\(p\) \{.*\}/.exec(html) || [])[0];
    assert.ok(src, 'restPrice not found'); const restPrice = new Function('has', src + '; return restPrice;')((x) => x !== null && x !== undefined);
    assert.strictEqual(restPrice({ bid: 0.49, ask: 0.50 }), 0.49); assert.strictEqual(restPrice({ bid: 0.45, ask: 0.50 }), 0.46); assert.strictEqual(restPrice({ bid: null, ask: 0.5 }), null);
  });

  // the logger, with its database and the push services faked
  await check('logger: tests reach one signed-up phone only, and sign-ups must be real push addresses', async () => {
    const mod = await import(path.join(root, 'worker/src/index.js')); const worker = mod.default;
    const kv = new Map(); const subs = new Map(); const sent = [];
    const stmt = (sql, args) => ({
      bind: (...a) => stmt(sql, a),
      first: async () => {
        if (/FROM kv WHERE k/.test(sql)) return kv.has(args[0]) ? { v: kv.get(args[0]) } : null;
        if (/SELECT 1 x FROM subs/.test(sql)) return subs.has(args[0]) ? { x: 1 } : null;
        if (/SELECT tested FROM subs/.test(sql)) return subs.has(args[0]) ? { tested: subs.get(args[0]).tested || null } : null;
        if (/COUNT\(\*\) n FROM subs/.test(sql)) return { n: subs.size };
        return { n: 0, t: null };
      },
      run: async () => {
        if (/INSERT INTO kv/.test(sql)) kv.set(args[0], args[1]);
        else if (/INSERT INTO subs/.test(sql)) subs.set(args[0], subs.get(args[0]) || {});
        else if (/UPDATE subs SET tested/.test(sql)) subs.get(args[1]).tested = args[0];
        else if (/DELETE FROM subs/.test(sql)) subs.delete(args[0]);
        return {};
      },
      all: async () => ({ results: /SELECT endpoint FROM subs/.test(sql) ? [...subs.keys()].map((endpoint) => ({ endpoint })) : [] }),
    });
    const env = { APP_URL: 'https://app.example', DB: { prepare: (sql) => stmt(sql, []), batch: async () => [] } };
    const realFetch = global.fetch; global.fetch = async (url) => { sent.push(String(url)); return { status: 201, ok: true, json: async () => ({}) }; };
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
    } finally { global.fetch = realFetch; }
  });

  console.log(results.join('\n')); console.log(process.exitCode ? '\nSome checks failed.' : '\nAll checks passed.');
})();
