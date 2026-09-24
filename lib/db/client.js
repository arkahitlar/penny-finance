import { createClient } from '@libsql/client';
import { ApiError } from '../http/ApiError.js';

let client;

/** Reuse a lightweight libSQL client across warm serverless invocations. */
export function getDatabaseClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new ApiError(503, 'Expense storage is not configured yet.', 'DATABASE_NOT_CONFIGURED');
  if (!url.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN) {
    throw new ApiError(503, 'Expense storage is not configured yet.', 'DATABASE_NOT_CONFIGURED');
  }
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  return client;
}
