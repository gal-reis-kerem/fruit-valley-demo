// Auto-issuance of fixed (standing) orders, per each customer's OWN schedule.
// A fixed order is issued only on days that have a base list (loaded from the
// Drive folder by fixedSync) - never "all fixed customers every day".
//
// Issuance happens once per office per delivery date, at/after
// config.fixedIssueHour Israel time, and is remembered in
// data/fixed-issued.json so restarts never double-issue.
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('../logger');
const sheets = require('../crm/sheets');
const baseOrders = require('./baseOrders');
const bus = require('../bus');

const FILE = () => path.join(config.dataDir, 'fixed-issued.json');

function loadIssued() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}
function saveIssued(db) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(db, null, 2));
}

function israelNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
}

function pastIssueHour(now = israelNow()) {
  const [h, m] = String(config.fixedIssueHour).split(':').map(Number);
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= (m || 0));
}

// Which fixed offices are due for TODAY (delivery today) and not yet issued.
function dueToday(now = israelNow()) {
  const dateStr = now.toLocaleDateString('en-CA');
  const issued = loadIssued();
  const due = [];
  for (const office of sheets.allOffices()) {
    if (office.orderType !== 'fixed') continue;
    const key = `${office.key}|${dateStr}`;
    if (issued[key]) continue;
    const base = baseOrders.baseFor(office.key, dateStr);
    if (!base) continue; // no base for this weekday -> not on today's schedule
    due.push({ office, dateStr, base });
  }
  return due;
}

function markIssued(officeKey, dateStr, orderId) {
  const issued = loadIssued();
  issued[`${officeKey}|${dateStr}`] = { orderId, at: new Date().toISOString() };
  saveIssued(issued);
}

/**
 * One scheduler tick. getFlow returns the live Orchestrator (or null when
 * WhatsApp is not connected - issuance waits for the next tick).
 */
async function tick(getFlow, now = israelNow()) {
  if (!pastIssueHour(now)) return { issued: 0, reason: 'לפני שעת ההנפקה' };
  const due = dueToday(now);
  if (!due.length) return { issued: 0 };
  const flow = getFlow();
  if (!flow) {
    log.warn(`יש ${due.length} הזמנות קבועות שממתינות להנפקה אך וואטסאפ לא מחובר - ננסה שוב בטיק הבא`);
    return { issued: 0, reason: 'whatsapp_disconnected', pending: due.length };
  }
  let issued = 0;
  for (const { office, dateStr } of due) {
    const company = sheets.companyByOfficeKey(office.key);
    if (!company) continue;
    try {
      const order = await flow.issueScheduledOrder(company, dateStr);
      markIssued(office.key, dateStr, order.id);
      issued += 1;
      bus.yuval(`הזמנה קבועה של ${office.displayName} הונפקה לפי הלוז (${order.id})`);
    } catch (err) {
      log.error(`הנפקת הזמנה קבועה של ${office.displayName} נכשלה: ${err.message}`);
    }
  }
  return { issued };
}

module.exports = { tick, dueToday, pastIssueHour, markIssued };
