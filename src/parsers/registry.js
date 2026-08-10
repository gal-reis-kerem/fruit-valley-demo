// Format parsers. Channel and format are independent dimensions: a PDF may
// arrive over WhatsApp, an Excel over email, a shared Google Sheet is read
// from its link. Each parser turns its input into TEXT which the canonical
// free-text parser (Claude) normalizes - one brain, many formats.
//
// PDF strategies: recognized layouts (Restigo, Zest) get dedicated
// strategies once their example files are analyzed; until then a generic
// text-extraction strategy applies and low-confidence results are flagged.
const log = require('../logger');

const pdfStrategies = {
  // Placeholders on purpose: never pretend a layout-specific parser exists
  // before its example was analyzed. `generic` extracts raw text.
  restigo: { status: 'missing_prerequisite', reason: 'ממתין לניתוח קובצי הדוגמה של רסטיגו' },
  zest: { status: 'missing_prerequisite', reason: 'ממתין לניתוח קובצי הדוגמה של Zest' },
};

// PDF -> plain text (generic strategy). Works for text-based PDFs; scanned
// images yield empty text and are routed to manual review by the caller.
async function pdfToText(buffer) {
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(buffer);
  return (parsed.text || '').trim();
}

// Excel -> tab-separated text lines (all sheets), preserving cell text.
function excelToText(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const lines = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    for (const row of rows) {
      const line = row.map((c) => String(c).trim()).join('\t').trim();
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

// Shared Google Sheet (by link) -> CSV text. Only called when the office has
// a configured link; readiness gating prevents calls without one.
async function sharedSheetToText(sheetUrl) {
  const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('לינק גיליון לא תקין');
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`הגיליון המשותף לא נגיש (HTTP ${res.status})`);
  return res.text();
}

// media (from WhatsApp) -> { text, provenance } or { manualReview: reason }
async function mediaToText(media, office) {
  const mimetype = media.mimetype || '';
  const buffer = Buffer.from(media.data, 'base64');
  try {
    if (mimetype.includes('pdf')) {
      const strategyName = office && office.notesFlags && office.notesFlags.pdfSource;
      const strategy = strategyName && pdfStrategies[strategyName];
      const provenance = strategy && strategy.status !== 'ready'
        ? `pdf/generic (אסטרטגיית ${strategyName}: ${strategy.reason})`
        : 'pdf/generic';
      const text = await pdfToText(buffer);
      if (!text || text.length < 10) {
        return { manualReview: 'לא חולץ טקסט מה-PDF (ייתכן קובץ סרוק) - נדרשת בדיקה ידנית' };
      }
      return { text, provenance };
    }
    if (mimetype.includes('sheet') || mimetype.includes('excel') || /\.(xlsx?|csv)$/i.test(media.filename || '')) {
      const text = excelToText(buffer);
      if (!text) return { manualReview: 'קובץ האקסל ריק או במבנה בלתי צפוי - נדרשת בדיקה ידנית' };
      return { text, provenance: 'excel/generic' };
    }
  } catch (err) {
    log.warn(`פענוח קובץ נכשל: ${err.message}`);
    return { manualReview: `הקובץ לא נקרא (${err.message}) - נשמר לבדיקה ידנית` };
  }
  return null; // not a parseable document (e.g. an image)
}

module.exports = { mediaToText, pdfToText, excelToText, sharedSheetToText, pdfStrategies };
