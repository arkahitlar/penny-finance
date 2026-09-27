// An explicitly selected, in-memory sample. Never sent to the API or persisted.
import { validateEdit } from './expenseManager.js';
import { expenseDate, validExpenseDate } from './expenseDates.js';
import { inferCategory, potentialLeakForCategory } from './classifyExpense.js';

const INDIA_OFFSET = 330 * 60 * 1000;
const DRAFT_LIFETIME_MS = 15 * 60 * 1000;
const CATEGORIES = new Set(['food_drink', 'shopping', 'entertainment', 'transport', 'groceries', 'bills', 'health', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function dateKey() { return new Date(Date.now() + INDIA_OFFSET).toISOString().slice(0, 10); }

function demoError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseDemoExpense(value) {
  if (typeof value !== 'string' || value.length > 500 || !value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error('Describe your expense in 1–500 characters.');
  }
  const text = value.replace(/\s+/g, ' ').trim();
  const matches = [...text.matchAll(/[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g)];
  const validAmount = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/;
  if (!matches.length) throw new Error('Include a total in rupees, like “coffee for 80”.');
  if (matches.some(([token]) => !validAmount.test(token))
    || /[+-]\s*(?:₹\s*)?(?:\d|\.\d)/.test(text)
    || /[$€£]|\b(?:USD|EUR|GBP|dollars?|euros?|pounds?)\b/i.test(text)) {
    throw new Error('Use a positive rupee amount with at most two decimal places.');
  }
  const candidates = matches.map((match) => {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const quantity = /^\s*(?:x\b|cups?\b|dosas?\b|idlis?\b|coffees?\b|teas?\b|samosas?\b|tickets?\b|litres?\b|liters?\b|kg\b|kilograms?\b|bottles?\b|packets?\b|pieces?\b|shirts?\b|pairs?\b)/i.test(after);
    const currency = /(?:₹|\b(?:rs\.?|inr|rupees))\s*$/i.test(before) || /^\s*(?:rupees?|inr|rs\.?)\b/i.test(after);
    const total = /\b(?:total|altogether|combined|in all)(?:\s+(?:was|is|of|for|came to))?\s*(?:(?:₹|rs\.?|inr)\s*)?$/i.test(before);
    return { match, quantity: quantity && !currency, total };
  });
  let selected;
  if (candidates.length === 1 && !candidates[0].quantity) selected = candidates[0];
  else {
    const totals = candidates.filter((candidate) => candidate.total);
    if (totals.length === 1) selected = totals[0];
    else if (totals.length === 0) {
      const amounts = candidates.filter((candidate) => !candidate.quantity);
      if (amounts.length === 1) selected = amounts[0];
    }
  }
  if (!selected) throw new Error('Include one clear total, like “2 dosas and coffee for 235”.');
  const amount = Number(selected.match[0].replaceAll(',', ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new Error('Add a positive amount in rupees, like “coffee for 80”.');
  const amountEnd = selected.match.index + selected.match[0].length;
  let item = `${text.slice(0, selected.match.index)} ${text.slice(amountEnd)}`.replaceAll('₹', '')
    .replace(/\b(?:had|bought|paid|spent|for|on|rs\.?|rupees?|inr|total|altogether|combined|was|is)\b/gi, '')
    .replace(/\s+/g, ' ').trim().replace(/^[.,:]+|[.,:]+$/g, '').trim();
  if (!item || !/\p{L}/u.test(item)) throw new Error('Include what you bought, like “coffee for 80”.');
  item = item.charAt(0).toUpperCase() + item.slice(1);
  if (item.length > 120) item = `${item.slice(0, 117).trimEnd()}…`;
  const { category, is_potential_leak } = inferCategory(text);
  return { item, amount, category, is_potential_leak };
}

export function emptyAnalytics() {
  return { date: dateKey(), timezone: 'Asia/Kolkata', currency: 'INR', total_spent: 0, expense_count: 0, daily_leak_velocity: 0, leak_count: 0, leak_share_percent: 0, small_transaction_count: 0, groups: [], warnings: [], hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, leak_total: 0 })) };
}
export function createDemo() {
  let day = dateKey();
  const drafts = new Map();
  const savedDrafts = new Map();
  const savedKeys = new Map();
  const deleted = new Set();
  let expenses = [
    ['Filter coffee', 80, 'food_drink', true, 'cash', '09:15'],
    ['Auto to work', 120, 'transport', false, 'cash', '09:40'],
    ['Dosa & coffee', 235, 'food_drink', true, 'credit_card', '12:30'],
    ['Weekly groceries', 640, 'groceries', false, 'credit_card', '14:05'],
    ['Afternoon chai', 40, 'food_drink', true, 'cash', '16:20'],
    ['A little snack break', 95, 'food_drink', true, 'cash', '17:45'],
  ].map(([item, amount, category, is_potential_leak, payment_method, time]) => ({ id: crypto.randomUUID(), item, amount, category, is_potential_leak, payment_method, expense_date: day, revision: 1, created_at: new Date(`${day}T${time}:00+05:30`).toISOString() }));
  function rollDay() {
    if (day !== dateKey()) day = dateKey();
    for (const [id, draft] of drafts) if (Date.parse(draft.expires_at) <= Date.now()) drafts.delete(id);
  }
  return {
    getExpenses() { rollDay(); return { date: day, timezone: 'Asia/Kolkata', expenses: expenses.filter(expense => expenseDate(expense) === day).map((expense) => ({ ...expense })).sort((a, b) => b.created_at.localeCompare(a.created_at)) }; },
    getAllExpenses() { rollDay(); return { date: day, timezone: 'Asia/Kolkata', expenses: expenses.map(expense => ({ ...expense })) }; },
    getAnalytics() {
      rollDay();
      const result = emptyAnalytics();
      const groups = new Map();
      const warningGroups = new Map();
      let totalPaise = 0;
      let leakPaise = 0;
      for (const expense of expenses.filter(expense => expenseDate(expense) === day)) {
        const paise = Math.round(expense.amount * 100);
        const leak = expense.is_potential_leak && paise < 50000;
        const key = `${expense.category}:${expense.is_potential_leak}`;
        totalPaise += paise;
        result.expense_count++;
        if (paise < 50000) result.small_transaction_count++;
        if (leak) { leakPaise += paise; result.leak_count++; }
        const group = groups.get(key) || { category: expense.category, is_potential_leak: expense.is_potential_leak, count: 0, total: 0 };
        group.count++; group.total = Math.round((group.total + expense.amount) * 100) / 100; groups.set(key, group);
        if (leak) {
          const warning = warningGroups.get(expense.category) || { category: expense.category, count: 0, total: 0 };
          warning.count++; warning.total = Math.round((warning.total + expense.amount) * 100) / 100; warningGroups.set(expense.category, warning);
        }
        const hour = new Date(new Date(expense.created_at).valueOf() + INDIA_OFFSET).getUTCHours();
        result.hourly[hour].total += expense.amount;
        if (leak) result.hourly[hour].leak_total += expense.amount;
      }
      result.total_spent = totalPaise / 100;
      result.daily_leak_velocity = leakPaise / 100;
      result.leak_share_percent = totalPaise ? leakPaise / totalPaise * 100 : 0;
      result.groups = [...groups.values()];
      result.warnings = [...warningGroups.values()].filter((group) => group.count >= 3).sort((a, b) => b.total - a.total);
      return result;
    },
    previewExpense(text) {
      rollDay();
      const parsed = parseDemoExpense(text);
      const draft = { id: crypto.randomUUID(), ...parsed, expires_at: new Date(Date.now() + DRAFT_LIFETIME_MS).toISOString() };
      drafts.set(draft.id, draft);
      return { ...draft };
    },
    saveExpense(draftId, { payment_method, category, expense_date = savedDrafts.get(draftId)?.expense_date ?? dateKey() } = {}, idempotencyKey) {
      rollDay();
      if (!['cash', 'credit_card'].includes(payment_method)) throw new Error('Choose cash or credit card before adding this expense.');
      if (!validExpenseDate(expense_date)) throw demoError('Choose a real date through today.', 'INVALID_EXPENSE_DATE', 400);
      if (!CATEGORIES.has(category)) throw new Error('Choose a valid expense category.');
      if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) throw new Error('A valid save request is required. Please try again.');
      const key = idempotencyKey.toLowerCase();
      const sameChoices = (saved) => saved.payment_method === payment_method && saved.category === category && saved.expense_date === expense_date;
      const previousKey = savedKeys.get(key);
      if (previousKey && (previousKey.draftId !== draftId || !sameChoices(previousKey.expense))) {
        throw demoError('This save request was already used for another expense.', 'IDEMPOTENCY_CONFLICT');
      }
      const existing = savedDrafts.get(draftId);
      if (existing && deleted.has(existing.id)) throw demoError('This expense was deleted.', 'EXPENSE_DELETED', 410);
      if (existing) {
        if (!sameChoices(existing)) throw demoError('This expense has already been added with different choices.', 'DRAFT_ALREADY_SAVED');
        savedKeys.set(key, { draftId, expense: existing });
        return { ...expenses.find(expense => expense.id === existing.id) };
      }
      const draft = drafts.get(draftId);
      if (!draft) throw demoError('This preview expired. Enter the expense again.', 'DRAFT_EXPIRED');
      const expense = { id: crypto.randomUUID(), item: draft.item, amount: draft.amount, category,
        is_potential_leak: potentialLeakForCategory(category, draft.category, draft.is_potential_leak), payment_method, expense_date, revision: 1,
        created_at: new Date().toISOString() };
      expenses.push(expense);
      drafts.delete(draftId);
      savedDrafts.set(draftId, expense);
      savedKeys.set(key, { draftId, expense });
      return { ...expense };
    },
    updateExpense(input) {
      rollDay();
      const index = expenses.findIndex(expense => expense.id === input.id);
      if (index < 0) throw demoError('This expense is no longer available.', 'EXPENSE_NOT_FOUND', 404);
      const current = expenses[index];
      if (current.revision !== input.revision) throw demoError('This expense changed. Refresh to edit the latest version.', 'EXPENSE_CONFLICT');
      const fields = validateEdit({ ...input, amount: String(input.amount) });
      if (fields.payment_method === 'unspecified' && current.payment_method !== 'unspecified') throw demoError('Choose cash or credit card.', 'INVALID_PAYMENT_METHOD', 400);
      const updated = { ...current, ...fields, revision: current.revision + 1,
        is_potential_leak: potentialLeakForCategory(fields.category, current.category, current.is_potential_leak) };
      expenses[index] = updated;
      return { expense: { ...updated } };
    },
    deleteExpense({ id, revision }) {
      rollDay();
      const current = expenses.find(expense => expense.id === id);
      if (!current) throw demoError('This expense is no longer available.', 'EXPENSE_NOT_FOUND', 404);
      if (current.revision !== revision) throw demoError('This expense changed. Refresh to delete the latest version.', 'EXPENSE_CONFLICT');
      deleted.add(id);
      expenses = expenses.filter(expense => expense.id !== id);
      return { deleted: true };
    },
  };
}
