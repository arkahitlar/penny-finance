import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemo } from '../public/demo.js';

function save(demo, text, payment_method = 'cash', category) {
  const draft = demo.previewExpense(text);
  return demo.saveExpense(draft.id, { payment_method, category: category || draft.category }, crypto.randomUUID());
}

test('previewing an expense leaves the feed and totals unchanged until payment is confirmed', () => {
  const demo = createDemo();
  const before = demo.getExpenses();
  const analytics = demo.getAnalytics();
  const draft = demo.previewExpense('had a dosa and coffee for 235');
  assert.match(draft.item, /dosa and coffee/i);
  assert.equal(draft.amount, 235);
  assert.equal(draft.category, 'food_drink');
  assert.equal(draft.is_potential_leak, true);
  assert.ok(Date.parse(draft.expires_at) > Date.now());
  assert.equal(Object.hasOwn(draft, 'payment_method'), false);
  assert.deepEqual(demo.getExpenses(), before);
  assert.deepEqual(demo.getAnalytics(), analytics);
  const expense = demo.saveExpense(draft.id, { payment_method: 'credit_card', category: draft.category }, crypto.randomUUID());
  assert.equal(expense.payment_method, 'credit_card');
  assert.equal(expense.amount, 235);
  assert.equal(demo.getExpenses().expenses.length, before.expenses.length + 1);
});

test('demo rejects signed, overprecise, foreign, and ambiguous amounts without adding an expense', () => {
  const demo = createDemo();
  const initialExpenses = demo.getExpenses().expenses;
  for (const text of [
    'coffee for -80', 'coffee for +80', 'coffee for 12.345', 'coffee for 1.0000001',
    'dosa for 80 and coffee for 50', 'coffee $80', 'coffee 5 dollars', 'coffee for 0',
    'coffee total 80 and total 50', '80', 'coffee 1,2,3', 'had 2 dosas',
  ]) {
    assert.throws(() => demo.previewExpense(text), undefined, `should reject ${text}`);
    assert.deepEqual(demo.getExpenses().expenses, initialExpenses);
  }
});

test('demo distinguishes quantities from one total and accepts common payment wording', () => {
  const demo = createDemo();
  for (const [text, amount, category] of [
    ['2 dosas and cofee for 235', 235, 'food_drink'],
    ['spent235 on dinner', 235, 'food_drink'],
    ['paid ₹1,200 for shoes', 1200, 'shopping'],
    ['coffee for 80.', 80, 'food_drink'],
    ['milk 80 and fruit 120 total 200', 200, 'groceries'],
    ['₹80 coffee', 80, 'food_drink'],
  ]) {
    const draft = demo.previewExpense(text);
    assert.equal(draft.amount, amount, text);
    assert.equal(draft.category, category, text);
  }
});

test('saving requires a selected payment and category, and category corrections update leak status', () => {
  const demo = createDemo();
  const draft = demo.previewExpense('coffee for 235');
  const before = demo.getAnalytics();
  for (const choices of [{ category: 'food_drink' }, { payment_method: 'debit_card', category: 'food_drink' }, { payment_method: 'cash', category: 'invalid' }]) {
    assert.throws(() => demo.saveExpense(draft.id, choices, crypto.randomUUID()));
  }
  assert.deepEqual(demo.getAnalytics(), before);
  const expense = demo.saveExpense(draft.id, { payment_method: 'cash', category: 'groceries' }, crypto.randomUUID());
  assert.equal(expense.category, 'groceries');
  assert.equal(expense.is_potential_leak, false);
  assert.equal(expense.payment_method, 'cash');
  assert.equal(demo.getAnalytics().daily_leak_velocity, before.daily_leak_velocity);
});

test('double confirmation saves once and cannot change an already saved expense', () => {
  const demo = createDemo();
  const draft = demo.previewExpense('coffee for 235');
  const key = crypto.randomUUID();
  const count = demo.getExpenses().expenses.length;
  const choices = { payment_method: 'cash', category: 'food_drink' };
  const first = demo.saveExpense(draft.id, choices, key);
  assert.deepEqual(demo.saveExpense(draft.id, choices, key), first);
  assert.deepEqual(demo.saveExpense(draft.id, choices, crypto.randomUUID()), first);
  assert.equal(demo.getExpenses().expenses.length, count + 1);
  assert.throws(() => demo.saveExpense(draft.id, { ...choices, payment_method: 'credit_card' }, key));
  const second = demo.previewExpense('coffee for 90');
  assert.throws(() => demo.saveExpense(second.id, choices, key), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('expired drafts cannot be confirmed and returned drafts cannot alter saved amounts', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T06:00:00Z') });
  const demo = createDemo();
  const draft = demo.previewExpense('coffee for 235');
  const next = demo.previewExpense('coffee for 90');
  draft.amount = 1;
  const saved = demo.saveExpense(draft.id, { payment_method: 'cash', category: 'food_drink' }, crypto.randomUUID());
  assert.equal(saved.amount, 235);
  context.mock.timers.tick(15 * 60 * 1000);
  assert.throws(() => demo.saveExpense(next.id, { payment_method: 'cash', category: 'food_drink' }, crypto.randomUUID()), { code: 'DRAFT_EXPIRED' });
});

test('demo excludes an expense of exactly ₹500 from leak totals', () => {
  const demo = createDemo();
  const before = demo.getAnalytics();
  save(demo, 'coffee for 500');
  const after = demo.getAnalytics();
  assert.equal(after.total_spent, before.total_spent + 500);
  assert.equal(after.expense_count, before.expense_count + 1);
  assert.equal(after.daily_leak_velocity, before.daily_leak_velocity);
  assert.equal(after.leak_count, before.leak_count);
  assert.equal(after.small_transaction_count, before.small_transaction_count);
});
