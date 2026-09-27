import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateInsights, normalizedItem } from '../public/insights.js';
import { buildDemoReport } from '../public/reports.js';

const group = (category, count, total) => ({ category, count, total });
const purchase = (item, amount, category = 'food_drink') => ({ item, amount, category });

test('insights use matched category windows, never unmatched full-month totals', () => {
  const result = calculateInsights({
    groups: [group('shopping', 10, 5000), group('food_drink', 5, 450)],
    expenses: [],
    comparison: { days_elapsed: 28,
      groups: [group('food_drink', 3, 300), group('shopping', 1, 50)],
      current_groups: [group('food_drink', 3, 450), group('shopping', 1, 50)] },
  });
  assert.equal(result.observations[0].kind, 'category_change');
  assert.equal(result.observations[0].category, 'food_drink');
  assert.equal(result.observations[0].difference, 150);
  assert.match(result.observations[0].text, /28 calendar days/);
  assert.doesNotMatch(result.observations[0].text, /5,000/);
  assert.equal(result.note, 'Based on your logged expenses.');
});

test('comparison needs at least three logged entries in both matched windows', () => {
  for (const [before, after] of [[0, 5], [2, 5], [5, 2]]) {
    const result = calculateInsights({ groups: [group('food_drink', after, 100)],
      comparison: { days_elapsed: 7, groups: [group('food_drink', before, 10)], current_groups: [group('food_drink', after, 100)] } });
    assert.equal(result.observations.some((entry) => entry.kind === 'category_change'), false);
  }
});

test('repeated entries normalize spacing case and Unicode without grouping different descriptions', () => {
  assert.equal(normalizedItem('  ＣＯＦＦＥＥ\n break '), 'coffee break');
  const report = { groups: [group('food_drink', 6, 400)], expenses: [
    purchase(' Coffee ', 0.1), purchase('COFFEE', 0.2), purchase('coffee', 100),
    purchase('Coffee large', 200), purchase('Café', 20), purchase('Cafe', 30),
  ] };
  const observation = calculateInsights(report).observations[0];
  assert.equal(observation.kind, 'repeated_item');
  assert.equal(observation.count, 3);
  assert.equal(observation.total, 100.3);
  assert.match(observation.text, /matching descriptions/);
  assert.equal(calculateInsights({ ...report, expenses: report.expenses.slice(1) }).observations.length, 0);
});

test('biggest contributor needs three entries and multiple categories, with duplicate group flags combined', () => {
  const low = calculateInsights({ groups: [group('food_drink', 1, 80), group('shopping', 1, 120)] });
  assert.equal(low.observations.length, 0);
  assert.match(low.emptyMessage, /Not enough history/);
  const enough = calculateInsights({ groups: [group('food_drink', 1, 80), group('food_drink', 1, 20), group('shopping', 1, 100)] });
  assert.equal(enough.observations[0].share_percent, 50);
  assert.equal(enough.observations[0].category, 'food_drink');
  assert.equal(calculateInsights({ groups: [group('food_drink', 5, 100)] }).observations.length, 0);
});

test('only two observations are returned and category changes/repetitions take precedence', () => {
  const report = { groups: [group('food_drink', 3, 600), group('shopping', 1, 100)],
    expenses: [purchase('Coffee', 200), purchase('Coffee', 200), purchase('Coffee', 200)],
    comparison: { days_elapsed: 7, groups: [group('food_drink', 3, 300)], current_groups: [group('food_drink', 3, 600)] } };
  assert.deepEqual(calculateInsights(report).observations.map((entry) => entry.kind), ['category_change', 'repeated_item']);
  assert.equal(calculateInsights(report, { max: 1 }).observations.length, 1);
  assert.equal(calculateInsights(report, { max: 10 }).observations.length, 2);
});

test('empty and malformed data give factual empty states, never no-spend or savings claims', () => {
  assert.deepEqual(calculateInsights().observations, []);
  assert.match(calculateInsights().emptyMessage, /No entries/);
  const invalid = calculateInsights({ groups: [group('food_drink', 4, NaN)], expenses: [purchase('Coffee', NaN), purchase('', 50)] });
  assert.deepEqual(invalid.observations, []);
  assert.doesNotMatch(JSON.stringify(invalid), /saved|waste|no spending|no-spend/i);
});

test('payment filtering scopes insights, category comparisons, repeated purchases and shares', () => {
  const rows = [0, 1, 2].flatMap((index) => [
    { ...purchase('Coffee', 100), id: `cash-${index}`, created_at: '2026-09-24T07:00:00Z', expense_date: '2026-09-24', payment_method: 'cash' },
    { ...purchase('Taxi', 300, 'transport'), id: `card-${index}`, created_at: '2026-09-24T07:00:00Z', expense_date: '2026-09-24', payment_method: 'credit_card' },
    { ...purchase('Coffee', 50), id: `prior-${index}`, created_at: '2026-09-23T07:00:00Z', expense_date: '2026-09-23', payment_method: 'cash' },
  ]);
  const cash = calculateInsights(buildDemoReport(rows, 'day', '2026-09-24', new Date('2026-09-24T10:00:00Z'), 'cash'));
  assert.deepEqual(cash.observations.map((entry) => entry.kind), ['category_change', 'repeated_item']);
  assert.equal(cash.observations[0].difference, 150);
  assert.equal(cash.observations[1].total, 300);
  assert.doesNotMatch(JSON.stringify(cash), /Taxi|Getting around/);
  const card = calculateInsights(buildDemoReport(rows, 'day', '2026-09-24', new Date('2026-09-24T10:00:00Z'), 'credit_card'));
  assert.deepEqual(card.observations.map((entry) => entry.kind), ['repeated_item']);
  assert.equal(card.observations[0].total, 900);
});

test('decreases and missing prior categories remain factual without division by zero', () => {
  const report = { groups: [group('health', 3, 600)], comparison: { days_elapsed: 1,
    groups: [group('food_drink', 3, 1000)], current_groups: [group('health', 3, 600)] } };
  const result = calculateInsights(report);
  assert.equal(result.observations[0].category, 'food_drink');
  assert.equal(result.observations[0].difference, -1000);
  assert.match(result.observations[0].title, /down/);
  assert.match(result.observations[0].text, /1 calendar day\./);
  assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity/);
});
