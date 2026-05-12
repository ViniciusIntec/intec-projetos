// sw.js — Service Worker do INTEC
// Responsável por: cache offline, notificações push em background

const CACHE_NAME = 'intec-v1';
const ASSETS_CACHE = [
  '/',
  '/index.html',
];

// ── Instalar: cachear assets principais ──────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_CACHE).catch(() => {});
    })
  );
  self.skipWaiting();
});

// ── Ativar: limpar caches antigos ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: tentar rede primeiro, fallback para cache ─────────────────────────
self.addEventListener('fetch', event => {
  // Ignorar requisições de API e Supabase
  if (event.request.url.includes('/api/') ||
      event.request.url.includes('supabase.co') ||
      event.request.url.includes('resend.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cachear respostas bem-sucedidas de assets estáticos
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Notificações push (para uso futuro com push server) ──────────────────────
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'INTEC', {
      body:    data.body || '',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag || 'intec',
      data:    { url: data.url || '/' },
    })
  );
});

// ── Clique na notificação: abrir/focar o app ──────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Se já tem uma janela aberta, foca ela
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Senão abre uma nova
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data?.url || '/');
      }
    })
  );
});
