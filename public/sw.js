// Shows the studio's reminders on the phone. No offline caching, so the app is never stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || "Muto's", {
    body: d.body || '', icon: '/icon-512.png', badge: '/icon-180.png', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/crew' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/crew';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ('focus' in w) { if ('navigate' in w) w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
