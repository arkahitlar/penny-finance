import test from 'node:test';
import assert from 'node:assert/strict';
import { validExpenseDate, todayInIndia, yesterdayInIndia, expenseDate } from '../public/expenseDates.js';
import { validateEdit } from '../public/expenseManager.js';
import { createDemo } from '../public/demo.js';

const now = new Date('2026-09-26T18:30:00Z');
test('date controls use India midnight, actual calendar dates and no future dates', () => {
  assert.equal(todayInIndia(now), '2026-09-27');
  assert.equal(yesterdayInIndia(now), '2026-09-26');
  assert.equal(todayInIndia(new Date(now - 1)), '2026-09-26');
  assert.equal(expenseDate({ created_at: now.toISOString() }), '2026-09-27');
  for (const date of ['2024-02-29', '1900-01-01', '2026-09-27']) assert.equal(validExpenseDate(date, now), true);
  for (const date of ['2025-02-29', '1900-02-29', '2026-09-31', '1899-12-31', '2026-09-28', '', '2026-9-27', 'bad']) assert.equal(validExpenseDate(date, now), false, date);
});

test('editor validates exact decimal amounts and preserves literal safe text', () => {
  const entry = { item: ' Coffee ', amount: '0.01', category: 'food_drink', payment_method: 'cash', expense_date: '2024-02-29' };
  assert.deepEqual(validateEdit(entry), { ...entry, item: 'Coffee', amount: 0.01 });
  for (const amount of ['0', '-5', '1e3', '1.234', 'Infinity', '10000000.01', '1,000', '']) assert.throws(() => validateEdit({ ...entry, amount }));
  assert.equal(validateEdit({ ...entry, amount: '10000000' }).amount, 10000000);
  for (const patch of [{ item: ' ' }, { item: 'x'.repeat(121) }, { item: 'a\nb' }, { category: 'unknown' }, { payment_method: 'bank' }, { expense_date: '2025-02-29' }]) assert.throws(() => validateEdit({ ...entry, ...patch }));
  assert.equal(validateEdit({ ...entry, item: '<script>alert(1)</script>' }).item, '<script>alert(1)</script>');
});

test('sample controls backdate, edit across days, reject stale changes and keep deletion final', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const demo = createDemo();
  const initial = demo.getExpenses().expenses.length;
  const draft = demo.previewExpense('coffee for 90');
  const key = crypto.randomUUID();
  const choices = { payment_method: 'cash', category: 'food_drink', expense_date: '2026-09-26' };
  const saved = demo.saveExpense(draft.id, choices, key);
  assert.equal(saved.expense_date, '2026-09-26');
  assert.equal(saved.created_at, now.toISOString());
  assert.equal(demo.getExpenses().expenses.length, initial);
  assert.ok(demo.getAllExpenses().expenses.some(row => row.id === saved.id));
  const { expense: updated } = demo.updateExpense({ ...saved, item: 'Train fare', amount: 250, category: 'transport', payment_method: 'credit_card', expense_date: '2026-09-27' });
  assert.equal(updated.revision, 2);
  assert.deepEqual(demo.saveExpense(draft.id, choices, key), updated);
  assert.equal(demo.getExpenses().expenses.length, initial + 1);
  assert.throws(() => demo.updateExpense(saved), { code: 'EXPENSE_CONFLICT' });
  assert.throws(() => demo.deleteExpense(saved), { code: 'EXPENSE_CONFLICT' });
  demo.deleteExpense(updated);
  assert.equal(demo.getExpenses().expenses.length, initial);
  assert.throws(() => demo.saveExpense(draft.id, choices, key), { code: 'EXPENSE_DELETED' });
  assert.throws(() => demo.saveExpense(draft.id, choices, crypto.randomUUID()), { code: 'EXPENSE_DELETED' });
  t.mock.timers.tick(86400000);
  assert.equal(demo.getExpenses().expenses.length, 0);
  assert.equal(demo.getAllExpenses().expenses.length, initial);
});
