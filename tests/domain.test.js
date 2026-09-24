import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORIES, normalizeExpenseText, validateParsedExpense } from '../lib/domain/expense.js';
import { getDayRange, getIndiaHour } from '../lib/domain/day.js';
import { getPeriodRange } from '../lib/domain/period.js';

const expense = (changes = {}) => ({
  item: 'Dosa and coffee',
  amount: 235,
  category: CATEGORIES[0],
  is_potential_leak: true,
  ...changes,
});

test('normalizes natural language input without changing its meaning', () => {
  assert.equal(normalizeExpenseText('  had a dosa\n and   coffee for ₹235  '), 'had a dosa and coffee for ₹235');
  for (const input of [undefined, null, 235, {}, [], '', ' \n ', 'a'.repeat(501)]) {
    assert.throws(() => normalizeExpenseText(input), undefined, `should reject ${JSON.stringify(input)}`);
  }
});

test('converts validated rupees to integer paise, including decimal currency boundaries', () => {
  for (const [amount, paise] of [[0.01, 1], [0.29, 29], [12.34, 1234], [235, 23500], [499.99, 49999], [500, 50000], [1e7, 1e9]]) {
    const value = validateParsedExpense(expense({ amount }));
    assert.equal(value.amount, amount);
    assert.equal(value.amount_paise, paise);
    assert.equal(Number.isSafeInteger(value.amount_paise), true);
  }
});

test('rejects unsafe, nonnumeric, missing, and overprecise amounts', () => {
  for (const amount of [0, -1, NaN, Infinity, -Infinity, '235', null, undefined, 0.001, 12.345, 1.0000001, 10000000.01]) {
    assert.throws(() => validateParsedExpense(expense({ amount })), undefined, `should reject amount ${String(amount)}`);
  }
});

test('enforces the four-field model schema and actual boolean values', () => {
  for (const input of [
    null,
    [],
    'not JSON',
    expense({ extra: 'do not trust extra model fields' }),
    expense({ item: '' }),
    expense({ item: '  ' }),
    expense({ item: 5 }),
    expense({ category: 'unknown-category' }),
    expense({ category: null }),
    expense({ is_potential_leak: 'false' }),
    expense({ is_potential_leak: 1 }),
  ]) {
    assert.throws(() => validateParsedExpense(input));
  }
  const missingFlag = expense();
  delete missingFlag.is_potential_leak;
  assert.throws(() => validateParsedExpense(missingFlag));
  assert.equal(validateParsedExpense(expense({ is_potential_leak: false })).is_potential_leak, false);
});

test('uses the Indian calendar day on both sides of midnight', () => {
  assert.deepEqual(getDayRange(new Date('2026-09-24T18:29:59.999Z')), {
    date: '2026-09-24',
    timezone: 'Asia/Kolkata',
    start: '2026-09-23T18:30:00.000Z',
    end: '2026-09-24T18:30:00.000Z',
  });
  assert.deepEqual(getDayRange(new Date('2026-09-24T18:30:00.000Z')), {
    date: '2026-09-25',
    timezone: 'Asia/Kolkata',
    start: '2026-09-24T18:30:00.000Z',
    end: '2026-09-25T18:30:00.000Z',
  });
});

test('Indian day and hour conversion handles year and leap-day boundaries', () => {
  const yearBoundary = getDayRange(new Date('2025-12-31T20:00:00.000Z'));
  assert.equal(yearBoundary.date, '2026-01-01');
  assert.equal(yearBoundary.start, '2025-12-31T18:30:00.000Z');
  const leapDay = getDayRange(new Date('2024-02-28T18:30:00.000Z'));
  assert.equal(leapDay.date, '2024-02-29');
  assert.equal(getIndiaHour('2026-09-24T18:30:00.000Z'), 0);
  assert.equal(getIndiaHour('2026-09-24T18:29:59.999Z'), 23);
});

test('report periods use inclusive calendar dates and half-open UTC bounds', () => {
  const now = '2026-09-24T10:00:00.000Z';
  const week = getPeriodRange({ period: 'week' }, now);
  assert.equal(week.start_date, '2026-09-21');
  assert.equal(week.end_date, '2026-09-27');
  assert.equal(week.start, '2026-09-20T18:30:00.000Z');
  assert.equal(week.end, '2026-09-24T18:30:00.000Z');
  assert.equal(week.days_elapsed, 4);
  const sunday = getPeriodRange({ period: 'week', date: '2026-09-20' }, now);
  assert.equal(sunday.start_date, '2026-09-14');
  assert.equal(sunday.end_date, '2026-09-20');
  assert.equal(sunday.days_elapsed, 7);
  const month = getPeriodRange({ period: 'month' }, now);
  assert.equal(month.start_date, '2026-09-01');
  assert.equal(month.end_date, '2026-09-30');
  assert.equal(month.days_elapsed, 24);
  assert.equal(month.comparison.end_date, '2026-08-24');
});

test('report dates validate leap years, month boundaries, and IST midnight', () => {
  const now = '2026-09-24T18:30:00.000Z';
  const leap = getPeriodRange({ period: 'month', date: '2024-02-29' }, now);
  assert.equal(leap.end_date, '2024-02-29');
  assert.equal(leap.days_elapsed, 29);
  assert.equal(leap.end, '2024-02-29T18:30:00.000Z');
  assert.equal(getPeriodRange({}, now).start_date, '2026-09-25');
  const january = getPeriodRange({ period: 'month', date: '2026-01-10' }, now);
  assert.equal(january.comparison.start_date, '2025-12-01');
  assert.equal(january.comparison.end_date, '2025-12-31');
  for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-09-26', '2026-9-24', 'garbage', '', '0000-01-01']) {
    assert.throws(() => getPeriodRange({ date }, now), (error) => error.statusCode === 400);
  }
  assert.throws(() => getPeriodRange({ period: 'year' }, now), (error) => error.code === 'INVALID_REPORT_PERIOD');
});
