import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoReport, reportCsv } from '../public/reports.js';

function expense(item, amount, created_at, is_potential_leak = true, category = 'food_drink') {
  return { id: item, item, amount, created_at, is_potential_leak, category };
}

test('legacy demo dates use IST days and integer paise', () => {
  const rows = [
    expense('Prior day', 70, '2026-09-23T18:29:59Z'),
    expense('At midnight', 0.1, '2026-09-23T18:30:00Z'),
    expense('Coffee', 0.2, '2026-09-24T01:00:00Z'),
    expense('Exactly 500', 500, '2026-09-24T02:00:00Z'),
    expense('Essential', 100, '2026-09-24T03:00:00Z', false, 'transport'),
  ];
  const result = buildDemoReport(rows, 'day', '2026-09-24', new Date('2026-09-24T06:00:00Z'));
  assert.equal(result.total_spent, 600.3);
  assert.equal(result.expense_count, 4);
  assert.equal(Object.hasOwn(result, 'leak_total'), false);
  assert.equal(result.comparison.total_spent, 70);
  assert.equal(result.series[0].date, '2026-09-24');
  assert.equal(result.series[0].total, 600.3);
});

test('weekly reports start Monday, include zero-spend days, and compare matched elapsed days', () => {
  const rows = [
    expense('This Thursday', 400, '2026-09-24T05:00:00Z'),
    expense('Previous Monday', 100, '2026-09-14T05:00:00Z'),
    expense('Previous Friday', 1000, '2026-09-18T05:00:00Z'),
  ];
  const result = buildDemoReport(rows, 'week', '2026-09-24', new Date('2026-09-24T07:00:00Z'));
  assert.equal(result.start_date, '2026-09-21');
  assert.equal(result.end_date, '2026-09-27');
  assert.equal(result.days_elapsed, 4);
  assert.equal(result.series.length, 4);
  assert.equal(result.series[0].total, 0);
  assert.equal(result.average_daily_spend, 100);
  assert.equal(result.comparison.end_date, '2026-09-17');
  assert.equal(result.comparison.total_spent, 100);
  assert.equal(result.comparison.change_percent, 300);
  assert.deepEqual(result.comparison.groups, [{ category: 'food_drink', count: 1, total: 100 }]);
  assert.deepEqual(result.comparison.current_groups, [{ category: 'food_drink', count: 1, total: 400 }]);
});

test('monthly comparison caps both sides to the previous shorter month', () => {
  const rows = [
    expense('March early', 280, '2026-03-02T05:00:00Z'),
    expense('March late', 1000, '2026-03-31T05:00:00Z'),
    expense('February early', 140, '2026-02-02T05:00:00Z'),
  ];
  const result = buildDemoReport(rows, 'month', '2026-03-31', new Date('2026-04-01T07:00:00Z'));
  assert.equal(result.days_elapsed, 31);
  assert.equal(result.total_spent, 1280);
  assert.equal(result.comparison.days_elapsed, 28);
  assert.equal(result.comparison.end_date, '2026-02-28');
  assert.equal(result.comparison.current_total_spent, 280);
  assert.equal(result.comparison.change_percent, 100);
  assert.equal(result.comparison.current_groups[0].total, 280);
});

test('calendar arithmetic handles leap years and year boundaries', () => {
  const february = buildDemoReport([], 'month', '2024-02-29', new Date('2024-03-05T00:00:00Z'));
  assert.equal(february.days_elapsed, 29);
  assert.equal(february.comparison.end_date, '2024-01-29');
  const january = buildDemoReport([], 'week', '2026-01-01', new Date('2026-01-01T00:00:00Z'));
  assert.equal(january.start_date, '2025-12-29');
  assert.equal(january.end_date, '2026-01-04');
  assert.equal(january.comparison.start_date, '2025-12-22');
});

test('demo history stays empty when only current-day sample rows exist', () => {
  const result = buildDemoReport([expense('Today', 80, '2026-09-24T04:00:00Z')], 'week', '2026-09-14', new Date('2026-09-24T07:00:00Z'));
  assert.equal(result.total_spent, 0);
  assert.deepEqual(result.expenses, []);
  assert.equal(result.average_daily_spend, 0);
  assert.equal(result.comparison.change_percent, null);
});

