// Court Edge service worker. Its only job is phone alerts. The logger sends an empty push and leaves
// the text of each alert where this can fetch it: big whale adds and injury changes for key players.
const LOGGER = 'https://court-edge-logger.jnikam1.workers.dev';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let notes = [];
    try {
      const sub = await self.registration.pushManager.getSubscription(); // sent so a test meant for this phone is included
      const d = await (await fetch(LOGGER + '/latest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub ? sub.endpoint : null }), cache: 'no-store' })).json();
      const all = (d && d.notes) || [];
      // everything from the newest minute, three at most
      if (all.length) notes = all.filter((n) => all[0].t - n.t < 90).slice(0, 3);
    } catch (err) { /* fall through to the plain text */ }
    if (!notes.length) notes = [{ id: 'plain', title: 'Court Edge alert', body: 'Something changed. Tap to open the app.', url: '/#alerts' }];
    for (const n of notes) await self.registration.showNotification(n.title, { body: n.body, tag: n.id, renotify: true, icon: '/icon-180.png', data: { url: n.url || '/#alerts' } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#alerts';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.navigate(url); } catch (err) { /* same page */ } return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
