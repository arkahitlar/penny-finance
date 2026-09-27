import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

export const LEGACY_USER_ID = 'legacy-unclaimed';

/** Atomic, repeatable migration. Historical shared data is never claimed by a Google user. */
export async function migrateDatabase(client) {
  const [authSchema, expenseSchema] = await Promise.all([
    readFile(new URL('../database/auth.sql', import.meta.url), 'utf8'),
    readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'),
  ]);
  const transaction = await client.transaction('write');
  try {
    await transaction.executeMultiple(authSchema);
    const columns = await transaction.execute('PRAGMA table_info(expenses)');
    const hasLegacyExpenses = columns.rows.length > 0 && !columns.rows.some((row) => row.name === 'user_id');
    if (hasLegacyExpenses) {
      await transaction.execute({
        sql: `INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        args: [LEGACY_USER_ID, 'legacy:unclaimed', 'unclaimed@invalid.local', 'Unclaimed legacy expenses', new Date().toISOString()],
      });
      const legacyUser = await transaction.execute({ sql: 'SELECT google_sub FROM users WHERE id = ?', args: [LEGACY_USER_ID] });
      if (legacyUser.rows[0]?.google_sub !== 'legacy:unclaimed') throw new Error('Reserved legacy account is unavailable.');
      await transaction.execute('ALTER TABLE expenses RENAME TO expenses_legacy_unclaimed');
      await transaction.executeMultiple(expenseSchema);
      await transaction.execute({
        sql: `INSERT INTO expenses
          (id, user_id, item, amount_paise, category, is_potential_leak, created_at, expense_date, idempotency_key, request_hash)
          SELECT id, ?, item, amount_paise, category, is_potential_leak, created_at, date(created_at, '+330 minutes'), idempotency_key, request_hash
          FROM expenses_legacy_unclaimed`,
        args: [LEGACY_USER_ID],
      });
      await transaction.execute('DROP TABLE expenses_legacy_unclaimed');
    } else {
      if (columns.rows.length) {
        if (!columns.rows.some((row) => row.name === 'expense_date')) {
          await transaction.execute("ALTER TABLE expenses ADD COLUMN expense_date TEXT");
          await transaction.execute("UPDATE expenses SET expense_date = date(created_at, '+330 minutes') WHERE expense_date IS NULL");
        }
        if (!columns.rows.some((row) => row.name === 'revision')) {
          await transaction.execute('ALTER TABLE expenses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)');
        }
        if (!columns.rows.some((row) => row.name === 'payment_method')) {
          await transaction.execute("ALTER TABLE expenses ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'unspecified' CHECK (payment_method IN ('cash', 'credit_card', 'unspecified'))");
        }
        if (!columns.rows.some((row) => row.name === 'source_draft_id')) {
          await transaction.execute('ALTER TABLE expenses ADD COLUMN source_draft_id TEXT');
        }
      }
      await transaction.executeMultiple(expenseSchema);
    }
    await transaction.execute("UPDATE expenses SET expense_date = date(created_at, '+330 minutes') WHERE expense_date IS NULL OR expense_date = ''");
    const invalidDates = await transaction.execute("SELECT id FROM expenses WHERE expense_date IS NULL OR expense_date < '1900-01-01' LIMIT 1");
    if (invalidDates.rows.length) throw new Error('Database contains an invalid historical expense date.');
    const violations = await transaction.execute('PRAGMA foreign_key_check');
    if (violations.rows.length) throw new Error('Database contains invalid user references.');
    await transaction.commit();
    return { migratedLegacyExpenses: hasLegacyExpenses };
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url || (!url.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN)) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running the migration.');
    process.exitCode = 1;
    return;
  }
  let client;
  try {
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
    const result = await migrateDatabase(client);
    console.log(result.migratedLegacyExpenses
      ? 'Database schema is ready. Legacy expenses are preserved in an inaccessible unclaimed account.'
      : 'Database schema is ready.');
  } catch {
    console.error('Migration failed. Check the database connection and schema. No partial migration was committed.');
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
