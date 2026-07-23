// Persistent app settings (wizard results): data/settings.json
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const SETTINGS_PATH = path.join(config.dataDir, 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    return { setupDone: false, businessPhone: '', sheetUrl: '' };
  }
}

function writeSettings(patch) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { readSettings, writeSettings };
