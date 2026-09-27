import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoReport, createReportsView } from '../public/reports.js';

// A small DOM harness exercises state races and event contracts without a browser dependency.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.style = { setProperty() {} };
    this.className = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].filter(Boolean).join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
      toggle: (name, on) => { this.classList[on ? 'add' : 'remove'](name); },
    };
  }
  set textContent(text) { this.ownText = String(text); this.children = []; }
  get textContent() { return (this.ownText || '') + this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === '#fragment') this.append(...child.children);
      else { this.children.push(child); child.parent = this; }
    }
  }
  replaceChildren(...children) { this.children = []; this.ownText = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.events[name] = listener; }
  click() { if (!this.disabled) return this.events.click?.(); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function byText(root, text) { return descendants(root).find((element) => element.tagName === 'button' && element.textContent === text); }
function byClass(root, name) { return descendants(root).find((element) => element.className.split(' ').includes(name)); }
function dom(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
    createTextNode: (text) => { const element = new Element('#text'); element.textContent = text; return element; },
  };
  t.after(() => { globalThis.document = previous; });
  return new Element('main');
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function report(item = 'Coffee', payment = 'all', amount = 80) {
  const now = new Date();
  const day = new Date(now.valueOf() + 330 * 60000).toISOString().slice(0, 10);
  return buildDemoReport([{ id: 'entry-1', revision: 4, item, amount, category: 'food_drink',
    expense_date: day, created_at: now.toISOString(), payment_method: payment === 'all' ? 'cash' : payment }], 'week', day, now, payment);
}

test('Reports provides accessible edit/delete actions with full row and selected date, and renders user text literally', async (t) => {
  const root = dom(t);
  const data = report('<img src=x onerror=alert(1)>');
  const edited = [];
  const deleted = [];
  const view = createReportsView({ root, request: async () => data, getDemo: () => null,
    onEdit: (expense) => edited.push(expense), onDelete: (expense) => deleted.push(expense) });
  await view.refresh();
  const edit = byText(root, 'Edit');
  const remove = byText(root, 'Delete');
  assert.match(edit.attributes['aria-label'], /Edit <img/);
  assert.match(remove.attributes['aria-label'], /Delete <img/);
  edit.click(); remove.click();
  assert.equal(edited[0], data.expenses[0]);
  assert.equal(deleted[0].revision, 4);
  assert.equal(descendants(root).some((element) => element.tagName === 'img'), false);
  assert.equal(descendants(root).find((element) => element.tagName === 'time').dateTime, data.expenses[0].expense_date);
  assert.doesNotMatch(root.textContent, /discretionary|leak|waste/i);
  assert.match(root.textContent, /Based on your logged expenses/);
});

test('latest payment filter wins over slower earlier report and clear invalidates in-flight updates', async (t) => {
  const root = dom(t);
  const requests = [];
  const view = createReportsView({ root, getDemo: () => null, request: (url) => {
    const pending = deferred(); requests.push({ url, ...pending }); return pending.promise;
  } });
  const first = view.refresh();
  byText(root, 'Credit card').click();
  assert.match(requests[1].url, /payment_method=credit_card/);
  requests[1].resolve(report('Current card', 'credit_card', 200));
  await tick();
  requests[0].resolve(report('Stale all', 'all', 900));
  await first;
  assert.match(root.textContent, /Current card/);
  assert.doesNotMatch(root.textContent, /Stale all/);
  assert.equal(byText(root, 'Credit card').attributes['aria-pressed'], 'true');
  const pending = view.refresh();
  view.clear();
  requests[2].resolve(report('Signed-out leak'));
  await pending;
  assert.doesNotMatch(root.textContent, /Signed-out leak/);
  assert.match(root.textContent, /after you sign in/);
  assert.equal(byText(root, 'All').attributes['aria-pressed'], 'true');
});

test('report refresh and failure disable editing and export of stale rows; refresh restores controls', async (t) => {
  const root = dom(t);
  let pending;
  let edited = 0;
  const view = createReportsView({ root, getDemo: () => null,
    request: () => { pending = deferred(); return pending.promise; }, onEdit: () => { edited++; } });
  const initial = view.refresh(); pending.resolve(report()); await initial;
  const edit = byText(root, 'Edit');
  assert.equal(edit.disabled, false);
  const refresh = view.refresh();
  assert.equal(edit.disabled, true);
  edit.click();
  assert.equal(edited, 0);
  pending.reject(new Error('Network unavailable'));
  await refresh;
  assert.equal(edit.disabled, true);
  assert.equal(byText(root, '↓ Download CSV').disabled, true);
  assert.match(root.textContent, /last successful report/);
  const recovered = view.refresh(); pending.resolve(report()); await recovered;
  assert.equal(byText(root, 'Edit').disabled, false);
  byText(root, 'Edit').click();
  assert.equal(edited, 1);
});

test('demo report reads all historical expenses and never calls the API', async (t) => {
  const root = dom(t);
  const row = report().expenses[0];
  const day = new Date(`${row.expense_date}T00:00:00Z`);
  const previous = new Date(day.valueOf() - 7 * 86400000).toISOString().slice(0, 10);
  const historical = { ...row, item: 'Backdated demo entry', expense_date: previous };
  const demo = { getExpenses: () => ({ expenses: [] }), getAllExpenses: () => ({ expenses: [historical] }) };
  const view = createReportsView({ root, getDemo: () => demo, request: () => { throw new Error('Unexpected API request'); } });
  await view.refresh();
  const previousButton = descendants(root).find((element) => element.attributes['aria-label'] === 'Previous week');
  previousButton.click();
  await tick();
  assert.match(root.textContent, /Backdated demo entry/);
  assert.equal(byClass(root, 'reports-error'), undefined);
});

test('unauthorized report clears private data and calls session handler once', async (t) => {
  const root = dom(t);
  let unauthorized = 0;
  let expired = false;
  const view = createReportsView({ root, getDemo: () => null, onUnauthorized: () => { unauthorized++; }, request: async () => {
    if (expired) { const error = new Error('Expired'); error.status = 401; throw error; }
    return report('Private expense');
  } });
  await view.refresh();
  expired = true;
  await view.refresh();
  assert.equal(unauthorized, 1);
  assert.doesNotMatch(root.textContent, /Private expense/);
  assert.equal(byText(root, '↓ Download CSV').disabled, true);
});

test('report date jumps to history, rejects impossible/future dates, and persists when changing period', async (t) => {
  const root = dom(t);
  const requests = [];
  const view = createReportsView({ root, getDemo: () => null, request: async (url) => {
    requests.push(url);
    const params = new URLSearchParams(url.split('?')[1]);
    return buildDemoReport([], params.get('period'), params.get('date'));
  } });
  await view.refresh();
  const input = byClass(root, 'reports-date-input');
  assert.equal(input.min, '1900-01-01');
  for (const invalid of ['', '2026-02-30', '2025-02-29', '2099-12-31', '1899-12-31']) {
    input.value = invalid;
    input.events.change();
    await tick();
    assert.equal(requests.length, 1, invalid);
    assert.match(root.textContent, /Choose a valid report date/);
  }
  input.value = '2024-02-29';
  input.events.change();
  await tick();
  assert.match(requests[1], /date=2024-02-29/);
  assert.equal(input.value, '2024-02-29');
  byText(root, 'Monthly').click();
  await tick();
  assert.match(requests[2], /period=month&date=2024-02-29/);
  assert.match(root.textContent, /February 2024/);
  input.value = '1900-01-01';
  input.events.change();
  await tick();
  const previous = descendants(root).find((element) => element.attributes['aria-label'] === 'Previous month');
  assert.equal(previous.disabled, true);
});

test('CSV export respects payment filter and suppresses a stale download after navigation', async (t) => {
  const root = dom(t);
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const requests = [];
  let filesCreated = 0;
  URL.createObjectURL = () => { filesCreated++; return 'blob:test'; };
  globalThis.fetch = (url, options) => {
    const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise;
  };
  t.after(() => { globalThis.fetch = previousFetch; URL.createObjectURL = previousCreate; });
  const view = createReportsView({ root, getDemo: () => null, request: async (url) => {
    const payment = new URLSearchParams(url.split('?')[1]).get('payment_method');
    return report('Exported entry', payment);
  } });
  await view.refresh();
  byText(root, 'Cash').click();
  await tick();
  const download = byText(root, '↓ Download CSV').click();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /payment_method=cash&format=csv/);
  assert.equal(byText(root, 'Downloading…').disabled, true);
  byText(root, 'Credit card').click();
  await tick();
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve({ ok: true, headers: { get: () => 'text/csv' }, blob: async () => new Blob(['old cash rows']) });
  await download;
  assert.equal(filesCreated, 0);
  assert.equal(byText(root, '↓ Download CSV').disabled, false);
  assert.equal(byText(root, 'Credit card').attributes['aria-pressed'], 'true');
});
