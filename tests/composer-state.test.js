import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpenseComposer } from '../public/expenseComposer.js';
import { todayInIndia, yesterdayInIndia } from '../public/expenseDates.js';

// Only the dialog/event interfaces used by the composer; no production helpers are mocked.
class Control {
  constructor(value = '') {
    this.value = value;
    this.events = new Map();
    this.attributes = {};
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    const classes = new Set();
    this.classList = { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
  }
  addEventListener(name, callback) {
    const callbacks = this.events.get(name) || [];
    callbacks.push(callback);
    this.events.set(name, callbacks);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  async fire(name, properties = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    await Promise.all((this.events.get(name) || []).map((callback) => callback(event)));
    return event;
  }
  click() { return this.disabled ? Promise.resolve() : this.fire('click'); }
}
function makeDialog() {
  const dialog = new Control();
  const controls = new Map();
  const categories = ['food_drink', 'shopping', 'groceries'].map((value) => new Control(value));
  const payments = ['cash', 'credit_card'].map((value) => new Control(value));
  dialog.querySelector = (selector) => {
    if (!controls.has(selector)) controls.set(selector, new Control());
    return controls.get(selector);
  };
  dialog.querySelectorAll = (selector) => selector.includes('review-category') ? categories : payments;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    // Browser close events arrive after close() returns.
    queueMicrotask(() => { void dialog.fire('close'); });
  };
  return { dialog, find: dialog.querySelector, categories, payments };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function draft(id = 'draft-one', item = 'Coffee') {
  return { id, item, amount: 80, category: 'food_drink', expires_at: new Date(Date.now() + 900000).toISOString() };
}
function harness(options = {}) {
  const dom = makeDialog();
  const saved = [];
  const openings = [];
  const composer = createExpenseComposer({ ...dom,
    preview: async () => draft(),
    save: async () => ({ id: 'saved-one', item: 'Coffee', amount: 80, payment_method: 'cash' }),
    onSaved: (...args) => saved.push(args), onUnauthorized: () => assert.fail('Unexpected session expiry'),
    onOpenChange: (open) => openings.push(open), ...options,
  });
  return { ...dom, composer, saved, openings };
}
async function ready(context) {
  context.composer.open('coffee 80');
  await tick();
  await context.payments[0].fire('change');
  await context.find('#review-yesterday').click();
  assert.equal(context.find('#review-save').disabled, false);
}
const submit = (context) => context.find('#review-form').fire('submit');

test('an uncertain save locks every choice and retries the exact draft, date, payment, category and key', async () => {
  const calls = [];
  const context = harness({ save: async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) throw new Error('Response lost after commit');
    return { id: 'saved-one', ...args[1] };
  } });
  await ready(context);
  await submit(context);
  assert.equal(context.saved.length, 0);
  for (const selector of ['#review-date', '#review-payment', '#review-categories', '#review-today', '#review-yesterday']) {
    assert.equal(context.find(selector).disabled, true, selector);
  }
  assert.equal(context.find('#review-save').disabled, false);
  assert.equal(context.find('#review-save').textContent, 'Retry save');
  // Even a queued change event cannot alter choices after the uncertain response.
  await context.payments[1].fire('change');
  await context.categories[1].fire('change');
  await context.find('#review-date').fire('change', { target: { value: todayInIndia() } });
  await submit(context);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[0][1], { payment_method: 'cash', category: 'food_drink', expense_date: yesterdayInIndia() });
  assert.match(calls[0][2], /^[0-9a-f-]{36}$/i);
  assert.equal(context.saved.length, 1);
  assert.equal(context.dialog.open, false);
});

test('dismissing an uncertain save requests a refresh and reopening preserves its retry receipt', async () => {
  let dismissed = 0;
  let previews = 0;
  const calls = [];
  const context = harness({ preview: async () => { previews++; return draft(); },
    save: async (...args) => { calls.push(structuredClone(args)); throw new Error('Network unavailable'); },
    onDismissUncertain: () => { dismissed++; },
  });
  await ready(context);
  await submit(context);
  await context.find('#review-cancel').click();
  await tick();
  assert.equal(dismissed, 1);
  assert.equal(context.dialog.open, false);
  context.composer.open('coffee 80');
  await tick();
  assert.equal(previews, 1);
  assert.equal(context.find('#review-date').disabled, true);
  await submit(context);
  assert.deepEqual(calls[1], calls[0]);
  context.composer.reset();
  await tick();
  assert.equal(dismissed, 1, 'A session reset must not schedule another private refresh');
});

test('a deleted-expense replay discards the dead draft and a fresh preview receives a new key', async () => {
  let previews = 0;
  const calls = [];
  const context = harness({ preview: async () => draft(`draft-${++previews}`),
    save: async (...args) => {
      calls.push(structuredClone(args));
      if (calls.length === 1) {
        const error = new Error('This expense was deleted.');
        error.status = 410; error.code = 'EXPENSE_DELETED'; throw error;
      }
      return { id: 'new-expense', ...args[1] };
    },
  });
  await ready(context);
  await submit(context);
  assert.equal(context.find('#review-details').hidden, true);
  assert.equal(context.find('#review-save').disabled, true);
  assert.equal(context.find('#review-retry').hidden, false);
  await context.find('#review-retry').click();
  assert.equal(previews, 2);
  assert.equal(context.find('#review-date').disabled, false);
  await submit(context);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1][0], calls[0][0]);
  assert.notEqual(calls[1][2], calls[0][2]);
  assert.equal(context.saved.length, 1);
});

test('reset discards delayed preview and save results after logout without leaking into the next session', async () => {
  const pendingPreview = deferred();
  let previews = 0;
  const previewContext = harness({ preview: () => ++previews === 1 ? pendingPreview.promise : Promise.resolve(draft('next-session', 'Next session item')) });
  previewContext.composer.open('private old purchase 80');
  previewContext.composer.reset();
  await tick();
  previewContext.composer.open('new session item 80');
  await tick();
  pendingPreview.resolve(draft('stale-private', 'Private old purchase'));
  await tick();
  assert.equal(previewContext.find('#review-item').textContent, 'Next session item');
  assert.equal(previewContext.find('#review-original').textContent, 'new session item 80');
  assert.equal(previewContext.saved.length, 0);

  const pendingSave = deferred();
  let saves = 0;
  const saveContext = harness({ save: () => ++saves === 1 ? pendingSave.promise : Promise.resolve({ id: 'next-save' }) });
  await ready(saveContext);
  const submitted = submit(saveContext);
  assert.equal(saveContext.find('#review-close').disabled, true);
  saveContext.composer.reset();
  await tick();
  saveContext.composer.open('new session item 80');
  await tick();
  pendingSave.resolve({ id: 'stale-saved', item: 'Private old purchase' });
  await submitted;
  assert.equal(saveContext.saved.length, 0);
  assert.equal(saveContext.dialog.open, true);
  assert.equal(saveContext.find('#review-original').textContent, 'new session item 80');
  await saveContext.payments[0].fire('change');
  await submit(saveContext);
  assert.equal(saveContext.saved.length, 1);
  assert.equal(saveContext.saved[0][0].id, 'next-save');
});
