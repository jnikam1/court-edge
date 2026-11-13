#!/usr/bin/env node
// Command-line version of the app's big-adds alert.
//   node scripts/whale-alerts.js [--minutes 70] [--min-stake 50000] [--min-add 10000]
// Behind a proxy: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle> node scripts/whale-alerts.js
const { scanAlerts } = require('../lib/alerts');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const money = (x) => (Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : '$' + Math.round(x / 1000) + 'k');
const cents = (x) => Math.round(x * 100) + 'c';
scanAlerts({ minutes: arg('minutes', 70), minStake: arg('min-stake', 50000), minAdd: arg('min-add', 10000), maxPages: 8 }).then((r) => {
  console.log('WHALE ALERTS: ' + r.alerts.length + ' (window ' + r.minutes + ' min, stake ' + money(r.minStake) + '+, added ' + money(r.minAdd) + '+, ' + r.wallets + ' wallets, ' + r.failed + ' failed)');
  for (const a of r.alerts) {
    console.log('- ' + a.whale + ' ' + (a.fresh ? 'opened' : 'added to') + ' ' + (a.outcome || 'a side') + ' | ' + a.title + ' [' + a.cat + ']');
    console.log('  bought ' + money(a.added) + ' at ' + cents(a.paid) + ', stake now ' + money(a.stake) + (a.cur !== null ? ', price now ' + cents(a.cur) : '') + ', ' + Math.round((Date.now() / 1000 - a.last) / 60) + ' min ago');
    console.log('  their ' + a.cat + ' record: ' + money(a.rec.net) + (a.rec.n ? ' over ' + a.rec.n + ' markets' : '') + ' | https://polymarket.com/event/' + a.slug);
  }
  if (r.failed > r.wallets / 2) process.exitCode = 2;
}).catch((e) => { console.error('whale-alerts failed: ' + (e && e.message)); process.exit(1); });
