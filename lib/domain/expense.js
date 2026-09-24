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
  };
}

export function normalizeConfirmation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
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
  return { draft_id: draftId, payment_method: value.payment_method, category: value.category };
}

export function publicDraft(row) {
  return {
    id: row.id, item: row.item, amount: Number(row.amount_paise) / 100,
    category: row.category, is_potential_leak: Boolean(row.is_potential_leak), expires_at: row.expires_at,
  };
}
