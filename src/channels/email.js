// Email order channel (IMAP, read-only). Some customers send their orders by
// email (e.g. a weekly Excel every Thursday). We poll the configured inbox,
// keep only messages whose SENDER address appears in the CRM contacts, and
// hand the content (body text / Excel / PDF attachments) to the orchestrator.
//
// Read-only by design: messages are never deleted, moved or marked; processed
// UIDs are remembered locally in data/email-state.json.
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { config } = require('../config');
const log = require('../logger');
const sheets = require('../crm/sheets');
const settings = require('../settings');
const bus = require('../bus');

const STATE_FILE = () => path.join(config.dataDir, 'email-state.json');
// Full addresses never reach logs/terminals - "d***@fruitvalley.co.il"
const redactEmail = (a) => {
  const s = String(a || '');
  const at = s.indexOf('@');
  return at > 0 ? `${s[0]}***${s.slice(at)}` : s;
};
let pollTimer = null;
const status = { configured: false, ok: null, error: null, lastPoll: null, processed: 0 };

function creds() {
  const s = settings.readSettings();
  return {
    host: (s.emailHost || config.emailHost || 'imap.gmail.com').trim(),
    user: (s.emailUser || config.emailUser || '').trim(),
    pass: (s.emailPassword || config.emailPassword || '').trim(),
  };
}

function configured() {
  const c = creds();
  return Boolean(c.user && c.pass);
}

function getStatus() {
  return { ...status, configured: configured(), user: creds().user };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return { lastUid: 0 }; }
}
function saveState(s) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
}

async function connect() {
  const c = creds();
  const client = new ImapFlow({
    host: c.host,
    port: 993,
    secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
  });
  await client.connect();
  return client;
}

// Quick connection check for the onboarding screen / repair dialog.
async function testConnection() {
  if (!configured()) return { ok: false, error: 'חסרים כתובת מייל או סיסמת אפליקציה' };
  try {
    const client = await connect();
    const lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    await client.logout();
    status.ok = true;
    status.error = null;
    return { ok: true, total };
  } catch (err) {
    status.ok = false;
    status.error = err.message;
    return { ok: false, error: err.message };
  }
}

// One poll pass: fetch new UIDs, keep CRM-sender messages, feed the flow.
async function pollOnce(getFlow) {
  if (!configured()) return { skipped: 'not_configured' };
  const state = loadState();
  let client;
  try {
    client = await connect();
  } catch (err) {
    status.ok = false;
    status.error = err.message;
    log.warn(`חיבור המייל נכשל: ${err.message}`);
    return { error: err.message };
  }
  const report = { seen: 0, matched: 0, handled: 0 };
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      status.ok = true;
      status.error = null;
      status.lastPoll = Date.now();
      const startUid = state.lastUid + 1;
      // on the very first run only look back one day - older mail is history
      const range = state.lastUid ? `${startUid}:*` : { since: new Date(Date.now() - 24 * 3600 * 1000) };
      for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true }, { uid: Boolean(state.lastUid) })) {
        if (msg.uid <= state.lastUid) continue;
        report.seen += 1;
        state.lastUid = Math.max(state.lastUid, msg.uid);
        const fromAddr = (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address || '').toLowerCase();
        const candidates = sheets.contactCompaniesByEmail(fromAddr);
        if (!candidates.length) continue; // not a CRM contact - ignore silently
        report.matched += 1;

        const parsed = await simpleParser(msg.source);
        const attachments = (parsed.attachments || []).map((a) => ({
          filename: a.filename || 'קובץ',
          contentType: a.contentType,
          content: a.content,
        }));
        const flow = getFlow();
        if (!flow) {
          log.warn('מייל הזמנה התקבל אך וואטסאפ לא מחובר - יטופל בסבב הבא');
          state.lastUid = msg.uid - 1; // reprocess next time
          break;
        }
        bus.naama(`התקבל מייל מ-${redactEmail(fromAddr)} (${parsed.subject || 'ללא נושא'})`);
        try {
          await flow.handleEmailOrder(candidates, {
            from: fromAddr,
            subject: parsed.subject || '',
            text: (parsed.text || '').trim(),
            attachments,
          });
          report.handled += 1;
          status.processed += 1;
        } catch (err) {
          log.error(`טיפול במייל מ-${redactEmail(fromAddr)} נכשל: ${err.message}`);
        }
      }
      saveState(state);
    } finally {
      lock.release();
    }
  } catch (err) {
    status.ok = false;
    status.error = err.message;
    log.warn(`תשאול המייל נכשל: ${err.message}`);
  } finally {
    await client.logout().catch(() => {});
  }
  return report;
}

function startPolling(getFlow, intervalMs = 2 * 60 * 1000) {
  stopPolling();
  if (!configured()) return false;
  const run = () => pollOnce(getFlow).catch((err) => log.warn(`סבב מייל נכשל: ${err.message}`));
  run();
  pollTimer = setInterval(run, intervalMs);
  log.info(`ערוץ המייל פעיל (${redactEmail(creds().user)})`);
  return true;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = { configured, getStatus, testConnection, pollOnce, startPolling, stopPolling };
