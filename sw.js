// Keeps the app up to date. Browsers hold on to a site's files for a while
// to save time, which meant a freshly published change could take several
// minutes (or a special "hard refresh") to show up. This small background
// helper makes the browser check with the server for a newer copy of each
// of the app's own files every time the page loads. If there's no
// connection, it falls back to the copy the browser already has.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only the app's own files. Supabase and Plaid requests are left alone.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(checkAgainNextTime)
      .catch(() => fetch(event.request, { cache: 'force-cache' }))
  );
});

// Hand the file to the page marked "check again before reusing". Without
// this the page keeps its own in-memory copy for a few minutes and never
// even asks this helper on the next reload.
function checkAgainNextTime(response) {
  if (!response.ok || response.type !== 'basic') return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ---------- Notifications ----------

// A notification has arrived from the server: show it.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Family Budget', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: data.url || './' },
    })
  );
});

// Tapping it brings the app forward, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(event.notification.data?.url || './');
    })()
  );
});
