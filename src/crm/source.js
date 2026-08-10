// CRM v2 source: the Fruit Valley customers spreadsheet (payer + office model).
//
// Reading strategy (read-only in both modes; the sheet is never written):
//   1. GOOGLE_API_KEY set   -> Google Sheets API v4, FORMATTED_VALUE (keeps
//      leading zeros in phone numbers), sheet discovery by title.
//   2. no key (fallback)    -> public gviz CSV addressed BY SHEET NAME (not
//      gid), which also returns displayed values. Requires link-sharing.
//
// Resilience: every successful sync is snapshotted to data/crm-snapshot.json.
// On any failure the last good snapshot keeps serving - configuration is
// never replaced by partial or empty data.
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('../logger');

const MAIN_SHEET = process.env.CRM_MAIN_SHEET || 'פירות העמק לקוחות';
const INTERNAL_SHEET = process.env.CRM_INTERNAL_SHEET || 'פירות העמק פנימי';
const SNAPSHOT_PATH = path.join(config.dataDir, 'crm-snapshot.json');

// Initial-migration validation counts (warn-only, never a hard rule)
const EXPECTED = {
  records: 47,
  orderType: { fixed: 9, variable: 38 },
  displayMode: { floors: 6, unified: 41 },
  channel: { whatsapp: 34, sheet: 2, email: 2, db: 9 },
  format: { freetext: 25, pdf: 18, excel: 2, gsheet: 2 },
  example: { has: 17, missing: 6, not_needed: 24 },
};

// ---------------------------------------------------------------- normalize
const BIDI_RE = /[‎‏‪-‮⁦-⁩­﻿]/g;
const clean = (s) => String(s ?? '').replace(BIDI_RE, '').trim();

// Israeli phone -> "0XXXXXXXXX"; keeps nothing else. Never coerced to number.
function normalizeIlPhone(raw) {
  const s = clean(raw).replace(/[‐-―−]/g, '-'); // exotic dashes
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  if (!digits.startsWith('0') && digits.length === 9) digits = '0' + digits;
  return digits.length >= 9 && digits.length <= 10 ? digits : null;
}

const normalizeEmail = (raw) => {
  const s = clean(raw).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
};

const redactPhone = (p) => (p ? `${p.slice(0, 3)}•••${p.slice(-3)}` : '');

