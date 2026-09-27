// This worker stores only a generic connection screen, never the journal or API data.
// Bump this version when changing the offline HTML or CSS.
const OFFLINE_CACHE = 'penny-offline-v1';
const OFFLINE_PAGE = '/offline.html';
const OFFLINE_STYLES = '/offline.css';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(cache => cache.addAll([OFFLINE_PAGE, OFFLINE_STYLES])));
  // Let an update wait until existing pages close, preserving in-progress forms.
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith('penny-offline-') && name !== OFFLINE_CACHE)
    .map(name => caches.delete(name)))));
});

function bypassRequest(url) {
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return true; }
  if (path === '/api' || path.startsWith('/api/')) return true;
  if (/(?:^|\/)(?:auth|oauth|oauth2|callback|login|logout|signin|signout)(?:\/|$)/i.test(path)) return true;
  // Never replace an OAuth return or sign-in error with an offline document.
  return ['code', 'state', 'error', 'error_description', 'auth_error', 'access_token', 'id_token', 'oauth_token', 'oauth_verifier']
    .some(parameter => url.searchParams.has(parameter));
}

async function offlinePage() {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const page = await cache.match(OFFLINE_PAGE);
    if (page) return page;
  } catch {
    // A browser may deny or evict cache storage; keep the fallback readable.
  }
  return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Penny</title><h1>Connect to the internet</h1><p>Penny needs a connection to open your private journal.</p><a href="/">Try again</a></html>', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || bypassRequest(url)) return;

  if (request.mode === 'navigate') {
    // Return online responses untouched, including HTTP errors. Only a network
    // failure gets the generic offline page. No response is added to a cache.
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(offlinePage));
    return;
  }

  // The generic fallback's stylesheet is the only cached subresource.
  if (url.pathname === OFFLINE_STYLES && !url.search) {
    event.respondWith(caches.open(OFFLINE_CACHE).then(async cache =>
      (await cache.match(OFFLINE_STYLES)) || fetch(request)));
  }
});
