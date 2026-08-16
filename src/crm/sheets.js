// Bridge between CRM v2 (source.js - payer/office model) and the engine's
// company registry (config.companies). Keeps the historical interface
// (refresh / startPolling / contactCompanies / getStatus) so the engine, the
// desktop app and the wizard continue to work unchanged.
const { config } = require('../config');
const log = require('../logger');
const bus = require('../bus');
const source = require('./source');

let pollTimer = null;
const status = { configured: true, ok: null, lastSync: null, error: null };

function getStatus() {
  const s = source.getSyncState();
  return {
    configured: true,
    ok: status.ok,
    lastSync: s.lastSync || status.lastSync,
    error: s.error || status.error,
    validationIssues: s.validation || [],
  };
}

// Latin initials for Hebrew names (used for order ids: "מייקרוסופט תל אביב" -> MT)
const HEB2LAT = { א: 'A', ב: 'B', ג: 'G', ד: 'D', ה: 'H', ו: 'V', ז: 'Z', ח: 'H', ט: 'T', י: 'Y', כ: 'K', ך: 'K', ל: 'L', מ: 'M', ם: 'M', נ: 'N', ן: 'N', ס: 'S', ע: 'A', פ: 'P', ף: 'P', צ: 'Z', ץ: 'Z', ק: 'K', ר: 'R', ש: 'S', ת: 'T' };

function hebInitials(name, taken) {
  const words = String(name).replace(/[׳'"״]/g, '').split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0][0], words[1][0]] : [...(words[0] || 'XX')].slice(0, 2);
  let base = letters.map((ch) => HEB2LAT[ch] || (/[a-zA-Z]/.test(ch) ? ch.toUpperCase() : 'X')).join('');
  if (base.length < 2) base = (base + 'X').slice(0, 2);
  let candidate = base, n = 2;
  while (taken.has(candidate)) candidate = base + n++;
  taken.add(candidate);
  return candidate;
}

// office record -> engine company entry. The whole existing flow (parsing
// enum, folders, order ids, group captions) keys off these fields; the full
// CRM record rides along under `crm` for the new behaviors.
function toCompanies(offices) {
  const taken = new Set();
  return offices.map((o) => ({
    name: o.displayName,
    nameEn: o.displayName,
    initials: hebInitials(o.displayName, taken),
    // aliases power candidate matching; payer alone is shared between
    // offices and therefore yields multiple candidates -> ask, never guess.
    aliases: [o.payer, o.office].filter(Boolean),
    contacts: o.contacts
      .filter((c) => c.phone)
      .map((c) => c.phone.replace(/^0/, '972')),
    crm: o,
  }));
}

function applyCompanies(companies) {
  config.companies.length = 0;
  config.companies.push(...companies);
  bus.emit('crm', { companies: companies.map((c) => c.name) });
  log.info(`CRM עודכן: ${companies.length} משרדים נטענו`);
}

// phone -> companies owning this contact. A number shared by several offices
// (FoodiFairy case) returns them all - the caller must treat >1 as ambiguous.
function contactCompanies(phoneId) {
  const phone = String(phoneId).replace('@c.us', '');
  return config.companies.filter((c) => (c.contacts || []).includes(phone));
}

// email -> companies whose CRM contacts include this address (lowercased).
function contactCompaniesByEmail(address) {
  const email = String(address || '').trim().toLowerCase();
  if (!email) return [];
  return config.companies.filter((c) =>
    ((c.crm && c.crm.contacts) || []).some((ct) => ct.email === email));
}

// The raw CRM office records currently loaded (empty array before first sync).
function allOffices() {
  return config.companies.filter((c) => c.crm).map((c) => c.crm);
}

// office key -> the engine company entry (with initials/aliases/crm).
function companyByOfficeKey(officeKey) {
  return config.companies.find((c) => c.crm && c.crm.key === officeKey) || null;
}

async function refresh() {
  try {
    const snapshot = await source.sync();
    applyCompanies(toCompanies(snapshot.offices));
    status.ok = true;
    status.lastSync = Date.now();
    status.error = null;
    return config.companies;
  } catch (err) {
    status.ok = false;
    status.error = err.message;
    // last-good snapshot still serves if it exists
    const snap = source.loadSnapshot();
    if (snap && !config.companies.some((c) => c.crm)) {
      applyCompanies(toCompanies(snap.offices));
      log.warn('נטען snapshot אחרון תקין של ה-CRM');
    }
    throw err;
  }
}

function startPolling(_legacyUrl, intervalMs = 5 * 60 * 1000) {
  stopPolling();
  const tick = () => refresh().catch((err) => log.warn(`רענון CRM נכשל: ${err.message}`));
  tick();
  pollTimer = setInterval(tick, intervalMs);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = {
  refresh,
  startPolling,
  stopPolling,
  contactCompanies,
  contactCompaniesByEmail,
  allOffices,
  companyByOfficeKey,
  getStatus,
  readinessReport: () => source.readinessReport(),
  getSyncState: () => source.getSyncState(),
};
