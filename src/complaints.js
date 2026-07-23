// Complaints Naama detects in customer messages. Kept on disk and shown in
// the complaints page for 14 days.
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const FILE = path.join(config.dataDir, 'complaints.json');
const RETENTION_MS = 14 * 24 * 3600 * 1000;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function prune(list) {
  const cutoff = Date.now() - RETENTION_MS;
  return list.filter((c) => new Date(c.ts).getTime() >= cutoff);
}

function add({ text, company, orderId }) {
  const list = prune(load());
  const entry = { ts: new Date().toISOString(), text, company: company || null, orderId: orderId || null };
  list.push(entry);
  save(list);
  return entry;
}

function list() {
  return prune(load()).sort((a, b) => b.ts.localeCompare(a.ts));
}

module.exports = { add, list };
