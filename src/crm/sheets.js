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

// Well-known brands keep their canonical Latin names/initials even when the
// sheet doesn't provide them.
const KNOWN_BRANDS = {
  'כרם קפיטל': { nameEn: 'Kerem Capital', initials: 'KC' },
  'טריפל': { nameEn: 'Triple', initials: 'TR' },
  "סולראדג'": { nameEn: 'Solar-edge', initials: 'SE' },
};

// normalize Hebrew geresh/gershayim to plain quotes for matching
const normName = (s) => String(s || '').replace(/[׳’]/g, "'").replace(/[״]/g, '"').trim();

// Latin initials for Hebrew company names (fallback when no initials column)
const HEB2LAT = { א: 'A', ב: 'B', ג: 'G', ד: 'D', ה: 'H', ו: 'V', ז: 'Z', ח: 'H', ט: 'T', י: 'Y', כ: 'K', ך: 'K', ל: 'L', מ: 'M', ם: 'M', נ: 'N', ן: 'N', ס: 'S', ע: 'A', פ: 'P', ף: 'P', צ: 'Z', ץ: 'Z', ק: 'K', ר: 'R', ש: 'S', ת: 'T' };

function hebInitials(name, taken) {
  const words = normName(name).split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0][0], words[1][0]] : [...(words[0] || 'XX')].slice(0, 2);
  let base = letters.map((ch) => HEB2LAT[ch] || (/[a-zA-Z]/.test(ch) ? ch.toUpperCase() : 'X')).join('');
  if (base.length < 2) base = (base + 'X').slice(0, 2);
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

  // The header row is not necessarily the first row (title rows above are
  // fine) — scan the first rows for one that contains recognizable headers.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const headers = rows[i].map((h) => h.trim());
    if (
      findCol(headers, 'שםלקוח', 'שםהלקוח', 'לקוח', 'אישקשר', 'שם', 'name') >= 0 &&
      findCol(headers, 'משרד', 'חברה', 'חברות', 'טלפון', 'וואטסאפ', 'phone') >= 0
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error('לא נמצאה שורת כותרות. נדרשות עמודות: שם (איש קשר או לקוח), משרד/חברה, טלפון');
  }
  const headers = rows[headerIdx].map((h) => h.trim());
  const dataRows = rows.slice(headerIdx + 1);

  const nameCol = findCol(headers, 'שםלקוח', 'שםהלקוח', 'לקוח', 'אישקשר', 'שם', 'name');
  const officeCol = findCol(headers, 'משרד', 'חברה', 'חברות', 'company');
  const phoneCol = findCol(headers, 'וואטסאפ', 'ווצאפ', 'טלפון', 'נייד', 'phone', 'whatsapp');
  const enCol = findCol(headers, 'אנגלית', 'english');
  const initialsCol = findCol(headers, 'ראשי', 'initials');

  const taken = new Set();
  const byName = new Map(); // normalized company name -> company object

  const getCompany = (rawName, rowEn, rowInitials) => {
    const name = normName(rawName);
    if (!name) return null;
    if (byName.has(name)) return byName.get(name);
    const known = KNOWN_BRANDS[name];
    const nameEn = (known && known.nameEn) || (rowEn && rowEn.trim()) || name;
    let initials = (known && known.initials) || (rowInitials && rowInitials.trim().toUpperCase()) || null;
    if (initials && taken.has(initials)) initials = null;
    if (initials) taken.add(initials);
    else initials = hebInitials(nameEn, taken);
    const company = { name, nameEn, initials, aliases: [], contacts: [] };
    byName.set(name, company);
    return company;
  };

  for (const row of dataRows) {
    const phones = phoneCol >= 0
      ? (row[phoneCol] || '').split(/[,;/]+/).map((p) => normalizePhone(p)).filter((p) => p.length >= 11)
      : [];
    const rowEn = enCol >= 0 ? row[enCol] : null;
    const rowInitials = initialsCol >= 0 ? row[initialsCol] : null;

    // Two supported layouts:
    //  contact-centric: name = contact person, משרד = their company/companies
    //  company-centric: name = the company itself
    const companyNames =
      officeCol >= 0 && officeCol !== nameCol && (row[officeCol] || '').trim()
        ? row[officeCol].split(/[,;/]+/)
        : [row[nameCol]];

    for (const raw of companyNames) {
      const company = getCompany(raw, rowEn, rowInitials);
      if (!company) continue;
      for (const phone of phones) {
        if (!company.contacts.includes(phone)) company.contacts.push(phone);
      }
    }
  }

  const companies = [...byName.values()];
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
