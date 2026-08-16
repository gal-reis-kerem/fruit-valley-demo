// Format parsers. Channel and format are independent dimensions: a PDF may
// arrive over WhatsApp, an Excel over email, a shared Google Sheet is read
// from its link. Each parser turns its input into TEXT (or structured items)
// which the canonical parser (Claude) normalizes - one brain, many formats.
//
// PDFs are handled GENERICALLY by Claude's native PDF understanding
// (src/ai/docParser.js): the same path reads Restigo exports, Zest exports,
// delivery notes, floor-matrix tables and scanned pages - no per-customer
// strategy code, exactly like a human reading the page.
const log = require('../logger');

// PDF -> plain text (cheap textual extraction). Kept for tests/diagnostics;
// the live flow prefers docParser which also reads scans and matrices.
async function pdfToText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const res = await parser.getText();
    return (res.text || '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
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
const excelBufferToText = excelToText;

// Shared Google Sheet (by link) -> CSV text. Only called when the office has
// a configured link; readiness gating prevents calls without one.
async function sharedSheetToText(sheetUrl) {
  const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('לינק גיליון לא תקין');
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`הגיליון המשותף לא נגיש (HTTP ${res.status})`);
  return res.text();
}

// media (from WhatsApp) -> one of:
//   { doc, provenance }   structured docParser output (PDFs)
//   { text, provenance }  raw text for the free-text parser (Excel)
//   { manualReview: reason } / null (not a parseable document)
// caption: the free-text message sent WITH the file - its changes/requests
// are applied on top of the document's list.
async function mediaToText(media, office, caption = '') {
  const mimetype = media.mimetype || '';
  const buffer = Buffer.from(media.data, 'base64');
  try {
    if (mimetype.includes('pdf')) {
      const { parseOrderDocument } = require('../ai/docParser');
      const hintParts = [];
      if (office) hintParts.push(`הקובץ הגיע בוואטסאפ מהלקוח ${office.displayName}`);
      const flags = office && office.notesFlags;
      if (flags && flags.pdfSource) hintParts.push(`פורמט צפוי: ייצוא ${flags.pdfSource}`);
      const doc = await parseOrderDocument(buffer, { hint: hintParts.join('. '), accompanyingText: caption });
      if (!doc.orders.length || !doc.orders.some((o) => o.items.length)) {
        return { manualReview: 'לא זוהו פריטי הזמנה ב-PDF - נדרשת בדיקה ידנית' };
      }
      return { doc, provenance: 'pdf/claude' };
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

module.exports = { mediaToText, pdfToText, excelToText, excelBufferToText, sharedSheetToText };
