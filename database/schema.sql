-- Apply once with npm run db:migrate before serving requests.
-- Store exact paise and canonical ISO-8601 UTC timestamps; display INR/Asia/Kolkata.
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 120),
  amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise BETWEEN 1 AND 1000000000),
  category TEXT NOT NULL CHECK (category IN ('food_drink', 'shopping', 'entertainment', 'transport', 'groceries', 'bills', 'health', 'other')),
  is_potential_leak INTEGER NOT NULL CHECK (is_potential_leak IN (0, 1)),
  payment_method TEXT NOT NULL DEFAULT 'unspecified' CHECK (payment_method IN ('cash', 'credit_card', 'unspecified')),
  source_draft_id TEXT,
  created_at TEXT NOT NULL,
  expense_date TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_created_at ON expenses (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses (user_id, expense_date DESC, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_user_draft ON expenses (user_id, source_draft_id);

-- Parsed previews are private to one user and expire without becoming expenses.
CREATE TABLE IF NOT EXISTS expense_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 120),
  amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise BETWEEN 1 AND 1000000000),
  category TEXT NOT NULL CHECK (category IN ('food_drink', 'shopping', 'entertainment', 'transport', 'groceries', 'bills', 'health', 'other')),
  is_potential_leak INTEGER NOT NULL CHECK (is_potential_leak IN (0, 1)),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expense_drafts_expiry ON expense_drafts (expires_at);

-- Retain retry keys even when a saved draft is confirmed again with a fresh key.
CREATE TABLE IF NOT EXISTS expense_confirmations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, idempotency_key)
);

-- One counter row per user, updated atomically before each new paid AI attempt.
-- Fixed UTC calendar minute/day buckets; failed AI attempts consume quota too.
CREATE TABLE IF NOT EXISTS parsing_usage (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute_start INTEGER NOT NULL,
  minute_attempts INTEGER NOT NULL CHECK (minute_attempts >= 1),
  day_start INTEGER NOT NULL,
  day_attempts INTEGER NOT NULL CHECK (day_attempts >= 1)
);
CREATE INDEX IF NOT EXISTS idx_parsing_usage_day ON parsing_usage (day_start);

-- Minimal deletion receipts prevent delayed save retries from resurrecting deleted entries.
-- No item, amount, category, or other expense content is retained here.
CREATE TABLE IF NOT EXISTS expense_deletions (
  expense_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  source_draft_id TEXT,
  deleted_at TEXT NOT NULL,
  UNIQUE (user_id, source_draft_id)
);
CREATE TABLE IF NOT EXISTS expense_deleted_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  expense_id TEXT NOT NULL REFERENCES expense_deletions(expense_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, idempotency_key)
);

-- Compatibility with the previous release during the additive migration/deployment window.
CREATE TRIGGER IF NOT EXISTS expenses_default_spending_date
AFTER INSERT ON expenses WHEN NEW.expense_date IS NULL OR NEW.expense_date = ''
BEGIN
  UPDATE expenses SET expense_date = date(NEW.created_at, '+330 minutes') WHERE id = NEW.id;
END;
