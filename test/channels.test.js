// Sheet-orders CSV handling and email-contact matching.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FV_DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fv-test-'));

const { csvToText } = require('../src/orders/sheetOrders');
const { config } = require('../src/config');
const sheets = require('../src/crm/sheets');

test('csvToText: שורות ריקות ופסיקים עודפים מסולקים, התוכן נשמר', () => {
  const csv = 'למונייד - ראשון 09/08,,,,\n,,,,\nV / X,מוצר,להזמנה 0,להזמנה 1,סה״כ\n,חלב 3 אחוז,2,1,3\n';
  const text = csvToText(csv);
  const lines = text.split('\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith('למונייד'));
  assert.ok(text.includes('חלב 3 אחוז'));
});

test('contactCompaniesByEmail: כתובת משותפת מחזירה את כל הלקוחות', () => {
  config.companies.length = 0;
  config.companies.push(
    { name: 'סולאראדג׳ ציפורית', crm: { key: 'סולאראדג׳ ציפורית', contacts: [{ email: 'gal@kerem.capital' }] } },
    { name: 'סטרטסייס קריית גת', crm: { key: 'סטרטסייס קריית גת', contacts: [{ email: 'gal@kerem.capital' }] } },
    { name: 'אלמה', crm: { key: 'אלמה', contacts: [{ phone: '0501111111' }] } },
  );
  const hits = sheets.contactCompaniesByEmail('Gal@Kerem.Capital');
  assert.strictEqual(hits.length, 2, 'שני לקוחות על אותה כתובת - שניהם מועמדים');
  assert.strictEqual(sheets.contactCompaniesByEmail('unknown@x.com').length, 0);
});
