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
    // Google shows app passwords in spaced groups ("abcd efgh ...") but the
    // real password is the 16 characters WITHOUT spaces - normalize always
    pass: (s.emailPassword || config.emailPassword || '').replace(/\s+/g, ''),
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

// ONE persistent connection, reused across polls. Reconnecting every poll
// made Gmail throttle the logins ("Command failed" loops); a single live
// session with occasional NOOPs is the pattern Gmail expects.
let conn = null;
let failStreak = 0;
let backoffUntil = 0;

function describeImapError(err) {
  if (err && err.authenticationFailed) {
    return 'סיסמת האפליקציה נדחתה - יש לחדש אותה ב-myaccount.google.com ← אבטחה ← סיסמאות אפליקציה';
  }
  return (err && (err.responseText || err.message)) || String(err);
}

async function getConnection() {
  if (conn && conn.usable) return conn;
  try { if (conn) await conn.logout().catch(() => {}); } catch { /* stale */ }
  conn = null;
  const c = creds();
  const client = new ImapFlow({
    host: c.host,
    port: 993,
    secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    // must outlive the gap between polls, or the idle socket dies each cycle
    socketTimeout: 10 * 60 * 1000,
    greetingTimeout: 30 * 1000,
  });
  // CRITICAL: without an 'error' listener, a socket timeout between
  // operations becomes an UNCAUGHT exception and crashes the whole app.
  client.on('error', (err) => {
    status.ok = false;
    status.error = describeImapError(err);
    if (conn === client) conn = null; // next poll builds a fresh one
    log.warn(`שגיאת חיבור מייל: ${describeImapError(err)} - יחודש בסבב הבא`);
  });
  client.on('close', () => {
    if (conn === client) conn = null;
  });
  await client.connect();
  conn = client;
  return conn;
}

// Quick connection check for the onboarding screen / repair dialog.
async function testConnection() {
  if (!configured()) return { ok: false, error: 'חסרים כתובת מייל או סיסמת אפליקציה' };
  try {
    const client = await getConnection();
    const lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    status.ok = true;
    status.error = null;
    backoffUntil = 0;
    failStreak = 0;
    return { ok: true, total };
  } catch (err) {
    status.ok = false;
    status.error = describeImapError(err);
    return { ok: false, error: describeImapError(err) };
  }
}

// One poll pass: fetch new UIDs, keep CRM-sender messages, feed the flow.
// Repeated failures back off exponentially (up to 15 min) instead of hammering
// the server every cycle.
async function pollOnce(getFlow) {
  if (!configured()) return { skipped: 'not_configured' };
  if (Date.now() < backoffUntil) return { skipped: 'backoff' };
  const state = loadState();
  let client;
  try {
    client = await getConnection();
    failStreak = 0;
  } catch (err) {
    failStreak += 1;
    const waitMin = Math.min(15, 2 ** failStreak);
    backoffUntil = Date.now() + waitMin * 60 * 1000;
    status.ok = false;
    status.error = describeImapError(err);
    log.warn(`חיבור המייל נכשל (${describeImapError(err)}) - ניסיון הבא בעוד ${waitMin} דק'`);
    return { error: describeImapError(err) };
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
      // Orders are same-day business: an email RECEIVED on a previous day is
      // stale and must never become an order - even after downtime, only mail
      // whose arrival date is TODAY (Israel time) is processed.
      const israelDayOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const today = israelDayOf(new Date());
      let stale = 0;
      for await (const msg of client.fetch(range, { uid: true, envelope: true, internalDate: true, source: true }, { uid: Boolean(state.lastUid) })) {
        if (msg.uid <= state.lastUid) continue;
        report.seen += 1;
        state.lastUid = Math.max(state.lastUid, msg.uid);
        const receivedAt = msg.internalDate || (msg.envelope && msg.envelope.date);
        if (!receivedAt || israelDayOf(receivedAt) !== today) {
          stale += 1;
          continue; // yesterday's (or older) mail - skipped, uid advanced
        }
        const fromAddr = (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address || '').toLowerCase();
        let candidates = sheets.contactCompaniesByEmail(fromAddr);
        let viaPlatform = false;
        if (!candidates.length) {
          // ordering platforms (Restigo/Foodnet...) email on behalf of
          // customers - the customer is resolved from subject/content
          const domain = fromAddr.split('@')[1] || '';
          if ((config.emailPlatformDomains || []).some((d) => domain === d || domain.endsWith(`.${d}`))) {
            candidates = require('../config').config.companies;
            viaPlatform = true;
            log.info(`מייל מפלטפורמת הזמנות (${domain}): "${(msg.envelope.subject || '').slice(0, 60)}"`);
          } else {
            continue; // not a CRM contact and not a known platform
          }
        }
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
            viaPlatform,
          });
          report.handled += 1;
          status.processed += 1;
        } catch (err) {
          log.error(`טיפול במייל מ-${redactEmail(fromAddr)} נכשל: ${err.message}`);
        }
      }
      if (stale) log.info(`ערוץ המייל: ${stale} מיילים מימים קודמים דולגו (רק מיילים מהיום הופכים להזמנות)`);
      saveState(state);
    } finally {
      lock.release();
    }
  } catch (err) {
    status.ok = false;
    status.error = describeImapError(err);
    log.warn(`תשאול המייל נכשל: ${describeImapError(err)}`);
    // a broken session is discarded; the next poll opens a fresh one
    try { await client.logout().catch(() => {}); } catch { /* stale */ }
    if (conn === client) conn = null;
  }
  // NOTE: on success the connection stays OPEN for the next poll - closing and
  // re-logging-in every 2 minutes is what made Gmail throttle us.
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
