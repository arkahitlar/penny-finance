import { LEAK_THRESHOLD_PAISE, LEAK_WARNING_COUNT } from '../domain/expense.js';
import { ApiError } from '../http/ApiError.js';
import { parsingLimits } from '../domain/limits.js';

export function requireUserScope(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId === 'legacy-unclaimed') {
    throw new ApiError(401, 'Sign in to access your expenses.', 'AUTHENTICATION_REQUIRED');
  }
  return userId;
}

function mapExpense(row) {
  if (!row) return null;
  return {
    id: String(row.id), item: String(row.item), amount_paise: Number(row.amount_paise),
    amount: Number(row.amount_paise) / 100,
    category: String(row.category), is_potential_leak: Boolean(Number(row.is_potential_leak)),
    created_at: String(row.created_at), idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash),
    payment_method: String(row.payment_method ?? 'unspecified'),
    source_draft_id: row.source_draft_id == null ? null : String(row.source_draft_id),
  };
}

function mapDraft(row) {
  if (!row) return null;
  return {
    id: String(row.id), item: String(row.item), amount_paise: Number(row.amount_paise),
    category: String(row.category), is_potential_leak: Boolean(Number(row.is_potential_leak)),
    expires_at: String(row.expires_at),
  };
}

const selection = 'FROM expenses WHERE user_id = ? AND created_at >= ? AND created_at < ?';
const expensesQuery = (userId, start, end) => ({
  sql: `SELECT * ${selection} ORDER BY created_at DESC, id DESC`, args: [userId, start, end],
});
const groupsQuery = (userId, start, end) => ({
  sql: `SELECT category, is_potential_leak, COUNT(*) AS count, SUM(amount_paise) AS total_paise,
    SUM(CASE WHEN amount_paise < ? THEN 1 ELSE 0 END) AS small_transaction_count,
    SUM(CASE WHEN is_potential_leak = 1 AND amount_paise < ? THEN 1 ELSE 0 END) AS leak_count,
    SUM(CASE WHEN is_potential_leak = 1 AND amount_paise < ? THEN amount_paise ELSE 0 END) AS leak_total_paise
    ${selection} GROUP BY category, is_potential_leak ORDER BY total_paise DESC, category`,
  args: [LEAK_THRESHOLD_PAISE, LEAK_THRESHOLD_PAISE, LEAK_THRESHOLD_PAISE, userId, start, end],
});
const mapGroups = (rows) => rows.map((row) => ({
  category: String(row.category), is_potential_leak: Boolean(Number(row.is_potential_leak)),
  count: Number(row.count), total_paise: Number(row.total_paise),
  small_transaction_count: Number(row.small_transaction_count),
  leak_count: Number(row.leak_count), leak_total_paise: Number(row.leak_total_paise),
}));

/** Every entry point requires an authenticated user ID; scope is never inferred from a payload. */
export class ExpenseRepository {
  constructor(client) { this.client = client; }

  async consumeParsingQuota(userId, now = new Date(), limits) {
    requireUserScope(userId);
    const { perMinute, perDay } = parsingLimits(limits);
    const seconds = Math.floor(new Date(now).getTime() / 1000);
    if (!Number.isSafeInteger(seconds)) throw new TypeError('A valid quota timestamp is required.');
    const minuteStart = Math.floor(seconds / 60) * 60;
    const dayStart = Math.floor(seconds / 86_400) * 86_400;
    // A single conditional UPSERT changes both counters or neither. The write batch
    // serializes independent Vercel invocations without an in-memory lock or queue.
    const [, consumed, current] = await this.client.batch([
      {
        sql: `DELETE FROM parsing_usage WHERE user_id IN (
          SELECT user_id FROM parsing_usage WHERE day_start < ? ORDER BY day_start LIMIT 100
        )`,
        args: [dayStart],
      },
      {
        sql: `INSERT INTO parsing_usage (user_id, minute_start, minute_attempts, day_start, day_attempts)
          VALUES (?, ?, 1, ?, 1)
          ON CONFLICT(user_id) DO UPDATE SET
            minute_start = excluded.minute_start,
            minute_attempts = CASE WHEN parsing_usage.minute_start = excluded.minute_start THEN parsing_usage.minute_attempts + 1 ELSE 1 END,
            day_start = excluded.day_start,
            day_attempts = CASE WHEN parsing_usage.day_start = excluded.day_start THEN parsing_usage.day_attempts + 1 ELSE 1 END
          WHERE (parsing_usage.minute_start <> excluded.minute_start OR parsing_usage.minute_attempts < ?)
            AND (parsing_usage.day_start <> excluded.day_start OR parsing_usage.day_attempts < ?)
          RETURNING user_id`,
        args: [userId, minuteStart, dayStart, perMinute, perDay],
      },
      { sql: 'SELECT minute_start, minute_attempts, day_start, day_attempts FROM parsing_usage WHERE user_id = ?', args: [userId] },
    ], 'write');
    if (consumed.rows.length) return { allowed: true, retryAfterSeconds: 0 };
    const usage = current.rows[0];
    const dailyExhausted = Number(usage.day_start) === dayStart && Number(usage.day_attempts) >= perDay;
    const reset = dailyExhausted ? dayStart + 86_400 : minuteStart + 60;
    return { allowed: false, retryAfterSeconds: Math.max(1, reset - seconds) };
  }

