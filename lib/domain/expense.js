import { getDayRange } from './day.js';
import { ApiError } from '../http/ApiError.js';

export const CATEGORIES = Object.freeze([
  'food_drink', 'shopping', 'entertainment', 'transport',
  'groceries', 'bills', 'health', 'other',
]);
export const LEAK_THRESHOLD_PAISE = 50_000;
export const LEAK_WARNING_COUNT = 3;
export const PAYMENT_METHODS = Object.freeze(['cash', 'credit_card']);
export const DRAFT_LIFETIME_MS = 15 * 60 * 1000;

export function normalizeExpenseText(value) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new ApiError(400, 'Describe your expense in 1–500 characters.', 'INVALID_TEXT');
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ApiError(400, 'Describe your expense in 1–500 characters.', 'INVALID_TEXT');
  }
  return text;
}

/** Treat every model response as untrusted input, even with a strict JSON schema. */
export function validateParsedExpense(value) {
  const keys = ['item', 'amount', 'category', 'is_potential_leak'];
  const malformed = () => new ApiError(502, 'The expense could not be understood. Please rephrase it.', 'INVALID_AI_RESPONSE');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) throw malformed();
  if (typeof value.item !== 'string' || !value.item.trim() || value.item.trim().length > 120
    || /[\u0000-\u001f\u007f]/.test(value.item)
    || typeof value.amount !== 'number' || !Number.isFinite(value.amount)
    || !CATEGORIES.includes(value.category) || typeof value.is_potential_leak !== 'boolean') throw malformed();
  if (value.amount <= 0) {
    throw new ApiError(422, 'Include one clear, positive total in rupees, such as “coffee for 120”.', 'AMOUNT_REQUIRED');
  }
  const amountPaise = Math.round(value.amount * 100);
  if (value.amount > 10_000_000 || amountPaise < 1 || !Number.isSafeInteger(amountPaise)
    || value.amount !== amountPaise / 100) {
    throw new ApiError(422, 'Use an amount up to ₹1,00,00,000 with at most two decimal places.', 'INVALID_AMOUNT');
  }
  return {
    item: value.item.trim(), amount: amountPaise / 100, amount_paise: amountPaise,
    category: value.category, is_potential_leak: value.is_potential_leak,
  };
}

export function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'Send a UUID in the Idempotency-Key header.', 'INVALID_IDEMPOTENCY_KEY');
  }
  return value.toLowerCase();
}

export function publicExpense(row) {
  return {
    id: row.id,
    item: row.item,
    amount: Number(row.amount_paise) / 100,
    category: row.category,
    is_potential_leak: Boolean(row.is_potential_leak),
    payment_method: row.payment_method ?? 'unspecified',
    created_at: row.created_at,
    expense_date: row.expense_date ?? getDayRange(row.created_at).date,
    revision: Number(row.revision ?? 1),
  };
}

export function normalizeConfirmation(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every((key) => ['draft_id', 'payment_method', 'category', 'expense_date'].includes(key))
    || !['draft_id', 'payment_method', 'category'].every((key) => Object.hasOwn(value, key))) {
    throw new ApiError(400, 'Review the expense and select a payment method before saving.', 'INVALID_CONFIRMATION');
  }
  let draftId;
  try { draftId = normalizeIdempotencyKey(value.draft_id); } catch {
    throw new ApiError(400, 'Review the expense again before saving.', 'INVALID_DRAFT_ID');
  }
  if (!PAYMENT_METHODS.includes(value.payment_method)) {
    throw new ApiError(400, 'Select Cash or Credit card before saving.', 'INVALID_PAYMENT_METHOD');
  }
  if (!CATEGORIES.includes(value.category)) {
    throw new ApiError(400, 'Select a valid expense category.', 'INVALID_CATEGORY');
  }
  return { draft_id: draftId, payment_method: value.payment_method, category: value.category,
    expense_date: normalizeExpenseDate(value.expense_date, now) };
}

export function publicDraft(row) {
  return {
    id: row.id, item: row.item, amount: Number(row.amount_paise) / 100,
    category: row.category, is_potential_leak: Boolean(row.is_potential_leak), expires_at: row.expires_at,
  };
}

/** Date-only spending dates are independent of when a record was created. */
export function normalizeExpenseDate(value, now = new Date()) {
  const today = getDayRange(now).date;
  if (value === undefined) return today;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'Choose an expense date in YYYY-MM-DD format.', 'INVALID_EXPENSE_DATE');
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value || value < '1900-01-01') {
    throw new ApiError(400, 'Choose a valid expense date on or after 1 January 1900.', 'INVALID_EXPENSE_DATE');
  }
  if (value > today) throw new ApiError(400, 'Expense dates cannot be in the future (India time).', 'FUTURE_EXPENSE_DATE');
  return value;
}

export function normalizeExpenseIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ApiError(400, 'Refresh the expense before making changes.', 'INVALID_EXPENSE_REVISION');
  }
  return { id: value.id, revision: value.revision };
}

export function normalizeExpenseUpdate(value, now = new Date()) {
  const identity = normalizeExpenseIdentity(value);
  const fields = ['id', 'revision', 'item', 'amount', 'category', 'payment_method', 'expense_date'];
  if (Object.keys(value).length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) {
    throw new ApiError(400, 'Complete all expense fields before saving.', 'INVALID_EXPENSE_UPDATE');
  }
  if (typeof value.item !== 'string' || !value.item.trim() || value.item.trim().length > 120
    || /[\u0000-\u001f\u007f]/.test(value.item)) {
    throw new ApiError(400, 'Use a description of 1–120 characters.', 'INVALID_ITEM');
  }
  const amountPaise = Math.round(value.amount * 100);
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount <= 0
    || value.amount > 10_000_000 || !Number.isSafeInteger(amountPaise)
    || amountPaise < 1 || value.amount !== amountPaise / 100) {
    throw new ApiError(400, 'Use a positive amount up to ₹1,00,00,000 with at most two decimal places.', 'INVALID_AMOUNT');
  }
  if (!CATEGORIES.includes(value.category)) throw new ApiError(400, 'Choose a valid category.', 'INVALID_CATEGORY');
  if (![...PAYMENT_METHODS, 'unspecified'].includes(value.payment_method)) throw new ApiError(400, 'Choose Cash or Credit card.', 'INVALID_PAYMENT_METHOD');
  if (value.expense_date === undefined) throw new ApiError(400, 'Choose an expense date.', 'INVALID_EXPENSE_DATE');
  return { ...identity, item: value.item.trim().replace(/\s+/g, ' '), amount_paise: amountPaise,
    category: value.category, payment_method: value.payment_method, expense_date: normalizeExpenseDate(value.expense_date, now) };
}

export function normalizeExpenseDelete(value) {
  const identity = normalizeExpenseIdentity(value);
  if (Object.keys(value).length !== 2) throw new ApiError(400, 'Send the expense and its revision.', 'INVALID_EXPENSE_DELETE');
  return identity;
}
