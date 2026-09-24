import { normalizeExpenseText } from '../domain/expense.js';
import { inferCategory } from '../../public/classifyExpense.js';

/** Conservative evidence only: never discard words or infer a price. */
export function prepareExpense(input) {
  const original = normalizeExpenseText(input);
  const normalized = original.normalize('NFKC').replace(/[\u2018\u2019]/g, "'");
  const numbers = [...normalized.matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?(?![\w.])/g)];
  const candidate = numbers.length === 1 ? numbers[0][0] : null;
  const validGrouping = candidate && /^[+]?\d+(?:\.\d{1,2})?$|^[+]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?$|^[+]?[1-9]\d?(?:,\d{2})*,\d{3}(?:\.\d{1,2})?$/.test(candidate);
  const foreignCurrency = /[$€£¥]|\b(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/i.test(normalized);
  const category = inferCategory(normalized);
  return { original, normalized, numeric_amount_hint: validGrouping && !foreignCurrency ? Number(candidate.replaceAll(',', '')) : null, category_hint: category.matched ? category.category : null };
}
