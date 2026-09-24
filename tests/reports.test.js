import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { getPeriodRange } from '../lib/domain/period.js';
import { csvField, reportToCsv } from '../lib/domain/reportCsv.js';
import { testDatabase, addExpense, NOW } from './database.js';

const makeService = (repository, now = NOW) => new ExpenseService({ repository, parser: {}, now: () => new Date(now) });

test('same submission key is independent per user and every expense query is isolated', async (t) => {
  const { repository } = await testDatabase(t);
  let calls = 0;
  const service = new ExpenseService({
    repository, now: () => new Date(NOW),
    parser: { async parse(text) {
      calls += 1;
      return { item: text, amount_paise: 12500, category: 'food_drink', is_potential_leak: true };
    } },
  });
  const key = randomUUID();
  const alice = await service.create('alice', 'Alice coffee 125', key);
  const bob = await service.create('bob', 'Bob coffee 125', key);
  assert.notEqual(alice.expense.id, bob.expense.id);
  assert.equal(calls, 2);
  assert.equal((await service.create('alice', 'Alice coffee 125', key)).replayed, true);
  assert.equal((await service.create('bob', 'Bob coffee 125', key)).replayed, true);
  await addExpense(repository, 'bob', { amount: 300 });
  await addExpense(repository, 'bob', { amount: 300 });
  assert.deepEqual((await service.listToday('alice')).expenses.map((row) => row.id), [alice.expense.id]);
  assert.equal((await service.analyticsToday('alice')).total_spent, 125);
  const report = await service.report('alice', { period: 'month' });
  assert.equal(report.total_spent, 125);
  assert.equal(report.expense_count, 1);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.series.reduce((total, row) => total + row.total, 0), 125);
  assert.equal(reportToCsv(report).includes('Bob'), false);
  const empty = await service.report('charlie', { period: 'month' });
  assert.equal(empty.total_spent, 0);
  assert.equal(empty.comparison.total_spent, 0);
  assert.equal(empty.comparison.change_percent, null);
  assert.deepEqual(empty.expenses, []);
});

test('repository and service reject absent identities and the inaccessible legacy account', async (t) => {
  const { repository } = await testDatabase(t);
  const service = makeService(repository);
  for (const userId of [undefined, null, '', ' ', 'legacy-unclaimed']) {
    for (const operation of [
      () => repository.create(userId, {}),
      () => repository.consumeParsingQuota(userId),
      () => repository.findByIdempotencyKey(userId, randomUUID()),
      () => repository.listBetween(userId, '', ''),
      () => repository.aggregateBetween(userId, '', ''),
      () => repository.reportBetween(userId, {}),
      () => service.create(userId, 'coffee 100', randomUUID()),
      () => service.listToday(userId),
      () => service.analyticsToday(userId),
      () => service.report(userId),
    ]) await assert.rejects(operation(), (error) => error.statusCode === 401);
  }
});

test('weekly reports compare matching elapsed days, zero-fill dates, and keep IST boundaries', async (t) => {
  const { repository } = await testDatabase(t);
  for (const [date, amount] of [['2026-09-21', 100], ['2026-09-22', 200], ['2026-09-23', 300], ['2026-09-24', 400]]) {
    await addExpense(repository, 'alice', { date, amount });
  }
  for (const date of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']) await addExpense(repository, 'alice', { date, amount: 50 });
  await addExpense(repository, 'alice', { date: '2026-09-18', amount: 999 });
  await addExpense(repository, 'alice', { createdAt: '2026-09-20T18:29:59.999Z', amount: 999 });
  await addExpense(repository, 'alice', { createdAt: '2026-09-24T18:30:00.000Z', amount: 999 });
  const report = await makeService(repository).report('alice', { period: 'week' });
  assert.equal(report.start_date, '2026-09-21');
  assert.equal(report.end_date, '2026-09-27');
  assert.equal(report.days_elapsed, 4);
  assert.equal(report.total_spent, 1000);
  assert.equal(report.leak_total, 1000);
  assert.equal(report.daily_leak_velocity, 250);
  assert.equal(report.average_daily_spend, 250);
  assert.equal(report.leak_share_percent, 100);
  assert.deepEqual(report.series.map((row) => row.total), [100, 200, 300, 400]);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.comparison, {
    start_date: '2026-09-14', end_date: '2026-09-17', days_elapsed: 4,
    total_spent: 200, current_total_spent: 1000, change_percent: 400,
  });
  const priorWeek = await makeService(repository).report('alice', { period: 'week', date: '2026-09-16' });
  assert.equal(priorWeek.days_elapsed, 7);
  assert.equal(priorWeek.series.length, 7);
  assert.equal(priorWeek.series[5].total, 0);
});

