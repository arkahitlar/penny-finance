const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const labels = {
  food_drink: 'Food & drink', transport: 'Getting around', shopping: 'Shopping',
  entertainment: 'Entertainment', groceries: 'Groceries', bills: 'Bills & utilities',
  health: 'Health', other: 'Other',
};
const paise = (amount) => Math.round(Number(amount) * 100);

function categoryTotals(groups = []) {
  const result = new Map();
  for (const group of groups) {
    const total = paise(group.total);
    if (!Number.isFinite(total) || total < 0 || !Number.isInteger(group.count) || group.count < 0) continue;
    const previous = result.get(group.category) || { category: group.category, count: 0, paise: 0 };
    previous.count += group.count;
    previous.paise += total;
    result.set(group.category, previous);
  }
  return result;
}

// Match only spelling/case/spacing variants, never infer merchants or subscriptions.
export function normalizedItem(item) {
  return String(item || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-IN');
}

export function calculateInsights(report = {}, { max = 2 } = {}) {
  const observations = [];
  const groups = categoryTotals(report.groups);
  const count = [...groups.values()].reduce((sum, group) => sum + group.count, 0);
  const total = [...groups.values()].reduce((sum, group) => sum + group.paise, 0);
  const comparison = report.comparison;
  const prior = categoryTotals(comparison?.groups);
  const current = categoryTotals(comparison?.current_groups);
  const priorCount = [...prior.values()].reduce((sum, group) => sum + group.count, 0);
  const currentCount = [...current.values()].reduce((sum, group) => sum + group.count, 0);

  if (comparison?.days_elapsed > 0 && priorCount >= 3 && currentCount >= 3) {
    const changes = [...new Set([...current.keys(), ...prior.keys()])].map((category) => ({
      category, previous: prior.get(category)?.paise || 0, current: current.get(category)?.paise || 0,
    })).map((entry) => ({ ...entry, difference: entry.current - entry.previous }))
      .filter((entry) => entry.difference !== 0)
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.category.localeCompare(b.category));
    const change = changes[0];
    if (change) {
      const name = labels[change.category] || 'Other';
      const days = comparison.days_elapsed;
      observations.push({
        kind: 'category_change', title: `${name}: ${change.difference > 0 ? 'up' : 'down'} ${currency.format(Math.abs(change.difference) / 100)}`,
        text: `${currency.format(change.current / 100)} logged, compared with ${currency.format(change.previous / 100)} in the previous period. Both windows cover ${days} calendar ${days === 1 ? 'day' : 'days'}.`,
        category: change.category, difference: change.difference / 100,
      });
    }
  }

  const repetitions = new Map();
  for (const expense of report.expenses || []) {
    const key = normalizedItem(expense.item);
    const amount = paise(expense.amount);
    if (!key || !Number.isFinite(amount) || amount <= 0) continue;
    const item = repetitions.get(key) || { name: String(expense.item).trim().replace(/\s+/gu, ' '), count: 0, paise: 0 };
    item.count++;
    item.paise += amount;
    repetitions.set(key, item);
  }
  const repeated = [...repetitions.values()].filter((item) => item.count >= 3)
    .sort((a, b) => b.paise - a.paise || b.count - a.count || a.name.localeCompare(b.name))[0];
  if (repeated) observations.push({
    kind: 'repeated_item', title: `${repeated.count} entries for ${repeated.name}`,
    text: `They total ${currency.format(repeated.paise / 100)} in this period. Entries are grouped by matching descriptions.`,
    count: repeated.count, total: repeated.paise / 100,
  });

  const contributors = [...groups.values()].filter((group) => group.paise > 0)
    .sort((a, b) => b.paise - a.paise || a.category.localeCompare(b.category));
  if (count >= 3 && contributors.length >= 2 && total > 0) {
    const largest = contributors[0];
    const share = Math.round(largest.paise / total * 100);
    observations.push({
      kind: 'largest_category', title: `${labels[largest.category] || 'Other'} leads at ${share}%`,
      text: `${currency.format(largest.paise / 100)} of ${currency.format(total / 100)} logged in this period.`,
      category: largest.category, share_percent: share,
    });
  }

  return {
    observations: observations.slice(0, Math.max(0, Math.min(2, Number.isFinite(max) ? Math.floor(max) : 2))),
    note: 'Based on your logged expenses.',
    emptyMessage: count === 0 ? 'No entries in this period yet. Add an expense, or choose another period.'
      : count < 3 ? 'Not enough history yet. A few more entries will help reveal useful patterns.'
        : 'No clear pattern in this period yet. Keep logging to compare categories and spot repeated purchases.',
  };
}
