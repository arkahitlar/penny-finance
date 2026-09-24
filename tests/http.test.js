import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../lib/http/ApiError.js';
import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { readExpenseBody, readIdempotencyKey } from '../lib/http/request.js';
import { mockRequest, mockResponse } from './helpers.js';

test('ApiResponse sends the same success envelope and disables response caching', () => {
  const response = mockResponse();
  new ApiResponse(201, { expense: { amount: 235 } }, 'Saved').send(response);
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body, { success: true, data: { expense: { amount: 235 } }, message: 'Saved' });
});

test('ApiError produces a consistent expected failure envelope without stack traces', () => {
  const error = new ApiError(400, 'Describe an expense.', 'INVALID_TEXT');
  const response = mockResponse();
  ApiResponse.fromError(error).send(response);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    success: false,
    data: null,
    message: 'Describe an expense.',
    error: { code: 'INVALID_TEXT' },
  });
  assert.equal(JSON.stringify(response.body).includes('stack'), false);
});

test('asynchronous route boundary sanitizes unexpected database and provider failures', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...parts) => logged.push(parts));
  const handler = asyncHandler(async () => {
    throw new Error('libsql://private-db?authToken=secret-and-expense-text');
  });
  const response = mockResponse();
  await handler(mockRequest(), response);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.success, false);
  assert.equal(response.body.data, null);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
  assert.equal(JSON.stringify(logged).includes('secret'), false);
});

test('validates mandatory UUID idempotency headers and normalizes case', () => {
  assert.equal(readIdempotencyKey(mockRequest({
    headers: { 'idempotency-key': 'E29E9F9A-F84E-46B3-AD2C-0138815C5A90' },
  })), 'e29e9f9a-f84e-46b3-ad2c-0138815c5a90');
  for (const key of [undefined, '', 'plain-key', 123, ['e29e9f9a-f84e-46b3-ad2c-0138815c5a90']]) {
    assert.throws(() => readIdempotencyKey(mockRequest({ headers: { 'idempotency-key': key } })),
      (error) => error instanceof ApiError && error.statusCode === 400);
  }
});

test('rejects invalid content types, oversized bodies, malformed JSON, and nonobject bodies', () => {
  for (const [request, status] of [
    [mockRequest({ body: { text: 'coffee 50' } }), 415],
    [mockRequest({ body: { text: 'coffee 50' }, headers: { 'content-type': 'text/plain' } }), 415],
    [mockRequest({ body: { text: 'coffee 50' }, headers: { 'content-type': 'application/json', 'content-length': '4097' } }), 413],
    [mockRequest({ body: '{invalid', headers: { 'content-type': 'application/json' } }), 400],
    [mockRequest({ body: [], headers: { 'content-type': 'application/json' } }), 400],
    [mockRequest({ body: null, headers: { 'content-type': 'application/json' } }), 400],
  ]) {
    assert.throws(() => readExpenseBody(request), (error) => error instanceof ApiError && error.statusCode === status);
  }
  assert.deepEqual(readExpenseBody(mockRequest({
    body: '{"text":"coffee 50"}',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })), { text: 'coffee 50' });
});
