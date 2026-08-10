// CRM v2 mapping tests (node:test) — run over the redacted fixture so no
// real contact details live in the repo.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FV_DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fv-test-'));

const source = require('../src/crm/source');

function fixtureOffices() {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'crm-main.fixture.csv'), 'utf8');
  const rows = source.parseCsv(text).filter((r) => r.some((c) => String(c).trim()));
  const col = source.buildColumnResolver(rows[0]);
  return rows.slice(1).map((r) => source.mapRow(r, col)).filter(Boolean);
}

test('כל 47 הרשומות נטענות, כולל לקוחות בלי לקוח משלם', () => {
  const offices = fixtureOffices();
  assert.strictEqual(offices.length, 47);
  const standalone = offices.filter((o) => !o.payer);
  assert.strictEqual(standalone.length, 30);
  for (const o of standalone) assert.ok(o.displayName === o.office, 'שם עצמאי = משרד בלבד');
});

test('התפלגויות תואמות את ספירות הקבלה', () => {
  const offices = fixtureOffices();
  const count = (fn) => offices.filter(fn).length;
  assert.strictEqual(count((o) => o.orderType === 'fixed'), 9);
  assert.strictEqual(count((o) => o.orderType === 'variable'), 38);
  assert.strictEqual(count((o) => o.displayMode === 'floors'), 6);
  assert.strictEqual(count((o) => o.channel === 'whatsapp'), 34);
  assert.strictEqual(count((o) => o.channel === 'email'), 2);
  assert.strictEqual(count((o) => o.channel === 'sheet'), 2);
  assert.strictEqual(count((o) => o.channel === 'db'), 9);
  assert.strictEqual(count((o) => o.format === 'freetext'), 25);
  assert.strictEqual(count((o) => o.format === 'pdf'), 18);
  assert.strictEqual(count((o) => o.format === 'excel'), 2);
  assert.strictEqual(count((o) => o.format === 'gsheet'), 2);
  assert.strictEqual(count((o) => o.exampleStatus === 'has'), 17);
  assert.strictEqual(count((o) => o.exampleStatus === 'missing'), 6);
  assert.strictEqual(count((o) => o.exampleStatus === 'not_needed'), 24);
});

test('כלל השם: [לקוח משלם] [משרד], ומשרדים לא ממוזגים', () => {
  const offices = fixtureOffices();
  const ms = offices.filter((o) => o.payer === 'מייקרוסופט');
  assert.strictEqual(ms.length, 2);
  assert.ok(ms.some((o) => o.displayName === 'מייקרוסופט תל אביב'));
  assert.ok(ms.some((o) => o.displayName === 'מייקרוסופט חיפה'));
  assert.notStrictEqual(ms[0].key, ms[1].key, 'לכל משרד זהות נפרדת');
});

test('טלפון משותף בין כמה לקוחות מחזיר את כולם כמועמדים (ולא שיוך יחיד)', () => {
  const offices = fixtureOffices();
  const phoneCount = new Map();
  for (const o of offices) {
    for (const c of o.contacts) {
      if (c.phone) phoneCount.set(c.phone, (phoneCount.get(c.phone) || 0) + 1);
    }
  }
  const shared = [...phoneCount.entries()].filter(([, n]) => n > 1);
  assert.ok(shared.length >= 1, 'קיים טלפון משותף בפיקסצ׳ר');
  const [sharedPhone, n] = shared[0];
  const candidates = offices.filter((o) => o.contacts.some((c) => c.phone === sharedPhone));
  assert.strictEqual(candidates.length, n);
  assert.ok(n > 1);
});

test('נרמול טלפונים: תווי כיווניות, מקפים אקזוטיים ו-972', () => {
  assert.strictEqual(source.normalizeIlPhone('055‑6861892‬'), '0556861892');
  assert.strictEqual(source.normalizeIlPhone('050-222 8674'), '0502228674');
  assert.strictEqual(source.normalizeIlPhone('+972 52-359-6607'), '0523596607');
  assert.strictEqual(source.normalizeIlPhone('לא טלפון'), null);
  assert.strictEqual(source.normalizeEmail('  Gal@TriplEP.co.IL '), 'gal@triplep.co.il');
});

test('הערות מתפרשות כהוראות תפעוליות', () => {
  assert.strictEqual(source.parseNotes('פורמט של רסטיגו').pdfSource, 'restigo');
  assert.strictEqual(source.parseNotes('PDF מ-Zest').pdfSource, 'zest');
  assert.ok(source.parseNotes('קידוד יחידות: k=ק"ג, u=יחידה').unitCodes);
  assert.ok(source.parseNotes('הזמנה שבועית שמגיעה ביום חמישי עבור השבוע הבא').weeklyThursday);
  assert.ok(source.parseNotes('חסר לינק לגיליון').missingPrerequisite);
});

test('ולידציית עמודות: גיליון בלי עמודת חובה נכשל בבירור', () => {
  assert.throws(
    () => source.buildColumnResolver(['לקוח משלם', 'משרד', 'סוג הזמנה']),
    /עמודה נדרשת/,
  );
});
