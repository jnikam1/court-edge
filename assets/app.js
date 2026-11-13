(function () {
  var LIST_MS = 15000, DETAIL_MS = 10000, WHALE_MS = 120000;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  var add = function (p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; };
  var has = function (x) { return x !== null && x !== undefined; };
  var cents = function (x) { return has(x) ? Math.round(x * 100) + '¢' : '–'; };
  var c1 = function (x) { return (x * 100).toFixed(1) + '¢'; };
  var pct = function (x) { return has(x) ? (x * 100).toFixed(1) + '%' : '–'; };
  // A player is called by last name; a team keeps its whole name (New York, Trail Blazers).
  var TEAMS = {}; try { TEAMS = JSON.parse(localStorage.getItem('ce-teams') || '{}') || {}; } catch (e) { TEAMS = {}; }
  var last = function (n) { if (TEAMS[n]) return n; var p = String(n || '').trim().split(' '); return p[p.length - 1] || n; };
  function noteTeams(d) { var n = 0; var see = function (g) { ['a', 'b'].forEach(function (k) { if (g && g[k] && g[k].name && !TEAMS[g[k].name]) { TEAMS[g[k].name] = 1; n++; } }); }; (d.games || []).forEach(see); if (d.kind === 'game') see(d); if (n) { try { localStorage.setItem('ce-teams', JSON.stringify(TEAMS)); } catch (e) {} } }
  var mins = function (s) { return !has(s) ? '' : s < 90 ? s + 's ago' : Math.round(s / 60) + ' min ago'; };
  var usd = function (x) { return !has(x) ? '–' : Math.abs(x) >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : Math.abs(x) >= 1000 ? '$' + (x / 1000).toFixed(Math.abs(x) >= 1e4 ? 0 : 1) + 'k' : '$' + Math.round(x); };
  var signed = function (x) { return (x < 0 ? '−' : '+') + usd(Math.abs(x)); };
  var clock = function (t) { return new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  var day = function (t) { return new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  var lastOk = Date.now(); // last time any data request succeeded
  var get = function (url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { if (d && d.error) throw new Error(d.error); lastOk = Date.now(); if (url.indexOf('/api/sports') === 0) noteTeams(d); return d; }); };

  // ---------- list ----------
  function stateText(m) {
    var w1 = m.set1 && m.set1.winner ? last(m[m.set1.winner].name) : null;
    if (m.state === 'set2') return (m.inWindow ? 'Set break · ' : 'Set 2 · ') + 'set 1 to ' + w1 + (has(m.since) ? ' · ' + mins(m.since) : '');
    if (m.state === 'decider') return 'Deciding set';
    if (m.state === 'closing') return 'Finished · settling';
    if (m.state === 'set1') return 'Set 1 in play';
    if (m.pm && m.pm.start) return 'Starts ' + day(Date.parse(m.pm.start) / 1000) + ' ' + clock(Date.parse(m.pm.start) / 1000);
    return 'Not started';
  }
  function setCells(sets, i, live) {
    var box = el('span', 'sets'); if (!sets) return box;
    sets.forEach(function (s, n) {
      var cur = live && n === sets.length - 1; var won = !cur && s[i] > s[1 - i];
      box.appendChild(el('b', cur ? 'cur' : won ? 'w' : '', String(s[i])));
    });
    return box;
  }
  // ---------- live point feed: point score and who is serving ----------
  var feed = { data: null, timer: null };
  var lastKey = function (n) { var t = String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' '); return t[t.length - 1] || ''; };
  function feedFor(m, sets) {
    var F = feed.data; if (!F || F.off || !F.matches || !m || !m.a) return null;
    var la = lastKey(m.a.name), lb = lastKey(m.b.name), x = null, flip = false;
    F.matches.forEach(function (q) { if (q.k1 === la && q.k2 === lb) { x = q; flip = false; } else if (q.k1 === lb && q.k2 === la) { x = q; flip = true; } });
    if (!x) return null;
    var ga = flip ? x.games[1] : x.games[0], gb = flip ? x.games[0] : x.games[1];
    // only trust the feed when its game score matches the one on screen
    var ok = true; if (sets && sets.length) { var n = sets.length - 1; ok = ga.length === sets.length && ga[n] === sets[n][0] && gb[n] === sets[n][1]; }
    return { ok: ok, points: ok && x.points && x.points.length === 2 ? (flip ? [x.points[1], x.points[0]] : x.points) : null, server: ok && x.server ? ((x.server === 1) !== flip ? 'a' : 'b') : null };
  }
  function loadFeed() {
    get('/api/feed').then(function (f) {
      feed.data = f; if (f.off) return;
      clearTimeout(feed.timer); feed.timer = setTimeout(function () { if (!document.hidden) loadFeed(); else feed.timer = null; }, Math.max(10, f.ttl || 900) * 1000);
      if (cur.event && cur.d) renderDetail(cur.d);
    }).catch(function () {});
  }
  function playersGrid(m, sets, live) {
    var g = el('div', 'players'); var f = live ? feedFor(m, sets) : null;
    add(g, el('span', 'colhead', ''), el('span', 'colhead', ''), el('span', 'colhead', 'Sell'), el('span', 'colhead', 'Buy'));
    ['a', 'b'].forEach(function (k, i) {
      var p = m[k]; var name = el('span', 'name');
      if (f && f.server === k) { var dot = el('i', 'srv'); dot.title = 'Serving'; name.appendChild(dot); }
      name.appendChild(document.createTextNode(p.name));
      if (m.set1 && m.set1.winner === k && !sets) add(name, document.createTextNode(' '), el('small', '', 'won set 1'));
      var cells = setCells(sets, i, live); if (f && f.points) cells.appendChild(el('b', 'pt', f.points[i]));
      add(g, name, cells, el('span', 'num', cents(p.bid)), el('span', 'num', cents(p.ask)));
    });
    return g;
  }
  // ---------- icons, saved matches, price alerts ----------
  var ICONS = {
    discover: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>', watch: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
    positions: '<path d="M3 20h18M6 20v-7M11 20V6M16 20v-10M21 20v-4"/>', whale: '<path d="M3 17l5-6 4 3 6-8 3 3"/><path d="M15 6h4v4"/>', out: '<path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"/>', alerts: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>'
  };
  function icon(name, filled) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ic' + (filled ? ' on' : '')); s.innerHTML = ICONS[name]; return s; }
  var store = function (k, def) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null || typeof v !== typeof def ? def : v; } catch (e) { return def; } };
  var keep = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  var nowS = function () { return Math.floor(Date.now() / 1000); };
  var titleOf = function (m) { return m.a.name + ' v ' + m.b.name; };

  var W = store('ce-watch', {});                       // saved matches: event -> { t, title }
  var R = store('ce-rules', []); if (!Array.isArray(R)) R = [];   // price alerts
  var mine = 0;                                        // price alerts that fired and have not been looked at
  function toggleWatch(ev, title) { if (W[ev]) delete W[ev]; else W[ev] = { t: nowS(), title: title }; keep('ce-watch', W); }
  var openRules = function (ev) { return R.filter(function (r) { return !r.fired && !r.paused && (!ev || r.event === ev); }); };
  var OPS = { 'bid>=': ' sell price reaches ', 'ask<=': ' buy price drops to ', 'bid<=': ' sell price falls to ' };
  var ruleText = function (r) { return r.name + (OPS[r.op] || ' reaches ') + cents(r.price); };
  var ruleHit = function (r, s) { return r.op === 'bid>=' ? has(s.bid) && s.bid >= r.price - 1e-9 : r.op === 'bid<=' ? has(s.bid) && has(s.ask) && s.bid <= r.price + 1e-9 : has(s.ask) && s.ask > 0 && s.ask <= r.price + 1e-9; };
  var defTarget = function (p) { return p < 0.7 ? 0.8 : Math.min(0.99, Math.round((p + 0.1) * 100) / 100); }; // 80¢, or ten cents up when already past 70¢

  function say(title, body, go) { // the banner at the top of the screen
    var t = $('toast'); t.replaceChildren(); add(t, el('b', '', title), body ? el('span', '', body) : null); t.dataset.go = go || ''; t.hidden = false;
    clearTimeout(al.hide); al.hide = setTimeout(function () { t.hidden = true; }, go ? 15000 : 4000);
  }
  // This phone's push subscription, or null when phone alerts are off.
  function withSub(fn) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !pu.url) { fn(null); return; }
    navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(fn).catch(function () { fn(null); });
  }
  function sendRule(r) { withSub(function (sub) { if (!sub) return; lg('/rules', { endpoint: sub.endpoint, id: r.id, ticker: r.ticker, title: ruleText(r), op: r.op, price: r.price, url: '/#m=' + encodeURIComponent(r.event) }).then(function () { r.remote = true; keep('ce-rules', R); if (location.hash === '#alerts') renderRules(); }).catch(function () {}); }); }
  function addRuleRaw(o) {
    var r = { id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), event: o.event, ticker: o.ticker, side: o.side, name: o.name, title: o.title, op: o.op, price: o.price, created: nowS(), fired: null, remote: false };
    R.unshift(r); R = R.slice(0, 60); keep('ce-rules', R); sendRule(r); return r;
  }
  function addRule(m, side, op, price) { return addRuleRaw({ event: m.event, ticker: m[side].ticker, side: side, name: last(m[side].name), title: titleOf(m), op: op, price: price }); }
  function dropRule(id) {
    var r = R.filter(function (x) { return x.id === id; })[0]; R = R.filter(function (x) { return x.id !== id; }); keep('ce-rules', R);
    if (r && r.remote) withSub(function (sub) { if (sub) lg('/rules/delete', { endpoint: sub.endpoint, id: id }).catch(function () {}); });
  }
  // Current prices for a set of events, from the same lists the Discover tab uses.
  var Q = { t: 0, by: {}, at: {}, pm: {} };
  var feedOf = function (ev) { return leagueOf(ev) || 't'; };
  var detailUrl = function (ev) { var l = leagueOf(ev); return l ? '/api/sports?league=' + l + '&event=' + encodeURIComponent(ev) : '/api/match?event=' + encodeURIComponent(ev); };
  function quotes(events, pmEvents) {
    var need = { t: false, nba: false, nfl: false }; events.forEach(function (e) { need[feedOf(e)] = true; });
    var calls = [];
    if (need.t) calls.push(get('/api/scan').then(function (d) { (d.matches || []).forEach(function (m) { Q.by[m.event] = m; }); Q.at.t = Date.now(); }).catch(function () {}));
    ['nba', 'nfl'].forEach(function (l) { if (need[l]) calls.push(get('/api/sports?league=' + l).then(function (d) { (d.games || []).forEach(function (m) { Q.by[m.event] = m; }); Q.at[l] = Date.now(); }).catch(function () {})); });
    // Polymarket has no list feed here, so a position held there reads its quote from the matchup itself.
    (pmEvents || []).forEach(function (ev) { calls.push(get(detailUrl(ev)).then(function (d) { var pm = d.pm || d.polymarket; Q.pm[ev] = { bid: pm && pm.bid ? pm.bid : null, t: Date.now() }; }).catch(function () {})); });
    return Promise.all(calls).then(function () { Q.t = Date.now(); return Q.by; });
  }
  // While the app is open, check price alerts here too, so the banner shows without waiting for the logger's minute.
  function checkRules() {
    var open = openRules(); if (!open.length || document.hidden) return;
    quotes(open.map(function (r) { return r.event; })).then(function (by) {
      var hit = [];
      open.forEach(function (r) { var m = by[r.event]; var s = m && m[r.side]; if (!s) return; if (ruleHit(r, s)) { r.fired = nowS(); hit.push(r); } });
      if (!hit.length) return;
      keep('ce-rules', R); mine += hit.length; badge(); if (al.sound) beep();
      say(ruleText(hit[0]), hit[0].title + (hit.length > 1 ? ', and ' + (hit.length - 1) + ' more' : '') + '. Tap to open.', hit.length > 1 ? '#alerts' : '#m=' + encodeURIComponent(hit[0].event));
      if (location.hash === '#alerts') renderRules();
    });
  }
  // The logger may have fired an alert while the app was closed.
  function pullRules() {
    withSub(function (sub) {
      if (!sub) return;
      lg('/rules/list', { endpoint: sub.endpoint }).then(function (d) {
        var by = {}; (d.rules || []).forEach(function (x) { by[x.id] = x; }); var ch = false;
        R.forEach(function (r) { var x = by[r.id]; if (!x) { if (!r.fired && !r.remote) sendRule(r); return; } r.remote = true; if (x.fired && !r.fired) { r.fired = x.fired > 0 ? x.fired : nowS(); r.gone = x.fired < 0; ch = true; } });
        if (ch) { keep('ce-rules', R); renderRules(); }
      }).catch(function () {});
    });
  }
  function renderRules() {
    var box = $('rList'); box.replaceChildren(); var open = R.filter(function (r) { return !r.fired; }); var fired = R.filter(function (r) { return r.fired; }).slice(0, 12);
    if (!R.length) { box.appendChild(el('div', 'empty', 'No price alerts yet. Tap the bell on any match, pick a side and a price, and you are told when it gets there.')); return; }
    var one = function (r) {
      var c = el('div', 'card'); var top = el('div', 'top'); var a = el('a', 'lnk'); a.href = '#m=' + encodeURIComponent(r.event); a.appendChild(el('b', '', ruleText(r)));
      add(top, a, el('span', 'chip' + (r.fired ? (r.gone ? '' : ' good') : ''), r.fired ? (r.gone ? 'Market closed first' : 'Reached ' + ago(r.fired)) : r.paused ? 'Paused' : r.remote ? 'On: push to this device' : 'On: only while the app is open'));
      add(c, top, el('div', 'small', r.title + ' · set ' + ago(r.created)));
      var seg = el('div', 'seg'); var btn = function (label, fn) { var x = el('button', '', label); x.type = 'button'; x.addEventListener('click', fn); seg.appendChild(x); };
      if (!r.fired) {
        btn('Edit', function () { alertSheet(Q.by[r.event] || ruleStub(r), r); });
        btn(r.paused ? 'Resume' : 'Pause', function () {
          r.paused = !r.paused;
          if (r.paused && r.remote) { withSub(function (sub) { if (sub) lg('/rules/delete', { endpoint: sub.endpoint, id: r.id }).catch(function () {}); }); r.remote = false; }
          keep('ce-rules', R); if (!r.paused) sendRule(r); renderRules(); refreshMarks();
        });
      }
      btn('Delete', function () { dropRule(r.id); renderRules(); refreshMarks(); });
      if (r.fired && !r.gone) { var again = el('button', '', 'Set again'); again.type = 'button'; again.addEventListener('click', function () { r.fired = null; r.created = nowS(); r.remote = false; keep('ce-rules', R); sendRule(r); renderRules(); }); seg.appendChild(again); }
      c.appendChild(seg); return c;
    };
    open.forEach(function (r) { box.appendChild(one(r)); }); fired.forEach(function (r) { box.appendChild(one(r)); });
    if (open.some(function (r) { return !r.remote && !r.paused; })) box.appendChild(el('div', 'small', 'Alerts marked "only while the app is open" are checked on this device and show as a banner. Turn on phone alerts below and they are also pushed with the app closed.'));
    box.appendChild(el('div', 'small', 'Prices are checked about once a minute, so a price that touches your level for a few seconds can be missed.'));
  }
  // Bottom sheet: side, type, price, create. Opens with a sensible default so it is two taps.
  // A stand-in for a matchup that is no longer in the lists, so its alert can still be edited.
  function ruleStub(r) { var m = { event: r.event, a: { name: r.side === 'a' ? r.name : (r.title.split(' v ')[0] || 'Other side') }, b: { name: r.side === 'b' ? r.name : (r.title.split(' v ')[1] || 'Other side') } }; m[r.side].ticker = r.ticker; return m; }
  function alertSheet(m, edit) {
    var pos = J.filter(function (x) { return x.status === 'open' && x.event === m.event; })[0];
    var st = { side: 'a', op: 'bid>=', price: 0.8 };
    if (edit) { st.side = edit.side; st.op = edit.op; st.price = edit.price; }
    else if (pos) { st.side = pos.side; st.price = pos.target || defTarget(pos.price); }
    else {
      var a = has(m.a.bid) ? m.a.bid : 0, b = has(m.b.bid) ? m.b.bid : 0; var lead = a >= b ? 'a' : 'b'; var hi = Math.max(a, b);
      if (hi < 0.78) { st.side = lead; st.price = 0.8; }                                   // the usual case: the side in front, at 80¢
      else if (hi < 0.94) { st.side = lead; st.price = Math.min(0.97, Math.round((hi + 0.05) * 100) / 100); } // already past 80¢: a little higher
      else { st.side = lead; st.op = 'ask<='; st.price = Math.max(0.5, Math.round((hi - 0.1) * 100) / 100); }   // nearly over: only a pullback is worth an alert
    }
    var draw = function () {
      var box = sheetShell(edit ? 'Edit price alert' : 'Set a price alert', titleOf(m) + ' · Kalshi');
      var sides = el('div', 'seg'); ['a', 'b'].forEach(function (k) { if (!m[k].ticker) return; var x = el('button', '', last(m[k].name) + (has(m[k].bid) || has(m[k].ask) ? ' · sell ' + cents(m[k].bid) + ', buy ' + cents(m[k].ask) : '')); x.type = 'button'; x.setAttribute('aria-pressed', String(st.side === k)); x.addEventListener('click', function () { st.side = k; draw(); }); sides.appendChild(x); });
      var ops = el('div', 'seg'); [['bid>=', 'Sell price reaches'], ['bid<=', 'Sell price falls to'], ['ask<=', 'Buy price drops to']].forEach(function (o) { var x = el('button', '', o[1]); x.type = 'button'; x.setAttribute('aria-pressed', String(st.op === o[0])); x.addEventListener('click', function () { if (st.op !== o[0]) { st.op = o[0]; var s = m[st.side]; st.price = o[0] === 'ask<=' ? Math.max(0.03, Math.round(((has(s.ask) ? s.ask : 0.5) - 0.05) * 100) / 100) : o[0] === 'bid<=' ? Math.max(0.02, Math.round(((has(s.bid) ? s.bid : 0.5) - 0.15) * 100) / 100) : defTarget(has(s.bid) ? s.bid : 0.5); } draw(); }); ops.appendChild(x); });
      var step = el('div', 'step'); var bump = function (d) { var x = el('button', '', (d > 0 ? '+' : '−') + Math.abs(d)); x.type = 'button'; x.setAttribute('aria-label', (d > 0 ? 'Raise' : 'Lower') + ' by ' + Math.abs(d) + ' cents'); x.addEventListener('click', function () { st.price = Math.min(0.99, Math.max(0.01, Math.round((st.price + d / 100) * 100) / 100)); draw(); }); return x; };
      add(step, bump(-5), bump(-1), el('div', 'v', cents(st.price)), bump(1), bump(5));
      var go = el('button', 'go pri', edit ? 'Save changes' : 'Create alert'); go.type = 'button';
      go.addEventListener('click', function () { if (edit) dropRule(edit.id); var r = addRule(m, st.side, st.op, st.price); closeSheet(); say(edit ? 'Alert updated' : 'Alert set', ruleText(r) + '.'); refreshMarks(); if (location.hash === '#alerts') renderRules(); });
      var s = m[st.side]; var away = st.op === 'bid>=' ? (has(s.bid) ? st.price - s.bid : null) : st.op === 'bid<=' ? (has(s.bid) ? s.bid - st.price : null) : (has(s.ask) ? s.ask - st.price : null);
      add(box, sides, ops, step, el('div', 'small', (has(away) ? (away > 0 ? Math.round(away * 100) + '¢ away right now. ' : 'Already there, so this fires on the next check. ') : '') + (pu.on ? 'Pushed to this device even with the app closed. Kalshi prices are checked about once a minute.' : 'Phone alerts are off, so this is only checked while the app is open and shows as a banner. Turn them on in Alerts to get a push.')), go);
      var ex = openRules(m.event).filter(function (r) { return !edit || r.id !== edit.id; }); if (ex.length) { var rows = el('div', 'rows'); ex.forEach(function (r) { var row = el('div'); var rm = el('button', 'go', 'Remove'); rm.type = 'button'; rm.addEventListener('click', function () { dropRule(r.id); refreshMarks(); draw(); }); add(row, el('span', 'l', ruleText(r)), rm); rows.appendChild(row); }); add(box, el('div', 'sub', 'Already set'), rows); }
    };
    draw(); openSheetNow();
  }
  // Bottom sheet: record a trade in two taps.
  var VENUES = { kalshi: 'Kalshi', polymarket: 'Polymarket' };
  var venueOf = function (x) { return x.venue === 'polymarket' ? 'polymarket' : 'kalshi'; };
  var feeAt = function (venue, p, n) { return venue === 'kalshi' ? takerFee(p, n) : 0; }; // Polymarket fees are not modelled here
  function tradeSheet(d) {
    var pm = d.pm || d.polymarket || null; var pmOk = !!(pm && pm.slug && pm.price); // only offer a venue that lists this exact matchup
    var side = d.read && d.read.side ? d.read.side : cs.side || 'a'; var st = { venue: 'kalshi', side: side, price: null, qty: null, target: null, stop: null, alert: true };
    var quote = function (k) { return st.venue === 'kalshi' ? d[k].ask : pm.price[k === 'a' ? 0 : 1]; };
    var fill = function () { var p = quote(st.side); st.price = has(p) ? Math.min(0.99, Math.max(0.01, Math.round(p * 100) / 100)) : 0.5; st.qty = Math.max(1, Math.floor((cs.stake || 100) / st.price)); st.target = defTarget(st.price); st.stop = null; }; fill();
    var draw = function () {
      var box = sheetShell('Track a position', titleOf(d));
      var pickRow = function (label, opts, cur, set) { var w = el('div'); w.appendChild(el('div', 'flabel', label)); var g = el('div', 'seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label); opts.forEach(function (o) { var x = el('button', '', o[1]); x.type = 'button'; x.setAttribute('aria-pressed', String(cur === o[0])); x.addEventListener('click', function () { set(o[0]); fill(); draw(); }); g.appendChild(x); }); w.appendChild(g); return w; };
      if (pmOk) box.appendChild(pickRow('Venue', [['kalshi', 'Kalshi'], ['polymarket', 'Polymarket']], st.venue, function (v) { st.venue = v; }));
      box.appendChild(pickRow('Outcome', ['a', 'b'].map(function (k) { return [k, last(d[k].name) + ' to win · ' + cents(quote(k))]; }), st.side, function (v) { st.side = v; }));
      var num = function (label, val, set, min, max, opt) { var f = el('label', 'field', label); var i = el('input'); i.type = 'number'; i.inputMode = 'numeric'; i.min = String(min); i.max = String(max); i.value = has(val) ? String(val) : ''; if (opt) i.placeholder = 'None'; i.addEventListener('input', function () { var v = parseFloat(i.value); if (opt && i.value === '') set(null); else if (v >= min && v <= max) set(v); }); f.appendChild(i); return f; };
      var grid = el('div', 'fgrid');
      add(grid, num('Entry price, ¢', Math.round(st.price * 100), function (v) { st.price = v / 100; }, 1, 99), num('Contracts', st.qty, function (v) { st.qty = Math.floor(v); }, 1, 1000000),
        num('Target, ¢ (optional)', has(st.target) ? Math.round(st.target * 100) : null, function (v) { st.target = has(v) ? v / 100 : null; }, 2, 99, true), num('Stop, ¢ (optional)', has(st.stop) ? Math.round(st.stop * 100) : null, function (v) { st.stop = has(v) ? v / 100 : null; }, 1, 98, true));
      box.appendChild(grid);
      if (st.venue === 'kalshi') { var al2 = el('div', 'seg'); var tg = el('button', '', 'Alert me at the target and the stop'); tg.type = 'button'; tg.setAttribute('aria-pressed', String(st.alert)); tg.addEventListener('click', function () { st.alert = !st.alert; tg.setAttribute('aria-pressed', String(st.alert)); }); al2.appendChild(tg); box.appendChild(al2); }
      var go = el('button', 'go pri', 'Save position'); go.type = 'button';
      go.addEventListener('click', function () {
        if (has(st.target) && st.target <= st.price) { say('Check the target', 'The target has to be above the entry price.'); return; }
        if (has(st.stop) && st.stop >= st.price) { say('Check the stop', 'The stop has to be below the entry price.'); return; }
        var fee = feeAt(st.venue, st.price, st.qty); var x = { id: Date.now(), t: nowS(), venue: st.venue, source: 'manual', event: d.event, ticker: d[st.side].ticker, title: titleOf(d), side: st.side, name: d[st.side].name, price: st.price, qty: st.qty, fee: fee, cost: st.qty * st.price + fee, target: st.target, stop: st.stop, read: d.read ? d.read.level : 'none', readTitle: d.read ? d.read.title : '', fair: d.model && d.model.live ? (st.side === 'a' ? d.model.live.a : 1 - d.model.live.a) : null, status: 'open', exit: null };
        J.unshift(x); saveJ(); var set = [];
        if (st.venue === 'kalshi' && st.alert) { if (has(st.target)) { addRule(d, st.side, 'bid>=', st.target); set.push(cents(st.target)); } if (has(st.stop)) { addRule(d, st.side, 'bid<=', st.stop); set.push(cents(st.stop)); } }
        closeSheet(); say('Position tracked', last(x.name) + ', ' + x.qty + ' at ' + cents(x.price) + ' on ' + VENUES[st.venue] + (set.length ? '. Alerts at ' + set.join(' and ') : '') + '.', '#positions'); refreshMarks(); if (cur.d) calcOut(cur.d);
      });
      add(box, go, el('div', 'small', 'This is a record you keep on this device. It does not place, change or cancel any order on ' + VENUES[st.venue] + '.' + (st.venue === 'polymarket' ? ' Polymarket fees are not included, and alerts only watch Kalshi prices.' : '')));
    };
    draw(); openSheetNow();
  }
  function openSheetNow() { var sh = $('sheet'); $('scrim').hidden = false; sh.hidden = false; requestAnimationFrame(function () { sh.classList.add('on'); }); }
  // bookmark and bell on every card
  function wrapCard(c, m) {
    var w = el('div', 'cw'); var acts = el('div', 'acts'); var t = titleOf(m);
    var s = el('button'); s.type = 'button'; var b = el('button'); b.type = 'button';
    var paint = function () { var on = !!W[m.event]; s.replaceChildren(icon('watch', on)); s.className = on ? 'on' : ''; s.setAttribute('aria-pressed', String(on)); s.setAttribute('aria-label', (on ? 'Remove from watchlist: ' : 'Save to watchlist: ') + t); var n = openRules(m.event).length; b.replaceChildren(icon('alerts', n > 0)); b.className = n ? 'on' : ''; b.setAttribute('aria-label', 'Set a price alert: ' + t); };
    s.addEventListener('click', function () { toggleWatch(m.event, t); paint(); if (location.hash === '#watch') loadWatch(); });
    b.addEventListener('click', function () { alertSheet(m); });
    w.dataset.ev = m.event; w.paint = paint; paint(); add(acts, s, b); add(w, c, acts); return w;
  }
  function refreshMarks() { document.querySelectorAll('.cw').forEach(function (w) { if (w.paint) w.paint(); }); paintSave(); }
  function paintSave() { var b = $('actSave'); var on = !!(cur.event && W[cur.event]); b.replaceChildren(icon('watch', on)); b.className = on ? 'on' : ''; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Remove from watchlist' : 'Save to watchlist'); }

  // ---------- watchlist ----------
  function loadWatch() {
    var evs = Object.keys(W); var box = $('waList');
    if (!evs.length) { box.replaceChildren(el('div', 'empty', 'Nothing saved yet. Tap the bookmark on any match in Discover and it stays here until you remove it.')); $('waStatus').textContent = 'Matches you saved with the bookmark.'; return; }
    quotes(evs).then(function (by) {
      if (location.hash !== '#watch') return; box.replaceChildren();
      var rank = function (e) { var m = by[e]; return !m ? 3 : m.state === 'upcoming' ? 2 : m.state === 'closing' ? 2.5 : 1; };
      evs.sort(function (x, y) { return rank(x) - rank(y) || ((by[x] && by[x].start) || 0) - ((by[y] && by[y].start) || 0); });
      evs.forEach(function (e) {
        var m = by[e]; if (m) { box.appendChild(leagueOf(e) ? gameCard(m) : card(m)); return; }
        var c = el('div', 'card'); var top = el('div', 'top'); var rm = el('button', 'go', 'Remove'); rm.type = 'button'; rm.addEventListener('click', function () { toggleWatch(e, ''); loadWatch(); });
        add(top, el('b', '', W[e].title || e), rm); add(c, top, el('div', 'small', 'Finished, or no longer listed on Kalshi.')); box.appendChild(c);
      });
      var s = $('waStatus'); s.replaceChildren(); add(s, document.createTextNode('Updated '), el('b', '', new Date().toLocaleTimeString()), document.createTextNode(' · ' + evs.length + ' saved · refreshes every 15s'));
    });
  }

  // ---------- Discover: one list for tennis, NBA and NFL ----------
  // One matchup as a compact row: league and status, both sides, score, and the price to buy each side.
  function matchRow(m, o) {
    var c = el('a', 'row'); c.href = '#m=' + encodeURIComponent(m.event);
    var top = el('div', 'top'); add(top, el('span', 'lg', o.lg), el('span', 'st' + (o.live ? ' live' : ''), o.st));
    var g = el('div', 'mgrid');
    ['a', 'b'].forEach(function (k, i) {
      var p = m[k]; var nm = el('span', 'name');
      if (o.srv === k) { var dot = el('i', 'srv'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Serving'); nm.appendChild(dot); }
      nm.appendChild(document.createTextNode(p.name)); if (o.sub && o.sub[i]) nm.appendChild(el('small', '', o.sub[i]));
      var px = el('span', 'px' + (has(p.ask) ? '' : ' none'), has(p.ask) ? cents(p.ask) : '–'); px.setAttribute('aria-label', has(p.ask) ? 'Buy ' + p.name + ' at ' + Math.round(p.ask * 100) + ' cents' : 'No price for ' + p.name);
      add(g, nm, o.cells ? o.cells[i] : el('span', 'sets'), px);
    });
    add(c, top, g, o.ctx || null); return c;
  }
  function card(m) { // tennis
    var live = m.state !== 'upcoming'; var sets = m.pm && m.pm.live ? m.pm.sets : null; var f = live ? feedFor(m, sets) : null;
    var cells = ['a', 'b'].map(function (k, i) { var x = setCells(sets, i, true); if (f && f.points) x.appendChild(el('b', 'pt', f.points[i])); return x; });
    var ctx = null; var gap = m.call && m.call.live && m.call.bet && m.fair;
    if (gap) { ctx = el('div', 'ctx'); add(ctx, el('b', '', 'Gap '), document.createTextNode(last(m[m.call.side].name) + ' at ' + cents(m.call.price) + ', usual level ' + cents(m.fair[m.call.side]) + ' after a set like this.')); }
    var st = live ? stateText(m) : stateText(m).replace(/^Starts /, '');
    return wrapCard(matchRow(m, { lg: m.tournament || m.tourLabel || m.tour || 'Tennis', st: st, live: live && m.state !== 'closing', cells: cells, srv: f ? f.server : null, sub: !sets && m.set1 && m.set1.winner ? [m.set1.winner === 'a' ? 'won set 1' : '', m.set1.winner === 'b' ? 'won set 1' : ''] : null, ctx: ctx }), m);
  }
  function gState(m) {
    if (m.state === 'live') return m.text || 'In play';
    if (m.state === 'closing') return 'Final · settling';
    return m.start ? day(m.start) + ' ' + clock(m.start) : 'Not started';
  }
  function gameCard(m) { // NBA and NFL
    var on = m.state !== 'upcoming';
    var cells = ['a', 'b'].map(function (k) { var x = el('span', 'sets'); var p = m[k], o = m[k === 'a' ? 'b' : 'a']; if (on && has(p.score)) x.appendChild(el('b', 'sc ' + (m.state === 'closing' ? (p.score > o.score ? 'w' : '') : 'cur'), String(p.score))); return x; });
    var ctx = el('div', 'ctx'); var gap = m.gap && m.gap.edge >= 0.03 && m.state === 'upcoming';
    if (gap) add(ctx, el('b', '', 'Gap '), document.createTextNode(m[m.gap.side].name + ' at ' + cents(m.gap.ask) + ', ' + m.book.name + ' fair ' + cents(m.gap.fair) + '. '));
    else if (on && m.sit && m.sit.text) ctx.appendChild(document.createTextNode(m.sit.text + ' '));
    else if (!on && m.book && has(m.book.a)) ctx.appendChild(document.createTextNode(m.book.name + ' fair ' + cents(m.book.a) + ' / ' + cents(m.book.b) + (m.book.text ? ' · ' + m.book.text : '') + ' '));
    var inj = []; ['a', 'b'].forEach(function (k) { ((m.inj && m.inj[k]) || []).forEach(function (i) { inj.push(last(i.name) + ' ' + i.tag.toLowerCase()); }); });
    if (inj.length) ctx.appendChild(el('span', 'inj', inj.slice(0, 3).join(', ')));
    return wrapCard(matchRow(m, { lg: (m.league === 'nba' ? 'NBA' : 'NFL') + (m.note ? ' · ' + m.note : ''), st: gState(m), live: m.state === 'live', cells: cells, sub: [m.a.record || '', [m.b.record, 'home'].filter(Boolean).join(' · ')], ctx: ctx.childNodes.length ? ctx : null }), m);
  }
  function gameGrid(m) { // the larger scoreboard on a game's own page
    var g = el('div', 'players'); var on = m.state !== 'upcoming';
    add(g, el('span', 'colhead', ''), el('span', 'colhead', ''), el('span', 'colhead', 'Sell'), el('span', 'colhead', 'Buy'));
    ['a', 'b'].forEach(function (k) {
      var p = m[k], o = m[k === 'a' ? 'b' : 'a']; var name = el('span', 'name', p.name);
      add(name, document.createTextNode(' '), el('small', 'at', [p.record, k === 'b' ? 'home' : null].filter(Boolean).join(' · ')));
      var cells = el('span', 'sets'); if (on && has(p.score)) cells.appendChild(el('b', 'sc ' + (m.state === 'closing' ? (p.score > o.score ? 'w' : '') : 'cur'), String(p.score)));
      add(g, name, cells, el('span', 'num', cents(p.bid)), el('span', 'num', cents(p.ask)));
    });
    return g;
  }
  function ago2(t) { var s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; }

  var SPORTS = [['all', 'All'], ['tennis', 'Tennis'], ['nba', 'NBA'], ['nfl', 'NFL']];
  var D = { src: { tennis: null, nba: null, nfl: null }, err: {}, at: {}, sport: 'all', when: '', q: '' };
  try { var s0 = localStorage.getItem('ce-sport2'); if (s0 === 'tennis' || s0 === 'nba' || s0 === 'nfl') D.sport = s0; var w0 = localStorage.getItem('ce-when'); if (w0 === 'live' || w0 === 'up') D.when = w0; } catch (e) {}
  function drawFilters() {
    var box = $('fSport'); box.replaceChildren();
    SPORTS.forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(D.sport === o[0]));
      b.addEventListener('click', function () { D.sport = o[0]; try { localStorage.setItem('ce-sport2', D.sport); } catch (e) {} drawFilters(); renderDiscover(); loadDiscover(); });
      box.appendChild(b);
    });
    box.appendChild(el('span', 'gap'));
    [['live', 'Live'], ['up', 'Upcoming']].forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(D.when === o[0]));
      b.addEventListener('click', function () { D.when = D.when === o[0] ? '' : o[0]; try { localStorage.setItem('ce-when', D.when); } catch (e) {} drawFilters(); renderDiscover(); });
      box.appendChild(b);
    });
  }
  function discoverRows() {
    var rows = []; var want = function (k) { return D.sport === 'all' || D.sport === k; };
    if (want('tennis') && D.src.tennis) (D.src.tennis.matches || []).forEach(function (m) {
      rows.push({ m: m, sport: 'tennis', live: m.state !== 'upcoming', gap: !!(m.call && m.call.live && m.call.bet), t: m.pm && m.pm.start ? Date.parse(m.pm.start) / 1000 : 0, text: (m.a.name + ' ' + m.b.name + ' ' + (m.tournament || '') + ' tennis').toLowerCase() });
    });
    ['nba', 'nfl'].forEach(function (k) {
      if (want(k) && D.src[k]) (D.src[k].games || []).forEach(function (m) {
        rows.push({ m: m, sport: k, live: m.state !== 'upcoming', gap: m.state === 'upcoming' && !!(m.gap && m.gap.edge >= 0.03), t: m.start || 0, text: (m.a.name + ' ' + m.b.name + ' ' + (m.a.full || '') + ' ' + (m.b.full || '') + ' ' + m.a.code + ' ' + m.b.code + ' ' + k).toLowerCase() });
      });
    });
    if (D.q) rows = rows.filter(function (r) { return r.text.indexOf(D.q) >= 0; });
    return rows;
  }
  function renderDiscover() {
    var rows = discoverRows(); var names = { tennis: 'tennis matches', nba: 'NBA games', nfl: 'NFL games' };
    var wanted = D.sport === 'all' ? ['tennis', 'nba', 'nfl'] : [D.sport];
    var loading = wanted.filter(function (k) { return !D.src[k] && !D.err[k]; }); var failed = wanted.filter(function (k) { return D.err[k]; });
    var put = function (id, items, emptyText, head) {
      var box = $(id); box.replaceChildren();
      if (!items.length) { box.appendChild(el('div', 'empty', emptyText)); return; }
      var h = el('div', 'list-head'); add(h, el('span', '', head), el('span', '', 'Buy')); box.appendChild(h);
      items.forEach(function (r) { box.appendChild(r.sport === 'tennis' ? card(r.m) : gameCard(r.m)); });
    };
    var what = D.sport === 'all' ? 'matchups' : names[D.sport]; var none = function (kind) {
      if (loading.length === wanted.length) return 'Loading…';
      if (D.q) return 'Nothing ' + (kind === 'listed' ? '' : kind + ' ') + 'matches "' + D.q + '". Check the spelling, or clear the search.';
      if (failed.length === wanted.length) return 'Could not load ' + what + '. Trying again every 15 seconds.';
      if (kind === 'live') return 'No ' + what + ' in play right now.';
      return 'No ' + what + (kind === 'listed' ? ' are listed' : ' ' + kind) + ' on Kalshi right now.' + (D.sport === 'nba' || D.sport === 'nfl' ? ' Games appear here as soon as Kalshi lists them.' : '');
    };
    var gaps = rows.filter(function (r) { return r.gap; }); $('secGaps').hidden = !gaps.length || D.when === 'up' && !gaps.some(function (r) { return !r.live; });
    if (gaps.length) put('bets', gaps, '', 'To win');
    var live = rows.filter(function (r) { return r.live && !r.gap; }).sort(function (x, y) { return SPORTS.map(function (s) { return s[0]; }).indexOf(x.sport) - SPORTS.map(function (s) { return s[0]; }).indexOf(y.sport) || x.t - y.t; });
    var up = rows.filter(function (r) { return !r.live && !r.gap; }).sort(function (x, y) { return (x.t || 9e12) - (y.t || 9e12); });
    // nothing at all for this choice: one message, not one per section
    var shown = (D.when === 'up' ? [] : live).length + (D.when === 'live' ? [] : up).length + (D.when ? gaps.filter(function (r) { return D.when === 'live' ? r.live : !r.live; }) : gaps).length;
    var dn = $('dNone'); dn.hidden = shown > 0; if (!shown) dn.textContent = none(D.when === 'live' ? 'live' : D.when === 'up' ? 'upcoming' : 'listed');
    $('secLive').hidden = D.when === 'up' || !shown; $('secUp').hidden = D.when === 'live' || !shown;
    put('live', live, none('live'), 'To win'); put('upcoming', up.slice(0, 80), none('upcoming'), 'To win');
    // injury watch, for the leagues on screen
    var w = []; ['nba', 'nfl'].forEach(function (k) { if ((D.sport === 'all' || D.sport === k) && D.src[k]) (D.src[k].watch || []).forEach(function (i) { w.push(Object.assign({ lg: k }, i)); }); });
    w.sort(function (x, y) { return (y.t || 0) - (x.t || 0); }); $('secInj').hidden = D.sport === 'tennis';
    var ib = $('gInj'); ib.replaceChildren();
    if (!w.length) ib.appendChild(el('div', 'small', 'No leading scorer, runner, receiver or starting quarterback is in doubt for the next games.'));
    else {
      var list = el('div', 'rows');
      w.slice(0, 14).forEach(function (i) {
        var a = el('a'); a.href = '#m=' + encodeURIComponent(i.event); var l = el('span', 'l', i.lg.toUpperCase() + ' · ' + i.name + ' (' + i.team + ') ' + i.tag.toLowerCase() + (i.part ? ', ' + i.part.toLowerCase() : ''));
        l.appendChild(el('div', 'small', (i.t ? 'Updated ' + ago2(i.t) + ' · ' : '') + 'rough worth ' + i.lo + ' to ' + i.hi + ' points (' + i.why + ')')); a.appendChild(l); list.appendChild(a);
      });
      ib.appendChild(list); if (w.length > 14) ib.appendChild(el('div', 'small', 'And ' + (w.length - 14) + ' more on the game pages.'));
    }
    // status line: when each source last answered, and what is not answering
    var s = $('status'); s.replaceChildren(); var ts = wanted.map(function (k) { return D.at[k] || 0; }).filter(Boolean);
    if (ts.length) add(s, document.createTextNode('Updated '), el('b', '', new Date(Math.min.apply(null, ts)).toLocaleTimeString()), document.createTextNode(' · ' + rows.length + ' ' + (rows.length === 1 ? 'matchup' : 'matchups')));
    else s.appendChild(document.createTextNode(loading.length ? 'Loading Kalshi prices…' : ''));
    if (failed.length) s.appendChild(el('span', 'err', (s.textContent ? ' · ' : '') + 'Not loading: ' + failed.map(function (k) { return k === 'tennis' ? 'Tennis' : k.toUpperCase(); }).join(', ') + '. Retrying.'));
    var nosc = ['nba', 'nfl'].filter(function (k) { return wanted.indexOf(k) >= 0 && D.src[k] && !D.src[k].scores && (D.src[k].games || []).length; });
    if (nosc.length) s.appendChild(document.createTextNode(' · ' + nosc.map(function (k) { return k.toUpperCase(); }).join(' and ') + ' scores are not answering, showing prices only'));
  }
  function loadDiscover() {
    (D.sport === 'all' ? ['tennis', 'nba', 'nfl'] : [D.sport]).forEach(function (k) {
      get(k === 'tennis' ? '/api/scan' : '/api/sports?league=' + k).then(function (d) {
        D.src[k] = d; D.at[k] = Date.now(); delete D.err[k];
        (k === 'tennis' ? d.matches || [] : d.games || []).forEach(function (m) { Q.by[m.event] = m; });
        if (onDiscover()) renderDiscover();
      }).catch(function (e) { D.err[k] = e.message; if (onDiscover()) renderDiscover(); });
    });
  }
  var onDiscover = function () { return location.hash === '' || location.hash === '#'; };
  var leagueOf = function (ev) { return /^KXNBA/.test(ev) ? 'nba' : /^KXNFL/.test(ev) ? 'nfl' : null; };

  // ---------- NBA and NFL game page ----------
  var pct0 = function (x) { return has(x) ? Math.round(x * 100) + '%' : '–'; }; // model estimates are chances, shown as %, never as a price
  // Links to the same market on the venues where it is actually listed.
  function venueLinks(d, pmSlug) {
    var box = el('div', 'venues'); var mk = function (label, href) { var a = el('a', 'ext', label); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.appendChild(icon('out')).classList.add('s'); return a; };
    if (d.a && d.a.ticker) box.appendChild(mk('Open on Kalshi', 'https://kalshi.com/markets/' + encodeURIComponent(String(d.a.ticker).toLowerCase())));
    if (pmSlug) box.appendChild(mk('Open on Polymarket', 'https://polymarket.com/event/' + encodeURIComponent(pmSlug)));
    return box;
  }
  function gHead(d) {
    var box = $('dHead'); box.replaceChildren();
    var top = el('div', 'top'); add(top, el('span', 'tour', [d.label, d.note].filter(Boolean).join(' · ')), el('span', 'chip' + (d.state === 'live' ? ' live' : ''), gState(d)));
    add(box, top, gameGrid(d));
    var k = d.favA ? 'a' : 'b'; var pick = function (a) { return !has(a) ? null : d.favA ? a : 1 - a; };
    var third = d.model.live ? ['Model estimate', pct0(pick(d.model.live.a))] : ['Polymarket price', cents(d.pm && d.pm.price ? d.pm.price[d.favA ? 0 : 1] : null)];
    box.appendChild(trio([[d[k].name + ', Kalshi price', cents(pick(d.midA))], [d.book ? d.book.name + (d.book.stale ? ' at the close' : ' fair') : 'Sportsbook fair', cents(d.book ? pick(d.book.a) : null)], third]));
    var bits = [];
    if (d.sit && d.sit.text && d.state === 'live') bits.push(d.sit.text);
    if (d.book && d.book.text) bits.push((d.book.stale ? 'Closing line ' : 'Line ') + d.book.text + (has(d.book.total) ? ', total ' + d.book.total : ''));
    if (d.weather && d.weather.text) bits.push(d.weather.text + (has(d.weather.temp) ? ' ' + d.weather.temp + '°F' : ''));
    bits.push('Kalshi volume ' + usd(d.volume).replace('$', '') + ' contracts');
    if (!d.hasScores) bits.push('No live score feed for this game');
    add(box, el('div', 'small', bits.join(' · ')), venueLinks(d, d.pm ? d.pm.slug : null));
  }
  function gInj(d) {
    var box = $('gdInj'); box.replaceChildren(); var any = false;
    ['a', 'b'].forEach(function (k) {
      var list = d.inj[k] || []; var others = k === 'a' ? d.inj.othersA : d.inj.othersB;
      box.appendChild(el('div', 'sub', d[k].name));
      if (!list.length) { box.appendChild(el('div', 'small', 'No key player in doubt.' + (others ? ' ' + others + ' other listed.' : ''))); return; }
      any = true; var rows = el('div', 'rows');
      list.forEach(function (i) {
        var row = el('div'); var l = el('span', 'l', i.name + (i.pos ? ' (' + i.pos + ')' : '') + (i.part ? ', ' + i.part.toLowerCase() : ''));
        l.appendChild(el('div', 'small', (i.t ? 'Updated ' + ago2(i.t) + '. ' : '') + 'Rough worth ' + i.lo + ' to ' + i.hi + ' points (' + i.why + ').' + (i.note ? ' ' + i.note : '')));
        add(row, l, el('span', 'chip' + (i.fresh ? ' bad' : ''), i.tag)); rows.appendChild(row);
      });
      box.appendChild(rows); if (others) box.appendChild(el('div', 'small', 'Plus ' + others + ' other listed.'));
    });
    box.appendChild(el('div', 'small', (any ? 'Near an even game, one point of spread is about 3¢. A player who has been out for weeks is already in the price. What moves it is a change. ' : '') + 'Injury data is ESPN\'s list, which can trail the official report by some minutes.'));
  }
  function gFair(d) {
    var box = $('gdFair'); box.replaceChildren(); var kv = el('div', 'kv');
    add(kv, el('span', 'k', ''), el('span', 'h', d.a.name), el('span', 'h', d.b.name));
    var row = function (k, a, asPct) { if (!has(a)) return; var f = asPct ? function (x) { return Math.round(x * 100) + '%'; } : cents; add(kv, el('span', 'k', k), el('span', 'num', f(a)), el('span', 'num', f(1 - a))); };
    row('Kalshi now', d.midA);
    if (d.pm && d.pm.price) row('Polymarket now', d.pm.price[0]);
    if (d.book) row(d.book.name + (d.book.stale ? ' closing line' : '') + ', margin removed', d.book.a);
    if (has(d.pre)) row('Kalshi at the start', d.pre);
    row('ESPN pre-game projection', d.model.proj, true);
    if (d.model.live) row('Score model, live', d.model.live.a, true);
    row('ESPN live win probability', d.model.espn, true);
    box.appendChild(kv);
    if (d.book && has(d.book.mlA)) box.appendChild(el('div', 'small', d.book.name + ' moneyline: ' + d.a.name + ' ' + d.book.mlA + ', ' + d.b.name + ' ' + d.book.mlB + '.'));
    box.appendChild(el('div', 'small', d.state === 'live' ? 'The score model treats the score gap as a random walk around the pre-game price. It knows the score and the clock, not who has the ball or who is on the floor.' : 'When these agree there is nothing to do. When Kalshi is the odd one out, look for the reason before assuming it is wrong.'));
  }
  function gLines(d) {
    var box = $('gdLines'); box.replaceChildren(); var L = d.lines || {}; var flagged = [];
    var table = function (title, set, label) {
      box.appendChild(el('div', 'sub', title)); var kv = el('div', 'kv');
      add(kv, el('span', 'k', ''), el('span', 'h', 'Kalshi bid / ask'), el('span', 'h', set.book + ' fair'));
      set.rows.forEach(function (r) {
        add(kv, el('span', 'k', label(r.strike)), el('span', 'num', cents(r.bid) + ' / ' + cents(r.ask)), el('span', 'num', has(r.fair) ? cents(r.fair) : '–'));
        if (r.gap) flagged.push(label(r.strike) + ': ' + (r.gap.side === 'yes' ? 'Yes' : 'No') + ' at ' + cents(r.gap.at) + ' is ' + c1(r.gap.edge) + ' under the sportsbook price after the fee.');
      });
      box.appendChild(kv);
    };
    if (L.spread) table('Spread', L.spread, function (x) { return L.spread.team + ' by more than ' + x; });
    if (L.total) table('Total points', L.total, function (x) { return 'Over ' + x; });
    if (!L.spread && !L.total) { box.appendChild(el('div', 'small', d.book ? 'No Kalshi spread or total markets found for this game.' : 'No sportsbook line yet, so nothing to line the Kalshi spread and total markets up against.')); return; }
    if (flagged.length) { var v = el('div', 'verdict lean'); add(v, el('b', 't', 'Off the sportsbook line')); var ul = el('ul'); flagged.forEach(function (t) { ul.appendChild(el('li', '', t)); }); v.appendChild(ul); box.appendChild(v); }
    if (L.stale) box.appendChild(el('div', 'small', 'In play, the only sportsbook number available is the closing line, so no comparison or gap is shown.'));
    box.appendChild(el('div', 'small', 'The sportsbook price is only shown on the line it actually quotes. Spreads and totals trade less than the winner market, so they follow news more slowly. A gap of 3¢ or more after the fee is flagged.'));
  }
  function gStrength(d) {
    var box = $('gdStr'); box.replaceChildren(); var S = d.strength || {}; var A = S.a, B = S.b;
    if (!A && !B) { box.appendChild(el('div', 'small', 'Team numbers are not available right now.')); return; }
    A = A || {}; B = B || {}; var kv = el('div', 'kv'); add(kv, el('span', 'k', ''), el('span', 'h', d.a.name), el('span', 'h', d.b.name));
    var rk = function (v, r, dp) { return !has(v) ? '–' : (dp ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp) : v) + (r ? ' · ' + r + ordinal(r) : ''); };
    var row = function (k, a, b) { if (a === '–' && b === '–') return; add(kv, el('span', 'k', k), el('span', 'num', a), el('span', 'num', b)); };
    row('Record', has(A.w) ? A.w + '-' + A.l + (A.t ? '-' + A.t : '') : '–', has(B.w) ? B.w + '-' + B.l + (B.t ? '-' + B.t : '') : '–');
    row('Away / home record', A.roadRec || '–', B.homeRec || '–');
    row('Points scored a game', rk(A.pf, A.offRank), rk(B.pf, B.offRank));
    row('Points allowed a game', rk(A.pa, A.defRank), rk(B.pa, B.defRank));
    if (A.epa || B.epa) {
      var ea = A.epa || {}, eb = B.epa || {};
      row('Offence, value per play', rk(ea.off, ea.offRank, 2), rk(eb.off, eb.offRank, 2));
      row('Passing offence', rk(ea.offPass, ea.offPassRank, 2), rk(eb.offPass, eb.offPassRank, 2));
      row('Running offence', rk(ea.offRush, ea.offRushRank, 2), rk(eb.offRush, eb.offRushRank, 2));
      row('Defence, value allowed per play', rk(ea.def, ea.defRank, 2), rk(eb.def, eb.defRank, 2));
      row('Pass defence', rk(ea.defPass, ea.defPassRank, 2), rk(eb.defPass, eb.defPassRank, 2));
      row('Run defence', rk(ea.defRush, ea.defRushRank, 2), rk(eb.defRush, eb.defRushRank, 2));
    }
    box.appendChild(kv);
    if (S.notes && S.notes.length) { var ul = el('ul', 'plain'); S.notes.forEach(function (t) { ul.appendChild(el('li', '', t)); }); box.appendChild(ul); }
    box.appendChild(el('div', 'small', (S.source === 'nflverse' ? 'Value per play is expected points added, from nflverse play-by-play through week ' + S.week + '. For a defence, lower is better and 1st is best. ' : d.league === 'nba' ? 'Points a game are not adjusted for pace. ' : '') + 'Sportsbooks already price all of this. It explains why the line is where it is, not where it is wrong.'));
  }
  var ordinal = function (n) { var v = n % 100; return v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10]; };
  function gForm(d) {
    var box = $('gdForm'); box.replaceChildren(); var F = d.form || {}; var none = true;
    ['a', 'b'].forEach(function (k) {
      var list = F[k] || []; if (!list.length) return; none = false;
      box.appendChild(el('div', 'sub', d[k].name)); var wl = el('div', 'wl');
      list.forEach(function (e) { var b = el('b', e.res === 'W' ? 'W' : '', (e.res || '?') + ' ' + e.score + ' ' + e.at + ' ' + e.opp); b.title = day(e.t); wl.appendChild(b); });
      box.appendChild(wl);
      var r = d.rest ? d.rest[k] : null; if (has(r)) box.appendChild(el('div', 'small', d.state === 'upcoming' ? (r <= 1 && d.league === 'nba' ? 'Played yesterday, so this is the second night of a back-to-back.' : r + ' days since the last game.') : 'Newest first.'));
    });
    if (none) box.appendChild(el('div', 'small', 'Recent results are not available right now.'));
    else box.appendChild(el('div', 'small', 'Newest first. A short run of results says little on its own, and the price already knows the schedule.'));
  }
  function loadGameWallets() {
    var ev = cur.event; var d = cur.d; var box = $('gdWal'); if (!d) return;
    if (!d.pm || !d.pm.cond) { box.replaceChildren(el('div', 'small', 'No matching Polymarket market found for this game.')); return; }
    get('/api/wallet?cond=' + d.pm.cond).then(function (r) {
      if (ev !== cur.event) return; box.replaceChildren();
      (r.sides || []).forEach(function (sd) {
        box.appendChild(el('div', 'sub', sd.outcome + ': ' + usd(sd.total) + ' across ' + sd.count + ' wallets')); var rows = el('div', 'rows');
        sd.top.slice(0, 6).forEach(function (h) { var row = el('div'); var l = el('span', 'l', h.name); if (h.tracked) l.appendChild(el('div', 'small', h.rec ? 'Tracked. ' + r.cat + ' record ' + signed(h.rec.net) + (h.rec.n ? ' over ' + h.rec.n : '') : 'Tracked, no ' + r.cat + ' record')); add(row, l, el('span', 'r', usd(h.usd) + ' at ' + cents(h.avg))); rows.appendChild(row); });
        box.appendChild(rows);
      });
      if (!(r.sides || []).length) box.appendChild(el('div', 'small', 'No holders of $50 or more yet.'));
      box.appendChild(el('div', 'small', 'Polymarket holders of $50 or more on the winner market. Tracked means one of the graded whales from the Whales tab. Many big wallets hedge elsewhere.'));
    }).catch(function () { if (ev === cur.event) box.replaceChildren(el('div', 'small err', 'Could not load Polymarket wallets.')); });
  }
  function renderGame(d) {
    cur.d = d; gHead(d); read(d); calc(d); chart(d); gInj(d); gFair(d); gLines(d); gStrength(d); gForm(d);
    var cond = d.pm ? d.pm.cond : null; if (cur.pmCond !== cond) { cur.pmCond = cond; loadGameWallets(); }
    var s = $('dStatus'); s.replaceChildren(); add(s, document.createTextNode('Updated '), el('b', '', new Date(d.asOf).toLocaleTimeString()), document.createTextNode(' · refreshes every 10s'));
  }
  function loadGame() {
    var ev = cur.event; if (!ev) return; var seq = cur.seq = (cur.seq || 0) + 1;
    get('/api/sports?league=' + cur.league + '&event=' + encodeURIComponent(ev)).then(function (d) { if (ev === cur.event && seq === cur.seq) renderGame(d); })
      .catch(function (e) { if (ev === cur.event) $('dStatus').replaceChildren(el('span', 'err', e.message + (cur.d ? ' Showing the last data.' : ''))); });
  }
  function openGame(lg, ev) {
    cur.timers.forEach(clearInterval);
    cur = { event: ev, kind: 'game', league: lg, srv: null, d: null, timers: [], aiText: null, pmCond: undefined };
    show('detailView'); detailKind(true); $('back').textContent = '‹ Back'; window.scrollTo(0, 0);
    DETAIL_BOXES.forEach(function (id) { $(id).replaceChildren(); });
    $('gdWal').replaceChildren(el('span', 'small', 'Loading wallets…')); $('dStatus').textContent = 'Loading…';
    loadGame();
    cur.timers.push(setInterval(function () { if (!document.hidden) loadGame(); }, DETAIL_MS));
    cur.timers.push(setInterval(function () { if (!document.hidden) loadGameWallets(); }, WHALE_MS));
  }

  // ---------- detail ----------
  var cur = { event: null, srv: null, d: null, timers: [], aiText: null };

  function head(d) {
    var box = $('dHead'); box.replaceChildren();
    var top = el('div', 'top');
    var sc = d.score; var st = { event: d.event, a: d.a, b: d.b, state: d.state, since: d.since, inWindow: d.inWindow, set1: d.set1, pm: sc };
    add(top, el('span', 'tour', [d.tournament || d.tour, d.surface].filter(Boolean).join(' · ')), el('span', 'chip' + (d.inWindow ? ' window' : d.state !== 'upcoming' ? ' live' : ''), stateText(st)));
    add(box, top, playersGrid(d, sc && (sc.live || sc.ended) ? sc.sets : null, !!(sc && sc.live)));
    var favA = !has(d.pre) || d.pre >= 0.5; var fk = favA ? 'a' : 'b'; var fn = last(d[fk].name);
    var km = has(d.midA) ? (favA ? d.midA : 1 - d.midA) : null; var pmP = d.polymarket && d.polymarket.price ? d.polymarket.price[favA ? 0 : 1] : null;
    var mf = d.model.live ? (favA ? d.model.live.a : 1 - d.model.live.a) : has(d.model.rating) && d.state === 'upcoming' ? (favA ? d.model.rating : 1 - d.model.rating) : null;
    box.appendChild(trio([[fn + ', Kalshi price', cents(km)], ['Polymarket price', cents(pmP)], [d.model.live ? 'Model estimate' : 'Ratings estimate', has(mf) ? pct0(mf) : '–']]));
    if (has(km) && has(pmP)) { var gapV = Math.abs(km - pmP); box.appendChild(el('div', 'small', gapV >= 0.04 ? 'Kalshi and Polymarket are ' + Math.round(gapV * 100) + '¢ apart. Fees on both sides cost about 3.5¢, so check both books before acting.' : 'Kalshi and Polymarket agree to within ' + Math.max(1, Math.round(gapV * 100)) + '¢. No cross-market gap here.')); }
    var bits = [];
    if (has(d.pre)) bits.push('Pre-match '  + last(d.a.name) + ' ' + cents(d.pre) + ' / ' + last(d.b.name) + ' ' + cents(1 - d.pre));
    bits.push('Kalshi volume ' + usd(d.volume).replace('$', '') + ' contracts');
    if (!sc) bits.push('No live score feed for this match');
    add(box, el('div', 'small', bits.join(' · ')), venueLinks(d, d.polymarket ? d.polymarket.slug : null));
  }

  function read(d) {
    var r = d.read; var v = el('div', 'verdict ' + r.level);
    add(v, el('b', 't', r.title));
    if (r.why && r.why.length) { var ul = el('ul'); r.why.forEach(function (w) { ul.appendChild(el('li', '', w)); }); v.appendChild(ul); }
    $('dRead').replaceChildren(v);
  }

  // What the next game, break point or set would do to the fair value, and the nearest way to 80¢.
  function pathsBox(d, box, A, B) {
    var P = d.paths; if (!P || !P.rows || !P.rows.length) return;
    var s = P.server, S = s === 'a' ? A : B, R = s === 'a' ? B : A;
    var name = { game_a: s ? (s === 'a' ? A + ' holds serve' : A + ' breaks serve') : A + ' wins the next game', game_b: s ? (s === 'b' ? B + ' holds serve' : B + ' breaks serve') : B + ' wins the next game',
      games2_a: A + ' wins the next two games', games2_b: B + ' wins the next two games', bp3: R + ' gets to 0–40 on ' + S + '’s serve', gp3: S + ' goes 40–0 up on serve', set_a: A + ' wins this set', set_b: B + ' wins this set' };
    box.appendChild(el('div', 'sub', 'What moves it from here'));
    var kv = el('div', 'kv'); add(kv, el('span', 'k', ''), el('span', 'h', A), el('span', 'h', B));
    var row = function (k, a) { add(kv, el('span', 'k', k), el('span', 'num', cents(a)), el('span', 'num', cents(1 - a))); };
    row('Now' + (d.points ? ', at ' + d.points.join('–') : ''), P.now);
    P.rows.forEach(function (r) { if (name[r.k]) row(name[r.k], r.a); });
    box.appendChild(kv);
    // nearest single step that takes each player to 80¢ on the model
    var order = ['gp3', 'bp3', 'game_a', 'game_b', 'games2_a', 'games2_b', 'set_a', 'set_b']; var lines = [];
    [['a', A], ['b', B]].forEach(function (x) {
      var cur0 = x[0] === 'a' ? P.now : 1 - P.now; if (cur0 >= 0.8 || cur0 < 0.25) return;
      var hit = null; order.forEach(function (k) { if (hit) return; var r = P.rows.filter(function (q) { return q.k === k; })[0]; if (!r) return; var v = x[0] === 'a' ? r.a : 1 - r.a; if (v >= 0.795 && v > cur0) hit = { k: k, v: v }; });
      lines.push(!hit ? x[1] + ' at ' + cents(cur0) + ' does not reach 80¢ from one game or this set alone.' : hit.v >= 0.995 ? x[1] + ' at ' + cents(cur0) + ' only gets past 80¢ by winning the match from here.' : x[1] + ' at ' + cents(cur0) + ' gets to 80¢ if ' + name[hit.k] + ' (' + cents(hit.v) + ').');
    });
    if (lines.length) { var v = el('div', 'verdict'); var ul = el('ul'); ul.style.marginTop = '0'; lines.forEach(function (t) { ul.appendChild(el('li', '', t)); }); v.appendChild(ul); box.appendChild(v); }
    box.appendChild(el('div', 'small', 'Model values from the score' + (s ? '' : ', averaged over who serves because the server is not set') + '. They show how far each event should move the price, not how likely it is.' + (d.points ? '' : ' With a live point feed this updates on every point.')));
  }
  function modelBox(d) {
    var box = $('dModel'); box.replaceChildren(); var m = d.model;
    var A = last(d.a.name), B = last(d.b.name);
    if (m.live) {
      var g = el('div', 'big2');
      [['a', m.live.a], ['b', 1 - m.live.a]].forEach(function (x) {
        var ask = d[x[0]].ask; var cell = el('div');
        add(cell, el('div', 'v ' + (x[0] === 'a' ? 'ca' : 'cb'), cents(x[1])), el('div', 'l', (x[0] === 'a' ? A : B) + ' fair · ask ' + cents(ask) + (has(ask) ? ' · gap ' + ((x[1] - ask) * 100 >= 0 ? '+' : '−') + Math.abs((x[1] - ask) * 100).toFixed(1) + '¢' : '')));
        g.appendChild(cell);
      });
      add(box, g, el('div', 'small', 'From the live score with a point-by-point model. Starting point: ' + m.live.basis + '. Gap is before fees. Mid-set numbers tend to run about 3¢ high for the player ahead.'));
      var seg = el('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Who is serving');
      [[null, cur.auto ? 'From live feed' : 'Server unknown'], ['a', A + ' serving'], ['b', B + ' serving']].forEach(function (o) {
        var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(cur.srv === o[0]));
        b.addEventListener('click', function () { cur.srv = o[0]; loadDetail(); }); seg.appendChild(b);
      });
      box.appendChild(seg);
      pathsBox(d, box, A, B);
    } else {
      add(box, el('div', 'small', d.state === 'upcoming' ? 'The live fair value starts when the match does.' : d.score ? 'No live fair value for this state.' : 'No live score for this match, so no point-by-point fair value.'));
    }
    var kv = el('div', 'kv');
    add(kv, el('span', 'k', ''), el('span', 'h', A), el('span', 'h', B));
    var row = function (k, a, b) { add(kv, el('span', 'k', k), el('span', 'num', a), el('span', 'num', b)); };
    if (m.rule) row('After set 1 (Kalshi history, n=' + m.rule.n + ')', cents(m.rule.a), cents(m.rule.b));
    if (has(m.rating)) row('Ratings only, pre-match (to ' + m.through + ')', cents(m.rating), cents(1 - m.rating));
    if (has(d.pre)) row('Kalshi pre-match price', cents(d.pre), cents(1 - d.pre));
    if (kv.children.length > 3) box.appendChild(kv);
  }

  function chart(d) {
    var box = $('dChart'); box.replaceChildren();
    var pts = d.chart || [];
    var favA = has(d.favA) ? d.favA : (!has(d.pre) || d.pre >= 0.5); var who = favA ? d.a : d.b;
    var f = function (v) { return favA ? v : 1 - v; };
    var mv = function (x) { return !has(x) ? '–' : (f(x) - (favA ? 0 : 1) >= 0 ? '+' : '−') + Math.abs(Math.round(x * 100)) + '¢'; };
    var g = el('div', 'kv'); g.style.gridTemplateColumns = 'repeat(3, 1fr)';
    [['5 min', d.move.m5], ['15 min', d.move.m15], ['60 min', d.move.m60]].forEach(function (x) {
      var cell = el('div', 'mv'); add(cell, el('b', '', mv(x[1])), el('span', 'small', 'last ' + x[0])); g.appendChild(cell);
    });
    add(box, el('div', 'small', last(who.name) + ' price on Kalshi'), g);
    if (pts.length < 3) { add(box, el('div', 'small', 'Not enough price history yet.')); return; }
    var W = 600, H = 190, L = 34, R = 44, T = 10, Bm = 22;
    var ys = pts.map(function (p) { return f(p[1]); });
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    if (has(d.pre)) { lo = Math.min(lo, f(d.pre)); hi = Math.max(hi, f(d.pre)); }
    lo = Math.max(0, Math.floor(lo * 20) / 20 - 0.0001); hi = Math.min(1, Math.ceil(hi * 20) / 20 + 0.0001); if (hi - lo < 0.1) { hi = Math.min(1, hi + 0.05); lo = Math.max(0, lo - 0.05); }
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    var X = function (t) { return L + (W - L - R) * (t - t0) / Math.max(1, t1 - t0); };
    var Y = function (v) { return T + (H - T - Bm) * (1 - (v - lo) / (hi - lo)); };
    var NS = 'http://www.w3.org/2000/svg';
    var s = function (tag, at, text) { var e = document.createElementNS(NS, tag); for (var k in at) e.setAttribute(k, at[k]); if (text) e.textContent = text; return e; };
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': last(who.name) + ' price over the last ' + Math.round((t1 - t0) / 60) + ' minutes, now ' + cents(ys[ys.length - 1]) });
    [lo, (lo + hi) / 2, hi].forEach(function (v) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
      svg.appendChild(s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--muted)' }, Math.round(v * 100) + '¢'));
    });
    if (has(d.pre)) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(f(d.pre)), y2: Y(f(d.pre)), stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
    }
    var marks = [];
    if (d.score && d.score.start) marks.push([Date.parse(d.score.start) / 1000, 'start']);
    if (d.set1 && d.set1.ended) marks.push([d.set1.ended, 'set 1 over']);
    marks.forEach(function (mk) {
      if (mk[0] <= t0 || mk[0] >= t1) return;
      svg.appendChild(s('line', { x1: X(mk[0]), x2: X(mk[0]), y1: T, y2: H - Bm, stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
      svg.appendChild(s('text', { x: X(mk[0]), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, mk[1]));
    });
    svg.appendChild(s('polyline', { points: pts.map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(f(p[1])).toFixed(1); }).join(' '), fill: 'none', stroke: favA ? 'var(--pa)' : 'var(--pb)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    var ly = Y(ys[ys.length - 1]);
    svg.appendChild(s('circle', { cx: X(t1), cy: ly, r: 4, fill: favA ? 'var(--pa)' : 'var(--pb)' }));
    svg.appendChild(s('text', { x: X(t1) + 8, y: ly + 5, 'font-size': 14, 'font-weight': 600, fill: 'var(--fg)' }, cents(ys[ys.length - 1])));
    svg.appendChild(s('text', { x: L, y: H - 6, 'font-size': 11, fill: 'var(--muted)' }, clock(t0)));
    svg.appendChild(s('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, clock(t1)));
    box.appendChild(svg);
    if (has(d.pre)) box.appendChild(el('div', 'small', 'Dashed line: pre-match price ' + cents(f(d.pre)) + '.'));
  }

  function legend(d) {
    var l = el('div', 'legend');
    [['a', d.a.name], ['b', d.b.name]].forEach(function (x) { var s = el('span'); var i = el('i'); i.style.background = 'var(--p' + x[0] + ')'; add(s, i, document.createTextNode(x[1])); l.appendChild(s); });
    return l;
  }
  function split(label, a, b, extraA, extraB) {
    var w = el('div', 'split'); var tot = a + b;
    var lab = el('div', 'lab'); add(lab, el('span', '', label), el('span', '', tot > 0 ? Math.round(100 * Math.max(a, b) / tot) + '% ' + (a >= b ? 'left' : 'right') : 'none'));
    var bar = el('div', 'bar'); var ia = el('i', 'a'); var ib = el('i', 'b');
    ia.style.width = (tot > 0 ? 100 * a / tot : 0) + '%'; ib.style.width = (tot > 0 ? 100 * b / tot : 0) + '%'; add(bar, ia, ib);
    var amt = el('div', 'amt'); add(amt, el('span', 'ca', usd(a) + (extraA || '')), el('span', 'cb', usd(b) + (extraB || '')));
    return add(w, lab, bar, amt);
  }
  function sideSplit(label, a, b, d, extraA, extraB) {
    var w = split(label, a, b, extraA, extraB); var tot = a + b;
    w.firstChild.lastChild.textContent = tot > 0 ? Math.round(100 * Math.max(a, b) / tot) + '% ' + last(a >= b ? d.a.name : d.b.name) : 'none';
    return w;
  }

  function flow(d) {
    var box = $('dFlow'); box.replaceChildren(); var f = d.flow;
    if (!f || !f.trades) { box.appendChild(el('div', 'small', 'No trades yet.')); return; }
    add(box, legend(d), sideSplit('Taker buys, last 5 min', f.m5.a, f.m5.b, d), sideSplit('Last 15 min', f.m15.a, f.m15.b, d));
    if (f.m60.covered) box.appendChild(sideSplit('Last 60 min', f.m60.a, f.m60.b, d));
    else if (f.since) box.appendChild(sideSplit('Since ' + clock(f.since) + ' (last ' + f.trades + ' trades)', f.all.a, f.all.b, d));
    if (f.big && f.big.length) {
      add(box, el('div', 'small', 'Biggest recent single trades ($2k+)'));
      var rows = el('div', 'rows');
      f.big.forEach(function (t) { var r = el('div'); add(r, add(el('span', 'l'), el('span', t.side === 'a' ? 'ca' : 'cb', last(d[t.side].name)), document.createTextNode(' at ' + cents(t.price))), el('span', 'r', usd(t.usd) + ' · ' + clock(t.t))); rows.appendChild(r); });
      box.appendChild(rows);
    }
    box.appendChild(el('div', 'small', 'Who is hitting the ask. It shows urgency, not who is right.'));
  }

  function whales(d, w) {
    var box = $('dWhales'); box.replaceChildren();
    if (!w || w.none) { box.appendChild(el('div', 'small', 'Polymarket does not list this match, so there is no wallet data.')); return; }
    var g = w.groups; var n = function (x) { return ' · ' + x + 'w'; };
    add(box, legend(d));
    var rows = [['Wallets winning at tennis lately', g.winner], ['Wallets losing at tennis lately', g.loser], ['About break-even at tennis', g.flat], ['Little tennis history', g.thin], ['Smaller wallets, not graded', g.rest]];
    rows.forEach(function (r) { if (r[1][2] + r[1][3] > 0) box.appendChild(sideSplit(r[0], r[1][0], r[1][1], d, n(r[1][2]), n(r[1][3]))); });
    add(box, el('div', 'small', 'Largest net positions and each wallet\'s recent tennis record'));
    var t = el('div', 'rows');
    (w.rows || []).forEach(function (p) {
      var r = el('div'); var l = el('span', 'l');
      add(l, el('span', p.side === 'a' ? 'ca' : 'cb', last(d[p.side].name)), document.createTextNode(' · ' + p.name + (p.hedged ? ' (both sides)' : '')));
      var tn = p.tennis; var rec = !tn || !tn.matches ? 'No tennis in recent history' : 'Tennis ' + signed(tn.net) + ' over ' + tn.matches + ' matches, won ' + Math.round(100 * tn.won / tn.matches) + '%';
      add(l, el('div', 'small', rec + (has(p.lifetime) ? ' · all markets ' + signed(p.lifetime) : '')));
      add(r, l, el('span', 'r', usd(p.usd) + ' at ' + cents(p.avg))); t.appendChild(r);
    });
    box.appendChild(t);
    box.appendChild(el('div', 'small', 'Each wallet is netted across both players. The ' + w.graded + ' biggest of ' + w.counted + ' wallets with $' + w.minStake + '+ are graded on tennis match bets in their last 2,000 closed positions, after fees and counting losing bets they never redeemed. Winning or losing means at least $2k either way over 15+ matches. Lifetime profit in other sports says nothing about tennis. Updated ' + new Date(w.asOf).toLocaleTimeString() + '.'));
  }

  function form(d, f) {
    var box = $('dForm'); box.replaceChildren();
    if (!f) { box.appendChild(el('div', 'small', 'No results found.')); return; }
    ['a', 'b'].forEach(function (k) {
      var p = f[k]; var hd = el('div', 'top');
      var wl = el('span', 'wl'); p.results.slice().reverse().forEach(function (r) { wl.appendChild(el('i', r.won ? 'w' : 'x', r.won ? 'W' : 'L')); });
      add(hd, el('b', k === 'a' ? 'ca' : 'cb', d[k].name), el('span', 'small', p.results.length ? p.w + '-' + p.l + ' in the last ' + p.results.length + ', streak ' + p.streak : 'no recent matches on Kalshi'));
      add(box, hd, p.results.length ? wl : null);
      if (p.threeSet) box.appendChild(el('div', 'small', 'Three-set matches in that run: won ' + p.threeSet.won + ' of ' + p.threeSet.played + '.'));
      var rows = el('div', 'rows');
      p.results.slice(0, 6).forEach(function (r) { var x = el('div'); var l = el('span', 'l', (r.won ? 'Beat ' : 'Lost to ') + r.vs); l.appendChild(el('div', 'small', (r.tournament || '').replace(/^(ATP|WTA) /, '').slice(0, 34) + ', ' + day(r.t))); add(x, l, el('span', 'r ' + (r.won ? 'up' : 'down'), r.score || (r.won ? 'won' : 'lost'))); rows.appendChild(x); });
      if (p.results.length) box.appendChild(rows);
    });
    box.appendChild(el('div', 'small', 'Last 75 days from settled Kalshi markets, oldest on the left. Scores from Polymarket where it listed the match.'));
    var hb = $('dH2h'); hb.replaceChildren(); var h = f.h2h || { wins: [0, 0], meetings: [] };
    if (!h.meetings.length) { hb.appendChild(el('div', 'small', 'No meetings on record since ' + (h.since || 2015) + '. Lower-level pairings are not all covered.' + (h.missing ? ' The history table failed to load.' : ''))); return; }
    var g = el('div', 'big2');
    ['a', 'b'].forEach(function (k, i) { var c = el('div'); add(c, el('div', 'v ' + (k === 'a' ? 'ca' : 'cb'), String(h.wins[i])), el('div', 'l', last(d[k].name) + ' wins')); g.appendChild(c); });
    var rows2 = el('div', 'rows');
    h.meetings.forEach(function (x) { var r = el('div'); var l = el('span', 'l'); add(l, el('span', x.winner === 'a' ? 'ca' : 'cb', last(d[x.winner].name)), document.createTextNode(' won')); l.appendChild(el('div', 'small', x.tournament + (x.surface ? ', ' + x.surface : '') + ', ' + new Date(x.t * 1000).toLocaleDateString([], { month: 'short', year: 'numeric' }))); add(r, l, el('span', 'r', x.score || '')); rows2.appendChild(r); });
    add(hb, g, rows2, el('div', 'small', 'Tour-level meetings since ' + h.since + '. Latest ' + h.meetings.length + ' shown.'));
  }

  function stats(d) {
    var box = $('dStats'); box.replaceChildren(); var a = d.stats.a, b = d.stats.b;
    if (!a && !b) { box.appendChild(el('div', 'small', 'Neither player is in the ratings table.')); return; }
    var kv = el('div', 'kv'); add(kv, el('span', 'k', ''), el('span', 'h', last(d.a.name)), el('span', 'h', last(d.b.name)));
    var row = function (k, fa) { add(kv, el('span', 'k', k), el('span', 'num', a ? fa(a) : '–'), el('span', 'num', b ? fa(b) : '–')); };
    row('Rating, all surfaces', function (p) { return String(p.elo); });
    row('Rating on ' + d.surface, function (p) { return has(p.surf) ? p.surf + ' (' + p.surfN + ')' : '–'; });
    row('Record, 12 months', function (p) { return p.w + '-' + p.l; });
    row('Serve points won', function (p) { return pct(p.sv); });
    row('Return points won', function (p) { return pct(p.rt); });
    var frac = function (x) { return x && x[1] ? Math.round(100 * x[0] / x[1]) + '% of ' + x[1] : '–'; };
    row('Wins after taking set 1', function (p) { return p.pt ? frac(p.pt.s1w) : '–'; });
    row('Comes back after losing set 1', function (p) { return p.pt ? frac(p.pt.s1l) : '–'; });
    row('Deciding sets won', function (p) { return p.pt ? frac(p.pt.dec) : '–'; });
    row('Tiebreaks won', function (p) { return p.pt ? frac(p.pt.tb) : '–'; });
    add(box, kv, el('div', 'small', 'Set patterns cover the two years to ' + d.model.through + '. Tour-level data to ' + d.model.through + '. Nothing newer is free, so treat these as background, not current form.' + (has(d.model.rating) ? ' Ratings alone make it ' + last(d.a.name) + ' ' + cents(d.model.rating) + '.' : '')));
  }

  function ai() {
    var box = $('dAi'); box.replaceChildren();
    if (cur.aiText) { add(box, el('div', 'ai', cur.aiText)); }
    var b = el('button', 'go', cur.aiText ? 'Write it again' : 'Write analysis'); b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true; b.textContent = 'Writing…'; var ev = cur.event;
      get('/api/ai?event=' + encodeURIComponent(ev)).then(function (r) {
        if (ev !== cur.event) return;
        if (r.off) { box.replaceChildren(el('div', 'small', 'Off. Add ANTHROPIC_API_KEY to this project in Vercel to get a Claude write-up here. The read at the top works without it.')); return; }
        cur.aiText = r.text || 'No text came back.'; ai();
      }).catch(function (e) { if (ev !== cur.event) return; b.disabled = false; b.textContent = 'Try again'; box.appendChild(el('div', 'small err', e.message)); });
    });
    add(box, b, cur.aiText ? null : el('div', 'small', 'Claude reads everything on this page and writes a short verdict. Runs only when you tap.'));
  }

  function renderDetail(d) {
    if (cur.kind === 'game') return;
    cur.d = d;
    var ff = d.score && d.score.live ? feedFor(d, d.score.sets) : null; var auto = ff ? ff.server : null; var ap = ff && ff.points && auto ? ff.points.join('-') : null;
    if (auto !== (cur.auto || null) || ap !== (cur.autoPts || null)) { cur.auto = auto; cur.autoPts = ap; if (!cur.srv) { loadDetail(); } }
    head(d); read(d); calc(d); modelBox(d); chart(d); flow(d); stats(d);
    var hb = $('dHist'); hb.replaceChildren();
    if (d.history && d.history.length) { var ul = el('ul', 'plain'); d.history.forEach(function (t) { ul.appendChild(el('li', '', t)); }); add(hb, ul, el('div', 'small', 'From ' + d.historyN + ' settled Kalshi matches this year and tour results since 2011. These are base rates for the spot, not a prediction for this match.')); }
    else hb.appendChild(el('div', 'small', 'No matching history for this spot.'));
    var s = $('dStatus'); s.replaceChildren(); add(s, document.createTextNode('Updated '), el('b', '', new Date(d.asOf).toLocaleTimeString()), document.createTextNode(' · refreshes every 10s'));
    if (cur.whales !== undefined) whales(d, cur.whales);
    if (cur.form !== undefined) form(d, cur.form);
  }
  function loadDetail() {
    var ev = cur.event; if (!ev) return;
    if (cur.kind === 'game') { loadGame(); return; }
    var sv = cur.srv || cur.auto; var seq = cur.seq = (cur.seq || 0) + 1; // a slower, older answer must not overwrite a newer one
    get('/api/match?event=' + encodeURIComponent(ev) + (sv ? '&srv=' + sv : '') + (!cur.srv && cur.auto && cur.autoPts ? '&pts=' + encodeURIComponent(cur.autoPts) : '')).then(function (d) { if (ev === cur.event && seq === cur.seq) renderDetail(d); })
      .catch(function (e) { if (ev === cur.event) $('dStatus').replaceChildren(el('span', 'err', e.message + (cur.d ? ' Showing the last data.' : ''))); });
  }
  function loadWhales() {
    var ev = cur.event; if (!ev) return;
    get('/api/whales?event=' + encodeURIComponent(ev)).then(function (w) { if (ev !== cur.event) return; cur.whales = w; if (cur.d) whales(cur.d, w); })
      .catch(function () { if (ev === cur.event && cur.whales === undefined) $('dWhales').replaceChildren(el('div', 'small err', 'Could not load Polymarket wallets. Will retry.')); });
  }
  function loadForm() {
    var ev = cur.event; if (!ev) return;
    get('/api/form?event=' + encodeURIComponent(ev)).then(function (f) { if (ev !== cur.event) return; cur.form = f; if (cur.d) form(cur.d, f); })
      .catch(function () { if (ev === cur.event) $('dForm').replaceChildren(el('div', 'small err', 'Could not load results.')); });
  }


  // ---------- whales tab ----------
  var wb = { filter: 'strong', data: null, kalshi: null, prev: 0, shown: 30, timers: [] };
  var ago = function (t) { if (!t) return ''; var s = Math.max(0, Date.now() / 1000 - t); return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  var recText = function (c) { return signed(c.net) + (c.n ? ' over ' + c.n + ' markets' : '') + ' (' + (c.roi >= 0 ? '+' : '−') + Math.abs(c.roi * 100).toFixed(1) + '%)'; };
  function trio(pairs) { var t = el('div', 'trio'); pairs.forEach(function (x) { var c = el('div'); add(c, el('span', '', x[0]), el('b', x[2] || '', x[1])); t.appendChild(c); }); return t; }
  function betCard(b, d, withName) {
    var c = el('button', 'bet'); c.type = 'button'; var w = d.whales[b.who];
    var who = el('div', 'who'); add(who, el('b', '', withName ? w.name : b.cat), el('span', '', ago(b.last)));
    var diff = b.cur - b.avg;
    add(c, withName ? el('span', 'av', w.name.replace(/^0x/, '').charAt(0)) : null, who, el('div', 'bet-t', b.outcome), el('div', 'sub', b.title),
      trio([['Size', usd(b.usd)], ['Paid', cents(b.avg)], ['Now', cents(b.cur), Math.abs(diff) < 0.005 ? '' : diff > 0 ? 'up' : 'down']]));
    if (!withName) { who.style.gridColumn = '1 / -1'; c.children[1].style.gridColumn = '1 / -1'; }
    var foot = el('div', 'foot');
    foot.appendChild(el('span', 'chip' + (b.grade === 'strong' ? ' good' : b.grade === 'weak' ? ' bad' : ''), b.rec ? b.cat + ' record ' + signed(b.rec.net) + (b.rec.n ? ' over ' + b.rec.n : '') : b.cat + ', no graded record'));
    if (b.first && wb.prev && b.first > wb.prev) foot.appendChild(el('span', 'chip window', 'New'));
    if (pins[b.cond]) foot.appendChild(el('span', 'chip', 'Pinned'));
    c.appendChild(foot);
    c.addEventListener('click', function () { openSheet(b, d); });
    return c;
  }

  // ---------- action sheet for one bet ----------
  var pins = {}; try { pins = JSON.parse(localStorage.getItem('ce-pins') || '{}') || {}; } catch (e) { pins = {}; }
  var sheetKey = 0;
  function closeSheet() { sheetKey++; var sh = $('sheet'); sh.classList.remove('on'); $('scrim').hidden = true; setTimeout(function () { if (!sh.classList.contains('on')) sh.hidden = true; }, 240); }
  function sheetShell(title, sub, back) {
    var box = $('sheetIn'); box.replaceChildren(); box.appendChild(el('div', 'grab'));
    if (back) { var bk = el('button', 'back x', '‹ Back'); bk.type = 'button'; bk.addEventListener('click', back); box.appendChild(bk); }
    add(box, el('h3', '', title), sub ? el('div', 'small', sub) : null);
    return box;
  }
  function act(rows, label, fn, href) {
    var r = href ? el('a') : el('button'); if (href) { r.href = href; r.target = '_blank'; r.rel = 'noopener'; } else { r.type = 'button'; r.addEventListener('click', fn); }
    r.appendChild(el('span', 'l', label)); rows.appendChild(r);
  }
  function openSheet(b, d) {
    var w = d.whales[b.who]; var menu = function () { openSheet(b, d); };
    var box = sheetShell(w.name + ' on ' + b.outcome, b.title);
    box.appendChild(trio([['Size', usd(b.usd)], ['Paid', cents(b.avg)], ['Now', cents(b.cur)]]));
    var rows = el('div', 'rows');
    act(rows, 'Their trades in this market', function () { sheetTrades(b, w, menu); });
    act(rows, 'Who else holds this market', function () { sheetHolders(b, menu); });
    act(rows, 'Where ' + w.name + ' wins and loses', function () { sheetProfile(b.w, w.name, menu); });
    act(rows, 'Their latest trades anywhere', function () { sheetProfile(b.w, w.name, menu, true); });
    act(rows, 'Open the event on Polymarket', null, 'https://polymarket.com/event/' + encodeURIComponent(b.slug));
    act(rows, 'Open their Polymarket profile', null, 'https://polymarket.com/profile/' + b.w);
    act(rows, pins[b.cond] ? 'Unpin this market' : 'Pin this market', function () { if (pins[b.cond]) delete pins[b.cond]; else pins[b.cond] = 1; try { localStorage.setItem('ce-pins', JSON.stringify(pins)); } catch (e) {} renderWhales(); openSheet(b, d); });
    act(rows, 'Copy wallet address', function (ev) { var t = ev.currentTarget.firstChild; var done = function () { t.textContent = 'Copied ' + b.w.slice(0, 8) + '…'; }; if (navigator.clipboard) navigator.clipboard.writeText(b.w).then(done, function () { t.textContent = b.w; }); else t.textContent = b.w; });
    box.appendChild(rows);
    var cl = el('button', 'go', 'Close'); cl.type = 'button'; cl.addEventListener('click', closeSheet); box.appendChild(cl);
    var sh = $('sheet'); sh.hidden = false; $('scrim').hidden = false; sh.scrollTop = 0; requestAnimationFrame(function () { sh.classList.add('on'); });
  }
  function sheetLoad(title, sub, back, url, render) {
    var key = ++sheetKey; var box = sheetShell(title, sub, back); var hold = el('div', 'small', 'Loading…'); box.appendChild(hold);
    get(url).then(function (r) { if (key !== sheetKey) return; hold.remove(); render(box, r); })
      .catch(function (e) { if (key === sheetKey) hold.textContent = 'Could not load this (' + e.message + '). Go back and try again.'; });
  }
  function tradeRows(list, withTitle) {
    var rows = el('div', 'rows');
    list.forEach(function (t) { var r = el('div'); var l = el('span', 'l', (t.side === 'SELL' ? 'Sold ' : 'Bought ') + t.outcome); if (withTitle) l.appendChild(el('div', 'small', t.title + ' · ' + t.cat)); add(r, l, el('span', 'r', usd(t.usd) + ' at ' + cents(t.price) + ' · ' + ago(t.t))); rows.appendChild(r); });
    return rows;
  }
  function sheetTrades(b, w, back) {
    sheetLoad(w.name + ' in this market', b.title, back, '/api/wallet?w=' + b.w + '&cond=' + b.cond, function (box, r) {
      if (!r.here.length) { box.appendChild(el('div', 'small', 'No trades found for this market.')); return; }
      var buys = {}; r.here.forEach(function (t) { if (t.side === 'BUY') buys[t.outcome] = (buys[t.outcome] || 0) + t.usd; });
      var ks = Object.keys(buys); if (ks.length > 1) box.appendChild(el('div', 'verdict watch', 'They bought both sides here: ' + ks.map(function (k) { return usd(buys[k]) + ' on ' + k; }).join(', ') + '. That is hedging or market making, not a one-way view.'));
      add(box, el('div', 'small', 'Latest ' + r.here.length + ' fills, newest first'), tradeRows(r.here, false));
    });
  }
  function sheetHolders(b, back) {
    sheetLoad('Who holds this market', b.title, back, '/api/wallet?cond=' + b.cond, function (box, r) {
      r.sides.forEach(function (sd) {
        add(box, el('h2', '', sd.outcome + ': ' + usd(sd.total) + ' across ' + sd.count + ' wallets'));
        var rows = el('div', 'rows');
        sd.top.forEach(function (h) { var row = el('div'); var l = el('span', 'l', h.name); if (h.tracked) l.appendChild(el('div', 'small', h.rec ? 'Tracked. ' + r.cat + ' record ' + signed(h.rec.net) + (h.rec.n ? ' over ' + h.rec.n : '') : 'Tracked, no ' + r.cat + ' record')); add(row, l, el('span', 'r', usd(h.usd) + ' at ' + cents(h.avg))); rows.appendChild(row); });
        box.appendChild(rows);
      });
      box.appendChild(el('div', 'small', 'Holders of $50 or more, by current value.' + (r.partial ? ' Very large market, so the list may be cut short.' : '')));
    });
  }
  function sheetProfile(wallet, name, back, tradesFirst) {
    sheetLoad(name, tradesFirst ? 'Latest trades in any market' : 'Category record', back, '/api/wallet?w=' + wallet, function (box, r) {
      box.appendChild(trio([['All time', has(r.pnl) ? signed(r.pnl) : 'n/a', r.pnl >= 0 ? 'up' : 'down'], ['Last 30 days', has(r.month) ? signed(r.month) : 'n/a', r.month >= 0 ? 'up' : 'down'], ['Volume', has(r.volume) ? usd(r.volume) : 'n/a']]));
      var cats = function () {
        if (!r.cats) { box.appendChild(el('div', 'small', 'This wallet is not one of the tracked ones, so there is no category record for it yet.')); return; }
        var rows = el('div', 'rows');
        r.cats.forEach(function (c) { var row = el('div'); add(row, add(el('span', 'l'), el('span', 'chip' + (c.grade === 'strong' ? ' good' : c.grade === 'weak' ? ' bad' : ''), c.k), document.createTextNode(c.n ? '  ' + c.n + ' markets' : '')), el('span', 'r ' + (c.net >= 0 ? 'up' : 'down'), signed(c.net) + ' (' + (c.roi >= 0 ? '+' : '−') + Math.abs(c.roi * 100).toFixed(1) + '%)')); rows.appendChild(row); });
        add(box, el('h2', '', 'By category'), rows);
        if (r.complete === false) box.appendChild(el('div', 'small', 'Graded on the most recent 20,000 positions only.'));
      };
      var trades = function () { add(box, el('h2', '', 'Latest trades'), r.recent.length ? tradeRows(r.recent.slice(0, 25), true) : el('div', 'small', 'No recent trades.')); };
      if (tradesFirst) { trades(); cats(); } else { cats(); trades(); }
    });
  }
  $('scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

  function renderWhales() {
    var d = wb.data; if (!d) return;
    var seg = $('wFilter'); seg.replaceChildren();
    [['strong', 'Best category'], ['weak', 'Worst category'], ['all', 'All bets'], ['pin', 'Pinned']].forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(wb.filter === o[0]));
      b.addEventListener('click', function () { wb.filter = o[0]; wb.shown = 30; renderWhales(); }); seg.appendChild(b);
    });
    var list = d.bets.filter(function (b) { return wb.filter === 'all' || (wb.filter === 'pin' ? !!pins[b.cond] : b.grade === wb.filter); });
    var box = $('wBets'); box.replaceChildren();
    if (!list.length) box.appendChild(el('div', 'empty', wb.filter === 'pin' ? 'Nothing pinned. Tap a bet and choose Pin this market to keep it here.' : 'No open bets of $1k+ in this group right now.'));
    list.slice(0, wb.shown).forEach(function (b) { box.appendChild(betCard(b, d, true)); });
    if (list.length > wb.shown) { var m = el('button', 'go', 'Show ' + Math.min(30, list.length - wb.shown) + ' more'); m.type = 'button'; m.addEventListener('click', function () { wb.shown += 30; renderWhales(); }); box.appendChild(m); }
    var wl = $('wWhales'); var openNames = {}; wl.querySelectorAll('details[open]').forEach(function (x) { openNames[x.dataset.name] = 1; }); wl.replaceChildren();
    d.whales.forEach(function (w, k) {
      var c = el('details', 'card'); c.dataset.name = w.name; if (openNames[w.name]) c.open = true;
      var sm = el('summary'); var top = el('div', 'top');
      add(top, el('b', '', w.name), el('span', 'small', 'all time ' + signed(w.pnl) + (has(w.month) && Math.abs(w.month) >= 1000 ? ' · 30 days ' + signed(w.month) : '')));
      var ch = el('div', 'chips');
      w.strong.forEach(function (x) { ch.appendChild(el('span', 'chip good', x.k + ' ' + signed(x.net))); });
      w.weak.forEach(function (x) { ch.appendChild(el('span', 'chip bad', x.k + ' ' + signed(x.net))); });
      add(sm, top, ch, el('div', 'more', w.open ? w.open + ' open bets, ' + usd(w.openUsd) + (w.inStrong ? ' · ' + w.inStrong + ' in a strong category' : '') + ' ▾' : 'No open bets of $1k+'));
      c.appendChild(sm);
      var mine = d.bets.filter(function (b) { return b.who === k; });
      var inner = el('div', 'list'); inner.style.marginTop = '10px';
      w.strong.concat(w.weak).forEach(function (x) { inner.appendChild(el('div', 'small', x.k + ': ' + recText(x))); });
      if (!w.complete) inner.appendChild(el('div', 'small', 'Graded on the most recent 20,000 positions only.'));
      var pb = el('button', 'go', 'Record and latest trades'); pb.type = 'button'; pb.addEventListener('click', function () { sheetProfile(w.w, w.name, closeSheet); var sh = $('sheet'); sh.hidden = false; $('scrim').hidden = false; requestAnimationFrame(function () { sh.classList.add('on'); }); }); inner.appendChild(pb);
      mine.forEach(function (b) { inner.appendChild(betCard(b, d, false)); });
      c.appendChild(inner); wl.appendChild(c);
    });
    var s = $('wStatus'); s.replaceChildren();
    add(s, document.createTextNode('Updated '), el('b', '', new Date(d.asOf).toLocaleTimeString()), document.createTextNode(' · ' + d.whales.length + ' wallets · records built ' + d.built + ' · refreshes every minute'));
  }
  function renderKalshi() {
    var k = wb.kalshi; var box = $('wKalshi'); if (!k) return; box.replaceChildren();
    var nm = function (t) { var x = k.names[t]; return x ? (x.title + (x.sub && x.title.indexOf(x.sub) < 0 ? ' · ' + x.sub : '')) : t; };
    box.appendChild(el('div', 'small', k.visible + ' of the ' + k.scanned + ' accounts on Kalshi\'s profit leaderboards show their positions. These ' + k.profiles.length + ' are up $50k+ and active.'));
    k.profiles.forEach(function (p) {
      var c = el('details', 'card'); var sm = el('summary'); var top = el('div', 'top');
      add(top, el('b', '', p.nick), el('span', 'small', 'profit ' + signed(p.pnl)));
      var ch = el('div', 'chips');
      (p.cats || []).forEach(function (x) { ch.appendChild(el('span', 'chip good', x[0] + ' ' + signed(x[1]))); });
      if (!(p.cats || []).length) (p.top || []).forEach(function (x) { ch.appendChild(el('span', 'chip', 'trades ' + x)); });
      if (p.bot) ch.appendChild(el('span', 'chip bad', 'high frequency · ' + usd(p.markets).replace('$', '') + ' markets'));
      add(sm, top, ch, el('div', 'more', p.holdCount + ' open positions · last trade ' + (p.last ? ago(p.last) : 'not shown') + ' ▾'));
      c.appendChild(sm);
      var inner = el('div', 'rows'); inner.style.marginTop = '8px';
      if (p.trades.length) inner.appendChild(el('div', 'small', 'Latest trades of $100+'));
      p.trades.forEach(function (t) { var r = el('a'); r.href = 'https://kalshi.com/markets/' + encodeURIComponent(t.ticker.toLowerCase()); r.target = '_blank'; r.rel = 'noopener'; var l = el('span', 'l', t.side + ' on ' + nm(t.ticker) + (t.resting ? ' (resting order)' : '')); l.appendChild(el('div', 'small', usd(t.usd) + ' at ' + cents(t.avg) + ', ' + ago(t.t))); r.appendChild(l); inner.appendChild(r); });
      if (p.holds.length) inner.appendChild(el('div', 'small', 'Biggest open positions'));
      p.holds.forEach(function (h) { var r = el('a'); r.href = 'https://kalshi.com/markets/' + encodeURIComponent(h.ticker.toLowerCase()); r.target = '_blank'; r.rel = 'noopener'; var l = el('span', 'l', h.side + ' on ' + nm(h.ticker)); l.appendChild(el('div', 'small', usd(h.qty).replace('$', '') + ' contracts, ' + signed(h.pnl) + ' so far')); r.appendChild(l); inner.appendChild(r); });
      var kp = el('a'); kp.href = 'https://kalshi.com/ideas/profiles/' + encodeURIComponent(p.nick); kp.target = '_blank'; kp.rel = 'noopener'; kp.appendChild(el('span', 'l', 'Open ' + p.nick + ' on Kalshi')); inner.appendChild(kp);
      if (!p.trades.length && !p.holds.length) inner.appendChild(el('div', 'small', 'Nothing open and no recent trades of $100+.'));
      c.appendChild(inner); box.appendChild(c);
    });
  }
  function loadWhaleboard() {
    get('/api/whaleboard').then(function (d) { wb.data = d; renderWhales(); try { localStorage.setItem('ce-whales-seen', String(Math.floor(Date.now() / 1000))); } catch (e) {} })
      .catch(function (e) { $('wStatus').replaceChildren(el('span', 'err', 'Could not load whale bets (' + e.message + '). Retrying.')); });
    get('/api/kalshi-profiles').then(function (k) { wb.kalshi = k; renderKalshi(); })
      .catch(function () { if (!wb.kalshi) $('wKalshi').replaceChildren(el('div', 'empty', 'Could not load Kalshi profiles. Will retry.')); });
  }
  function openWhales() {
    try { wb.prev = wb.prev || parseInt(localStorage.getItem('ce-whales-seen') || '0', 10) || 0; } catch (e) { wb.prev = 0; }
    loadWhaleboard();
    wb.timers.push(setInterval(function () { if (!document.hidden) loadWhaleboard(); }, 60000));
  }

  var DETAIL_BOXES = ['dHead', 'dRead', 'dCalc', 'dModel', 'dHist', 'dChart', 'dFlow', 'dStats', 'gdInj', 'gdFair', 'gdLines', 'gdStr', 'gdForm', 'gdWal'];
  var dtab = 'overview'; try { dtab = localStorage.getItem('ce-dtab') || 'overview'; } catch (e) {}
  // Which sections show: the ones for this kind of match that belong to the chosen tab.
  function detailKind(game) {
    if (['overview', 'scenarios', 'activity'].indexOf(dtab) < 0) dtab = 'overview';
    document.querySelectorAll('#detailView [data-tab]').forEach(function (e) { e.hidden = e.dataset.tab !== dtab || (game ? e.classList.contains('only-t') : e.classList.contains('only-g')); });
    var box = $('dTabs'); box.replaceChildren();
    [['overview', 'Overview'], ['scenarios', 'Scenarios'], ['activity', 'Activity']].forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(dtab === o[0]));
      b.addEventListener('click', function () { dtab = o[0]; try { localStorage.setItem('ce-dtab', dtab); } catch (e) {} detailKind(cur.kind === 'game'); });
      box.appendChild(b);
    });
    paintSave();
  }
  function openDetail(ev) {
    cur.timers.forEach(clearInterval);
    cur = { event: ev, srv: null, d: null, timers: [], aiText: null };
    show('detailView'); detailKind(false); $('back').textContent = '‹ Back'; window.scrollTo(0, 0);
    DETAIL_BOXES.forEach(function (id) { $(id).replaceChildren(); });
    $('dWhales').replaceChildren(el('span', 'small', 'Loading wallets…')); $('dForm').replaceChildren(el('span', 'small', 'Loading results…')); $('dH2h').replaceChildren(el('span', 'small', 'Loading meetings…'));
    $('dStatus').textContent = 'Loading…'; ai();
    loadDetail(); loadWhales(); loadForm();
    cur.timers.push(setInterval(function () { if (!document.hidden) loadDetail(); }, DETAIL_MS));
    cur.timers.push(setInterval(function () { if (!document.hidden) loadWhales(); }, WHALE_MS));
  }
  function show(view) {
    ['discoverView', 'detailView', 'whalesView', 'watchView', 'positionsView', 'alertsView'].forEach(function (id) { $(id).hidden = id !== view; });
    document.body.classList.toggle('on-detail', view === 'detailView'); // phones swap the tab bar for the action bar on a matchup
    var tab = { discoverView: 'tabD', whalesView: 'tabWh', watchView: 'tabWa', positionsView: 'tabP', alertsView: 'tabA' }[view];
    ['tabD', 'tabWa', 'tabP', 'tabA', 'tabWh'].forEach(function (id) { if (id === tab) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); });
  }
  var place = {}; var lastList = ''; var prevHash;
  var backTo = function (h) { var y = place[h] || 0; requestAnimationFrame(function () { window.scrollTo(0, y); }); }; // return to where the list was left
  function route() {
    wb.timers.forEach(clearInterval); wb.timers = [];
    var h = location.hash === '#' ? '' : location.hash;
    if (h === '#journal') { location.replace('#positions'); return; }
    if (prevHash !== undefined && !/^#m=/.test(prevHash)) place[prevHash] = window.scrollY;
    prevHash = h;
    var m = /^#m=(.+)$/.exec(location.hash);
    if (!m) lastList = h;
    if (m) { var ev = decodeURIComponent(m[1]); var league = leagueOf(ev); if (league) openGame(league, ev); else openDetail(ev); return; }
    cur.timers.forEach(clearInterval); cur = { event: null, srv: null, d: null, timers: [], aiText: null };
    var sp = h === '#nba' ? 'nba' : h === '#nfl' ? 'nfl' : h === '#tennis' ? 'tennis' : null; // old links to one sport
    if (sp) { D.sport = sp; try { localStorage.setItem('ce-sport2', sp); } catch (e) {} location.replace('#'); return; }
    if (h === '#whales') { show('whalesView'); openWhales(); badge(); backTo(h); return; }
    if (h === '#alerts') { show('alertsView'); mine = 0; renderRules(); renderAlerts(); badge(); loadLogger(); pullRules(); loadInjuries(); setTimeout(function () { al.fresh = {}; }, 60000); backTo(h); return; }
    if (h === '#watch') { show('watchView'); loadWatch(); badge(); backTo(h); return; }
    if (h === '#positions') { show('positionsView'); renderJournal(); badge(); backTo(h); return; }
    show('discoverView'); drawFilters(); renderDiscover(); loadDiscover(); badge(); backTo(h);
  }


  // ---------- cost to act, and your own journal ----------
  var J = []; try { J = JSON.parse(localStorage.getItem('ce-journal') || '[]') || []; } catch (e) { J = []; }
  var saveJ = function () { try { localStorage.setItem('ce-journal', JSON.stringify(J)); } catch (e) {} };
  var takerFee = function (p, n) { return Math.ceil(0.07 * n * p * (1 - p) * 100 - 1e-9) / 100; }; // Kalshi rounds the fee up per order
  var makerFee = function (p, n) { return Math.ceil(0.0175 * n * p * (1 - p) * 100 - 1e-9) / 100; }; // smaller fee some markets charge on resting orders
  var money = function (x) { return (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2); };
  var cs = { side: 'a', stake: 50, mode: 'take' }; try { cs.stake = parseFloat(localStorage.getItem('ce-stake')) || 50; } catch (e) {}
  // One cent above the bid, unless that would reach the ask and trade straight away. Then join the bid.
  function restPrice(p) { if (!has(p.bid)) return null; var up = Math.round((p.bid + 0.01) * 100) / 100; return !has(p.ask) || up < p.ask - 1e-9 ? up : p.bid; }
  function quote(d) {
    var p = d[cs.side]; var price = cs.mode === 'take' ? p.ask : restPrice(p);
    if (!has(price) || price <= 0 || price >= 1) return null;
    var n = Math.floor(cs.stake / price); var fee = cs.mode === 'take' ? takerFee(price, n) : d.makerFee ? makerFee(price, n) : 0; var cost = n * price + fee;
    var fair = d.model.live ? (cs.side === 'a' ? d.model.live.a : 1 - d.model.live.a) : null;
    return { price: price, n: n, fee: fee, cost: cost, be: n ? cost / n : null, fair: fair };
  }
  function calcOut(d) {
    var out = $('calcOut'); if (!out) return; out.replaceChildren(); var q = quote(d);
    if (!q || !q.n) { out.appendChild(el('div', 'small', q ? 'Stake is smaller than one contract.' : 'No price to trade at right now.')); return; }
    var kv = el('div', 'kv2'); var row = function (k, v, cls) { add(kv, el('span', 'k', k), el('span', 'v ' + (cls || ''), v)); };
    row(cs.mode === 'take' ? 'Buy at the ask' : 'Rest an order at', cents(q.price)); row('Contracts', String(q.n));
    row('Fee', cs.mode === 'take' ? money(q.fee) : d.makerFee ? money(q.fee) + ' if it fills' : 'usually $0 if it rests'); row('Total cost', money(q.cost));
    row('You need to win', (q.be * 100).toFixed(1) + '% of the time'); row('If it wins', '+' + money(q.n - q.cost).replace('−', ''), 'up'); row('If it loses', money(-q.cost), 'down');
    out.appendChild(kv);
    if (has(q.fair)) out.appendChild(el('div', 'small', 'Model has ' + last(d[cs.side].name) + ' at ' + (q.fair * 100).toFixed(0) + '%, against the ' + (q.be * 100).toFixed(1) + '% you need. ' + (q.fair > q.be + 0.02 ? 'Above break-even on the model, which has not been proven against this market.' : 'Not above break-even.')));
    if (cs.mode === 'rest') out.appendChild(el('div', 'small', 'A resting order only fills if someone sells to you, often right after the score moves against you.' + (d.makerFee ? ' This market charges a small fee on resting orders too, about a quarter of the normal one. It is included above.' : ' Check the fee schedule for this market before relying on zero fees.')));
    var mine = J.filter(function (x) { return x.event === d.event && x.status === 'open'; });
    mine.forEach(function (x) {
      var bid = d[x.side].bid; if (!has(bid)) return; var f2 = takerFee(bid, x.qty); var back = x.qty * bid - f2; var free = Math.min(x.qty, Math.ceil(x.cost / Math.max(0.01, bid - 0.07 * bid * (1 - bid))));
      out.appendChild(el('div', 'verdict', 'Your ' + x.qty + ' on ' + last(d[x.side].name) + ' at ' + cents(x.price) + ': selling now at ' + cents(bid) + ' returns ' + money(back) + ' after a ' + money(f2) + ' fee, ' + (back - x.cost >= 0 ? 'up ' : 'down ') + money(Math.abs(back - x.cost)) + '.' + (bid > x.price && free < x.qty ? ' Sell ' + free + ' to get your stake back and let ' + (x.qty - free) + ' ride.' : '')));
    });
  }
  function calc(d) {
    var box = $('dCalc');
    if (box.dataset.ev !== d.event || !$('calcSide')) { // also rebuild when the box was cleared by reopening the same match
      box.dataset.ev = d.event; box.replaceChildren();
      if (has(d.pre) && d.pre < 0.5) cs.side = 'b'; else cs.side = 'a';
      if (d.read && d.read.side) cs.side = d.read.side;
      var sides = el('div', 'seg'); sides.id = 'calcSide'; var modes = el('div', 'seg'); modes.id = 'calcMode';
      var f1 = el('label', 'field', 'Stake in dollars'); var inp = el('input'); inp.type = 'number'; inp.inputMode = 'decimal'; inp.min = '1'; inp.step = '1'; inp.value = String(cs.stake); f1.appendChild(inp);
      inp.addEventListener('input', function () { cs.stake = Math.max(0, parseFloat(inp.value) || 0); try { localStorage.setItem('ce-stake', String(cs.stake)); } catch (e) {} if (cur.d) calcOut(cur.d); });
      var out = el('div'); out.id = 'calcOut'; out.style.display = 'flex'; out.style.flexDirection = 'column'; out.style.gap = '8px';
      var logB = el('button', 'go', 'Track this position'); logB.type = 'button';
      logB.addEventListener('click', function () {
        var dd = cur.d; var q = dd ? quote(dd) : null; if (!q || !q.n) return;
        J.unshift({ id: Date.now(), t: Math.floor(Date.now() / 1000), event: dd.event, ticker: dd[cs.side].ticker, target: defTarget(q.price), title: dd.a.name + ' v ' + dd.b.name, side: cs.side, name: dd[cs.side].name, price: q.price, qty: q.n, fee: q.fee, cost: q.cost, read: dd.read ? dd.read.level : 'none', readTitle: dd.read ? dd.read.title : '', fair: q.fair, status: 'open', exit: null });
        saveJ(); logB.textContent = 'Tracked. See Positions'; calcOut(dd); setTimeout(function () { logB.textContent = 'Track this position'; }, 2500);
      });
      add(box, sides, modes, f1, out, logB);
    }
    var sd = $('calcSide'); sd.replaceChildren();
    ['a', 'b'].forEach(function (k) { var b = el('button', '', last(d[k].name) + ' ' + cents(d[k].ask)); b.type = 'button'; b.setAttribute('aria-pressed', String(cs.side === k)); b.addEventListener('click', function () { cs.side = k; calc(cur.d); }); sd.appendChild(b); });
    var md = $('calcMode'); md.replaceChildren();
    [['take', 'Take the price now'], ['rest', 'Rest an order below the ask']].forEach(function (o) { var b = el('button', '', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(cs.mode === o[0])); b.addEventListener('click', function () { cs.mode = o[0]; calc(cur.d); }); md.appendChild(b); });
    calcOut(d);
  }
  function pnlOf(x) { return x.status === 'won' ? x.qty - x.cost : x.status === 'lost' ? -x.cost : x.status === 'sold' ? x.qty * x.exit - feeAt(venueOf(x), x.exit, x.qty) - x.cost : null; }
  // One open trade, built around getting out: entry, what it sells for now, the gain, and the target.
  // The price this position could be sold at right now, on its own venue, with how fresh that is.
  function sellQuote(x) {
    var v = venueOf(x);
    if (v === 'polymarket') { var q = Q.pm[x.event]; return { bid: q && q.bid ? q.bid[x.side === 'a' ? 0 : 1] : null, size: null, at: q ? q.t : 0, listed: !!q }; }
    var m = Q.by[x.event]; var sd = m && m[x.side]; return { bid: sd && has(sd.bid) && sd.bid > 0 ? sd.bid : null, size: sd && has(sd.bidSize) ? sd.bidSize : null, at: Q.at[feedOf(x.event)] || 0, listed: !!m };
  }
  function posCard(x) {
    var v = venueOf(x); var m = Q.by[x.event]; var sq = sellQuote(x); var bid = sq.bid; var tgt = has(x.target) ? x.target : null; var stp = has(x.stop) ? x.stop : null;
    var pl = has(bid) ? x.qty * bid - feeAt(v, bid, x.qty) - x.cost : null;
    var rules = R.filter(function (r) { return !r.fired && r.event === x.event && r.side === x.side; }); var ruleFor = function (op) { return rules.filter(function (r) { return r.op === op; })[0]; };
    var c = el('div', 'card pos'); var top = el('div', 'top'); var a = el('a', 'lnk'); a.href = '#m=' + encodeURIComponent(x.event); a.appendChild(el('b', '', x.name + ' to win'));
    add(top, a, el('span', 'chip' + (m && m.state !== 'upcoming' ? ' live' : ''), !m ? 'Not listed now' : m.state === 'upcoming' ? 'Not started' : m.state === 'closing' ? 'Settling' : 'In play'));
    add(c, top, el('div', 'small', VENUES[v] + ' · Entered by hand · ' + x.title + ' · ' + day(x.t) + ' ' + clock(x.t)));
    c.appendChild(trio([['Entry', x.qty + ' at ' + cents(x.price)], ['Sell price', cents(bid)], ['If sold now', has(pl) ? (pl >= 0 ? '+' : '') + money(pl) : '–', has(pl) ? (pl >= 0 ? 'up' : 'down') : '']]));
    // honesty about the quote: missing, old, or too thin for the whole position
    var age = sq.at ? Math.round((Date.now() - sq.at) / 1000) : null; var flags = [];
    if (!has(bid)) flags.push(sq.listed ? 'No one is bidding right now, so there is no sell price.' : v === 'polymarket' ? 'Polymarket quote unavailable right now.' : 'This market is not in the current list, so there is no quote.');
    else if (age !== null && age > 90) flags.push('Quote is ' + (age < 3600 ? Math.round(age / 60) + ' min' : 'over an hour') + ' old. Prices could not be refreshed.');
    if (has(bid) && has(sq.size) && sq.size < x.qty) flags.push('Only ' + Math.floor(sq.size) + ' of your ' + x.qty + ' contracts are bid at ' + cents(bid) + '. The rest would sell lower.');
    else if (has(bid) && !has(sq.size)) flags.push('Size available at this price is not known for ' + VENUES[v] + '.');
    flags.forEach(function (f) { var w = el('div', 'flag'); add(w, icon('alert'), el('span', '', f)); c.appendChild(w); });
    if (has(tgt) || has(stp)) {
      var kv = el('div', 'kv');
      var line = function (label, price, op) { var at = x.qty * price - feeAt(v, price, x.qty) - x.cost; var hit = has(bid) && (op === 'bid>=' ? bid >= price - 1e-9 : bid <= price + 1e-9); var r = ruleFor(op);
        add(kv, el('span', 'k', label + ' ' + cents(price) + (hit ? ', reached' : has(bid) ? ', ' + Math.abs(Math.round((price - bid) * 100)) + '¢ away' : '')), el('span', 'num ' + (at >= 0 ? 'up' : 'down'), (at >= 0 ? '+' : '') + money(at)), el('span', 'small', v !== 'kalshi' ? 'No alert' : r ? (r.paused ? 'Alert paused' : 'Alert on') : 'No alert')); };
      if (has(tgt)) line('Target', tgt, 'bid>='); if (has(stp)) line('Stop', stp, 'bid<=');
      c.appendChild(kv);
    }
    var seg = el('div', 'seg'); var btn = function (label, fn, on) { var b = el('button', '', label); b.type = 'button'; if (on !== undefined) b.setAttribute('aria-pressed', String(on)); b.addEventListener('click', fn); seg.appendChild(b); return b; };
    btn('Edit target and stop', function () { levelSheet(x); });
    var close = function (status, exit) { x.status = status; x.exit = exit; rules.forEach(function (r) { dropRule(r.id); }); saveJ(); renderJournal(true); };
    if (has(bid)) btn('Mark sold at ' + cents(bid), function () { close('sold', bid); });
    c.appendChild(seg); seg = el('div', 'seg');
    var sp = el('input'); sp.type = 'number'; sp.inputMode = 'numeric'; sp.placeholder = 'Sold at ¢'; sp.setAttribute('aria-label', 'Price sold at, in cents'); sp.min = '1'; sp.max = '99'; sp.className = 'mini'; seg.appendChild(sp);
    btn('Mark sold', function () { var val = parseFloat(sp.value); if (!(val >= 1 && val <= 99)) { sp.focus(); return; } close('sold', val / 100); });
    btn('Won', function () { close('won', null); }); btn('Lost', function () { close('lost', null); });
    btn('Delete', function () { rules.forEach(function (r) { dropRule(r.id); }); J = J.filter(function (y) { return y.id !== x.id; }); saveJ(); renderJournal(true); });
    c.appendChild(seg); return c;
  }
  // Change a tracked position's target and stop, and keep its Kalshi alerts in step.
  function levelSheet(x) {
    var v = venueOf(x); var st = { target: has(x.target) ? x.target : null, stop: has(x.stop) ? x.stop : null };
    var box = sheetShell('Target and stop', x.name + ' to win · ' + x.qty + ' at ' + cents(x.price) + ' on ' + VENUES[v]);
    var num = function (label, val, set, min, max) { var f = el('label', 'field', label); var i = el('input'); i.type = 'number'; i.inputMode = 'numeric'; i.min = String(min); i.max = String(max); i.placeholder = 'None'; i.value = has(val) ? String(Math.round(val * 100)) : ''; i.addEventListener('input', function () { var n = parseFloat(i.value); set(i.value === '' ? null : n >= min && n <= max ? n / 100 : undefined); }); f.appendChild(i); return f; };
    var grid = el('div', 'fgrid'); add(grid, num('Target, ¢', st.target, function (n) { st.target = n; }, 2, 99), num('Stop, ¢', st.stop, function (n) { st.stop = n; }, 1, 98)); box.appendChild(grid);
    var go = el('button', 'go pri', 'Save'); go.type = 'button';
    go.addEventListener('click', function () {
      if (st.target === undefined || st.stop === undefined) { say('Check the prices', 'Use whole cents between 1 and 99, or leave a box empty.'); return; }
      if (has(st.target) && st.target <= x.price) { say('Check the target', 'The target has to be above the entry price.'); return; }
      if (has(st.stop) && st.stop >= x.price) { say('Check the stop', 'The stop has to be below the entry price.'); return; }
      x.target = st.target; x.stop = st.stop; saveJ();
      if (v === 'kalshi') {
        R.filter(function (r) { return !r.fired && r.event === x.event && r.side === x.side && (r.op === 'bid>=' || r.op === 'bid<='); }).forEach(function (r) { dropRule(r.id); });
        var m = Q.by[x.event]; var tk = x.ticker || (m && m[x.side] && m[x.side].ticker);
        if (tk) [['bid>=', st.target], ['bid<=', st.stop]].forEach(function (o) { if (has(o[1])) addRuleRaw({ event: x.event, ticker: tk, side: x.side, name: last(x.name), title: x.title, op: o[0], price: o[1] }); });
      }
      closeSheet(); say('Saved', (has(st.target) ? 'Target ' + cents(st.target) : 'No target') + ', ' + (has(st.stop) ? 'stop ' + cents(st.stop) : 'no stop') + (v === 'kalshi' ? '. Alerts updated.' : '.')); renderJournal(true);
    });
    add(box, go, el('div', 'small', v === 'kalshi' ? 'Saving sets a price alert at each level. Nothing is sent to Kalshi and no order is placed.' : 'Kept as a note only. Alerts watch Kalshi prices, so there is no alert for a Polymarket position.'));
    openSheetNow();
  }
  var pmHeld = function (open) { return open.filter(function (x) { return venueOf(x) === 'polymarket'; }).map(function (x) { return x.event; }); };
  function posTick() { var open = J.filter(function (x) { return x.status === 'open'; }); if (open.length) quotes(open.map(function (x) { return x.event; }), pmHeld(open)).then(function () { if (location.hash === '#positions') renderJournal(true); }); }
  function renderJournal(noFetch) {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && $('positionsView').contains(document.activeElement);
    var done = J.filter(function (x) { return x.status !== 'open'; }); var open = J.filter(function (x) { return x.status === 'open'; });
    if (!noFetch && open.length) quotes(open.map(function (x) { return x.event; }), pmHeld(open)).then(function () { if (location.hash === '#positions') renderJournal(true); });
    if (typing && noFetch) return; // do not rebuild the list under someone typing a price
    var po = $('pOpen'); po.replaceChildren();
    if (!open.length) po.appendChild(el('div', 'empty', 'No open positions. Open any matchup and choose Track position. It then shows here with its current sell price and how far it is from your target and stop.'));
    open.forEach(function (x) { po.appendChild(posCard(x)); });
    var net = done.reduce(function (q, x) { return q + pnlOf(x); }, 0); var wins = done.filter(function (x) { return pnlOf(x) > 0; }).length;
    var sum = $('jSum'); sum.replaceChildren();
    var used = Object.keys(VENUES).filter(function (k) { return J.some(function (x) { return venueOf(x) === k; }); });
    if (used.length < 2) sum.appendChild(trio([['Closed result', done.length ? (net >= 0 ? '+' : '') + money(net) : '–', done.length ? (net >= 0 ? 'up' : 'down') : ''], ['Record', done.length ? wins + '-' + (done.length - wins) : '–'], ['Open stake', money(open.reduce(function (q, x) { return q + x.cost; }, 0))]]));
    else { // money on different venues is never added together
      var vk = el('div', 'kv k4'); add(vk, el('span', 'k', ''), el('span', 'h', 'Closed'), el('span', 'h', 'Record'), el('span', 'h', 'Open stake'));
      used.forEach(function (k) { var dn = done.filter(function (x) { return venueOf(x) === k; }); var n = dn.reduce(function (q, x) { return q + pnlOf(x); }, 0); var w = dn.filter(function (x) { return pnlOf(x) > 0; }).length;
        add(vk, el('span', 'k', VENUES[k]), el('span', 'num ' + (dn.length ? (n >= 0 ? 'up' : 'down') : ''), dn.length ? (n >= 0 ? '+' : '') + money(n) : '–'), el('span', 'num', dn.length ? w + '-' + (dn.length - w) : '–'), el('span', 'num', money(open.filter(function (x) { return venueOf(x) === k; }).reduce(function (q, x) { return q + x.cost; }, 0)))); });
      sum.appendChild(vk);
    }
    if (done.length) { var staked = done.reduce(function (q, x) { return q + x.cost; }, 0); sum.appendChild(el('div', 'small', 'Return on money staked: ' + (100 * net / staked).toFixed(1) + '% over ' + done.length + ' closed trades. ' + (done.length < 100 ? 'Under 100 trades this is mostly luck either way.' : ''))); }
    var list = $('jList'); list.replaceChildren();
    if (!done.length) list.appendChild(el('div', 'empty', 'Nothing closed yet.'));
    done.forEach(function (x) {
      var c = el('div', 'card'); var top = el('div', 'top'); var pl = pnlOf(x);
      add(top, el('b', '', x.name), el('span', 'chip' + (pl > 0 ? ' good' : ' bad'), (x.status === 'sold' ? 'Sold at ' + cents(x.exit) + ', ' : x.status === 'won' ? 'Won, ' : 'Lost, ') + (pl >= 0 ? '+' : '') + money(pl)));
      add(c, top, el('div', 'small', VENUES[venueOf(x)] + ' · Entered by hand · ' + x.title + ' · ' + day(x.t) + ' ' + clock(x.t)), el('div', '', x.qty + ' contracts at ' + cents(x.price) + ', cost ' + money(x.cost)), el('div', 'small', 'App said: ' + (x.readTitle || 'nothing') + (has(x.fair) ? ' (model fair ' + cents(x.fair) + ')' : '')));
      var seg = el('div', 'seg'); var btn = function (label, fn) { var b = el('button', '', label); b.type = 'button'; b.addEventListener('click', fn); seg.appendChild(b); };
      btn('Reopen', function () { x.status = 'open'; x.exit = null; saveJ(); renderJournal(); });
      btn('Delete', function () { J = J.filter(function (y) { return y.id !== x.id; }); saveJ(); renderJournal(true); });
      c.appendChild(seg); list.appendChild(c);
    });
    var by = $('jBy'); by.replaceChildren(); var groups = {};
    done.forEach(function (x) { var g = groups[x.read] = groups[x.read] || { n: 0, net: 0, w: 0 }; g.n++; g.net += pnlOf(x); if (pnlOf(x) > 0) g.w++; });
    var names = { bet: 'Set-break gap', lean: 'Lean', watch: 'Small bet if stats agree', pass: 'App said no bet', none: 'No read' };
    if (!done.length) { by.appendChild(el('div', 'small', 'Once trades are closed, this shows whether you do better when you follow the app or when you ignore it.')); return; }
    var kv = el('div', 'kv'); add(kv, el('span', 'k', ''), el('span', 'h', 'Record'), el('span', 'h', 'Net'));
    Object.keys(groups).forEach(function (k) { var g = groups[k]; add(kv, el('span', 'k', names[k] || k), el('span', 'num', g.w + '-' + (g.n - g.w)), el('span', 'num ' + (g.net >= 0 ? 'up' : 'down'), (g.net >= 0 ? '+' : '') + money(g.net))); });
    by.appendChild(kv);
  }


  // ---------- phone alerts through the background logger ----------
  var LOGGER_DEFAULT = 'https://court-edge-logger.jnikam1.workers.dev';
  var pu = { url: LOGGER_DEFAULT, msg: '', status: null }; try { pu.url = localStorage.getItem('ce-logger') || LOGGER_DEFAULT; } catch (e) {}
  var canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var isHome = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(function () {}); }
  var keyBytes = function (b) { var p = '='.repeat((4 - b.length % 4) % 4); var raw = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; };
  var lg = function (path, body) { return fetch(pu.url.replace(/\/+$/, '') + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { if (d && d.error) throw new Error(d.error); return d; }); };
  function renderPush() {
    var box = $('pBox'); box.replaceChildren();
    if (!isHome) box.appendChild(el('div', 'verdict watch', 'On an iPhone this only works from the Home Screen copy of the app. In Safari tap Share, then Add to Home Screen, then open Court Edge from the new icon and come back to this box.'));
    else if (!canPush) box.appendChild(el('div', 'verdict watch', 'This browser does not support notifications for web apps.'));
    var f = el('label', 'field', 'Logger address (already filled in)'); var inp = el('input'); inp.type = 'url'; inp.placeholder = 'https://court-edge-logger.yourname.workers.dev'; inp.value = pu.url; inp.style.fontSize = '15px'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; f.appendChild(inp);
    inp.addEventListener('change', function () { pu.url = inp.value.trim(); try { localStorage.setItem('ce-logger', pu.url); } catch (e) {} pu.status = null; pu.msg = ''; loadLogger(); });
    var adv = el('details', 'adv'); add(adv, el('summary', '', 'Advanced: alert server address'), f);
    var seg = el('div', 'seg'); var btn = function (label, fn) { var b = el('button', '', label); b.type = 'button'; b.addEventListener('click', fn); seg.appendChild(b); };
    btn('Turn on alerts on this phone', function () {
      if (!pu.url) { pu.msg = 'Paste the logger address first.'; renderPush(); return; }
      if (!canPush) { pu.msg = 'Notifications are not available here. Open the app from the Home Screen icon.'; renderPush(); return; }
      var ask = Notification.requestPermission(); // must be asked straight from the tap
      Promise.resolve(ask).then(function (perm) { if (perm !== 'granted') throw new Error('Notifications were not allowed. Allow them for Court Edge in iPhone Settings, then try again.'); return Promise.all([navigator.serviceWorker.ready, lg('/vapid')]); })
        .then(function (x) { return x[0].pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(x[1].key) }); })
        .then(function (sub) { return lg('/subscribe', { endpoint: sub.endpoint }); })
        .then(function () { pu.msg = 'Alerts are on for this phone. Send a test to check.'; loadLogger(); })
        .catch(function (e) { pu.msg = 'Could not turn alerts on: ' + e.message; renderPush(); });
    });
    btn('Send a test alert', function () {
      if (!pu.url) return; if (!canPush) { pu.msg = 'Notifications are not available here. Open the app from the Home Screen icon.'; renderPush(); return; }
      pu.msg = 'Sending…'; renderPush();
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (sub) { if (!sub) throw new Error('Turn on alerts on this phone first.'); return lg('/test', { endpoint: sub.endpoint }); }) // the test goes to this phone only
        .then(function (r) { pu.msg = r.delivered ? 'Sent to this phone. It should arrive within a few seconds.' : 'The push service did not accept it (code ' + r.status + '). Turn alerts off and on again.'; renderPush(); })
        .catch(function (e) { pu.msg = 'Test failed: ' + e.message; renderPush(); });
    });
    btn('Turn off', function () { if (!canPush) return; navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) { if (!sub) return; var ep = sub.endpoint; return sub.unsubscribe().then(function () { return lg('/unsubscribe', { endpoint: ep }); }); }).then(function () { pu.msg = 'Alerts are off for this phone.'; loadLogger(); }).catch(function (e) { pu.msg = e.message; renderPush(); }); });
    box.appendChild(seg);
    if (pu.msg) box.appendChild(el('div', 'small', pu.msg));
    var st = pu.status;
    if (st && st.ok) box.appendChild(el('div', 'small', 'Logger ' + (st.last ? 'last ran ' + ago(st.last.t) : 'has not run yet') + '. ' + st.snapshots.toLocaleString() + ' price snapshots stored' + (st.since ? ' since ' + day(st.since) : '') + ', ' + st.alertsLogged + ' whale alerts logged, ' + st.phones + (st.phones === 1 ? ' phone' : ' phones') + ' signed up.'));
    else if (pu.url && st === false) box.appendChild(el('div', 'small err', 'Could not reach the alert server just now. Phone alerts cannot be turned on or tested until it answers.'));
    box.appendChild(adv);
    box.appendChild(el('div', 'small', 'The logger checks every minute and sends the big-add alerts shown above, plus NBA and NFL injury report changes for top scorers and starting quarterbacks, even with the app closed.'));
  }
  function loadInjuries() {
    var box = $('iList'); if (!pu.url) { box.replaceChildren(el('div', 'small', 'Needs the logger address in the box above.')); return; }
    lg('/injuries').then(function (d) {
      var rows = (d.changes || []).filter(function (x) { return x.pushed; }).slice(0, 12); box.replaceChildren();
      if (!rows.length) { box.appendChild(el('div', 'small', 'No status change for a top NBA scorer or a starting quarterback has been logged yet.')); return; }
      var list = el('div', 'rows');
      rows.forEach(function (x) {
        var a = x.event ? el('a') : el('div'); if (x.event) a.href = '#m=' + encodeURIComponent(x.event);
        var l = el('span', 'l', String(x.lg).toUpperCase() + ' · ' + x.name + ' (' + x.team + '): ' + (x.was ? String(x.was).toLowerCase() + ' to ' : '') + String(x.now).toLowerCase());
        l.appendChild(el('div', 'small', ago(x.t) + (has(x.mid) ? ' · team was ' + cents(x.mid) + ' on Kalshi then' : ''))); a.appendChild(l); list.appendChild(a);
      });
      add(box, list, el('div', 'small', 'From ESPN\'s injury list, checked every minute by the logger.'));
    }).catch(function () { box.replaceChildren(el('div', 'small', 'Could not reach the logger just now.')); });
  }
  function loadLogger() { withSub(function (sub) { var was = pu.on; pu.on = !!sub; if (pu.on && !was) pullRules(); }); renderPush(); if (!pu.url) return; lg('/status').then(function (s) { pu.status = s; renderPush(); }).catch(function () { pu.status = false; renderPush(); }); }

  // ---------- big-add alerts: checked every minute on any screen ----------
  var al = { data: null, seen: {}, first: true, sound: false, ctx: null, fresh: {} };
  try { al.seen = JSON.parse(localStorage.getItem('ce-alerts-seen') || '{}') || {}; al.first = !localStorage.getItem('ce-alerts-seen'); al.sound = localStorage.getItem('ce-alerts-sound') === '1'; } catch (e) {}
  function beep() { try { if (!al.ctx) return; var o = al.ctx.createOscillator(); var g = al.ctx.createGain(); o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(al.ctx.destination); o.start(); o.stop(al.ctx.currentTime + 0.25); } catch (e) {} }
  function soundLabel() { var b = $('aSound'); b.textContent = 'Sound on new alert: ' + (al.sound ? 'on' : 'off'); b.setAttribute('aria-pressed', String(al.sound)); }
  $('aSound').addEventListener('click', function () {
    al.sound = !al.sound; try { localStorage.setItem('ce-alerts-sound', al.sound ? '1' : '0'); } catch (e) {}
    if (al.sound) { try { al.ctx = al.ctx || new (window.AudioContext || window.webkitAudioContext)(); al.ctx.resume(); } catch (e) {} beep(); }
    soundLabel();
  });
  // phones only allow sound after a tap, so unlock it on the first tap anywhere
  document.addEventListener('click', function () { if (al.sound && !al.ctx) { try { al.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } }, true);
  function alertBet(a) { return { who: 0, w: a.w, cond: a.cond, title: a.title, outcome: a.outcome || 'this side', usd: a.stake, avg: a.avg, cur: a.cur, slug: a.slug }; }
  function alertCard(a) {
    var c = el('button', 'bet'); c.type = 'button';
    var who = el('div', 'who'); add(who, el('b', '', a.whale), el('span', '', ago(a.last)));
    add(c, el('span', 'av', a.whale.replace(/^0x/, '').charAt(0)), who, el('div', 'bet-t', (a.fresh ? 'Opened ' : 'Added ') + usd(a.added) + ' on ' + (a.outcome || 'one side')), el('div', 'sub', a.title),
      trio([['Bought at', cents(a.paid)], ['Stake now', usd(a.stake)], ['Price now', has(a.cur) ? cents(a.cur) : '–', !has(a.cur) || Math.abs(a.cur - a.paid) < 0.005 ? '' : a.cur > a.paid ? 'up' : 'down']]));
    var foot = el('div', 'foot'); foot.appendChild(el('span', 'chip good', a.cat + ' record ' + signed(a.rec.net) + (a.rec.n ? ' over ' + a.rec.n : '')));
    if (al.fresh[a.id]) foot.appendChild(el('span', 'chip window', 'New'));
    c.appendChild(foot);
    c.addEventListener('click', function () { openSheet(alertBet(a), { whales: [{ name: a.whale }] }); });
    return c;
  }
  function renderAlerts() {
    var d = al.data; if (!d) return; var box = $('aList'); box.replaceChildren();
    if (!d.alerts.length) box.appendChild(el('div', 'empty', 'No big adds in the last ' + Math.round(d.minutes / 60) + ' hours.'));
    d.alerts.forEach(function (a) { box.appendChild(alertCard(a)); });
    var s = $('aStatus'); s.replaceChildren();
    add(s, document.createTextNode('Checked '), el('b', '', new Date(d.asOf).toLocaleTimeString()), document.createTextNode(', every minute while the app is open. ' + d.wallets + ' wallets' + (d.failed ? ', ' + d.failed + ' could not be read this time' : '') + '.'));
  }
  function badge() { var n = Object.keys(al.fresh).length + mine; var b = $('aBadge'); b.hidden = !n || location.hash === '#alerts'; b.textContent = String(n); document.title = (n && location.hash !== '#alerts' ? '(' + n + ') ' : '') + 'Court Edge'; }
  function loadAlerts() {
    get('/api/alerts').then(function (d) {
      al.data = d; var fresh = [];
      d.alerts.forEach(function (a) { if (!al.seen[a.id] || a.last > al.seen[a.id]) { if (!al.first) { fresh.push(a); al.fresh[a.id] = 1; } al.seen[a.id] = a.last; } });
      var keep = {}; d.alerts.forEach(function (a) { keep[a.id] = al.seen[a.id]; }); al.seen = keep; al.first = false;
      try { localStorage.setItem('ce-alerts-seen', JSON.stringify(al.seen)); } catch (e) {}
      renderAlerts(); badge();
      if (fresh.length) {
        var a = fresh[0];
        say(a.whale + ' ' + (a.fresh ? 'opened ' : 'added ') + usd(a.added) + ' on ' + (a.outcome || 'one side'), a.title + ' (' + a.cat + ')' + (fresh.length > 1 ? ', and ' + (fresh.length - 1) + ' more' : '') + '. Tap to see.', '#alerts');
        if (al.sound) beep(); if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) {} }
      }
    }).catch(function () { if (!al.data) $('aStatus').textContent = 'Could not check for big adds. Trying again in a minute.'; });
  }
  $('toast').addEventListener('click', function () { var t = $('toast'); t.hidden = true; if (t.dataset.go) { location.hash = t.dataset.go; window.scrollTo(0, 0); } });
  // remember which sections are open
  var folds = {}; try { folds = JSON.parse(localStorage.getItem('ce-folds') || '{}') || {}; } catch (e) {}
  document.querySelectorAll('details.fold').forEach(function (dt) {
    var k = dt.dataset.k; if (folds[k] !== undefined) dt.open = !!folds[k];
    dt.addEventListener('toggle', function () { folds[k] = dt.open; try { localStorage.setItem('ce-folds', JSON.stringify(folds)); } catch (e) {} });
  });
  loadFeed();
  soundLabel(); loadAlerts();
  setInterval(function () { if (!document.hidden) loadAlerts(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadAlerts(); });

  $('back').addEventListener('click', function () { location.hash = lastList || '#'; });
  $('wBack').addEventListener('click', function () { location.hash = '#'; });
  $('qIcon').appendChild(icon('discover'));
  $('q').addEventListener('input', function () { D.q = $('q').value.trim().toLowerCase(); renderDiscover(); });
  $('tabWh').insertBefore(icon('whale'), $('tabWh').firstChild);
  // Phones: after the keyboard closes, iOS can leave the page shifted, which lifts anything pinned to the bottom into the
  // middle of the screen. Follow the visible area instead of trusting the layout, and nudge the page when typing ends.
  if (window.visualViewport) {
    var vv = window.visualViewport; var root = document.documentElement;
    var pin = function () { root.style.setProperty('--vv-down', Math.max(0, Math.round(vv.offsetTop + vv.height - root.clientHeight)) + 'px'); root.style.setProperty('--vv-top', Math.max(0, Math.round(vv.offsetTop)) + 'px'); };
    vv.addEventListener('resize', pin); vv.addEventListener('scroll', pin); window.addEventListener('scroll', pin, { passive: true });
    document.addEventListener('focusout', function () { setTimeout(function () { var a = document.activeElement; if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) { window.scrollTo(window.scrollX, window.scrollY); pin(); } }, 120); });
    pin();
  }
  // Say so when the device is offline or the data has stopped arriving.
  var netNote = function () {
    var n = $('net'); var old = Date.now() - lastOk;
    if (navigator.onLine === false) { n.textContent = 'You are offline. Prices on screen are from ' + new Date(lastOk).toLocaleTimeString() + '.'; n.hidden = false; }
    else if (!document.hidden && old > 60000) { n.textContent = 'No fresh data since ' + new Date(lastOk).toLocaleTimeString() + '. Still trying.'; n.hidden = false; }
    else n.hidden = true;
  };
  window.addEventListener('offline', netNote); window.addEventListener('online', function () { netNote(); if (cur.event) loadDetail(); else if (onDiscover()) loadDiscover(); });
  setInterval(netNote, 5000);
  // bottom tabs and the match action bar
  [['tabD', 'discover'], ['tabWa', 'watch'], ['tabP', 'positions'], ['tabA', 'alerts']].forEach(function (t) { $(t[0]).insertBefore(icon(t[1]), $(t[0]).firstChild); });
  $('actAlert').insertBefore(icon('alerts'), $('actAlert').firstChild); $('actTrade').insertBefore(icon('positions'), $('actTrade').firstChild);
  $('actSave').addEventListener('click', function () { if (!cur.event) return; toggleWatch(cur.event, cur.d ? titleOf(cur.d) : cur.event); paintSave(); });
  $('actAlert').addEventListener('click', function () { if (cur.d) alertSheet(cur.d); });
  $('actTrade').addEventListener('click', function () { if (cur.d) tradeSheet(cur.d); });
  withSub(function (sub) { pu.on = !!sub; });
  setInterval(checkRules, 30000);
  window.addEventListener('hashchange', route);
  route();
  setInterval(function () { if (document.hidden || cur.event) return; if (onDiscover()) loadDiscover(); else if (location.hash === '#watch') loadWatch(); else if (location.hash === '#positions') posTick(); }, LIST_MS);
  document.addEventListener('visibilitychange', function () { if (document.hidden) return; if (cur.event) loadDetail(); else if (location.hash === '#whales') loadWhaleboard(); else if (onDiscover()) loadDiscover(); else if (location.hash === '#watch') loadWatch(); else if (location.hash === '#positions') posTick(); checkRules(); if (!feed.timer) loadFeed(); });
})();
