import { ApiError } from './ApiError.js';
import { normalizeIdempotencyKey } from '../domain/expense.js';

export function requireMethod(req, res, method) {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    throw new ApiError(405, `Use ${method} for this endpoint.`, 'METHOD_NOT_ALLOWED');
  }
}

export function readExpenseBody(req) {
  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (contentType.split(';', 1)[0].trim() !== 'application/json') {
    throw new ApiError(415, 'Send a JSON request body.', 'UNSUPPORTED_MEDIA_TYPE');
  }
  if (Number(req.headers?.['content-length'] ?? 0) > 4096) {
    throw new ApiError(413, 'The expense description is too long.', 'PAYLOAD_TOO_LARGE');
  }
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > 4096) {
      throw new ApiError(413, 'The expense description is too long.', 'PAYLOAD_TOO_LARGE');
    }
    try { body = JSON.parse(body); } catch {
      throw new ApiError(400, 'The request body must be valid JSON.', 'INVALID_JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Send an object containing an expense description.', 'INVALID_BODY');
  }
  return body;
}

export function readIdempotencyKey(req) {
  return normalizeIdempotencyKey(req.headers?.['idempotency-key']);
}
