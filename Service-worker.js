// ============================================
// SERVICE WORKER FOR PERPETUAL RISK CALCULATOR
// ============================================

const CACHE_NAME = 'risk-calc-v3';
const OFFLINE_URL = '/Calculator/offline.html';

// Assets to cache on install
const STATIC_ASSETS = [
  '/Calculator/',
  '/Calculator/index.html',
  '/Calculator/offline.html',
  '/Calculator/manifest.json',
  '/Calculator/launchericon-192x192.png',
  '/Calculator/launchericon-512x512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];

// ============================================
// INSTALL EVENT
// ============================================
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[Service Worker] Skip waiting on install');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('[Service Worker] Install failed:', error);
      })
  );
});

// ============================================
// ACTIVATE EVENT
// ============================================
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  
  const cacheWhitelist = [CACHE_NAME];
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => {
      console.log('[Service Worker] Claiming clients');
      return self.clients.claim();
    })
  );
});

// ============================================
// FETCH EVENT
// ============================================
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }
  
  // Skip browser extensions and analytics
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            // Return cached and update in background
            event.waitUntil(updateCache(request));
            return cachedResponse;
          }
          return fetch(request).then((response) => {
            return cacheResponse(request, response);
          });
        })
        .catch(() => {
          return fetch(request);
        })
    );
    return;
  }
  
  // For same-origin requests, use stale-while-revalidate strategy
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          const fetchPromise = fetch(request)
            .then((networkResponse) => {
              // Update cache with fresh response
              if (networkResponse && networkResponse.status === 200) {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => {
                    cache.put(request, responseToCache);
                  })
                  .catch((error) => {
                    console.warn('[Service Worker] Cache update failed:', error);
                  });
              }
              return networkResponse;
            })
            .catch(() => {
              // If fetch fails, return cached if available
              if (!cachedResponse) {
                // If offline and no cache for this asset, show offline page for HTML requests
                if (request.headers.get('Accept').includes('text/html')) {
                  return caches.match(OFFLINE_URL);
                }
              }
              return cachedResponse;
            });
          
          // Return cached immediately if available, otherwise wait for network
          return cachedResponse || fetchPromise;
        })
    );
    return;
  }
  
  // For cross-origin requests, network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for cross-origin resources
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(request, responseToCache);
            })
            .catch((error) => {
              console.warn('[Service Worker] Cross-origin cache failed:', error);
            });
        }
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});

// ============================================
// MESSAGE HANDLING
// ============================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============================================
// BACKGROUND SYNC (for offline data)
// ============================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-journal') {
    console.log('[Service Worker] Background sync for journal data');
    event.waitUntil(syncJournalData());
  }
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
self.addEventListener('push', (event) => {
  if (!(self.Notification && self.Notification.permission === 'granted')) {
    return;
  }
  
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = {
        title: 'Risk Calculator',
        body: event.data.text() || 'Update available',
        icon: '/Calculator/launchericon-192x192.png'
      };
    }
  }
  
  const options = {
    body: data.body || 'Check your trading journal for updates',
    icon: data.icon || '/Calculator/launchericon-192x192.png',
    badge: '/Calculator/launchericon-192x192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/Calculator/'
    },
    actions: [
      {
        action: 'open',
        title: 'Open App'
      },
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'Risk Calculator', options)
  );
});

// ============================================
// NOTIFICATION CLICK
// ============================================
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const action = event.action;
  
  notification.close();
  
  if (action === 'dismiss') {
    return;
  }
  
  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })
    .then((clientList) => {
      const url = notification.data?.url || '/Calculator/';
      // Check if there's already a window/tab open with the target URL
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      // If not, open a new window/tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Update cache for a specific request
 */
async function updateCache(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response);
    }
  } catch (error) {
    // Silent fail for background updates
  }
}

/**
 * Cache a response
 */
async function cacheResponse(request, response) {
  if (response && response.status === 200) {
    const responseClone = response.clone();
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, responseClone);
    } catch (error) {
      console.warn('[Service Worker] Cache response failed:', error);
    }
  }
  return response;
}

/**
 * Sync journal data from localStorage to server
 * This is a placeholder - implement your own sync logic
 */
async function syncJournalData() {
  try {
    // Get all clients
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    
    // If there's an open client, send a message to sync
    for (const client of clients) {
      client.postMessage({
        type: 'SYNC_JOURNAL',
        data: { timestamp: Date.now() }
      });
    }
    
    console.log('[Service Worker] Journal sync completed');
  } catch (error) {
    console.error('[Service Worker] Journal sync failed:', error);
  }
}

// ============================================
// PERIODIC BACKGROUND SYNC (if supported)
// ============================================
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'periodic-sync-journal') {
      event.waitUntil(syncJournalData());
    }
  });
}

console.log('[Service Worker] Loaded successfully!');
