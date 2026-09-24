import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { ExpenseRepository } from '../lib/db/ExpenseRepository.js';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { DEFAULT_PARSING_LIMITS } from '../lib/domain/limits.js';
import { ApiError } from '../lib/http/ApiError.js';
import { createPreviewExpenseHandler } from '../api/previewExpense.js';
import { mockRequest, mockResponse } from './helpers.js';
import { testDatabase, NOW } from './database.js';

const parsed = { item: 'Coffee', amount_paise: 12500, category: 'food_drink', is_potential_leak: true };

test('default paid parsing quotas are 20 per minute and 200 per UTC day', () => {
  assert.deepEqual(DEFAULT_PARSING_LIMITS, { perMinute: 20, perDay: 200 });
});

test('concurrent requests across independent database clients cannot overrun either quota', async (t) => {
  const { client, repository, url } = await testDatabase(t);
  let aiCalls = 0;
  const connections = Array.from({ length: 4 }, () => createClient({ url }));
  t.after(() => connections.forEach((connection) => connection.close()));
  const services = connections.map((connection) => new ExpenseService({
    repository: new ExpenseRepository(connection), now: () => new Date(NOW),
    limits: { perMinute: 3, perDay: 5 }, parser: { async parse() { aiCalls += 1; return parsed; } },
  }));
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => services[index % services.length].create('alice', 'coffee 125', randomUUID())));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 3);
  for (const rejected of attempts.filter((result) => result.status === 'rejected')) {
    assert.equal(rejected.reason.statusCode, 429);
    assert.equal(rejected.reason.code, 'RATE_LIMITED');
    assert.equal(rejected.reason.details.retry_after_seconds, 60);
  }
  assert.equal(aiCalls, 3);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 3);
  let usage = (await client.execute("SELECT * FROM parsing_usage WHERE user_id='alice'")).rows[0];
  assert.equal(Number(usage.minute_attempts), 3);
  assert.equal(Number(usage.day_attempts), 3);
  // Advancing a minute resets only that counter; the daily cap remains shared.
  const nextMinute = await Promise.all(Array.from({ length: 8 }, () => repository.consumeParsingQuota('alice', '2026-09-24T10:01:00.000Z', { perMinute: 3, perDay: 5 })));
  assert.equal(nextMinute.filter((result) => result.allowed).length, 2);
  usage = (await client.execute("SELECT * FROM parsing_usage WHERE user_id='alice'")).rows[0];
  assert.equal(Number(usage.minute_attempts), 2);
  assert.equal(Number(usage.day_attempts), 5);
  assert.equal((await repository.consumeParsingQuota('bob', NOW, { perMinute: 3, perDay: 5 })).allowed, true);
});

test('failed AI attempts consume quota, while saved replay still succeeds after exhaustion', async (t) => {
  const { client, repository } = await testDatabase(t);
  let aiCalls = 0;
  const service = new ExpenseService({
    repository, now: () => new Date(NOW), limits: { perMinute: 2, perDay: 2 },
    parser: { async parse() {
      aiCalls += 1;
      if (aiCalls === 2) throw new ApiError(502, 'Please rephrase this expense.', 'INVALID_AI_RESPONSE');
      return parsed;
    } },
  });
  const savedKey = randomUUID();
  const saved = await service.create('alice', 'coffee 125', savedKey);
  await assert.rejects(service.create('alice', 'unclear expense', randomUUID()), (error) => error.statusCode === 502);
  await assert.rejects(service.create('alice', 'new coffee 125', randomUUID()), (error) => error.statusCode === 429);
  const replayed = await service.create('alice', 'coffee 125', savedKey);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.expense.id, saved.expense.id);
  await assert.rejects(service.create('alice', 'different expense', savedKey), (error) => error.statusCode === 409);
  assert.equal(aiCalls, 2);
  const usage = (await client.execute("SELECT * FROM parsing_usage WHERE user_id='alice'")).rows[0];
  assert.equal(Number(usage.minute_attempts), 2);
  assert.equal(Number(usage.day_attempts), 2);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), 1);
});

test('daily quota resets at UTC midnight and safe retries point to the exhausted window', async (t) => {
  const { repository } = await testDatabase(t);
  const limits = { perMinute: 2, perDay: 3 };
  assert.equal((await repository.consumeParsingQuota('alice', '2026-09-24T23:58:20.000Z', limits)).allowed, true);
  assert.equal((await repository.consumeParsingQuota('alice', '2026-09-24T23:58:20.000Z', limits)).allowed, true);
  assert.deepEqual(await repository.consumeParsingQuota('alice', '2026-09-24T23:58:20.000Z', limits), { allowed: false, retryAfterSeconds: 40 });
  assert.equal((await repository.consumeParsingQuota('alice', '2026-09-24T23:59:00.000Z', limits)).allowed, true);
  assert.deepEqual(await repository.consumeParsingQuota('alice', '2026-09-24T23:59:01.000Z', limits), { allowed: false, retryAfterSeconds: 59 });
  assert.equal((await repository.consumeParsingQuota('alice', '2026-09-25T00:00:00.000Z', limits)).allowed, true);
});

test('quota cleanup deletes at most 100 expired user rows per attempt and preserves active usage', async (t) => {
  const { client, repository } = await testDatabase(t);
  const dayStart = Math.floor(Date.parse(NOW) / 86_400_000) * 86_400;
  const statements = [];
  for (let index = 0; index < 205; index += 1) {
    const id = `old-user-${index}`;
    statements.push({
      sql: 'INSERT INTO users (id,google_sub,email,name,created_at) VALUES (?, ?, ?, ?, ?)',
      args: [id, String(1000 + index), `${id}@example.com`, id, NOW],
    });
    statements.push({
      sql: 'INSERT INTO parsing_usage (user_id,minute_start,minute_attempts,day_start,day_attempts) VALUES (?, ?, 1, ?, 1)',
      args: [id, dayStart - 60, dayStart - 86_400],
    });
  }
  await client.batch(statements, 'write');
  await repository.consumeParsingQuota('alice', NOW);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM parsing_usage')).rows[0].count), 106);
  await repository.consumeParsingQuota('alice', NOW);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM parsing_usage')).rows[0].count), 6);
  await repository.consumeParsingQuota('alice', NOW);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM parsing_usage')).rows[0].count), 1);
  assert.equal(Number((await client.execute('SELECT day_attempts FROM parsing_usage')).rows[0].day_attempts), 3);
});

test('preview API preserves safe 429 responses and does not consume quota for invalid input', async (t) => {
  const { repository, client } = await testDatabase(t);
  let aiCalls = 0;
  const service = new ExpenseService({
    repository, now: () => new Date(NOW), limits: { perMinute: 1, perDay: 1 },
    parser: { async parse() { aiCalls += 1; return parsed; } },
  });
  await assert.rejects(service.create('alice', '', randomUUID()), (error) => error.statusCode === 400);
  assert.equal((await client.execute('SELECT * FROM parsing_usage')).rows.length, 0);
  await service.create('alice', 'coffee 125', randomUUID());
  const response = mockResponse();
  await createPreviewExpenseHandler({ service, authenticate: async () => ({ id: 'alice' }), checkOrigin: () => {} })(mockRequest({
    body: { text: 'coffee 125' }, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  }), response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.body.error.code, 'RATE_LIMITED');
  assert.equal(response.body.error.details.retry_after_seconds, 50_400);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(aiCalls, 1);
});
