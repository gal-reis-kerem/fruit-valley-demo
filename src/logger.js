function ts() {
  return new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

module.exports = {
  info: (...args) => console.log(`[${ts()}]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] ⚠️`, ...args),
  error: (...args) => console.error(`[${ts()}] ❌`, ...args),
};
