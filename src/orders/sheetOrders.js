// Shared-Google-Sheet order channel. Each customer on the "גוגל שיטס משותף"
// channel has a spreadsheet inside the sheets Drive folder
// (<root>/<customer>/<one spreadsheet>). The sheet is updated by the customer
// before every order; we poll it, and on any content change the current table
// becomes the order (a new order, or an update to the open one).
//
// A WhatsApp free-text heads-up from that customer ("עדכנתי את הטבלה") also
// triggers an immediate re-read (see orchestrator.handleCustomerMessage).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const log = require('../logger');
const drive = require('../crm/drive');
const sheets = require('../crm/sheets');
const bus = require('../bus');

const STATE_FILE = () => path.join(config.dataDir, 'sheet-orders-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return { customers: {} }; }
}
function saveState(s) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
}

// Map sheet-channel offices to their spreadsheet ids by walking the folder.
// Returns [{ office, sheetId, sheetTitle }] and records gaps.
async function discover() {
  const offices = sheets.allOffices().filter((o) => o.channel === 'sheet');
  if (!offices.length) return { mapped: [], gaps: [] };
  const loose = (s) => String(s || '').replace(/[׳'"״`\s\-_.()]/g, '').replace(/[וי]/g, '');
  const root = await drive.listFolder(config.sheetsOrdersFolderId);
  const mapped = [];
  const gaps = [];
  for (const office of offices) {
    // subfolder whose name matches payer/office/display
    const folder = root.find((e) => e.kind === 'folder' && [office.payer, office.office, office.displayName]
      .filter(Boolean).some((n) => loose(n).includes(loose(e.title)) || loose(e.title).includes(loose(n))));
    if (!folder) { gaps.push(`לא נמצאה תיקיית שיטס עבור ${office.displayName}`); continue; }
    const inner = await drive.listFolder(folder.id);
    // prefer a sheet whose title mentions the office (disambiguates payers
    // with several offices), else the only sheet in the folder
    const sheetsIn = inner.filter((e) => e.kind === 'sheet');
    const match = sheetsIn.find((e) => loose(e.title).includes(loose(office.office))) ||
      (sheetsIn.length === 1 ? sheetsIn[0] : null);
    if (!match) { gaps.push(`בתיקיית "${folder.title}" לא זוהה גיליון עבור ${office.displayName}`); continue; }
    mapped.push({ office, sheetId: match.id, sheetTitle: match.title });
  }
  return { mapped, gaps };
}

// CSV -> compact readable table text for the parser.
function csvToText(csv) {
  return csv
    .split(/\r?\n/)
    .map((line) => line.replace(/^,+|,+$/g, ''))
    .filter((line) => line.replace(/,/g, '').trim())
    .join('\n');
}

// Israel-time helpers for windowed offices
function israelNowParts() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return { minutes: now.getHours() * 60 + now.getMinutes(), day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) };
}

function windowFor(office) {
  const loose = (s) => String(s || '').replace(/[׳'"״`\s\-_.()]/g, '').replace(/[וי]/g, '');
  return (config.sheetWindows || []).find((w) =>
    [office.displayName, office.office, office.payer].filter(Boolean)
      .some((n) => loose(n).includes(loose(w.office)) || loose(w.office).includes(loose(n)))) || null;
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Poll every mapped sheet once; changed content is handed to the orchestrator.
 * force: officeKey to re-read even without change (WhatsApp heads-up).
 *
 * Windowed offices (config.sheetWindows, e.g. למונייד 14:00-18:00 every 30m):
 * the sheet is ignored before the window; at the window's start today's
 * content becomes THE order (rewritten daily); until the window's end changes
 * are tracked at the configured interval; after it - quiet until tomorrow.
 */
async function pollOnce(getFlow, { forceOffice = null } = {}) {
  const { mapped, gaps } = await discover();
  for (const gap of gaps) log.warn(`ערוץ שיטס: ${gap}`);
  const state = loadState();
  const report = { checked: mapped.length, updated: 0, gaps };
  const { minutes: nowMin, day: today } = israelNowParts();

  for (const { office, sheetId, sheetTitle } of mapped) {
    const win = windowFor(office);
    const prev = state.customers[office.key];
    let firstTakeOfDay = false;

    if (win) {
      if (nowMin < toMin(win.start) || nowMin > toMin(win.end)) {
        if (forceOffice === office.key) {
          log.info(`ערוץ שיטס: הגיליון של ${office.displayName} פעיל רק בין ${win.start}-${win.end} - ההודעה נרשמה, ייבדק בפתיחת החלון`);
        }
        continue; // outside the window: no reads, no baselines
      }
      firstTakeOfDay = !prev || prev.lastOrderDay !== today;
      const throttleMs = (win.everyMin || 30) * 60 * 1000;
      if (!firstTakeOfDay && forceOffice !== office.key &&
          prev.lastPollAt && Date.now() - prev.lastPollAt < throttleMs) {
        continue; // within the window but before the next half-hour tick
      }
    }

    let csv;
    try {
      csv = await drive.sheetCsv(sheetId);
    } catch (err) {
      log.warn(`קריאת הגיליון של ${office.displayName} נכשלה: ${err.message}`);
      continue;
    }
    const hash = crypto.createHash('sha1').update(csv).digest('hex');
    const changed = !prev || prev.hash !== hash;
    // windowed first take of the day fires even without a change - the sheet
    // is rewritten daily and today's content IS today's order
    const shouldFire = firstTakeOfDay || changed || forceOffice === office.key;
    const entry = { hash, sheetId, sheetTitle, at: new Date().toISOString(), lastPollAt: Date.now(), lastOrderDay: prev && prev.lastOrderDay };
    if (!shouldFire) {
      state.customers[office.key] = entry;
      saveState(state);
      continue;
    }

    if (!win && !prev && !forceOffice) {
      // non-windowed sheet, first sight: baseline only, no order from stale content
      state.customers[office.key] = entry;
      saveState(state);
      log.info(`ערוץ שיטס: נקלט בסיס ראשוני של ${office.displayName} (ללא הנפקה)`);
      continue;
    }
    if (!changed && !firstTakeOfDay && forceOffice === office.key) {
      state.customers[office.key] = entry;
      saveState(state);
      log.info(`ערוץ שיטס: ${office.displayName} - אין שינוי בתוכן הגיליון`);
      continue;
    }

    const flow = getFlow();
    if (!flow) {
      // keep the previous state so the change fires when WhatsApp returns
      log.warn(`עדכון בגיליון של ${office.displayName} ממתין - וואטסאפ לא מחובר`);
      continue;
    }
    const company = sheets.companyByOfficeKey(office.key);
    if (!company) continue;
    entry.lastOrderDay = today;
    state.customers[office.key] = entry;
    saveState(state);
    bus.naama(firstTakeOfDay
      ? `הגיליון היומי של ${office.displayName} נקלט כהזמנת היום`
      : `זוהה עדכון בגיליון ההזמנות של ${office.displayName}`);
    try {
      await flow.handleSheetOrder(company, csvToText(csv), { sheetTitle });
      report.updated += 1;
    } catch (err) {
      log.error(`טיפול בעדכון הגיליון של ${office.displayName} נכשל: ${err.message}`);
    }
  }
  return report;
}

module.exports = { discover, pollOnce, csvToText };
