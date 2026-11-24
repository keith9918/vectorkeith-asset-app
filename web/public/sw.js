// VectorKeith PWA Service Worker：缓存 App 外壳（实时数据 /api、/ws 永远走网络）+ 接收手机推送提醒
const CACHE = 'vk-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

// ─── 推送提醒 ─────────────────────────────────────────────────
// 服务器发来的内容已端到端加密，浏览器解密后交给这里显示
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'VectorKeith', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      timestamp: d.ts || Date.now(),
      data: { url: d.url || '/#/assets' },
    }),
  );
});

// 点通知：打开（或切回）App 并跳到对应页面
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#/assets', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        return (c.navigate ? c.navigate(url).catch(() => c) : Promise.resolve(c)).then((w) => (w || c).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});

// 浏览器自动更换了推送订阅：把新订阅告诉服务器（旧订阅地址作为凭证）
self.addEventListener('pushsubscriptionchange', (e) => {
  const old = e.oldSubscription;
  e.waitUntil(
    fetch('/api/push/key')
      .then((r) => r.json())
      .then(({ publicKey }) => {
        const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
        const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
        const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      })
      .then((sub) =>
        old
          ? fetch('/api/push/resubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: sub.toJSON() }),
            })
          : null,
      )
      .catch(() => {}),
  );
});
