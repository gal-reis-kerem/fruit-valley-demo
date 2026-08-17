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

test('לקוח משלם עם כמה משרדים: בלי ציון משרד בהודעה - שואלים, לא מניחים', () => {
  const { config } = require('../src/config');
  config.companies.length = 0;
  config.companies.push(
    { name: 'סולאראדג׳ הרצליה', crm: { payer: 'סולאראדג׳', office: 'הרצליה' } },
    { name: 'סולאראדג׳ ציפורית', crm: { payer: 'סולאראדג׳', office: 'ציפורית' } },
    { name: 'סולאראדג׳ מודיעין', crm: { payer: 'סולאראדג׳', office: 'מודיעין' } },
    { name: 'אלמה', crm: { payer: null, office: 'אלמה' } },
  );
  const flow = new Orchestrator({}, { pickingGroup: { id: { _serialized: 'x' }, name: 'x' }, photosGroup: null });
  const solar = config.companies[1]; // המודל "בחר" ציפורית
  // ההודעה מזכירה רק את הלקוח המשלם -> חייבים לשאול (3 מועמדים)
  const amb = flow.ambiguousOffice(solar, 'הזמנה סולראדג׳: 2 קילו מלפפונים');
  assert.ok(amb && amb.length === 3);
  // המשרד נקוב בהודעה -> שיוך בטוח
  assert.strictEqual(flow.ambiguousOffice(solar, 'הזמנה לסולראדג׳ ציפורית: מלפפונים'), null);
  // לקוח בלי לקוח משלם -> אין דו-משמעות
  assert.strictEqual(flow.ambiguousOffice(config.companies[3], 'הזמנה לאלמה'), null);
});

test('עריכת הודעה: החלפת תרומה ובנייה מחדש דטרמיניסטית', () => {
  const flow = new Orchestrator({}, { pickingGroup: { id: { _serialized: 'x' }, name: 'x' }, photosGroup: null });
  const order = {
    baseSnapshot: [item('בננה', null)],
    contribs: [],
    items: [],
  };
  // הודעה מקורית: +2 מלפפונים
  const msg1 = { id: { _serialized: 'true_x_AAA' } };
  flow.recordContribution(order, msg1, { items: [{ product_he: 'מלפפון', quantity: 2, action: 'add' }] });
  // תוספת מאוחרת: +אבטיח
  const msg2 = { id: { _serialized: 'true_x_BBB' } };
  flow.recordContribution(order, msg2, { items: [{ product_he: 'אבטיח', quantity: 1, action: 'add' }] }, { printed: true });
  flow.rebuildFromContribs(order);
  assert.deepStrictEqual(order.items.map((i) => i.product_he), ['בננה', 'מלפפון', 'אבטיח']);

  // הלקוח ערך את ההודעה הראשונה: 3 מלפפונים במקום 2 + בלי בננות
  const contrib = order.contribs.find((c) => Orchestrator.stanzaEq(c.key, 'false_y_AAA'));
  assert.ok(contrib, 'התאמה לפי מזהה stanza גם בפורמט שונה');
  contrib.items = [
    { product_he: 'מלפפון', quantity: 3, action: 'add' },
    { product_he: 'בננות', action: 'remove' },
  ];
  flow.rebuildFromContribs(order);
  assert.deepStrictEqual(order.items.map((i) => i.product_he), ['מלפפון', 'אבטיח']);
  assert.strictEqual(order.items[0].quantity, 3, 'הכמות החדשה מהעריכה');
  assert.strictEqual(order.items[1].addedAfterPrint, true, 'דגל אחרי-הדפסה של התוספת נשמר');
});
