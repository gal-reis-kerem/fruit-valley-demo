// Fixed-orders Drive sync: filename schedules and customer matching.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FV_DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fv-test-'));

const { parseScheduleFromName, matchOffices, combinedNames, looseName, WORK_DAYS } = require('../src/orders/fixedSync');

test('לוז משם קובץ: יום בודד, טווח, תוספת, בלי יום', () => {
  assert.deepStrictEqual(parseScheduleFromName('אלמה - שלישי.pdf').days, [2]);
  assert.deepStrictEqual(parseScheduleFromName('אדוארד ימי חמישי.pdf').days, [4]);
  assert.strictEqual(parseScheduleFromName('אדוארד תוספת חמישי.pdf').isAddition, true);
  assert.deepStrictEqual(parseScheduleFromName('אינמוד - רביעי - תוספת.pdf').days, [3]);
  assert.strictEqual(parseScheduleFromName('אינמוד - רביעי - תוספת.pdf').isAddition, true);
  assert.deepStrictEqual(parseScheduleFromName('רחובות מעודן שני-חמישי (1).pdf').days, [1, 2, 3, 4]);
  // רשימת ימים כולל ו' החיבור ("ראשון שלישי וחמישי")
  assert.deepStrictEqual(parseScheduleFromName('בוסטון - ראשון שלישי וחמישי.pdf').days, [0, 2, 4]);
  assert.deepStrictEqual(parseScheduleFromName('בוסטון - שני ורביעי.pdf').days, [1, 3]);
  // no day token -> empty (caller applies WORK_DAYS)
  assert.deepStrictEqual(parseScheduleFromName('גליל מדיקל.pdf').days, []);
  assert.deepStrictEqual(parseScheduleFromName('מודיעין מעודכן קיץ 26 (1).pdf').days, []);
  assert.deepStrictEqual(WORK_DAYS, [0, 1, 2, 3, 4]);
});

test('קובץ משולב "ברוקר + אינמוד" מזין את שני הלקוחות', () => {
  assert.deepStrictEqual(combinedNames('ברוקר + אינמוד - שני.pdf'), ['ברוקר', 'אינמוד']);
  assert.strictEqual(combinedNames('אלמה - שני.pdf'), null);
});

test('התאמת שמות רופפת: וריאציות כתיב מהדרייב מול ה-CRM', () => {
  const offices = [
    { key: 'אינמוד', payer: null, office: 'אינמוד', displayName: 'אינמוד' },
    { key: 'סטרטסייס רחובות', payer: 'סטרטסייס', office: 'רחובות', displayName: 'סטרטסייס רחובות' },
    { key: 'סטרטסייס קריית גת', payer: 'סטרטסייס', office: 'קריית גת', displayName: 'סטרטסייס קריית גת' },
    { key: 'סולאראדג׳ מודיעין', payer: 'סולאראדג׳', office: 'מודיעין', displayName: 'סולאראדג׳ מודיעין' },
    { key: 'בוסטון לומינס', payer: null, office: 'בוסטון לומינס', displayName: 'בוסטון לומינס' },
  ];
  // אינומד (דרייב) -> אינמוד (CRM)
  assert.deepStrictEqual(matchOffices('אינומד', offices).map((o) => o.key), ['אינמוד']);
  // סטרטסיס (דרייב) -> שני המשרדים של סטרטסייס (payer), הצרה דרך תת-תיקייה
  const strat = matchOffices('סטרטסיס', offices);
  assert.strictEqual(strat.length, 2);
  assert.deepStrictEqual(matchOffices('רחובות', offices, { payerScope: strat }).map((o) => o.key), ['סטרטסייס רחובות']);
  // סולראדג׳ (דרייב, בלי א) -> ה-payer סולאראדג׳
  assert.ok(matchOffices('סולראדג׳', offices).some((o) => o.key === 'סולאראדג׳ מודיעין'));
  // בוסטון לומינס נשאר התאמה מדויקת ולא נתפס בטעות ע"י אחרים
  assert.deepStrictEqual(matchOffices('בוסטון לומינס', offices).map((o) => o.key), ['בוסטון לומינס']);
});
