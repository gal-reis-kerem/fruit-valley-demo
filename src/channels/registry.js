// Inbound channel adapters with HONEST readiness gating - an integration is
// never presented as active while its prerequisite is missing.
//   whatsapp - always live (src/engine.js)
//   email    - live once the inbox is configured (src/channels/email.js)
//   sheet    - live once the customer's sheet was located in the Drive
//              folder (src/orders/sheetOrders.js discovery)
//   db       - live once the customer's base order was loaded from Drive
//              (src/orders/fixedSync.js) or manually (npm run base:set)
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function sheetMapped(office) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'sheet-orders-state.json'), 'utf8'));
    return Boolean(office && st.customers && st.customers[office.key]);
  } catch {
    return false;
  }
}

const registry = {
  whatsapp: {
    describe: () => ({ status: 'active' }),
  },
  email: {
    describe: (office) => {
      let ok = false;
      try { ok = require('./email').configured(); } catch { /* not configured */ }
      return ok
        ? { status: 'active' }
        : { status: 'blocked', reason: `נדרשת הגדרת חיבור המייל עבור ${office ? office.displayName : 'הלקוח'}` };
    },
  },
  sheet: {
    describe: (office) => (sheetMapped(office)
      ? { status: 'active' }
      : { status: 'blocked', reason: 'הגיליון של הלקוח טרם אותר בתיקיית השיטס' }),
  },
  db: {
    describe: (office) => {
      let has = false;
      try { has = office && Boolean(require('../orders/baseOrders').activeBase(office.key)); } catch { /* empty */ }
      return has
        ? { status: 'active' }
        : { status: 'missing_prerequisite', reason: `נדרשת טעינת הזמנת הבסיס של ${office ? office.displayName : 'הלקוח'} (npm run fixed:sync)` };
    },
  },
};

function channelStatus(office) {
  const adapter = registry[office.channel] || null;
  if (!adapter) return { status: 'unknown', reason: `ערוץ לא מוכר: ${office.channel}` };
  return adapter.describe(office);
}

module.exports = { registry, channelStatus };
