// Court Edge service worker. Its only job is phone alerts: the logger sends an empty push, and
// this fetches the newest big whale add and shows it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = 'Whale alert'; let body = 'A tracked whale made a big add. Tap to see it.';
    try {
      const d = await (await fetch('/api/alerts', { cache: 'no-store' })).json();
      const a = d && d.alerts && d.alerts[0];
      if (a) {
        const k = (x) => '$' + (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1000) + 'k');
        title = a.whale + (a.fresh ? ' opened ' : ' added ') + k(a.added) + ' on ' + (a.outcome || 'one side');
        body = a.title + ' (' + a.cat + '). Bought at ' + Math.round(a.paid * 100) + '¢, stake now ' + k(a.stake) + '.' + (d.alerts.length > 1 ? ' ' + (d.alerts.length - 1) + ' more in the app.' : '');
      }
    } catch (err) { /* keep the plain text */ }
    await self.registration.showNotification(title, { body, tag: 'whale-alert', renotify: true, icon: '/icon-180.png', data: { url: '/#whales' } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.navigate('/#whales'); } catch (err) { /* same page */ } return c.focus(); } }
    return self.clients.openWindow('/#whales');
  })());
});
