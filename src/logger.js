const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve(__dirname, '..', 'data', 'app.log');

function ts() {
  return new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// Also persist to data/app.log so crashes can be diagnosed after the fact.
function toFile(level, args) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) {
        const tail = fs.readFileSync(LOG_PATH, 'utf8').slice(-500 * 1024);
        fs.writeFileSync(LOG_PATH, tail);
      }
    } catch (err) { /* no file yet */ }
    const line = args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ');
    fs.appendFileSync(LOG_PATH, `[${ts()}] [${level}] ${line}\n`);
  } catch (err) { /* never break the app over logging */ }
}

module.exports = {
  info: (...args) => { console.log(`[${ts()}]`, ...args); toFile('info', args); },
  warn: (...args) => { console.warn(`[${ts()}] ⚠️`, ...args); toFile('warn', args); },
  error: (...args) => { console.error(`[${ts()}] ❌`, ...args); toFile('error', args); },
};
