// Fixed ("קבועה") base orders. The CRM only says WHICH offices are fixed;
// the base lists themselves are loaded here, with versioning and a full
// audit trail. If a base is missing we never invent one - the order goes to
// manual review.
//
// data/base-orders.json:
// {
//   "<officeKey>": {
//     activeVersion: "v2",
//     versions: [
//       { id: "v1", createdAt, note,
//         items: [...]                    // same base for every day, or
//         perDay: { "0".."6": [...] }     // per weekday (0=Sunday)
//       }
//     ]
//   }
// }
const fs = require('fs');
const path = require('path');
const { config } = require('./../config');

const FILE = path.join(config.dataDir, 'base-orders.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function save(db) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function getVersion(officeKey, versionId = null) {
  const entry = load()[officeKey];
  if (!entry || !entry.versions || !entry.versions.length) return null;
  const id = versionId || entry.activeVersion || entry.versions[entry.versions.length - 1].id;
  return entry.versions.find((v) => v.id === id) || null;
}

// Base items for a given delivery date (weekday-specific when defined).
// Returns { versionId, items } or null when no base exists.
function baseFor(officeKey, deliveryDate) {
  const version = getVersion(officeKey);
  if (!version) return null;
  let items = version.items || null;
  if (version.perDay) {
    const weekday = new Date(`${deliveryDate}T00:00:00`).getDay(); // 0=Sunday
    items = version.perDay[String(weekday)] || version.items || null;
  }
  if (!items || !items.length) return null;
  // deep copy so applied changes never mutate the stored base
  return { versionId: version.id, items: JSON.parse(JSON.stringify(items)) };
}

// Add a new base version (never overwrites history - full audit trail).
function setBase(officeKey, { items = null, perDay = null, note = '' }) {
  if (!items && !perDay) throw new Error('נדרשים items או perDay');
  const db = load();
  const entry = db[officeKey] || { versions: [] };
  const id = `v${entry.versions.length + 1}`;
  entry.versions.push({ id, createdAt: new Date().toISOString(), note, items, perDay });
  entry.activeVersion = id;
  db[officeKey] = entry;
  save(db);
  return id;
}

function listBases() {
  const db = load();
  return Object.entries(db).map(([key, entry]) => ({
    officeKey: key,
    activeVersion: entry.activeVersion,
    versions: entry.versions.length,
  }));
}

module.exports = { baseFor, setBase, getVersion, listBases };
