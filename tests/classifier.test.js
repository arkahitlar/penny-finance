import assert from 'node:assert/strict';
import test from 'node:test';
import { inferCategory, potentialLeakForCategory } from '../public/classifyExpense.js';

test('classifies casual Indian purchases, merchants, and common spelling mistakes', () => {
  const examples = [
    ['had a dosa and cofee for 235', 'food_drink', true],
    ['2 idly and chai 85', 'food_drink', true],
    ['swigy biriyani 320', 'food_drink', true],
    ['ZOMATO dinner ₹280', 'food_drink', true],
    ['milk tea 40', 'food_drink', true],
    ['ice cream 95', 'food_drink', true],
    ['grocries 450', 'groceries', false],
    ['milk and fruits 200', 'groceries', false],
    ['tea powder 220', 'groceries', false],
    ['coffee beans 490', 'groceries', false],
    ['grocery shopping 300', 'groceries', false],
    ['BigBasket 640', 'groceries', false],
    ['paid Rapido 90', 'transport', false],
    ['Ola to office 140', 'transport', false],
    ['petorl 400', 'transport', false],
    ['pharamacy medcine 180', 'health', false],
    ['broadband bill via Uber 699', 'bills', false],
    ['mobile recharge 299', 'bills', false],
    ['eletricity 1400', 'bills', false],
    ['Netflix subscription 499', 'entertainment', true],
    ['spotfy 119', 'entertainment', true],
    ['new t-shirt and shoes 1200', 'shopping', true],
  ];
  for (const [description, category, is_potential_leak] of examples) {
    assert.deepEqual(inferCategory(description), { category, is_potential_leak, matched: true }, description);
  }
});

test('avoids substring matches and leaves unrelated or ambiguous purchases unclassified', () => {
  for (const description of [
    'steam cleaner 250', 'tuber 40', 'autograph 90', 'colander 250',
    'paid Ravi 500', 'something for 100', 'coffee beans and samosa 300',
    'medicine and shoes 800', 'not coffee 80', 'refund for petrol 300',
  ]) {
    assert.deepEqual(inferCategory(description), { category: 'other', is_potential_leak: false, matched: false }, description);
  }
  assert.equal(inferCategory('chocolate 40').category, 'food_drink');
  assert.equal(inferCategory('restaurant bill 300').category, 'food_drink');
  assert.equal(inferCategory('Netflix bill 499').category, 'entertainment');
});

test('category corrections keep essential purchases out of leak totals', () => {
  assert.equal(potentialLeakForCategory('food_drink', 'food_drink', false), false);
  assert.equal(potentialLeakForCategory('groceries', 'food_drink', true), false);
  assert.equal(potentialLeakForCategory('health', 'other', true), false);
  assert.equal(potentialLeakForCategory('food_drink', 'other', false), true);
});
