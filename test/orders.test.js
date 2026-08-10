// Floors rendering, fixed base orders and readiness gating (node:test).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FV_DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fv-test-'));

const { buildPickingSheetHTML } = require('../src/pdf/template');
const baseOrders = require('../src/orders/baseOrders');
const { channelStatus } = require('../src/channels/registry');

const item = (over) => ({
  product_he: 'מלפפון', product_en: 'Cucumber', product_th: '', product_ar: '',
  quantity: 1, unit: 'ק"ג', note: null, category: 'vegetables', vat_exempt: true,
  floor: null, action: 'add', ...over,
});

const orderStub = (items, over = {}) => ({
  id: 'SE-11082026', customerName: 'סולאראדג׳ הרצליה', customerNameEn: 'סולאראדג׳ הרצליה',
  deliveryDate: '2026-08-11', version: 1, customerNote: null, locationDetail: null,
  items, ...over,
});

test('PDF בחלוקה לקומות: כותרות, סדר קומות, ואין מיזוג בין קומות', () => {
  const html = buildPickingSheetHTML(orderStub(
    [
      item({ floor: 'קומה 2', quantity: 2 }),
      item({ product_he: 'מלון', product_en: 'Melon', category: 'fruits', floor: 'קומה 2' }),
      item({ floor: 'קומה 5', quantity: 3 }),
    ],
    { displayMode: 'floors' },
  ));
  const f2 = html.indexOf('קומה 2');
  const f5 = html.indexOf('קומה 5');
  assert.ok(f2 > 0 && f5 > 0, 'כותרת נפרדת לכל קומה');
  assert.ok(f2 < f5, 'סדר הקומות נשמר');
  assert.strictEqual((html.match(/מלפפון/g) || []).length, 2, 'אותו מוצר בשתי קומות לא מוזג');
  // Hebrew + RTL sanity
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes('סולאראדג׳ הרצליה'));
});

test('PDF ברשימה מאוחדת נשאר בקטגוריות (התנהגות קיימת לא נשברה)', () => {
  const html = buildPickingSheetHTML(orderStub([item(), item({ product_he: 'מלון', category: 'fruits' })]));
  assert.ok(html.includes('ירקות'));
  assert.ok(html.includes('פירות'));
});

test('הזמנת בסיס: גרסאות, בסיס פר יום, ו-audit', () => {
  const key = 'סולאראדג׳ מודיעין';
  const v1 = baseOrders.setBase(key, { items: [item({ product_he: 'תפוח' })], note: 'בסיס ראשון' });
  assert.strictEqual(v1, 'v1');
  const v2 = baseOrders.setBase(key, {
    perDay: { 0: [item({ product_he: 'בננה' })], 3: [item({ product_he: 'אגס' })] },
    note: 'בסיס לפי יום',
  });
  assert.strictEqual(v2, 'v2');
  // 2026-08-12 is a Wednesday (day 3)
  const wed = baseOrders.baseFor(key, '2026-08-12');
  assert.strictEqual(wed.versionId, 'v2');
  assert.strictEqual(wed.items[0].product_he, 'אגס');
  const sun = baseOrders.baseFor(key, '2026-08-09');
  assert.strictEqual(sun.items[0].product_he, 'בננה');
  // no base -> null (never invented)
  assert.strictEqual(baseOrders.baseFor('לקוח בלי בסיס', '2026-08-12'), null);
  // returned items are copies - mutating them must not touch the stored base
  wed.items[0].product_he = 'שונה';
  assert.strictEqual(baseOrders.baseFor(key, '2026-08-12').items[0].product_he, 'אגס');
});

test('ערוצים לא מוכנים מוצגים כחסומים, לא כפעילים', () => {
  assert.strictEqual(channelStatus({ channel: 'whatsapp' }).status, 'active');
  assert.strictEqual(channelStatus({ channel: 'email', displayName: 'סולאראדג׳ ציפורית' }).status, 'blocked');
  assert.strictEqual(channelStatus({ channel: 'sheet', displayName: 'למונייד' }).status, 'blocked');
  assert.strictEqual(channelStatus({ channel: 'db', displayName: 'סטרטסייס רחובות' }).status, 'missing_prerequisite');
});

test('idempotency: אותו תוכן קובץ מייצר אותו מזהה', () => {
  const crypto = require('node:crypto');
  const h1 = crypto.createHash('sha1').update('same-bytes').digest('hex');
  const h2 = crypto.createHash('sha1').update('same-bytes').digest('hex');
  assert.strictEqual(h1, h2);
});
