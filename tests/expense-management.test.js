import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { ExpenseRepository } from '../lib/db/ExpenseRepository.js';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { normalizeExpenseDate, normalizeConfirmation } from '../lib/domain/expense.js';
import { reportToCsv } from '../lib/domain/reportCsv.js';
import { migrateDatabase } from '../scripts/migrate.js';
import { createExpensesHandler } from '../api/expenses.js';
import { ApiError } from '../lib/http/ApiError.js';
import { testDatabase, addExpense, NOW } from './database.js';
import { mockRequest, mockResponse } from './helpers.js';

const parsed = { item: 'Coffee', amount_paise: 12500, category: 'food_drink', is_potential_leak: true };
const makeService = (repository, now = NOW) => new ExpenseService({ repository, now: () => new Date(now), parser: { async parse() { return parsed; } } });
const choices = (draft, expense_date = '2026-09-23') => ({ draft_id: draft.id, category: draft.category, payment_method: 'cash', expense_date });
const edit = (expense, changes = {}) => ({ id: expense.id, revision: expense.revision, item: expense.item, amount: expense.amount,
  category: expense.category, payment_method: expense.payment_method, expense_date: expense.expense_date, ...changes });
const fails = (status, code) => (error) => error.statusCode === status && (!code || error.code === code);

async function savedExpense(repository, date = '2026-09-23') {
  const service = makeService(repository);
  const { draft } = await service.preview('alice', 'coffee 125');
  const key = randomUUID();
  const saved = await service.confirm('alice', choices(draft, date), key);
  return { service, draft, key, ...saved };
}

test('expense dates validate strict formats, leap years, lower boundary and India midnight', () => {
  for (const value of ['', null, '2026-9-1', '2026-02-29', '2024-02-30', '1900-02-29', '1899-12-31', '2026-01-01T00:00:00Z', 20260923, ' 2026-09-23']) {
    assert.throws(() => normalizeExpenseDate(value, NOW), fails(400, 'INVALID_EXPENSE_DATE'), String(value));
  }
  assert.equal(normalizeExpenseDate('2024-02-29', NOW), '2024-02-29');
  assert.equal(normalizeExpenseDate('2000-02-29', NOW), '2000-02-29');
  assert.equal(normalizeExpenseDate('1900-01-01', NOW), '1900-01-01');
  assert.equal(normalizeExpenseDate(undefined, '2026-09-23T18:29:59.999Z'), '2026-09-23');
  assert.equal(normalizeExpenseDate(undefined, '2026-09-23T18:30:00.000Z'), '2026-09-24');
  assert.throws(() => normalizeExpenseDate('2026-09-24', '2026-09-23T18:29:59.999Z'), fails(400, 'FUTURE_EXPENSE_DATE'));
  assert.equal(normalizeExpenseDate('2026-09-24', '2026-09-23T18:30:00.000Z'), '2026-09-24');
  assert.equal(normalizeConfirmation({ draft_id: randomUUID(), category: 'food_drink', payment_method: 'cash' }, NOW).expense_date, '2026-09-24');
});

test('backdating changes report ownership of the day while retaining creation time and CSV dates', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  assert.equal(expense.expense_date, '2026-09-23');
  assert.equal(expense.created_at, NOW);
  assert.equal(expense.revision, 1);
  assert.equal((await service.listToday('alice')).expenses.length, 0);
  assert.equal((await service.analyticsToday('alice')).total_spent, 0);
  const report = await service.report('alice', { date: '2026-09-23', payment_method: 'cash' });
  assert.equal(report.total_spent, 125);
  assert.equal(report.series[0].date, '2026-09-23');
  assert.ok(reportToCsv(report).includes('"2026-09-23","2026-09-24 15:30:00","Coffee"'));
  assert.equal((await service.report('alice', { date: '2026-09-23', payment_method: 'credit_card' })).total_spent, 0);
});

test('confirmation dates are bound to retries while legacy omitted dates remain replayable across midnight', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, draft, expense, key } = await savedExpense(repository);
  for (const retryKey of [key, randomUUID()]) {
    assert.equal((await service.confirm('alice', choices(draft), retryKey)).expense.id, expense.id);
    await assert.rejects(service.confirm('alice', choices(draft, '2026-09-24'), retryKey), fails(409));
  }
  const later = makeService(repository, '2026-09-25T10:00:00.000Z');
  assert.equal((await later.confirm('alice', choices(draft), key)).expense.expense_date, '2026-09-23');
  const { draft: legacy } = await service.preview('alice', 'coffee 125');
  const body = { draft_id: legacy.id, category: legacy.category, payment_method: 'cash' };
  const original = await service.confirm('alice', body, randomUUID());
  const replay = await later.confirm('alice', body, randomUUID());
  assert.equal(replay.expense.id, original.expense.id);
  assert.equal(replay.expense.expense_date, '2026-09-24');
});

