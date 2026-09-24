import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createParseExpenseHandler } from '../api/parseExpense.js';
import { createPreviewExpenseHandler } from '../api/previewExpense.js';
import { createExpensesHandler } from '../api/expenses.js';
import { createAnalyticsHandler } from '../api/analytics.js';
import { createReportsHandler } from '../api/reports.js';
import { ApiError } from '../lib/http/ApiError.js';
import { mockRequest, mockResponse, VALID_EXPENSE } from './helpers.js';

const user = { id: 'route-user', name: 'Route test', email: 'test@example.com' };
const auth = { authenticate: async () => user, checkOrigin: () => {} };

test('all routes reject unsupported methods before resolving database or AI dependencies', async () => {
  for (const [handler, method, allowed] of [
    [createParseExpenseHandler(), 'GET', 'POST'],
    [createPreviewExpenseHandler(), 'GET', 'POST'],
    [createExpensesHandler(), 'POST', 'GET'],
    [createAnalyticsHandler(), 'DELETE', 'GET'],
    [createReportsHandler(), 'PUT', 'GET'],
  ]) {
    const response = mockResponse();
    await handler(mockRequest({ method }), response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, allowed);
    assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
  }
});

test('parse endpoint returns 201 on save and 200 plus replay header for a retried submission', async () => {
  for (const replayed of [false, true]) {
    const key = randomUUID();
    let argumentsReceived;
    const choices = { draft_id: randomUUID(), payment_method: 'cash', category: 'food_drink' };
    const handler = createParseExpenseHandler({ ...auth,
      service: {
        async confirm(...args) {
          argumentsReceived = args;
          return { expense: VALID_EXPENSE, replayed };
        },
      },
    });
    const response = mockResponse();
    await handler(mockRequest({
      body: choices,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
    }), response);
    assert.deepEqual(argumentsReceived, [user.id, choices, key]);
    assert.equal(response.statusCode, replayed ? 200 : 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data, { expense: VALID_EXPENSE });
    assert.equal(response.headers['idempotent-replayed'], replayed ? 'true' : undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('parse endpoint rejects invalid headers and bodies without calling the service', async () => {
  let calls = 0;
  const handler = createParseExpenseHandler({ ...auth, service: { async confirm() { calls += 1; } } });
  for (const [body, headers, status] of [
    [{ text: 'coffee for 40' }, {}, 415],
    [{ text: 'coffee for 40' }, { 'content-type': 'application/json' }, 400],
    ['{bad json', { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, 400],
  ]) {
    const response = mockResponse();
    await handler(mockRequest({ body, headers }), response);
    assert.equal(response.statusCode, status);
    assert.equal(response.body.success, false);
  }
  assert.equal(calls, 0);
});

test('preview endpoint preserves expected parsing failures as structured responses', async () => {
  const handler = createPreviewExpenseHandler({ ...auth,
    service: { async preview() { throw new ApiError(422, 'Include a total in rupees.', 'AMOUNT_REQUIRED'); } },
  });
  const response = mockResponse();
  await handler(mockRequest({
    body: { text: 'had coffee' },
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  }), response);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error.code, 'AMOUNT_REQUIRED');
  assert.equal(response.body.data, null);
});

test('read endpoints return service data inside the standard response envelope', async () => {
  const today = { date: '2026-09-24', timezone: 'Asia/Kolkata', expenses: [] };
  const analytics = { date: '2026-09-24', daily_leak_velocity: 0, warnings: [] };
  for (const [handler, expected] of [
    [createExpensesHandler({ ...auth, service: { async listToday() { return today; } } }), today],
    [createAnalyticsHandler({ ...auth, service: { async analyticsToday() { return analytics; } } }), analytics],
  ]) {
    const response = mockResponse();
    await handler(mockRequest({ method: 'GET' }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data, expected);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('every data route authenticates before accessing storage or validating export parameters', async () => {
  let storageCalls = 0;
  const dependencies = {
    authenticate: async () => { throw new ApiError(401, 'Sign in first.', 'AUTHENTICATION_REQUIRED'); },
    service: {
      async confirm() { storageCalls += 1; }, async preview() { storageCalls += 1; }, async listToday() { storageCalls += 1; },
      async analyticsToday() { storageCalls += 1; }, async report() { storageCalls += 1; },
    },
  };
  for (const [factory, method, url] of [
    [createParseExpenseHandler, 'POST', '/api/parseExpense'],
    [createPreviewExpenseHandler, 'POST', '/api/previewExpense'],
    [createExpensesHandler, 'GET', '/api/expenses'],
    [createAnalyticsHandler, 'GET', '/api/analytics'],
    [createReportsHandler, 'GET', '/api/reports?period=month&format=csv'],
  ]) {
    const response = mockResponse();
    await factory(dependencies)(mockRequest({ method, url }), response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.success, false);
    assert.equal(response.headers['content-disposition'], undefined);
  }
  assert.equal(storageCalls, 0);
});

test('expense creation checks request origin before parsing or saving', async () => {
  let called = false;
  const handler = createParseExpenseHandler({
    authenticate: auth.authenticate,
    checkOrigin: () => { throw new ApiError(403, 'Invalid origin.', 'INVALID_ORIGIN'); },
    service: { async confirm() { called = true; } },
  });
  const response = mockResponse();
  await handler(mockRequest({ body: { text: 'coffee 125' } }), response);
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
});

test('report JSON and CSV exports use authenticated identity and normalized query filters', async () => {
  const report = {
    period: 'week', start_date: '2026-09-21', end_date: '2026-09-27',
    expenses: [{ item: 'Coffee', category: 'food_drink', amount: 125, is_potential_leak: true, created_at: '2026-09-24T10:00:00.000Z' }],
  };
  const calls = [];
  const handler = createReportsHandler({
    ...auth, service: { async report(...args) { calls.push(args); return report; } },
  });
  const json = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/reports?period=week&date=2026-09-24&user_id=bob' }), json);
  assert.equal(json.statusCode, 200);
  assert.deepEqual(json.body.data, report);
  assert.deepEqual(calls[0], [user.id, { period: 'week', date: '2026-09-24' }]);
  const csv = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/reports?period=week&date=2026-09-24&format=csv' }), csv);
  assert.equal(csv.statusCode, 200);
  assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(csv.headers['cache-control'], 'no-store');
  assert.equal(csv.headers['content-disposition'], 'attachment; filename="penny-week-2026-09-21.csv"');
  assert.ok(csv.body.includes('"Coffee"'));
});

test('report exports reject ambiguous filters and unsupported output formats', async () => {
  let called = false;
  const handler = createReportsHandler({ ...auth, service: { async report() { called = true; } } });
  for (const query of ['period=day&period=week', 'date=2026-09-24&date=2026-09-23', 'format=csv&format=json', 'format=html']) {
    const response = mockResponse();
    await handler(mockRequest({ method: 'GET', url: `/api/reports?${query}` }), response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(called, false);
});
