// Google Sheets CRM (simple-link mode): the sheet is shared as
// "anyone with the link can view", so we can read it as CSV without OAuth.
// Expected columns (header names are matched loosely):
//   שם הלקוח | שם באנגלית | ראשי תיבות | וואטסאפ (מספר אחד או כמה, מופרדים בפסיק)
// Every refresh rebuilds config.companies in place, so the whole engine —
// parsing, attribution, folders, order numbers — follows the sheet.
const { config, normalizePhone } = require('../config');
const log = require('../logger');
const bus = require('../bus');

let pollTimer = null;
const status = { configured: false, ok: null, lastSync: null, error: null };

function getStatus() {
  return { ...status };
}

function csvUrlFrom(sheetUrl) {
  const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const gid = (String(sheetUrl).match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

// Minimal CSV parser with quoted-field support
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function findCol(headers, ...keys) {
  return headers.findIndex((h) => keys.some((k) => h.replace(/["\s]/g, '').includes(k)));
}

function initialsFor(nameEn, taken) {
  const words = String(nameEn).trim().split(/[\s-]+/).filter(Boolean);
  let base = words.length >= 2
    ? words.map((w) => w[0]).join('')
    : String(nameEn).slice(0, 2);
  base = base.toUpperCase().replace(/[^A-Z]/g, '') || 'XX';
  let candidate = base, n = 2;
  while (taken.has(candidate)) candidate = base + n++;
  taken.add(candidate);
  return candidate;
}

async function fetchCompanies(sheetUrl) {
  const url = csvUrlFrom(sheetUrl);
  if (!url) throw new Error('כתובת גיליון לא תקינה');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`הגיליון לא נגיש (HTTP ${res.status}) - ודאו שהוא משותף לכל מי שיש לו את הקישור`);
  const rows = parseCsv(await res.text());
  if (rows.length < 2) throw new Error('הגיליון ריק או חסרה שורת כותרות');

  const headers = rows[0].map((h) => h.trim());
  const nameCol = findCol(headers, 'שםהלקוח', 'לקוח', 'חברה', 'name');
  const enCol = findCol(headers, 'אנגלית', 'english');
  const initialsCol = findCol(headers, 'ראשי', 'initials');
  const phoneCol = findCol(headers, 'וואטסאפ', 'ווצאפ', 'טלפון', 'phone', 'whatsapp');
  if (nameCol < 0) throw new Error('לא נמצאה עמודת "שם הלקוח" בגיליון');

  const taken = new Set();
  const companies = [];
  for (const row of rows.slice(1)) {
    const name = (row[nameCol] || '').trim();
    if (!name) continue;
    const nameEn = ((enCol >= 0 && row[enCol]) || name).trim();
    const explicitInitials = (initialsCol >= 0 && (row[initialsCol] || '').trim().toUpperCase()) || null;
    const initials = explicitInitials && !taken.has(explicitInitials)
      ? (taken.add(explicitInitials), explicitInitials)
      : initialsFor(nameEn, taken);
    const contacts = phoneCol >= 0
      ? (row[phoneCol] || '').split(/[,;/]+/).map((p) => normalizePhone(p)).filter((p) => p.length >= 11)
      : [];
    companies.push({ name, nameEn, initials, aliases: [], contacts });
  }
  if (!companies.length) throw new Error('לא נמצאו לקוחות בגיליון');
  return companies;
}

// Replace config.companies IN PLACE so every module that holds a reference
// sees the update immediately.
function applyCompanies(companies) {
  config.companies.length = 0;
  config.companies.push(...companies);
  bus.emit('crm', { companies: companies.map((c) => c.name) });
  log.info(`CRM עודכן מהגיליון: ${companies.map((c) => c.name).join(', ')}`);
}

// phone -> list of companies that own this contact
function contactCompanies(phoneId) {
  const phone = String(phoneId).replace('@c.us', '');
  return config.companies.filter((c) => (c.contacts || []).includes(phone));
}

async function refresh(sheetUrl) {
  status.configured = true;
  try {
    const companies = await fetchCompanies(sheetUrl);
    applyCompanies(companies);
    status.ok = true;
    status.lastSync = Date.now();
    status.error = null;
    return companies;
  } catch (err) {
    status.ok = false;
    status.error = err.message;
    throw err;
  }
}

function startPolling(sheetUrl, intervalMs = 5 * 60 * 1000) {
  stopPolling();
  const tick = async () => {
    try {
      await refresh(sheetUrl);
    } catch (err) {
      log.warn(`רענון CRM נכשל: ${err.message}`);
    }
  };
  tick();
  pollTimer = setInterval(tick, intervalMs);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = { refresh, startPolling, stopPolling, contactCompanies, csvUrlFrom, getStatus };