test('editing updates exact paise, day, category and payment in all reports without changing creation time', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  const result = await service.update('alice', edit(expense, { item: 'Bus fare', amount: 0.29, category: 'transport', payment_method: 'credit_card', expense_date: '2026-09-24' }));
  assert.equal(result.expense.amount, 0.29);
  assert.equal(result.expense.created_at, NOW);
  assert.equal(result.expense.revision, 2);
  assert.equal(result.expense.is_potential_leak, false);
  assert.equal((await service.listToday('alice')).expenses[0].item, 'Bus fare');
  assert.equal((await service.report('alice', { date: '2026-09-23' })).total_spent, 0);
  assert.equal((await service.report('alice', { payment_method: 'cash' })).total_spent, 0);
  const report = await service.report('alice', { payment_method: 'credit_card' });
  assert.equal(report.total_spent, 0.29);
  assert.deepEqual(report.groups, [{ category: 'transport', is_potential_leak: false, count: 1, total: 0.29 }]);
  assert.equal((await service.analyticsToday('alice')).total_spent, 0.29);
  await assert.rejects(service.update('alice', edit(expense, { amount: 999 })), fails(409, 'EXPENSE_CONFLICT'));
  await assert.rejects(service.delete('alice', { id: expense.id, revision: 1 }), fails(409));
  assert.equal((await service.listToday('alice')).expenses[0].amount, 0.29);
});

test('updates reject forged scope, dangerous descriptions, invalid currency, dates, category, and revisions', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  for (const changes of [{ user_id: 'bob' }, { item: '' }, { item: 'x'.repeat(121) }, { item: 'a\nscript' }, { amount: -1 }, { amount: 0 }, { amount: 0.001 }, { amount: '10' }, { amount: Infinity }, { amount: 10000000.01 }, { category: 'fake' }, { payment_method: 'debit_card' }, { payment_method: 'unspecified' }, { expense_date: undefined }, { expense_date: '2026-09-25' }, { revision: 0 }, { revision: 1.2 }, { revision: '1' }]) {
    await assert.rejects(service.update('alice', edit(expense, changes)), fails(400), JSON.stringify(changes));
  }
  const maximum = await service.update('alice', edit(expense, { amount: 10000000, item: 'x'.repeat(120) }));
  assert.equal(maximum.expense.amount, 10000000);
  assert.equal(maximum.expense.revision, 2);
});

test('legacy unspecified payments can be preserved or corrected but known methods cannot be cleared', async (t) => {
  const { repository } = await testDatabase(t);
  const saved = await addExpense(repository, 'alice');
  const service = makeService(repository);
  const preserved = await service.update('alice', edit(saved.expense, { item: 'Corrected legacy' }));
  assert.equal(preserved.expense.payment_method, 'unspecified');
  const corrected = await service.update('alice', edit(preserved.expense, { payment_method: 'cash' }));
  await assert.rejects(service.update('alice', edit(corrected.expense, { payment_method: 'unspecified' })), fails(400, 'INVALID_PAYMENT_METHOD'));
});

test('cross-account update/delete and missing identities cannot see or change records', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  for (const user of ['bob', 'charlie']) {
    await assert.rejects(service.update(user, edit(expense)), fails(404));
    await assert.rejects(service.delete(user, { id: expense.id, revision: 1 }), fails(404));
  }
  for (const user of ['', undefined, 'legacy-unclaimed']) {
    await assert.rejects(service.update(user, edit(expense)), fails(401));
    await assert.rejects(service.delete(user, { id: expense.id, revision: 1 }), fails(401));
    await assert.rejects(repository.update(user, {}), fails(401));
    await assert.rejects(repository.delete(user, {}, NOW), fails(401));
  }
  assert.equal((await service.report('alice', { date: '2026-09-23' })).total_spent, 125);
});

