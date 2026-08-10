// Inbound channel adapters. WhatsApp is fully live (src/engine.js). Email and
// shared-Sheet polling are declared here with HONEST readiness gating - an
// integration is never presented as active while its prerequisite is missing.
const registry = {
  whatsapp: {
    active: true,
    describe: () => ({ status: 'active' }),
  },
  email: {
    active: false,
    describe: (office) => ({
      status: 'blocked',
      reason: `נדרשת הרשאת גישה לתיבת המייל עבור ${office ? office.displayName : 'הלקוח'}`,
    }),
  },
  sheet: {
    active: false,
    describe: (office) => ({
      status: office && office.examplesLink ? 'missing_prerequisite' : 'blocked',
      reason: 'נדרש לינק לגיליון המשותף של הלקוח (חסר ב-CRM)',
    }),
  },
  db: {
    active: false,
    describe: (office) => ({
      status: 'missing_prerequisite',
      reason: `נדרשת טעינת הזמנת הבסיס של ${office ? office.displayName : 'הלקוח'} (npm run base:set)`,
    }),
  },
};

function channelStatus(office) {
  const adapter = registry[office.channel] || null;
  if (!adapter) return { status: 'unknown', reason: `ערוץ לא מוכר: ${office.channel}` };
  return adapter.describe(office);
}

module.exports = { registry, channelStatus };
