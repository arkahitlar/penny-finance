import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { ExpenseRepository } from '../lib/db/ExpenseRepository.js';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { createParseExpenseHandler } from '../api/parseExpense.js';
import { createPreviewExpenseHandler } from '../api/previewExpense.js';
import { reportToCsv } from '../lib/domain/reportCsv.js';
import { testDatabase, NOW } from './database.js';
import { mockRequest, mockResponse } from './helpers.js';

const parsed = { item: 'Coffee', amount_paise: 12500, category: 'food_drink', is_potential_leak: true };
const choice = (draft, overrides = {}) => ({ draft_id: draft.id, payment_method: 'cash', category: draft.category, ...overrides });
const count = async (client, table) => Number((await client.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);

function serviceFor(repository, options = {}) {
  return new ExpenseService({ repository, parser: { async parse() { return parsed; } }, now: () => new Date(NOW), ...options });
}

test('preview returns server-owned details, saves no expense, and cancellation leaves reports untouched', async (t) => {
  const { client, repository } = await testDatabase(t);
  const service = serviceFor(repository);
  const { draft } = await service.preview('alice', 'coffee 125');
  assert.deepEqual(draft, {
    id: draft.id, item: 'Coffee', amount: 125, category: 'food_drink',
    is_potential_leak: true, expires_at: '2026-09-24T10:15:00.000Z',
  });
  assert.equal(await count(client, 'expense_drafts'), 1);
  assert.equal(await count(client, 'expenses'), 0);
  assert.deepEqual((await service.listToday('alice')).expenses, []);
  assert.equal((await service.report('alice')).total_spent, 0);
  assert.equal((await service.analyticsToday('alice')).expense_count, 0);
});

test('confirm persists payment and category correction, using one AI call and one quota unit overall', async (t) => {
  const { client, repository } = await testDatabase(t);
  let aiCalls = 0;
  const service = serviceFor(repository, {
    limits: { perMinute: 1, perDay: 1 }, parser: { async parse() { aiCalls += 1; return parsed; } },
  });
  const { draft } = await service.preview('alice', 'coffee 125');
  const { expense } = await service.confirm('alice', choice(draft, { category: 'groceries', payment_method: 'credit_card' }), randomUUID());
  assert.equal(expense.amount, 125);
  assert.equal(expense.item, 'Coffee');
  assert.equal(expense.payment_method, 'credit_card');
  assert.equal(expense.category, 'groceries');
  assert.equal(expense.is_potential_leak, false);
  assert.equal(expense.created_at, NOW);
  assert.equal(aiCalls, 1);
  const usage = (await client.execute("SELECT * FROM parsing_usage WHERE user_id = 'alice'")).rows[0];
  assert.equal(Number(usage.day_attempts), 1);
  assert.equal(Number(usage.minute_attempts), 1);
  assert.equal((await service.listToday('alice')).expenses[0].payment_method, 'credit_card');
  const report = await service.report('alice');
  assert.equal(report.expenses[0].payment_method, 'credit_card');
  assert.equal(report.daily_leak_velocity, 0);
  assert.ok(reportToCsv(report).includes('"Payment method"'));
  assert.ok(reportToCsv(report).includes('"Credit card"'));
});

test('drafts are isolated by signed-in identity and expire exactly at their deadline', async (t) => {
  const { client, repository } = await testDatabase(t);
  let now = NOW;
  const service = serviceFor(repository, { now: () => new Date(now) });
  const { draft } = await service.preview('alice', 'coffee 125');
  assert.equal(await repository.findDraft('bob', draft.id), null);
  await assert.rejects(service.confirm('bob', choice(draft), randomUUID()), (error) => error.statusCode === 404);
  now = draft.expires_at;
  await assert.rejects(service.confirm('alice', choice(draft), randomUUID()), (error) => error.statusCode === 410 && error.code === 'DRAFT_EXPIRED');
  assert.equal(await count(client, 'expenses'), 0);
  assert.equal(await count(client, 'expense_confirmations'), 0);
});

test('invalid choices and client-supplied parsed fields cannot save an expense', async (t) => {
  const { client, repository } = await testDatabase(t);
  const service = serviceFor(repository);
  const { draft } = await service.preview('alice', 'coffee 125');
  for (const body of [
    { text: 'coffee 125' }, choice(draft, { payment_method: 'unspecified' }),
    choice(draft, { payment_method: 'debit_card' }), choice(draft, { payment_method: null }),
    choice(draft, { category: 'unknown' }), choice(draft, { amount: 0.01 }),
    choice(draft, { item: 'Forged item' }), choice(draft, { is_potential_leak: false }),
    choice(draft, { user_id: 'bob' }), choice(draft, { draft_id: 'bad' }),
  ]) {
    const response = mockResponse();
    await createParseExpenseHandler({ service, authenticate: async () => ({ id: 'alice' }), checkOrigin: () => {} })(mockRequest({
      body, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    }), response);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(await count(client, 'expenses'), 0);
  assert.equal(await count(client, 'expense_confirmations'), 0);
});

test('same draft and choices replay with either the original key or a new key, even after expiry', async (t) => {
  const { client, repository } = await testDatabase(t);
  let now = NOW;
  const service = serviceFor(repository, { now: () => new Date(now) });
  const { draft } = await service.preview('alice', 'coffee 125');
  const key = randomUUID();
  const saved = await service.confirm('alice', choice(draft), key);
  assert.equal(saved.replayed, false);
  now = '2026-09-25T10:00:00.000Z';
  for (const retryKey of [key, randomUUID()]) {
    const retry = await service.confirm('alice', choice(draft), retryKey);
    assert.equal(retry.replayed, true);
    assert.equal(retry.expense.id, saved.expense.id);
  }
  assert.equal(await count(client, 'expenses'), 1);
  assert.equal(await count(client, 'expense_confirmations'), 2);
});

test('reused keys and reused drafts reject differing choices, including fresh retry aliases', async (t) => {
  const { client, repository } = await testDatabase(t);
  const service = serviceFor(repository);
  const { draft } = await service.preview('alice', 'coffee 125');
  const { draft: second } = await service.preview('alice', 'another coffee 125');
  const key = randomUUID();
  const alias = randomUUID();
  await service.confirm('alice', choice(draft), key);
  await service.confirm('alice', choice(draft), alias);
  for (const [input, retryKey] of [
    [choice(draft, { payment_method: 'credit_card' }), key],
    [choice(draft, { payment_method: 'credit_card' }), randomUUID()],
    [choice(draft, { category: 'groceries' }), randomUUID()],
    [choice(second), key], [choice(second), alias],
  ]) await assert.rejects(service.confirm('alice', input, retryKey), (error) => error.statusCode === 409);
  assert.equal(await count(client, 'expenses'), 1);
});

test('same key is independent per user for separate confirmed drafts', async (t) => {
  const { repository } = await testDatabase(t);
  const service = serviceFor(repository);
  const alice = await service.preview('alice', 'coffee 125');
  const bob = await service.preview('bob', 'coffee 125');
  const key = randomUUID();
  const first = await service.confirm('alice', choice(alice.draft), key);
  const second = await service.confirm('bob', choice(bob.draft), key);
  assert.notEqual(first.expense.id, second.expense.id);
  assert.deepEqual((await service.listToday('alice')).expenses.map((row) => row.id), [first.expense.id]);
  assert.deepEqual((await service.listToday('bob')).expenses.map((row) => row.id), [second.expense.id]);
});

test('parallel serverless clients cannot save a draft twice even with different submission keys', async (t) => {
  const { client, repository, url } = await testDatabase(t);
  const { draft } = await serviceFor(repository).preview('alice', 'coffee 125');
  const connections = Array.from({ length: 4 }, () => createClient({ url }));
  t.after(() => connections.forEach((connection) => connection.close()));
  const services = connections.map((connection) => serviceFor(new ExpenseRepository(connection)));
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => services[index % 4].confirm('alice', choice(draft), randomUUID())));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.expense.id)).size, 1);
  assert.equal(await count(client, 'expenses'), 1);
  assert.equal(await count(client, 'expense_confirmations'), 12);
});

