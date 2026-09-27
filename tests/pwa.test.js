import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const registrationSource = await readFile(new URL('../public/pwa.js', import.meta.url), 'utf8');
const origin = 'https://penny-gsk.vercel.app';

function worker({ network = async () => new Response('online'), entries = {}, names = [], cacheError = false } = {}) {
  const handlers = new Map();
  const opened = [];
  const added = [];
  const deleted = [];
  const matched = [];
  const fetched = [];
  const cache = {
    async addAll(paths) { added.push(...paths); },
    async match(path) { matched.push(path); return entries[path]?.clone(); },
    put() { assert.fail('The worker must never cache runtime responses.'); },
  };
  const context = {
    self: {
      location: { origin },
      addEventListener(type, handler) { handlers.set(type, handler); },
      skipWaiting() { assert.fail('An update must not force activation.'); },
      clients: { claim() { assert.fail('An update must not take over open expense forms.'); } },
    },
    caches: {
      async open(name) { opened.push(name); if (cacheError) throw new Error('Cache unavailable'); return cache; },
      async keys() { return names; },
      async delete(name) { deleted.push(name); return true; },
    },
    async fetch(request, options) { fetched.push({ request, options }); return network(request, options); },
    URL,
    Response,
  };
  vm.runInNewContext(workerSource, context, { filename: 'sw.js' });
  async function lifecycle(type) {
    let completion;
    handlers.get(type)({ waitUntil(value) { completion = value; } });
    await completion;
  }
  function fetchEvent(path, { method = 'GET', mode = 'navigate' } = {}) {
    let response;
    const request = { url: new URL(path, origin).href, method, mode };
    handlers.get('fetch')({ request, respondWith(value) { response = value; } });
    return { request, response };
  }
  return { lifecycle, fetchEvent, opened, added, deleted, matched, fetched };
}

test('manifest describes the Penny standalone app and separate maskable icon', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Penny');
  assert.equal(manifest.short_name, 'Penny');
  for (const field of ['id', 'scope', 'start_url']) assert.equal(manifest[field], '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#f6f3e9');
  assert.equal(manifest.background_color, '#f6f3e9');
  assert.deepEqual(manifest.icons.map(icon => [icon.src, icon.sizes, icon.purpose]), [
    ['/icons/icon-192.png', '192x192', 'any'],
    ['/icons/icon-512.png', '512x512', 'any'],
    ['/icons/maskable-512.png', '512x512', 'maskable'],
  ]);
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(index, /<script type="module" src="\/pwa\.js"><\/script>/);
});

test('installation only caches the public offline document and stylesheet', async () => {
  const app = worker();
  await app.lifecycle('install');
  assert.deepEqual(app.added, ['/offline.html', '/offline.css']);
  assert.deepEqual(app.opened, ['penny-offline-v1']);
  assert.equal(app.fetched.length, 0);
});

test('activation removes only older Penny offline caches and never claims open pages', async () => {
  const app = worker({ names: ['penny-offline-v0', 'penny-offline-v1', 'unrelated-app-cache'] });
  await app.lifecycle('activate');
  assert.deepEqual(app.deleted, ['penny-offline-v0']);
});

test('online navigations bypass browser cache and are returned without runtime storage', async () => {
  const app = worker({ network: async () => new Response('online journal shell', { headers: { 'X-Test': 'preserved' } }) });
  const response = await app.fetchEvent('/').response;
  assert.equal(await response.text(), 'online journal shell');
  assert.equal(response.headers.get('X-Test'), 'preserved');
  assert.equal(app.fetched[0].options.cache, 'no-store');
  assert.equal(app.opened.length, 0);
  assert.equal(app.added.length, 0);
});

test('a navigation network failure returns only the generic offline screen', async () => {
  const app = worker({ network: async () => { throw new TypeError('Network unavailable'); }, entries: { '/offline.html': new Response('generic offline screen') } });
  const response = await app.fetchEvent('/privacy.html').response;
  assert.equal(await response.text(), 'generic offline screen');
  assert.deepEqual(app.matched, ['/offline.html']);
  assert.equal(app.added.length, 0);
});

test('HTTP errors are not concealed by an offline screen', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const app = worker({ network: async () => new Response('server error', { status }) });
    const response = await app.fetchEvent('/').response;
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'server error');
    assert.equal(app.opened.length, 0);
  }
});

