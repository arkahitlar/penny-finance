import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { ExpenseRepository } from '../lib/db/ExpenseRepository.js';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { OpenAIParser } from '../lib/ai/OpenAIParser.js';
import { jsonCompletion, VALID_EXPENSE } from './helpers.js';

const NOW = '2026-09-24T10:00:00.000Z';
const USER_ID = 'integration-user';

async function database(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'money-leaks-test-'));
  const client = createClient({ url: `file:${path.join(directory, 'expenses.db')}` });
  t.after(async () => {
    client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.executeMultiple(await readFile(new URL('../database/auth.sql', import.meta.url), 'utf8'));
  await client.executeMultiple(await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'));
  await client.execute({ sql: 'INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)', args: [USER_ID, '123456', 'test@example.com', 'Test', NOW] });
  return { client, repository: new ExpenseRepository(client) };
}

async function insert(repository, { amount, category = 'food_drink', flag = true, createdAt = NOW }) {
  const id = randomUUID();
  return repository.create(USER_ID, {
    id,
    item: `Expense ${id}`,
    amount_paise: Math.round(amount * 100),
    category,
    is_potential_leak: flag,
    created_at: createdAt,
    idempotency_key: randomUUID(),
    request_hash: createHash('sha256').update(id).digest('hex'),
  });
}

test('persists parsed expenses once and replays an identical submission without another AI request', async (t) => {
  const { client, repository } = await database(t);
  let calls = 0;
  const parser = new OpenAIParser({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return jsonCompletion(VALID_EXPENSE);
    },
  });
  const service = new ExpenseService({ repository, parser, now: () => new Date(NOW) });
  const key = randomUUID();
  const first = await service.create(USER_ID, 'dosa and coffee for 235', key);
  const retry = await service.create(USER_ID, 'dosa and coffee for 235', key);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(first.expense.id, retry.expense.id);
  assert.equal(first.expense.amount, 235);
  assert.equal(first.expense.created_at, NOW);
  assert.equal(calls, 1);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 1);
  assert.equal(Object.hasOwn(first.expense, 'request_hash'), false);
  assert.equal(Object.hasOwn(first.expense, 'idempotency_key'), false);
  await assert.rejects(service.create(USER_ID, 'movie for 300', key), (error) => error.statusCode === 409);
  assert.equal(calls, 1);
});

test('invalid input and invalid AI output never create an expense', async (t) => {
  const { client, repository } = await database(t);
  let calls = 0;
  const parser = new OpenAIParser({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return jsonCompletion({ ...VALID_EXPENSE, amount: '235' });
    },
  });
  const service = new ExpenseService({ repository, parser, now: () => new Date(NOW) });
  await assert.rejects(service.create(USER_ID, '   ', randomUUID()));
  assert.equal(calls, 0);
  await assert.rejects(service.create(USER_ID, 'coffee for 235', randomUUID()));
  assert.equal(calls, 1);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 0);
});

