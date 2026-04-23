const CACHE_NAME = "tetris-cache-v3";
const ASSETS_TO_CACHE = [
  "./",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// IndexedDB Helper for SW
const getPendingScores = async () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tetris-db", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("scores", "readonly");
      const store = transaction.objectStore("scores");
      const index = store.index("synced");
      const getAllRequest = index.getAll(0); // 0 means synced: false (assuming bool is not indexed well, using 0/1)
      
      getAllRequest.onsuccess = () => {
        resolve(getAllRequest.result.filter(s => !s.synced));
      };
      getAllRequest.onerror = () => reject(getAllRequest.onerror);
    };
  });
};

const markScoreAsSynced = async (id) => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tetris-db", 1);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("scores", "readwrite");
      const store = transaction.objectStore("scores");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const data = getReq.result;
        data.synced = true;
        store.put(data);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };
  });
};

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event
self.addEventListener("fetch", (event) => {
  // Non-GET istekleri cache'e sokma
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);

  // HTML dokümanlarda her zaman ağı tercih et; offline olursa cache'e düş.
  if (event.request.mode === "navigate" || requestUrl.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./")))
    );
    return;
  }

  // Harici origin çağrılarında (geo api vb.) cache'e yazma.
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Statik varlıklarda cache-first
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return networkResponse;
      });
    })
  );
});

// Background Sync
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-scores") {
    event.waitUntil(syncScores());
  }
});

async function syncScores() {
  try {
    const pendingScores = await getPendingScores();
    for (const score of pendingScores) {
      try {
        const response = await fetch("https://YOUR_API_ENDPOINT/scores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(score)
        });
        if (response.ok) {
          await markScoreAsSynced(score.id);
        }
      } catch (err) {
        console.error("Failed to sync score:", err);
        // Leave it in DB to try again later
      }
    }
  } catch (err) {
    console.error("Sync process error:", err);
  }
}