test('a missing or unavailable offline cache produces a readable no-store fallback', async () => {
  for (const cacheError of [false, true]) {
    const app = worker({ cacheError, network: async () => { throw new TypeError('offline'); } });
    const response = await app.fetchEvent('/').response;
    assert.equal(response.status, 503);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.text();
    assert.match(body, /Connect to the internet/);
    assert.match(body, /href="\/"/);
  }
});

test('API, sign-in and OAuth callback requests are never intercepted, even as navigations', () => {
  const paths = [
    '/api', '/api/expenses', '/api/reports?format=csv', '/api/auth?action=login',
    '/api/auth?action=callback&code=secret&state=nonce', '/api%2fauth?action=callback',
    '/auth/callback', '/oauth/callback', '/oauth2/callback', '/callback', '/login', '/logout', '/signin', '/signout',
    '/?code=secret', '/?state=nonce', '/?auth_error=signin_failed', '/?error=access_denied',
    '/?error_description=denied', '/?id_token=secret', '/?access_token=secret', '/?oauth_token=secret', '/?oauth_verifier=secret',
    '/bad%path',
  ];
  const app = worker({ network: async () => { assert.fail('Excluded requests belong to the browser.'); } });
  for (const path of paths) {
    assert.equal(app.fetchEvent(path).response, undefined, path);
    assert.equal(app.fetchEvent(path, { mode: 'cors' }).response, undefined, path);
  }
  assert.equal(app.opened.length, 0);
  assert.equal(app.fetched.length, 0);
});

test('POST requests, cross-origin pages, app scripts and private subresources bypass the worker', () => {
  const app = worker();
  assert.equal(app.fetchEvent('/', { method: 'POST' }).response, undefined);
  assert.equal(app.fetchEvent('https://accounts.google.com/o/oauth2/auth').response, undefined);
  for (const path of ['/app.js', '/reports.js', '/styles.css', '/icons/icon-192.png', '/.well-known/assetlinks.json', '/?journal=private']) {
    assert.equal(app.fetchEvent(path, { mode: 'cors' }).response, undefined, path);
  }
  assert.equal(app.opened.length, 0);
  assert.equal(app.fetched.length, 0);
});

test('the generic offline stylesheet works offline; other URLs never get its cached content', async () => {
  const app = worker({ network: async () => { throw new TypeError('offline'); }, entries: { '/offline.css': new Response('body { color: green }') } });
  const response = await app.fetchEvent('/offline.css', { mode: 'no-cors' }).response;
  assert.equal(await response.text(), 'body { color: green }');
  assert.equal(app.fetched.length, 0);
  assert.equal(app.fetchEvent('/offline.css?user=private', { mode: 'no-cors' }).response, undefined);
  assert.equal(app.fetchEvent('/offline.css?code=secret', { mode: 'no-cors' }).response, undefined);
  assert.equal(app.fetchEvent('https://example.com/offline.css', { mode: 'no-cors' }).response, undefined);
});

function registration({ secure = true, supported = true, readyState = 'complete', failure = false } = {}) {
  const registered = [];
  const listeners = new Map();
  const context = {
    navigator: supported ? { serviceWorker: { async register(path, options) { registered.push({ path, options }); if (failure) throw new Error('Install unavailable'); } } } : {},
    window: { isSecureContext: secure, addEventListener(type, handler, options) { listeners.set(type, { handler, options }); } },
    document: { readyState },
  };
  vm.runInNewContext(registrationSource, context, { filename: 'pwa.js' });
  return { registered, listeners };
}

test('registration waits for page load and leaves unsupported or insecure browsers alone', () => {
  const app = registration({ readyState: 'interactive' });
  assert.equal(app.registered.length, 0);
  assert.equal(app.listeners.get('load').options.once, true);
  app.listeners.get('load').handler();
  assert.equal(app.registered.length, 1);
  assert.equal(app.registered[0].path, '/sw.js');
  assert.equal(app.registered[0].options.scope, '/');
  assert.equal(app.registered[0].options.updateViaCache, 'none');
  for (const options of [{ secure: false }, { supported: false }]) {
    const unavailable = registration(options);
    assert.equal(unavailable.registered.length, 0);
    assert.equal(unavailable.listeners.size, 0);
  }
});

test('late loading or installation failure does not reload or interrupt an open journal', async () => {
  const app = registration({ failure: true });
  assert.equal(app.registered.length, 1);
  assert.equal(app.listeners.size, 0);
  await new Promise(resolve => setImmediate(resolve));
});