test('racing contradictory confirmations save exactly one payment choice', async (t) => {
  const { client, repository, url } = await testDatabase(t);
  const service = serviceFor(repository);
  const { draft } = await service.preview('alice', 'coffee 125');
  const connection = createClient({ url });
  t.after(() => connection.close());
  const other = serviceFor(new ExpenseRepository(connection));
  const results = await Promise.allSettled([
    service.confirm('alice', choice(draft), randomUUID()),
    other.confirm('alice', choice(draft, { payment_method: 'credit_card' }), randomUUID()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
  assert.equal(await count(client, 'expenses'), 1);
});

test('same category preserves AI intent while category corrections use conservative leak rules', async (t) => {
  const { repository } = await testDatabase(t);
  const service = serviceFor(repository, { parser: { async parse() { return { ...parsed, is_potential_leak: false }; } } });
  for (const category of ['food_drink', 'shopping', 'entertainment', 'groceries', 'bills', 'health', 'transport', 'other']) {
    const { draft } = await service.preview('alice', 'coffee 125');
    const saved = await service.confirm('alice', choice(draft, { category }), randomUUID());
    assert.equal(saved.expense.is_potential_leak, ['shopping', 'entertainment'].includes(category), category);
  }
});

test('preview route authenticates, checks origin, and returns only the review draft', async (t) => {
  const { repository } = await testDatabase(t);
  const response = mockResponse();
  const handler = createPreviewExpenseHandler({
    service: serviceFor(repository), authenticate: async () => ({ id: 'alice' }), checkOrigin: () => {},
  });
  await handler(mockRequest({ body: { text: 'coffee 125' }, headers: { 'content-type': 'application/json' } }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.draft.amount, 125);
  assert.equal(response.body.data.expense, undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});
