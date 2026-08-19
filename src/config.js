require('dotenv').config({ quiet: true });
const path = require('path');

// "0557118125" -> "972557118125" (WhatsApp id format, without @c.us)
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return '972' + digits.slice(1);
  return digits;
}

const ROOT = path.resolve(__dirname, '..');

const config = {
  // Model split: free-text parsing and worker chat run on Sonnet (fast,
  // ~60% cheaper); document reading (PDFs, scans, floor matrices, Excel/sheet
  // tables) stays on Opus where the vision/table work is hardest.
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  anthropicDocModel: process.env.ANTHROPIC_DOC_MODEL || 'claude-opus-4-8',
  sourceContact: normalizePhone(process.env.SOURCE_CONTACT_NUMBER || '0557118125'),
  sourceContactId: normalizePhone(process.env.SOURCE_CONTACT_NUMBER || '0557118125') + '@c.us',
  // The source contact is a REPRESENTATIVE who orders on behalf of several
  // companies. Each order is attributed to one of them (folders, file names,
  // order numbers and group messages). Override via COMPANIES env (JSON).
  companies: process.env.COMPANIES
    ? JSON.parse(process.env.COMPANIES)
    : [
        { name: 'כרם קפיטל', nameEn: 'Kerem Capital', initials: 'KC', aliases: ['כרם', 'קפיטל', 'kerem', 'capital'] },
        { name: 'טריפל', nameEn: 'Triple', initials: 'TR', aliases: ['triple', 'טריפל'] },
        { name: "סולראדג'", nameEn: 'Solar-edge', initials: 'SE', aliases: ['סולראדג', 'סולר אדג', 'סולאראדג', 'solaredge', 'solar edge', 'solar-edge'] },
      ],
  // Observe mode: full processing (orders, PDFs, kanban, demo groups) but NO
  // private messages to customers - replies surface in Naama's terminal only.
  // The safety switch for running against a customer's real WhatsApp.
  observeMode: ['1', 'true'].includes(String(process.env.OBSERVE_MODE || '').toLowerCase()),
  webPort: Number(process.env.WEB_PORT || 3010),
  pickingGroupName: process.env.PICKING_GROUP_NAME || '',
  photosGroupName: process.env.PHOTOS_GROUP_NAME || '',
  changesCutoff: process.env.CHANGES_CUTOFF || '14:00',
  // CRM v2: the Fruit Valley customers spreadsheet (payer + office model).
  // Central place for the id - never scatter it through the code.
  crmSpreadsheetId: process.env.CRM_SPREADSHEET_ID || '1JRWKQblbuGn_4gLVFMl5rhgKCj5SIVI4vK9_kL2A8ag',
  // Google Drive folders (public link sharing, read-only):
  // fixed base orders per customer, and per-customer order sheets.
  fixedOrdersFolderId: process.env.FIXED_ORDERS_FOLDER_ID || '1NBYb8PQIb2rG3U0kYO2u_kULc9F6ZnCk',
  sheetsOrdersFolderId: process.env.SHEETS_ORDERS_FOLDER_ID || '1HPg7IsoKmmaOLi_2sjopzEiKfpxePWKn',
  // Fixed orders are auto-issued on their scheduled delivery day at this hour.
  fixedIssueHour: process.env.FIXED_ISSUE_HOUR || '08:00',
  // Per-office polling windows for the shared-sheets channel (Israel time):
  // the sheet becomes THE day's order at `start`, then changes are tracked
  // every `everyMin` minutes until `end`. Offices not listed are polled
  // continuously (change = order/update).
  sheetWindows: [
    { office: 'למונייד', start: '14:00', end: '18:00', everyMin: 30 },
  ],
  // Email channel (IMAP, read-only). User + app password land in settings.json
  // via the onboarding screen, or here via env.
  emailHost: process.env.EMAIL_HOST || 'imap.gmail.com',
  emailUser: process.env.EMAIL_USER || '',
  emailPassword: process.env.EMAIL_APP_PASSWORD || '',
  // Triple team contact for worker escalations ("מדבר עם החבר'ה של טריפל")
  tripleContact: normalizePhone(process.env.TRIPLE_CONTACT_NUMBER || '0548383333'),
  tripleContactId: normalizePhone(process.env.TRIPLE_CONTACT_NUMBER || '0548383333') + '@c.us',
  // WhatsApp Web is pinned to the last version compatible with whatsapp-web.js
  // 1.34.x — the 2.3000.1043xxx rollout (July 2026) broke the library's
  // injection (window.Store never gets built). Override via WWEB_VERSION once
  // a fixed library release lands.
  wwebVersion: process.env.WWEB_VERSION || '2.3000.1039710401-alpha',
  dataDir: process.env.FV_DATA_DIR || path.join(ROOT, 'data'),
  outputDir: path.join(ROOT, 'output'),
  authDir: path.join(ROOT, '.wwebjs_auth'),
};

module.exports = { config, normalizePhone };