// ---------------------------------------------------------------- notes
// Row notes are operational instructions, not display text.
function parseNotes(notes) {
  const t = clean(notes);
  const flags = {
    pdfSource: /רסטיגו|restigo/i.test(t) ? 'restigo' : /zest|זסט/i.test(t) ? 'zest' : null,
    unitCodes: /k\s*=|u\s*=|קידוד/i.test(t) || /\bk\b.*ק["״]ג|u.*יחיד/i.test(t),
    weeklyThursday: /חמישי/.test(t) && /שבוע/.test(t),
    whatsappUpdates: /שינויים|תוספות|עדכונים/.test(t) && /ווטסאפ|וואטסאפ|whatsapp/i.test(t),
    missingPrerequisite: /חסר|אין לינק|אין הרשאה|צריך הרשאה|ממתין/.test(t),
    raw: t,
  };
  return flags;
}

// ---------------------------------------------------------------- mapping
const ORDER_TYPE = { 'קבועה': 'fixed', 'משתנה': 'variable' };
const DISPLAY = { 'רשימת מוצרים': 'unified', 'חלוקה לקומות': 'floors' };
const CHANNEL = {
  'ווטסאפ': 'whatsapp', 'וואטסאפ': 'whatsapp',
  'גוגל שיטס משותף': 'sheet', 'מייל': 'email', 'רשימה קבועה במאגר': 'db',
};
const FORMAT = {
  'טקסט חופשי': 'freetext', 'PDF': 'pdf', 'pdf': 'pdf',
  'טבלת אקסל': 'excel', 'טבלת שיטס': 'gsheet',
};
const EXAMPLE = { V: 'has', X: 'missing', N: 'not_needed' };

const REQUIRED_COLUMNS = ['לקוח משלם', 'משרד', 'סוג הזמנה', 'תצוגה', 'איפה מתקבלת ההזמנה', 'פורמט'];

function officeKey(payer, office) {
  return clean(`${payer} ${office}`).replace(/\s+/g, ' ');
}

function mapRow(row, col) {
  const payer = clean(row[col('לקוח משלם')]);
  const office = clean(row[col('משרד')]);
  if (!payer && !office) return null; // empty row

  // Order/display name rule: "[payer] [office]" or office alone
  const displayName = payer ? `${payer} ${office}`.trim() : office;

  const contacts = [];
  for (const n of [1, 2, 3]) {
    const name = clean(row[col(`איש קשר ${n}`)]);
    const value = clean(row[col(`טלפון/מייל`, n)]);
    if (!name && !value) continue;
    const phone = normalizeIlPhone(value);
    const email = phone ? null : normalizeEmail(value);
    contacts.push({ name: name || null, phone, email });
  }

  const notesFlags = parseNotes(row[col('הערות')]);
  const channel = CHANNEL[clean(row[col('איפה מתקבלת ההזמנה')])] || 'unknown';
  const format = FORMAT[clean(row[col('פורמט')])] || 'unknown';
  const exampleStatus = EXAMPLE[clean(row[col('מכיל דוגמא?')]).toUpperCase()] || 'unknown';
  const examplesLink = clean(row[col('לינק לתיקיית דוגמאות')]) || null;

  // readiness: never present an integration as active when a prerequisite is
  // missing. WhatsApp free-text is the only fully-live path today.
  const reasons = [];
  if (channel === 'email') reasons.push('נדרשת הרשאת גישה למייל');
  if (channel === 'sheet') reasons.push('נדרש לינק לגיליון המשותף');
  if (channel === 'db') reasons.push('נדרשת טעינת הזמנת בסיס למאגר');
  if (format === 'pdf' && exampleStatus !== 'has') reasons.push('פרסור PDF ממתין לדוגמה');
  if (exampleStatus === 'missing') reasons.push('דוגמה חסרה בתיקיית הדוגמאות');
  if (notesFlags.missingPrerequisite) reasons.push(`הערת CRM: ${notesFlags.raw.slice(0, 60)}`);
  const status =
    channel === 'whatsapp' && (format === 'freetext' || format === 'pdf')
      ? (reasons.length ? 'partial' : 'active')
      : reasons.length
        ? 'missing_prerequisite'
        : 'active';

  return {
    key: officeKey(payer, office),
    payer: payer || null,
    office,
    displayName,
    orderType: ORDER_TYPE[clean(row[col('סוג הזמנה')])] || 'variable',
    displayMode: DISPLAY[clean(row[col('תצוגה')])] || 'unified',
    channel,
    format,
    notes: notesFlags.raw,
    notesFlags,
    examplesLink,
    exampleStatus,
    contacts,
    readiness: { status, reasons },
  };
}

// ---------------------------------------------------------------- fetching
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

async function fetchSheetRows(sheetName) {
  const sid = config.crmSpreadsheetId;
  if (process.env.GOOGLE_API_KEY) {
    // Google Sheets API v4, displayed values (read-only scope by nature)
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/` +
      `${encodeURIComponent(`'${sheetName}'!A:O`)}?valueRenderOption=FORMATTED_VALUE&key=${process.env.GOOGLE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sheets API: HTTP ${res.status} עבור "${sheetName}"`);
    return (await res.json()).values || [];
  }
  // fallback: public gviz CSV by SHEET NAME (not gid - order-proof)
  const url =
    `https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`הגיליון "${sheetName}" לא נגיש (HTTP ${res.status})`);
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error(`הגיליון "${sheetName}" מוגן - נדרש שיתוף בקישור או GOOGLE_API_KEY`);
  return parseCsv(text);
}

// ---------------------------------------------------------------- sync
const syncState = {
  lastSync: null,
  ok: null,
  error: null,
  counts: null,
  validation: [],
};

function validateCounts(offices) {
  const issues = [];
  const count = (fn) => offices.filter(fn).length;
  const actual = {
    records: offices.length,
    fixed: count((o) => o.orderType === 'fixed'),
    variable: count((o) => o.orderType === 'variable'),
    floors: count((o) => o.displayMode === 'floors'),
    unified: count((o) => o.displayMode === 'unified'),
    whatsapp: count((o) => o.channel === 'whatsapp'),
    sheet: count((o) => o.channel === 'sheet'),
    email: count((o) => o.channel === 'email'),
    db: count((o) => o.channel === 'db'),
    freetext: count((o) => o.format === 'freetext'),
    pdf: count((o) => o.format === 'pdf'),
    excel: count((o) => o.format === 'excel'),
    gsheet: count((o) => o.format === 'gsheet'),
    exampleHas: count((o) => o.exampleStatus === 'has'),
    exampleMissing: count((o) => o.exampleStatus === 'missing'),
    exampleNotNeeded: count((o) => o.exampleStatus === 'not_needed'),
  };
  const expect = (label, got, want) => {
    if (got !== want) issues.push(`${label}: ${got} (צפוי ${want})`);
  };
  expect('רשומות', actual.records, EXPECTED.records);
  expect('קבועות', actual.fixed, EXPECTED.orderType.fixed);
  expect('משתנות', actual.variable, EXPECTED.orderType.variable);
  expect('חלוקה לקומות', actual.floors, EXPECTED.displayMode.floors);
  expect('רשימה מאוחדת', actual.unified, EXPECTED.displayMode.unified);
  expect('וואטסאפ', actual.whatsapp, EXPECTED.channel.whatsapp);
  expect('שיטס משותף', actual.sheet, EXPECTED.channel.sheet);
  expect('מייל', actual.email, EXPECTED.channel.email);
  expect('רשימה קבועה', actual.db, EXPECTED.channel.db);
  expect('טקסט חופשי', actual.freetext, EXPECTED.format.freetext);
  expect('PDF', actual.pdf, EXPECTED.format.pdf);
  expect('אקסל', actual.excel, EXPECTED.format.excel);
  expect('טבלת שיטס', actual.gsheet, EXPECTED.format.gsheet);
  expect('עם דוגמה', actual.exampleHas, EXPECTED.example.has);
  expect('דוגמה חסרה', actual.exampleMissing, EXPECTED.example.missing);
  expect('ללא צורך בדוגמה', actual.exampleNotNeeded, EXPECTED.example.not_needed);
  return { actual, issues };
}

function buildColumnResolver(headerRow) {
  const headers = headerRow.map((h) => clean(h));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.includes(required)) {
      throw new Error(`עמודה נדרשת "${required}" לא נמצאה בגיליון הלקוחות`);
    }
  }
  // 'טלפון/מייל' appears 3 times - nth occurrence resolves per contact slot
  return (name, occurrence = 1) => {
    let seen = 0;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] === name) {
        seen += 1;
        if (seen === occurrence) return i;
      }
    }
    return -1;
  };
}

