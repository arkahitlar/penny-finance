import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Exercise the production session and rendering functions with a controllable network.
const functions = source.slice(source.indexOf('function renderAccount()'), source.indexOf('async function openView('));
function harness() {
  const elements = new Map();
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(`#${tag[1]}`, {
      hidden: /\bhidden\b/.test(tag[0]), disabled: /\bdisabled\b/.test(tag[0]),
      textContent: '', classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
    });
  }
  const requests = [];
  const context = vm.createContext({
    $: selector => elements.get(selector),
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    clearFinancialState() {},
  });
  vm.runInContext(`let user=null, demo=null, activeView='today', sessionVersion=0, authConfigured=false; ${functions}`, context);
  return { elements, requests, load: () => vm.runInContext('loadSession()', context) };
}
function visible(h, selector) { return !h.elements.get(selector).hidden; }
for (const scenario of ['authenticated', 'guest', 'failure']) {
  test(`startup hides sign-in while pending, then resolves ${scenario}`, async () => {
    const h = harness();
    const pending = h.load();
    assert.equal(visible(h, '#session-loading'), true);
    assert.equal(visible(h, '#auth-view'), false);
    assert.equal(visible(h, '#today-view'), false);
    if (scenario === 'failure') h.requests[0].reject(new Error('Network unavailable'));
    else h.requests[0].resolve({ configured: true, user: scenario === 'authenticated' ? { id: '1', name: 'Test', email: 'test@example.com' } : null });
    await pending;
    assert.equal(visible(h, '#session-loading'), false);
    assert.equal(visible(h, '#auth-view'), scenario !== 'authenticated');
    assert.equal(visible(h, '#today-view'), scenario === 'authenticated');
    assert.equal(h.elements.get('#google-signin').disabled, false);
    if (scenario === 'failure') assert.match(h.elements.get('#auth-status').textContent, /couldn’t check your session/);
  });
}
test('a stale session response cannot reveal login during the latest check', async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  h.requests[0].resolve({ configured: true, user: null });
  await first;
  assert.equal(visible(h, '#auth-view'), false);
  assert.equal(visible(h, '#session-loading'), true);
  h.requests[1].resolve({ configured: true, user: { id: '1', name: 'Test' } });
  await second;
  assert.equal(visible(h, '#today-view'), true);
  const background = h.load();
  assert.equal(visible(h, '#today-view'), true);
  assert.equal(visible(h, '#session-loading'), false);
  h.requests[2].resolve({ configured: true, user: null });
  await background;
  assert.equal(visible(h, '#auth-view'), true);
  assert.equal(visible(h, '#today-view'), false);
});