test('deletion is retry-safe and confirmation keys or drafts can never resurrect it', async (t) => {
  const { client, repository } = await testDatabase(t);
  const { service, draft, expense, key } = await savedExpense(repository);
  const alias = randomUUID();
  await service.confirm('alice', choices(draft), alias);
  for (let index = 0; index < 2; index++) assert.deepEqual(await service.delete('alice', { id: expense.id, revision: 1 }), { id: expense.id, deleted: true });
  for (const retryKey of [key, alias, randomUUID()]) await assert.rejects(service.confirm('alice', choices(draft), retryKey), fails(410, 'EXPENSE_DELETED'));
  const another = await service.preview('alice', 'coffee 125');
  await assert.rejects(service.confirm('alice', choices(another.draft), alias), fails(410));
  assert.equal((await service.report('alice', { date: '2026-09-23' })).total_spent, 0);
  assert.equal((await client.execute('SELECT * FROM expenses')).rows.length, 0);
  assert.equal((await client.execute('SELECT * FROM expense_confirmations')).rows.length, 0);
  assert.equal(await repository.findDraft('alice', draft.id), null);
  assert.equal((await client.execute('SELECT * FROM expense_deleted_keys')).rows.length, 2);
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
  await assert.rejects(service.update('alice', edit(expense)), fails(404));
  await assert.rejects(service.delete('bob', { id: expense.id, revision: 1 }), fails(404));
});

