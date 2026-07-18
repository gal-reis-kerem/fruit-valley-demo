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
  customerName: process.env.CUSTOMER_NAME || 'כרם קפיטל',
  pickingGroupName: process.env.PICKING_GROUP_NAME || '',
  photosGroupName: process.env.PHOTOS_GROUP_NAME || '',
  changesCutoff: process.env.CHANGES_CUTOFF || '14:00',
  dataDir: path.join(ROOT, 'data'),
  outputDir: path.join(ROOT, 'output'),
  authDir: path.join(ROOT, '.wwebjs_auth'),
};

module.exports = { config, normalizePhone };
