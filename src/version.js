// Code-version stamp, so a running app can always be matched to a commit.
// Solves the recurring "am I testing the latest build?" problem.
const path = require('path');

let cached = null;

function getVersion() {
  if (cached) return cached;
  try {
    const { execSync } = require('child_process');
    const cwd = path.resolve(__dirname, '..');
    const hash = execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const when = execSync('git log -1 --format=%cd --date=format:"%d.%m %H:%M"', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/"/g, '');
    cached = { hash, when, label: `${hash} · ${when}` };
  } catch (err) {
    cached = { hash: 'dev', when: '', label: 'dev' };
  }
  return cached;
}

module.exports = { getVersion };