test('parallel edits and deletes serialize with revision checks across independent connections', async (t) => {
  const { repository, url } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  const connection = createClient({ url });
  t.after(() => connection.close());
  const other = makeService(new ExpenseRepository(connection));
  const results = await Promise.allSettled([service.update('alice', edit(expense, { amount: 10 })), other.update('alice', edit(expense, { amount: 20 }))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
  const current = results.find((result) => result.status === 'fulfilled').value.expense;
  const race = await Promise.allSettled([service.update('alice', edit(current, { amount: 30 })), other.delete('alice', { id: current.id, revision: current.revision })]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok([404, 409].includes(race.find((result) => result.status === 'rejected').reason.statusCode));
});

test('matched comparison groups respect payment filters, expense dates, owner and short months', async (t) => {
  const { repository } = await testDatabase(t);
  for (const [user, date, payment, category, amount] of [
    ['alice', '2026-02-28', 'cash', 'food_drink', 10], ['alice', '2026-03-28', 'cash', 'food_drink', 20],
    ['alice', '2026-03-29', 'cash', 'shopping', 100], ['alice', '2026-03-28', 'credit_card', 'food_drink', 900],
    ['bob', '2026-03-28', 'cash', 'shopping', 9999],
  ]) await repository.create(user, { id: randomUUID(), item: 'Logged later', amount_paise: amount * 100, category, is_potential_leak: false,
    expense_date: date, created_at: NOW, payment_method: payment, idempotency_key: randomUUID(), request_hash: 'test' });
  const report = await makeService(repository).report('alice', { period: 'month', date: '2026-03-10', payment_method: 'cash' });
  assert.equal(report.total_spent, 120);
  assert.equal(report.comparison.current_total_spent, 20);
  assert.equal(report.comparison.total_spent, 10);
  assert.deepEqual(report.comparison.groups, [{ category: 'food_drink', count: 1, total: 10 }]);
  assert.deepEqual(report.comparison.current_groups, [{ category: 'food_drink', count: 1, total: 20 }]);
});

test('additive migration backfills IST expense dates and tolerates old deployment writes', async (t) => {
  const { client, repository } = await testDatabase(t);
  const first = await addExpense(repository, 'alice', { createdAt: '2026-09-23T18:29:59.999Z' });
  const second = await addExpense(repository, 'alice', { createdAt: '2026-09-23T18:30:00.000Z' });
  await client.executeMultiple('DROP TRIGGER expenses_default_spending_date; DROP INDEX idx_expenses_user_date; ALTER TABLE expenses DROP COLUMN expense_date; ALTER TABLE expenses DROP COLUMN revision;');
  await migrateDatabase(client);
  await migrateDatabase(client);
  const rows = (await client.execute('SELECT * FROM expenses ORDER BY created_at')).rows;
  assert.equal(rows[0].id, first.expense.id);
  assert.equal(rows[0].expense_date, '2026-09-23');
  assert.equal(rows[1].id, second.expense.id);
  assert.equal(rows[1].expense_date, '2026-09-24');
  assert.ok(rows.every((row) => Number(row.revision) === 1));
  await client.execute({ sql: `INSERT INTO expenses (id,user_id,item,amount_paise,category,is_potential_leak,created_at,idempotency_key,request_hash)
    VALUES (?, 'alice', 'Old release', 100, 'other', 0, ?, ?, 'legacy')`, args: [randomUUID(), '2026-09-24T18:30:00.000Z', randomUUID()] });
  const legacy = (await client.execute("SELECT expense_date,created_at FROM expenses WHERE item = 'Old release'")).rows[0];
  assert.equal(legacy.expense_date, '2026-09-25');
  assert.equal(legacy.created_at, '2026-09-24T18:30:00.000Z');
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
});

test('mutation API authenticates then checks origin before touching content or storage', async () => {
  for (const method of ['PATCH', 'DELETE']) {
    const order = [];
    const handler = createExpensesHandler({ authenticate: async () => { order.push('auth'); return { id: 'alice' }; },
      checkOrigin: () => { order.push('origin'); throw new ApiError(403, 'Invalid origin.', 'INVALID_ORIGIN'); },
      service: { update() { assert.fail('No mutation'); }, delete() { assert.fail('No mutation'); } } });
    const response = mockResponse();
    await handler(mockRequest({ method, body: null }), response);
    assert.equal(response.statusCode, 403);
    assert.deepEqual(order, ['auth', 'origin']);
    const denied = createExpensesHandler({ authenticate: async () => { throw new ApiError(401, 'Sign in.', 'AUTHENTICATION_REQUIRED'); },
      checkOrigin: () => assert.fail('Auth must run first') });
    const deniedResponse = mockResponse();
    await denied(mockRequest({ method }), deniedResponse);
    assert.equal(deniedResponse.statusCode, 401);
  }
});

test('mutation API sends private standard envelopes and rejects unsupported bodies', async (t) => {
  const { repository } = await testDatabase(t);
  const { service, expense } = await savedExpense(repository);
  const handler = createExpensesHandler({ service, authenticate: async () => ({ id: 'alice' }), checkOrigin: () => {} });
  const updated = mockResponse();
  await handler(mockRequest({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: edit(expense, { amount: 50 }) }), updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.data.expense.revision, 2);
  assert.equal(updated.headers['cache-control'], 'no-store');
  assert.equal(updated.body.data.expense.user_id, undefined);
  const deleted = mockResponse();
  await handler(mockRequest({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: { id: expense.id, revision: 2 } }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.body.data, { id: expense.id, deleted: true });
  for (const [body, contentType, expected] of [[{}, 'application/json', 400], [{ id: expense.id, revision: 2, user_id: 'alice' }, 'application/json', 400], [{ id: expense.id, revision: 2 }, 'text/plain', 415]]) {
    const response = mockResponse();
    await handler(mockRequest({ method: 'DELETE', headers: { 'content-type': contentType }, body }), response);
    assert.equal(response.statusCode, expected);
  }
});

test('racing different dates save once and deletion racing confirmation never restores content', async (t) => {
  const { repository, url, client } = await testDatabase(t);
  const service = makeService(repository);
  const connection = createClient({ url });
  t.after(() => connection.close());
  const other = makeService(new ExpenseRepository(connection));
  const { draft } = await service.preview('alice', 'coffee 125');
  const key = randomUUID();
  const dates = await Promise.allSettled([
    service.confirm('alice', choices(draft, '2026-09-23'), key),
    other.confirm('alice', choices(draft, '2026-09-22'), randomUUID()),
  ]);
  assert.equal(dates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(dates.find((result) => result.status === 'rejected').reason.statusCode, 409);
  const current = dates.find((result) => result.status === 'fulfilled').value.expense;
  const race = await Promise.allSettled([
    service.delete('alice', { id: current.id, revision: current.revision }),
    other.confirm('alice', choices(draft, current.expense_date), randomUUID()),
  ]);
  assert.equal(race[0].status, 'fulfilled');
  if (race[1].status === 'rejected') assert.equal(race[1].reason.statusCode, 410);
  else assert.equal(race[1].value.replayed, true);
  assert.equal((await client.execute('SELECT * FROM expenses')).rows.length, 0);
  await assert.rejects(service.confirm('alice', choices(draft, current.expense_date), randomUUID()), fails(410));
});


test('report lower bound matches expense dates and earlier comparison windows remain valid', async (t) => {
  const { repository } = await testDatabase(t);
  const service = makeService(repository);
  for (const date of ['0001-01-01', '0099-01-01', '1899-12-31']) {
    await assert.rejects(service.report('alice', { date }), fails(400, 'INVALID_REPORT_DATE'));
  }
  for (const period of ['day', 'week', 'month']) {
    const report = await service.report('alice', { period, date: '1900-01-01' });
    assert.equal(report.start_date, '1900-01-01');
    assert.ok(report.comparison.start_date.startsWith('1899-'));
    assert.equal(report.total_spent, 0);
    assert.equal(report.comparison.total_spent, 0);
    assert.deepEqual(report.comparison.groups, []);
  }
});
