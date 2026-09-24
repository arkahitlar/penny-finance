import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateDatabase, LEGACY_USER_ID } from '../scripts/migrate.js';
import { ExpenseService } from '../lib/services/ExpenseService.js';
import { testDatabase, addExpense, NOW } from './database.js';

const legacySchema = `CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  item TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  category TEXT NOT NULL,
  is_potential_leak INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);
CREATE INDEX idx_expenses_created_at ON expenses(created_at DESC);`;

async function legacyExpense(client, { amount = 12500 } = {}) {
  await client.execute({
    sql: `INSERT INTO expenses (id,item,amount_paise,category,is_potential_leak,created_at,idempotency_key,request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ['legacy-expense', 'Historical coffee', amount, 'food_drink', 1, NOW, 'legacy-key', 'original-hash'],
  });
}

test('fresh and repeated migrations preserve accounts and expenses with scoped uniqueness', async (t) => {
  const { client, repository } = await testDatabase(t);
  const saved = await addExpense(repository, 'alice', { amount: 235 });
  assert.deepEqual(await migrateDatabase(client), { migratedLegacyExpenses: false });
  assert.deepEqual(await migrateDatabase(client), { migratedLegacyExpenses: false });
  const rows = (await client.execute('SELECT id,user_id,amount_paise FROM expenses')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, saved.expense.id);
  assert.equal(rows[0].user_id, 'alice');
  assert.equal(Number(rows[0].amount_paise), 23500);
  assert.equal(saved.expense.payment_method, 'unspecified');
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
});

test('existing multi-user databases gain the parsing quota table without changing expense data', async (t) => {
  const { client, repository } = await testDatabase(t);
  const saved = await addExpense(repository, 'alice');
  await client.execute('DROP TABLE parsing_usage');
  await migrateDatabase(client);
  assert.equal((await repository.consumeParsingQuota('alice', NOW)).allowed, true);
  assert.equal((await client.execute('SELECT id FROM expenses')).rows[0].id, saved.expense.id);
});

test('legacy migration preserves every field under an account that cannot be accessed', async (t) => {
  const { client, repository } = await testDatabase(t, { migrate: false });
  await client.executeMultiple(legacySchema);
  await legacyExpense(client);
  assert.deepEqual(await migrateDatabase(client), { migratedLegacyExpenses: true });
  const row = (await client.execute('SELECT * FROM expenses')).rows[0];
  assert.equal(row.id, 'legacy-expense');
  assert.equal(row.user_id, LEGACY_USER_ID);
  assert.equal(row.item, 'Historical coffee');
  assert.equal(Number(row.amount_paise), 12500);
  assert.equal(row.created_at, NOW);
  assert.equal(row.idempotency_key, 'legacy-key');
  assert.equal(row.request_hash, 'original-hash');
  assert.equal(row.payment_method, 'unspecified');
  assert.equal(row.source_draft_id, null);
  const sentinel = (await client.execute({ sql: 'SELECT google_sub FROM users WHERE id = ?', args: [LEGACY_USER_ID] })).rows[0];
  assert.equal(sentinel.google_sub, 'legacy:unclaimed');
  await client.execute({
    sql: 'INSERT INTO users (id,google_sub,email,name,created_at) VALUES (?, ?, ?, ?, ?)',
    args: ['alice', '123456', 'alice@example.com', 'Alice', NOW],
  });
  const service = new ExpenseService({ repository, parser: {}, now: () => new Date(NOW) });
  assert.equal((await service.report('alice')).total_spent, 0);
  assert.deepEqual((await service.listToday('alice')).expenses, []);
  await assert.rejects(service.listToday(LEGACY_USER_ID), (error) => error.statusCode === 401);
  assert.deepEqual(await migrateDatabase(client), { migratedLegacyExpenses: false });
  assert.equal((await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses_legacy_unclaimed'")).rows.length, 0);
});

test('migration rolls back schema and data if a legacy record violates the new constraints', async (t) => {
  const { client } = await testDatabase(t, { migrate: false });
  await client.executeMultiple(legacySchema);
  await legacyExpense(client, { amount: -1 });
  await assert.rejects(migrateDatabase(client));
  const columns = (await client.execute('PRAGMA table_info(expenses)')).rows;
  assert.equal(columns.some((row) => row.name === 'user_id'), false);
  assert.equal(Number((await client.execute('SELECT amount_paise FROM expenses')).rows[0].amount_paise), -1);
  const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((row) => row.name);
  assert.deepEqual(tables, ['expenses']);
});

test('existing account databases gain payment tracking atomically without guessing historical payment methods', async (t) => {
  const { client, repository } = await testDatabase(t);
  const saved = await addExpense(repository, 'alice', { amount: 321 });
  // Recreate the released schema by removing only the new payment columns and tables.
  await client.executeMultiple(`
    DROP TABLE expense_confirmations;
    DROP TABLE expense_drafts;
    DROP INDEX idx_expenses_user_draft;
    ALTER TABLE expenses DROP COLUMN payment_method;
    ALTER TABLE expenses DROP COLUMN source_draft_id;
  `);
  for (let pass = 0; pass < 2; pass += 1) {
    await migrateDatabase(client);
    const row = (await client.execute('SELECT * FROM expenses')).rows[0];
    assert.equal(row.id, saved.expense.id);
    assert.equal(row.user_id, 'alice');
    assert.equal(Number(row.amount_paise), 32100);
    assert.equal(row.payment_method, 'unspecified');
    assert.equal(row.source_draft_id, null);
    assert.equal((await client.execute('SELECT * FROM users')).rows.length, 3);
    assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
  }
  await assert.rejects(client.execute("UPDATE expenses SET payment_method = 'debit_card'"));
  assert.equal((await repository.listBetween('alice', '2026-09-24', '2026-09-25'))[0].payment_method, 'unspecified');
});
