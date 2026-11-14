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
    const html = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8'); const src = (/function restPrice\(p\) \{.*\}/.exec(html) || [])[0];
    assert.ok(src, 'restPrice not found'); const restPrice = new Function('has', src + '; return restPrice;')((x) => x !== null && x !== undefined);
    assert.strictEqual(restPrice({ bid: 0.49, ask: 0.50 }), 0.49); assert.strictEqual(restPrice({ bid: 0.45, ask: 0.50 }), 0.46); assert.strictEqual(restPrice({ bid: null, ask: 0.5 }), null);
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
    const sig = { setup: 'nba_recovery', t: now, entry: 0.44, target: 0.56, deadline: now + 2400, ctx: { maxBehind: 20 } };
    assert.deepStrictEqual(B.manage(sig, { bid: 0.5, ask: 0.51, behind: 8 }, now + 60), { last: 0.5, hi: 0.5, lo: 0.5 });
    const hit = B.manage(sig, { bid: 0.57, ask: 0.58, behind: 2 }, now + 600); assert.strictEqual(hit.status, 'target'); assert.strictEqual(hit.exit, 0.56); assert.strictEqual(hit.net, 9.8); // 12¢ less 1.7¢ to get in and 0.4¢ to get out
    assert.strictEqual(B.manage(sig, { bid: 0.3, ask: 0.31, behind: 21 }, now + 600).status, 'invalid'); assert.strictEqual(B.manage(sig, { bid: 0.4, ask: 0.41, behind: 9 }, now + 2400).status, 'deadline');
    const lost = B.manage(sig, { bid: 0, ask: 0.02, behind: 30, state: 'live' }, now + 900); assert.strictEqual(lost.status, 'settled'); assert.strictEqual(lost.exit, 0); assert.ok(lost.net < -44);
    assert.deepStrictEqual(B.manage(sig, null, now + 300), {}, 'a missing quote is waited out'); assert.strictEqual(B.manage(Object.assign({ last: 0.95 }, sig), null, now + 3100).status, 'settled');
    const tn = { event: 'T', state: 'set2', live: { a: 0.74 }, pm: { sets: [[6, 3], [1, 0]] }, a: { name: 'A One', ask: 0.63, bid: 0.62 }, b: { name: 'B Two', ask: 0.38, bid: 0.37 } };
    const ts = B.tennisSignals(tn, now); assert.strictEqual(ts.length, 1); assert.strictEqual(ts[0].side, 'a'); assert.strictEqual(ts[0].target, 0.73); assert.strictEqual(B.tennisSignals(Object.assign({}, tn, { state: 'set1' }), now).length, 0);
    const grades = B.whaleGrades([{ setup: 'whale_add', lg: 'NBA', name: 'w1', status: 'deadline', net: 6 }, { setup: 'whale_add', lg: 'NBA', name: 'w2', status: 'deadline', net: -2 }]);
    assert.strictEqual(grades[0].whale, 'w1'); assert.ok(grades[0].grade < 6 && grades[0].grade > 2, 'one good add is pulled toward the category average');
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