test('concurrent submissions using one key cannot save two different expenses', async (t) => {
  const { client, repository } = await database(t);
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const parser = {
    async parse() {
      calls += 1;
      if (calls === 2) release();
      await gate;
      return { ...VALID_EXPENSE, amount_paise: 23500 };
    },
  };
  const service = new ExpenseService({ repository, parser, now: () => new Date(NOW) });
  const key = randomUUID();
  const results = await Promise.allSettled([
    service.create(USER_ID, 'coffee for 235', key),
    service.create(USER_ID, 'dosa for 235', key),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 1);
});

test('the SQLite schema independently rejects invalid currency, categories, and boolean flags', async (t) => {
  const { client } = await database(t);
  for (const overrides of [
    { amount: -1 },
    { amount: 0 },
    { amount: 123.5 },
    { amount: 1000000001 },
    { category: 'invented' },
    { flag: 2 },
  ]) {
    const values = { amount: 23500, category: 'food_drink', flag: 1, ...overrides };
    await assert.rejects(client.execute({
      sql: `INSERT INTO expenses (id, user_id, item, amount_paise, category, is_potential_leak, created_at, idempotency_key, request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [randomUUID(), USER_ID, 'Coffee', values.amount, values.category, values.flag, NOW, randomUUID(), 'hash'],
    }));
  }
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 0);
});

test('daily analytics use flagged expenses strictly below ₹500 and include both grouping dimensions', async (t) => {
  const { repository } = await database(t);
  for (const row of [
    { amount: 10, createdAt: '2026-09-23T18:30:00.000Z' },
    { amount: 20 },
    { amount: 499.99 },
    { amount: 500 },
    { amount: 50, flag: false },
    { amount: 80, category: 'shopping' },
    { amount: 49.5, category: 'transport' },
    { amount: 100, createdAt: '2026-09-23T18:29:59.999Z' },
    { amount: 200, createdAt: '2026-09-24T18:30:00.000Z' },
  ]) await insert(repository, row);
  const service = new ExpenseService({ repository, parser: {}, now: () => new Date(NOW) });
  const analytics = await service.analyticsToday(USER_ID);
  assert.equal(analytics.date, '2026-09-24');
  assert.equal(analytics.timezone, 'Asia/Kolkata');
  assert.equal(analytics.currency, 'INR');
  assert.equal(analytics.expense_count, 7);
  assert.equal(analytics.total_spent, 1209.49);
  assert.equal(analytics.daily_leak_velocity, 659.49);
  assert.equal(analytics.leak_count, 5);
  assert.equal(analytics.small_transaction_count, 6);
  assert.equal(analytics.groups.length, 4);
  const discretionaryFood = analytics.groups.find((group) => group.category === 'food_drink' && group.is_potential_leak);
  const essentialFood = analytics.groups.find((group) => group.category === 'food_drink' && !group.is_potential_leak);
  assert.equal(discretionaryFood.count, 4);
  assert.equal(discretionaryFood.total, 1029.99);
  assert.equal(essentialFood.count, 1);
  assert.equal(essentialFood.total, 50);
  assert.deepEqual(analytics.warnings, [{ category: 'food_drink', count: 3, total: 529.99 }]);
  assert.equal(analytics.hourly.length, 24);
  assert.deepEqual(analytics.hourly.map((row) => row.hour), Array.from({ length: 24 }, (_, hour) => hour));
  assert.equal(analytics.hourly[0].total, 10);
  assert.equal(analytics.hourly[0].leak_total, 10);
  assert.equal(Math.round(analytics.hourly.reduce((sum, row) => sum + row.total, 0) * 100), 120949);
  assert.equal(Math.round(analytics.hourly.reduce((sum, row) => sum + row.leak_total, 0) * 100), 65949);
  const today = await service.listToday(USER_ID);
  assert.equal(today.expenses.length, 7);
  assert.equal(today.expenses.some((row) => row.created_at === '2026-09-23T18:29:59.999Z'), false);
  assert.equal(today.expenses.some((row) => row.created_at === '2026-09-24T18:30:00.000Z'), false);
});

test('empty days produce finite zeros and no high-frequency warning', async (t) => {
  const { repository } = await database(t);
  const service = new ExpenseService({ repository, parser: {}, now: () => new Date(NOW) });
  const empty = await service.analyticsToday(USER_ID);
  assert.equal(empty.expense_count, 0);
  assert.equal(empty.total_spent, 0);
  assert.equal(empty.daily_leak_velocity, 0);
  assert.equal(empty.leak_share_percent, 0);
  assert.deepEqual(empty.warnings, []);
  assert.equal(empty.hourly.length, 24);
  await insert(repository, { amount: 100 });
  await insert(repository, { amount: 100 });
  assert.deepEqual((await service.analyticsToday(USER_ID)).warnings, []);
});