async function fetchOffices() {
  const rows = await fetchSheetRows(MAIN_SHEET);
  if (rows.length < 2) throw new Error('גיליון הלקוחות ריק');
  const col = buildColumnResolver(rows[0]);
  const offices = [];
  const seenKeys = new Set();
  for (const row of rows.slice(1)) {
    if (!row || !row.some((c) => clean(c))) continue; // skip empty rows
    const office = mapRow(row, col);
    if (!office) continue;
    // payer+office is the identity; never merge distinct offices
    if (seenKeys.has(office.key)) {
      log.warn(`רשומת CRM כפולה: "${office.displayName}" - נשמרת הראשונה`);
      continue;
    }
    seenKeys.add(office.key);
    offices.push(office);
  }
  if (!offices.length) throw new Error('לא נמצאו רשומות בגיליון הלקוחות');
  return offices;
}

async function fetchInternalContacts() {
  try {
    const rows = await fetchSheetRows(INTERNAL_SHEET);
    const contacts = [];
    for (const row of rows) {
      const name = clean(row[0]);
      const phone = normalizeIlPhone(row[1]);
      const email = phone ? null : normalizeEmail(row[1]);
      // keep any row with a valid phone/email; skip only pure header rows
      if (phone || email) {
        contacts.push({ name: name || null, phone, email });
      }
    }
    return contacts;
  } catch (err) {
    log.warn(`גיליון "${INTERNAL_SHEET}" לא נטען: ${err.message}`);
    return [];
  }
}

async function sync() {
  try {
    const [offices, internalContacts] = await Promise.all([fetchOffices(), fetchInternalContacts()]);
    const { actual, issues } = validateCounts(offices);
    const snapshot = {
      syncedAt: new Date().toISOString(),
      spreadsheetId: config.crmSpreadsheetId,
      offices,
      internalContacts,
      counts: actual,
      validationIssues: issues,
    };
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

    syncState.lastSync = snapshot.syncedAt;
    syncState.ok = true;
    syncState.error = null;
    syncState.counts = actual;
    syncState.validation = issues;
    log.info(`CRM v2 סונכרן: ${offices.length} משרדים (${issues.length ? `אזהרות ולידציה: ${issues.length}` : 'ולידציה תקינה'})`);
    for (const issue of issues) log.warn(`ולידציית CRM: ${issue}`);
    return snapshot;
  } catch (err) {
    syncState.ok = false;
    syncState.error = err.message;
    log.warn(`סנכרון CRM נכשל (${err.message}) - ממשיכים עם הגרסה התקינה האחרונה`);
    const last = loadSnapshot();
    if (last) return last;
    throw err;
  }
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

// Readiness / gaps report - never invent URLs, permissions or structures.
function readinessReport(snapshot) {
  const offices = (snapshot || loadSnapshot() || { offices: [] }).offices;
  return {
    generatedAt: new Date().toISOString(),
    lastSync: syncState.lastSync,
    counts: syncState.counts,
    validationIssues: syncState.validation,
    offices: offices.map((o) => ({
      displayName: o.displayName,
      channel: o.channel,
      format: o.format,
      orderType: o.orderType,
      displayMode: o.displayMode,
      status: o.readiness.status,
      reasons: o.readiness.reasons,
    })),
    gaps: offices
      .filter((o) => o.readiness.status !== 'active')
      .map((o) => `${o.displayName}: ${o.readiness.reasons.join(' | ') || o.readiness.status}`),
  };
}

module.exports = {
  sync,
  parseCsv,
  loadSnapshot,
  readinessReport,
  getSyncState: () => ({ ...syncState }),
  normalizeIlPhone,
  normalizeEmail,
  parseNotes,
  mapRow,
  buildColumnResolver,
  redactPhone,
  officeKey,
  MAIN_SHEET,
  INTERNAL_SHEET,
  EXPECTED,
};
