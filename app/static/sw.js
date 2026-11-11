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
    badge: '/static/badge-96.png',
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

// 알림이 여는 주소는 이 앱이거나 서울시 예약 사이트(https)일 때만 그대로 쓴다. 아니면 앱 첫 화면.
function safeTarget(url) {
  try {
    const u = new URL(url || '/', self.location.origin);
    if (u.origin === self.location.origin) return u.href;
    if (u.protocol === 'https:' && /(^|\.)seoul\.go\.kr$/.test(u.hostname)) return u.href;
  } catch (_) { /* 잘못된 주소 */ }
  return self.location.origin + '/';
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeTarget(event.notification.data && event.notification.data.url);
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
      if (!r.ok) throw new Error('key');
      const { publicKey } = await r.json();
      const pad = '='.repeat((4 - publicKey.length % 4) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      // 화면이 저장해 둔 설정(지역·시점)을 함께 보낸다. 없으면 서버가 옛 구독 설정을 옮긴다.
      let prefs = {};
      try {
        const c = await caches.open('tn-settings');
        const r = await c.match('/__tn_push_settings');
        if (r) { const v = await r.json(); prefs = { areas: v.areas, d1: v.d1, h1: v.h1 }; }
      } catch (_) { /* 설정 없음 */ }
      const old = event.oldSubscription ? event.oldSubscription.endpoint : '';
      // 서버가 받았는지 확인하고, 실패하면 잠깐 쉬었다가 두 번 더 시도한다.
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON(), old_endpoint: old, ...prefs }) });
          if (res.ok) break;
        } catch (_) { /* 연결 문제 — 다시 시도 */ }
        await new Promise((done) => setTimeout(done, 2000 * (i + 1)));
      }
    } catch (_) { /* 다음에 앱을 열 때 화면이 복구 */ }
  })());
});
