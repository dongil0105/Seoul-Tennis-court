// 코트 오픈 — 서비스워커: 앱 알림(웹 푸시) 표시 + 앱 아이콘 숫자 + 알림 누르면 앱/예약 페이지 열기.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
  const title = data.title || '코트 오픈';
  const opts = {
    body: data.body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: data.tag || 'court-open',
    renotify: true,
    data: { url: data.url || '/' },
  };
  const jobs = [self.registration.showNotification(title, opts)];
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(jobs).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const external = /^https?:\/\//.test(url) && !url.startsWith(self.location.origin);
    if (!external) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) { if ('focus' in w) return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// 브라우저가 구독을 새로 바꾸면 서버에 다시 등록(설정은 마지막 값을 화면이 다시 보냄).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const r = await fetch('/push/key');
      const { publicKey } = await r.json();
      const pad = '='.repeat((4 - publicKey.length % 4) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch (_) { /* 다음에 앱을 열 때 화면이 복구 */ }
  })());
});