test('CSV escapes formula-like names, double quotes, embedded line breaks, and IST date', () => {
  const result = buildDemoReport([
    { ...expense('=HYPERLINK("https://invalid.example")', 80, '2026-09-23T20:00:00Z'), payment_method: 'credit_card' },
    expense(' Coffee, "large"\nwith milk', 20, '2026-09-23T19:00:00Z'),
  ], 'day', '2026-09-24', new Date('2026-09-24T07:00:00Z'));
  const csv = reportCsv(result);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://invalid.example"")"'));
  assert.ok(csv.includes('" Coffee, ""large""\nwith milk"'));
  assert.ok(csv.includes('"2026-09-24 01:30:00"'));
  assert.ok(csv.includes('"2026-09-24","2026-09-24 01:30:00"'));
  assert.ok(csv.includes('"Expense date (IST)","Recorded at (IST)"'));
  assert.ok(!csv.includes('discretionary'));
  assert.ok(csv.includes('"Payment method"'));
  assert.ok(csv.includes('"Credit card","80.00"'));
  assert.ok(csv.includes('"Not specified","20.00"'));
});


test('demo payment filter also scopes previous-period comparisons and exports', () => {
  const rows = [
    { ...expense('Cash', 80, '2026-09-24T06:00:00Z'), payment_method: 'cash' },
    { ...expense('Card', 200, '2026-09-24T06:00:00Z'), payment_method: 'credit_card' },
    { ...expense('Prior cash', 40, '2026-09-23T06:00:00Z'), payment_method: 'cash' },
    { ...expense('Prior card', 500, '2026-09-23T06:00:00Z'), payment_method: 'credit_card' },
  ];
  const result = buildDemoReport(rows, 'day', '2026-09-24', new Date('2026-09-24T10:00:00Z'), 'cash');
  assert.equal(result.payment_method, 'cash');
  assert.equal(result.total_spent, 80);
  assert.equal(result.comparison.total_spent, 40);
  assert.equal(result.comparison.change_percent, 100);
  assert.equal(result.comparison.groups[0].total, 40);
  assert.equal(result.comparison.current_groups[0].total, 80);
  assert.ok(!reportCsv(result).includes('Card'));
});

test('backdated expenses affect their expense date instead of their recording date', () => {
  const rows = [
    { ...expense('Yesterday entered today', 80, '2026-09-24T10:00:00Z'), expense_date: '2026-09-23', payment_method: 'cash' },
    { ...expense('Today entered today', 200, '2026-09-24T06:00:00Z'), expense_date: '2026-09-24', payment_method: 'credit_card' },
  ];
  const today = buildDemoReport(rows, 'day', '2026-09-24', new Date('2026-09-24T10:00:00Z'));
  assert.equal(today.total_spent, 200);
  assert.equal(today.comparison.total_spent, 80);
  const yesterday = buildDemoReport(rows, 'day', '2026-09-23', new Date('2026-09-24T10:00:00Z'));
  assert.equal(yesterday.total_spent, 80);
  assert.equal(yesterday.series[0].total, 80);
  assert.match(reportCsv(yesterday), /"2026-09-23","2026-09-24 15:30:00"/);
});

test('demo report recomputes both comparison windows after edit and deletion', () => {
  const old = { ...expense('Coffee', 80, '2026-09-24T10:00:00Z'), expense_date: '2026-09-24', payment_method: 'cash' };
  const previous = { ...expense('Earlier coffee', 40, '2026-09-23T10:00:00Z'), expense_date: '2026-09-23', payment_method: 'cash' };
  const now = new Date('2026-09-24T10:00:00Z');
  const edited = { ...old, amount: 120, category: 'shopping', expense_date: '2026-09-23', payment_method: 'credit_card' };
  const all = buildDemoReport([edited, previous], 'day', '2026-09-24', now);
  assert.equal(all.total_spent, 0);
  assert.equal(all.comparison.total_spent, 160);
  assert.equal(all.comparison.current_groups.length, 0);
  const card = buildDemoReport([edited, previous], 'day', '2026-09-24', now, 'credit_card');
  assert.deepEqual(card.comparison.groups, [{ category: 'shopping', count: 1, total: 120 }]);
  const deleted = buildDemoReport([previous], 'day', '2026-09-23', now);
  assert.equal(deleted.total_spent, 40);
  assert.equal(deleted.expense_count, 1);
});

test('future demo window is empty without negative day count or future expenses', () => {
  const row = { ...expense('Future entry', 100, '2026-09-24T10:00:00Z'), expense_date: '2026-09-25' };
  const report = buildDemoReport([row], 'day', '2026-09-25', new Date('2026-09-24T10:00:00Z'));
  assert.equal(report.days_elapsed, 0);
  assert.equal(report.expense_count, 0);
  assert.deepEqual(report.series, []);
  assert.deepEqual(report.comparison.current_groups, []);
});
