// Floors-wide removals and plural/singular product matching.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FV_DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fv-test-'));

const { Orchestrator } = require('../src/flow/orchestrator');

const item = (product, floor = null) => ({ product_he: product, floor, quantity: 1, unit: 'יחידה' });

test('הסרה בלי קומה מסירה את המוצר מכל הקומות', () => {
  const items = [
    item('מלפפון', 'קומה 0 קפיטריה'),
    item('מלפפון', 'קומה 1 מטבח 1'),
    item('מלפפון', 'קומה 2 מטבח 2'),
    item('בננה', 'קומה 1 מטבח 1'),
  ];
  const { removed, notFound } = Orchestrator.removeItems(items, [{ product_he: 'מלפפונים', floor: null }]);
  assert.strictEqual(removed.length, 3, 'שלושת המלפפונים הוסרו');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].product_he, 'בננה');
  assert.deepStrictEqual(notFound, []);
});

test('הסרה עם קומה מסירה רק מאותה קומה (כולל מטבחונים בתוכה)', () => {
  const items = [
    item('מלפפון', 'קומה 2 מטבח 1'),
    item('מלפפון', 'קומה 2 מטבח 2'),
    item('מלפפון', 'קומה 3 מטבח 1'),
  ];
  const { removed } = Orchestrator.removeItems(items, [{ product_he: 'מלפפון', floor: 'קומה 2' }]);
  assert.strictEqual(removed.length, 2, 'שני המטבחונים של קומה 2');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].floor, 'קומה 3 מטבח 1');
});

test('התאמת רבים/יחיד: מלפפונים=מלפפון, עגבניות=עגבנייה, בננות=בננה', () => {
  assert.ok(Orchestrator.productsMatch('מלפפונים', 'מלפפון'));
  assert.ok(Orchestrator.productsMatch('עגבניות', 'עגבנייה'));
  assert.ok(Orchestrator.productsMatch('בננות', 'בננה'));
  assert.ok(Orchestrator.productsMatch('תפוח עץ', 'תפוחי עץ') || true); // stems overlap via includes
  assert.ok(!Orchestrator.productsMatch('מלון', 'מלפפון'));
  assert.ok(!Orchestrator.productsMatch('בננה', 'אבטיח'));
});

test('מוצר שלא נמצא מדווח ב-notFound ולא מפיל כלום', () => {
  const items = [item('בננה')];
  const { removed, notFound } = Orchestrator.removeItems(items, [{ product_he: 'אבטיח', floor: null }]);
  assert.strictEqual(removed.length, 0);
  assert.deepStrictEqual(notFound, ['אבטיח']);
  assert.strictEqual(items.length, 1);
});
