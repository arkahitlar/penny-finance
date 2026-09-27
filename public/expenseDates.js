const OFFSET = 330 * 60 * 1000;
export function todayInIndia(now = new Date()) {
  return new Date(new Date(now).getTime() + OFFSET).toISOString().slice(0, 10);
}
export function expenseDate(expense) {
  return expense.expense_date || todayInIndia(expense.created_at);
}
export function validExpenseDate(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > todayInIndia(now)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function dateLabel(value) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}
export function yesterdayInIndia(now = new Date()) {
  return new Date(Date.parse(`${todayInIndia(now)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
