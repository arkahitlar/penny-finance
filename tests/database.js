import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { migrateDatabase } from '../scripts/migrate.js';
import { ExpenseRepository } from '../lib/db/ExpenseRepository.js';

export const NOW = '2026-09-24T10:00:00.000Z';

export async function testDatabase(t, { migrate = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'penny-reports-'));
  const url = `file:${path.join(directory, 'expenses.db')}`;
  const client = createClient({ url });
  t.after(async () => {
    client.close();
    await rm(directory, { recursive: true, force: true });
  });
  if (migrate) {
    await migrateDatabase(client);
    for (const [id, sub] of [['alice', '101'], ['bob', '102'], ['charlie', '103']]) {
      await client.execute({
        sql: 'INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [id, sub, `${id}@example.com`, id, NOW],
      });
    }
  }
  return { client, repository: new ExpenseRepository(client), url };
}

export async function addExpense(repository, userId, {
  amount = 100, category = 'food_drink', flag = true, date = '2026-09-24',
  createdAt = `${date}T06:00:00.000Z`, item = 'Coffee', key = randomUUID(),
} = {}) {
  const id = randomUUID();
  return repository.create(userId, {
    id, item, amount_paise: Math.round(amount * 100), category,
    is_potential_leak: flag, created_at: createdAt,
    idempotency_key: key, request_hash: createHash('sha256').update(id).digest('hex'),
  });
}
