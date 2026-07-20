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
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
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
  webPort: Number(process.env.WEB_PORT || 3010),
  pickingGroupName: process.env.PICKING_GROUP_NAME || '',
  photosGroupName: process.env.PHOTOS_GROUP_NAME || '',
  changesCutoff: process.env.CHANGES_CUTOFF || '14:00',
  // WhatsApp Web is pinned to the last version compatible with whatsapp-web.js
  // 1.34.x — the 2.3000.1043xxx rollout (July 2026) broke the library's
  // injection (window.Store never gets built). Override via WWEB_VERSION once
  // a fixed library release lands.
  wwebVersion: process.env.WWEB_VERSION || '2.3000.1039710401-alpha',
  dataDir: path.join(ROOT, 'data'),
  outputDir: path.join(ROOT, 'output'),
  authDir: path.join(ROOT, '.wwebjs_auth'),
};

module.exports = { config, normalizePhone };