test('monthly warning totals include only categories and days reaching daily frequency threshold', async (t) => {
  const { repository } = await testDatabase(t);
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) await addExpense(repository, 'alice', { date, category: 'shopping', amount: 20 });
  for (let index = 0; index < 3; index += 1) await addExpense(repository, 'alice', { date: '2026-09-05', amount: 100 });
  await addExpense(repository, 'alice', { date: '2026-09-06', amount: 100 });
  await addExpense(repository, 'alice', { date: '2026-09-05', amount: 500 });
  await addExpense(repository, 'alice', { date: '2026-09-05', amount: 200, flag: false });
  const report = await makeService(repository, '2026-10-02T10:00:00.000Z').report('alice', { period: 'month', date: '2026-09-10' });
  assert.equal(report.days_elapsed, 30);
  assert.equal(report.series.length, 30);
  assert.equal(report.total_spent, 1160);
  assert.equal(report.leak_total, 460);
  assert.equal(report.leak_count, 7);
  assert.equal(report.daily_leak_velocity, 15.33);
  assert.equal(report.average_daily_spend, 38.67);
  assert.deepEqual(report.warnings, [{ category: 'food_drink', count: 3, total: 300 }]);
  assert.equal(report.groups.filter((row) => row.category === 'food_drink').length, 2);
});

test('shorter previous months compare equal day counts without changing full report totals', async (t) => {
  const { repository } = await testDatabase(t);
  await addExpense(repository, 'alice', { date: '2026-03-01', amount: 100 });
  await addExpense(repository, 'alice', { date: '2026-03-29', amount: 900 });
  await addExpense(repository, 'alice', { date: '2026-02-01', amount: 50 });
  const report = await makeService(repository).report('alice', { period: 'month', date: '2026-03-15' });
  assert.equal(report.total_spent, 1000);
  assert.equal(report.days_elapsed, 31);
  assert.equal(report.average_daily_spend, 32.26);
  assert.deepEqual(report.comparison, {
    start_date: '2026-02-01', end_date: '2026-02-28', days_elapsed: 28,
    total_spent: 50, current_total_spent: 100, change_percent: 100,
  });
});

test('empty daily reports have finite zeros, no warnings, and no invented percentage change', async (t) => {
  const { repository } = await testDatabase(t);
  const report = await makeService(repository).report('alice');
  for (const key of ['total_spent', 'expense_count', 'leak_total', 'leak_count', 'daily_leak_velocity', 'leak_share_percent', 'average_daily_spend']) assert.equal(report[key], 0);
  assert.equal(report.days_elapsed, 1);
  assert.deepEqual(report.series, [{ date: '2026-09-24', total: 0, leak_total: 0 }]);
  assert.equal(report.comparison.change_percent, null);
  assert.deepEqual(report.warnings, []);
});

test('CSV quotes fields, doubles embedded quotes, and neutralizes spreadsheet formula prefixes', () => {
  for (const value of ['=HYPERLINK("https://example.com")', '+1', '-1', '@SUM(A1)', ' \t=1+1', '\tunsafe', '\nunsafe']) {
    assert.ok(csvField(value).startsWith('"\''), value);
  }
  assert.equal(csvField('Coffee, "large"'), '"Coffee, ""large"""');
  const csv = reportToCsv({ expenses: [{
    item: '=1+1', category: 'food_drink', amount: 125.5, is_potential_leak: true,
    created_at: '2026-09-23T18:30:00.000Z',
  }] });
  assert.ok(csv.startsWith('\uFEFF"Date (IST)"'));
  assert.ok(csv.includes('"2026-09-24","00:00:00","\'=1+1","food_drink","Not specified","125.50","Yes"\r\n'));
  assert.equal(csv.includes('user_id'), false);
});

test('reports refuse invalid query periods and dates before querying storage', async () => {
  const service = makeService({ async reportBetween() { assert.fail('Storage must not be queried'); } });
  for (const options of [{ period: 'year' }, { date: '2026-09-25' }, { date: '2026-02-29' }, { date: '2026-9-1' }, { date: '' }]) {
    await assert.rejects(service.report('alice', options), (error) => error.statusCode === 400);
  }
  assert.equal(getPeriodRange({ period: 'day' }, NOW).days_elapsed, 1);
});