  async findByIdempotencyKey(userId, key) {
    requireUserScope(userId);
    const result = await this.client.execute({
      sql: 'SELECT * FROM expenses WHERE user_id = ? AND idempotency_key = ?', args: [userId, key],
    });
    return mapExpense(result.rows[0]);
  }

  async createDraft(userId, draft, now) {
    requireUserScope(userId);
    const [, result] = await this.client.batch([
      {
        sql: `DELETE FROM expense_drafts WHERE id IN (
          SELECT id FROM expense_drafts WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
        )`, args: [now],
      },
      {
        sql: `INSERT INTO expense_drafts (id, user_id, item, amount_paise, category, is_potential_leak, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [draft.id, userId, draft.item, draft.amount_paise, draft.category, draft.is_potential_leak ? 1 : 0, draft.expires_at],
      },
    ], 'write');
    return mapDraft(result.rows[0]);
  }

  async findDraft(userId, draftId) {
    requireUserScope(userId);
    const result = await this.client.execute({
      sql: 'SELECT * FROM expense_drafts WHERE user_id = ? AND id = ?', args: [userId, draftId],
    });
    return mapDraft(result.rows[0]);
  }

  /** One SQLite write transaction binds canonical preview data, choices, and every retry key. */
  async confirmDraft(userId, data) {
    requireUserScope(userId);
    const [inserted, , matched, originalKey, source] = await this.client.batch([
      {
        sql: `INSERT INTO expenses
          (id, user_id, item, amount_paise, category, is_potential_leak, payment_method, source_draft_id,
            created_at, idempotency_key, request_hash)
          SELECT ?, user_id, item, amount_paise, ?,
            CASE WHEN category = ? THEN is_potential_leak
              WHEN ? IN ('food_drink', 'shopping', 'entertainment') THEN 1 ELSE 0 END,
            ?, id, ?, ?, ?
          FROM expense_drafts WHERE user_id = ? AND id = ? AND expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM expense_confirmations WHERE user_id = ? AND idempotency_key = ?)
          ON CONFLICT DO NOTHING RETURNING *`,
        args: [data.id, data.category, data.category, data.category, data.payment_method,
          data.created_at, data.idempotency_key, data.request_hash, userId, data.draft_id,
          data.created_at, userId, data.idempotency_key],
      },
      {
        sql: `INSERT INTO expense_confirmations (user_id, idempotency_key, request_hash, expense_id)
          SELECT user_id, ?, ?, id FROM expenses AS saved
          WHERE user_id = ? AND source_draft_id = ? AND request_hash = ?
            AND NOT EXISTS (SELECT 1 FROM expenses AS other
              WHERE other.user_id = ? AND other.idempotency_key = ? AND other.id <> saved.id)
          ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
        args: [data.idempotency_key, data.request_hash, userId, data.draft_id, data.request_hash, userId, data.idempotency_key],
      },
      {
        sql: `SELECT expenses.* FROM expense_confirmations AS confirmation
          JOIN expenses ON expenses.id = confirmation.expense_id AND expenses.user_id = confirmation.user_id
          WHERE confirmation.user_id = ? AND confirmation.idempotency_key = ?`,
        args: [userId, data.idempotency_key],
      },
      { sql: 'SELECT * FROM expenses WHERE user_id = ? AND idempotency_key = ?', args: [userId, data.idempotency_key] },
      { sql: 'SELECT * FROM expenses WHERE user_id = ? AND source_draft_id = ?', args: [userId, data.draft_id] },
    ], 'write');
    return {
      expense: mapExpense(matched.rows[0] ?? originalKey.rows[0] ?? source.rows[0]),
      inserted: inserted.rows.length > 0,
    };
  }

  async create(userId, data) {
    requireUserScope(userId);
    const result = await this.client.execute({
      sql: `INSERT INTO expenses
        (id, user_id, item, amount_paise, category, is_potential_leak, created_at, idempotency_key, request_hash, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, idempotency_key) DO NOTHING RETURNING *`,
      args: [data.id, userId, data.item, data.amount_paise, data.category, data.is_potential_leak ? 1 : 0,
        data.created_at, data.idempotency_key, data.request_hash, data.payment_method ?? 'unspecified'],
    });
    if (result.rows.length) return { expense: mapExpense(result.rows[0]), inserted: true };
    return { expense: await this.findByIdempotencyKey(userId, data.idempotency_key), inserted: false };
  }

  async listBetween(userId, start, end) {
    requireUserScope(userId);
    const result = await this.client.execute(expensesQuery(userId, start, end));
    return result.rows.map(mapExpense);
  }

  async aggregateBetween(userId, start, end) {
    requireUserScope(userId);
    const [grouped, hourly] = await this.client.batch([
      groupsQuery(userId, start, end),
      {
        sql: `SELECT CAST(strftime('%H', created_at, '+330 minutes') AS INTEGER) AS hour,
          SUM(amount_paise) AS total_paise,
          SUM(CASE WHEN is_potential_leak = 1 AND amount_paise < ? THEN amount_paise ELSE 0 END) AS leak_total_paise
          ${selection} GROUP BY hour ORDER BY hour`,
        args: [LEAK_THRESHOLD_PAISE, userId, start, end],
      },
    ], 'read');
    return {
      groups: mapGroups(grouped.rows),
      hourly: hourly.rows.map((row) => ({
        hour: Number(row.hour), total_paise: Number(row.total_paise), leak_total_paise: Number(row.leak_total_paise),
      })),
    };
  }

  async reportBetween(userId, range) {
    requireUserScope(userId);
    const { start, end, comparison } = range;
    // One read snapshot keeps cards, chart, CSV rows, and comparison consistent.
    const [grouped, daily, warnings, expenses, previous, comparable] = await this.client.batch([
      groupsQuery(userId, start, end),
      {
        sql: `SELECT date(created_at, '+330 minutes') AS date, SUM(amount_paise) AS total_paise,
          SUM(CASE WHEN is_potential_leak = 1 AND amount_paise < ? THEN amount_paise ELSE 0 END) AS leak_total_paise
          ${selection} GROUP BY date ORDER BY date`,
        args: [LEAK_THRESHOLD_PAISE, userId, start, end],
      },
      {
        // Frequency is measured per Indian day, never across an entire week or month.
        sql: `SELECT category, SUM(count) AS count, SUM(total_paise) AS total_paise FROM (
          SELECT category, date(created_at, '+330 minutes') AS date, COUNT(*) AS count, SUM(amount_paise) AS total_paise
          ${selection} AND is_potential_leak = 1 AND amount_paise < ?
          GROUP BY category, date HAVING COUNT(*) >= ?
        ) GROUP BY category ORDER BY total_paise DESC, category`,
        args: [userId, start, end, LEAK_THRESHOLD_PAISE, LEAK_WARNING_COUNT],
      },
      expensesQuery(userId, start, end),
      { sql: `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise ${selection}`, args: [userId, comparison.start, comparison.end] },
      { sql: `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise ${selection}`, args: [userId, start, comparison.current_end] },
    ], 'read');
    return {
      groups: mapGroups(grouped.rows), expenses: expenses.rows.map(mapExpense),
      daily: daily.rows.map((row) => ({ date: String(row.date), total_paise: Number(row.total_paise), leak_total_paise: Number(row.leak_total_paise) })),
      warnings: warnings.rows.map((row) => ({ category: String(row.category), count: Number(row.count), total_paise: Number(row.total_paise) })),
      previous_total_paise: Number(previous.rows[0].total_paise),
      comparable_total_paise: Number(comparable.rows[0].total_paise),
    };
  }
}
