// Per-worker rulebooks (markdown). Live in rules/ (versioned, survives data
// wipes). Manager-approved additions are appended under "הנחיות מהמנהל".
const fs = require('fs');
const path = require('path');

const RULES_DIR = path.resolve(__dirname, '..', 'rules');
const MANAGER_HEADER = '## הנחיות מהמנהל';

function rulesPath(workerId) {
  return path.join(RULES_DIR, `${workerId.replace(/[^a-z]/g, '')}.md`);
}

function readRules(workerId) {
  try {
    return fs.readFileSync(rulesPath(workerId), 'utf8');
  } catch (err) {
    return '';
  }
}

function addManagerRule(workerId, ruleText) {
  let content = readRules(workerId);
  if (!content.includes(MANAGER_HEADER)) content = `${content.trim()}\n\n${MANAGER_HEADER}\n`;
  const date = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  content = `${content.trim()}\n- (${date}) ${ruleText.trim()}\n`;
  fs.writeFileSync(rulesPath(workerId), content);
  return content;
}

// The manager-directives section of Naama's rulebook is injected into the
// order-parsing prompt, so approved rules take effect immediately.
function managerDirectives(workerId) {
  const content = readRules(workerId);
  const idx = content.indexOf(MANAGER_HEADER);
  if (idx < 0) return '';
  return content.slice(idx + MANAGER_HEADER.length).trim();
}

module.exports = { readRules, addManagerRule, managerDirectives };
