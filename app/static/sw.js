// 코트 오픈 — 서비스워커: 앱 알림(웹 푸시) 표시 + 받은 알림 적어 두기 + 앱 아이콘 숫자 + 알림 누르면 앱/예약 페이지 열기.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── 받은 알림 보관함 ──────────────────────────────────────────────
// 알림이 올 때마다 '어느 곳의 무슨 알림인지'를 적어 둔다. 앱을 열면 화면이 이걸 읽어 '새 알림'으로 보여 주고 비운다.
// 그래서 앱 아이콘 숫자 = 보관함에 남은(아직 앱에서 안 본) 알림 수이고, 앱을 열면 0 이 된다.
const INBOX = { cache: 'tn-inbox', key: '/__tn_inbox', max: 30, age: 24 * 36e5 };

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  return items.filter((x) => x && typeof x === 'object' && typeof x.text === 'string' && x.text.trim())
    .slice(0, 12)
    .map((x) => ({ area: s(x.area, 20), place: s(x.place, 40), kind: s(x.kind, 10), key: s(x.key || x.text, 120), text: s(x.text, 300) }));
}

async function inboxAdd(items) {
  const c = await caches.open(INBOX.cache);
  let list = [];
  try {
    const r = await c.match(INBOX.key);
    const v = r ? await r.json() : [];
    if (Array.isArray(v)) list = v;
  } catch (_) { /* 깨진 보관함은 새로 만든다 */ }
  const now = Date.now();
  list = list.filter((x) => x && typeof x.at === 'number' && now - x.at < INBOX.age);
  for (const it of items) {
    list = list.filter((x) => !(x.area === it.area && x.key === it.key));   // 같은 일의 알림(전날 → 1시간 전)은 최신 것 하나만
    list.push({ ...it, at: now });
  }
  list = list.slice(-INBOX.max);
  await c.put(INBOX.key, new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }));
  return list.length;
}

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
  const items = cleanItems(data.items);
  event.waitUntil((async () => {
    const shown = self.registration.showNotification(title, opts).catch(() => {});
    if (items.length) {
      let count;
      try { count = await inboxAdd(items); }
      catch (_) { count = Math.max(1, Number(data.badge) || 0); }      // 적어 두지 못해도 숫자는 띄운다
      try {
        if (self.navigator && 'setAppBadge' in self.navigator) await self.navigator.setAppBadge(count);
      } catch (_) { /* 아이콘 숫자를 못 쓰는 기기 */ }
      try {                                                              // 앱이 열려 있으면 바로 보여 주게 알린다
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        wins.forEach((w) => { try { w.postMessage({ type: 'inbox' }); } catch (_) { /* 닫히는 중 */ } });
      } catch (_) { /* 열린 화면 없음 */ }
    }
    await shown;
  })());
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
      for (const w of wins) {
        if ('focus' in w) {
          try { w.postMessage({ target: url }); } catch (_) { /* 화면이 못 받아도 앱은 연다 */ }
          return w.focus();
        }
      }
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
