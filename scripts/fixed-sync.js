// Sync fixed base orders from the Drive folder (and optionally list what is
// due today). Run: npm run fixed:sync   /   npm run fixed:issue
// --issue only PREVIEWS what is due; actual issuance happens inside the
// running app (it needs the live WhatsApp connection).
const sheets = require('../src/crm/sheets');
const { syncFixedOrders } = require('../src/orders/fixedSync');
const scheduler = require('../src/orders/scheduler');

(async () => {
  console.log('מסנכרן CRM…');
  await sheets.refresh();
  console.log('מסנכרן הזמנות קבועות מגוגל דרייב…\n');
  const r = await syncFixedOrders({ force: process.argv.includes('--force') });

  console.log(`נטענו ${r.loaded.length} לקוחות (${r.filesParsed} קבצים פורסרו, ${r.filesCached} מהמטמון):`);
  const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  for (const l of r.loaded) {
    console.log(`  ${l.changed ? '🆕' : '✓ '} ${l.office} — ימים: ${l.days.map((d) => dayNames[d]).join(', ')}${l.versionId ? ` (${l.versionId})` : ''}`);
  }
  if (r.warnings.length) {
    console.log('\nאזהרות:');
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
  if (r.gaps.length) {
    console.log('\nפערים:');
    for (const g of r.gaps) console.log(`  - ${g}`);
  }

  if (process.argv.includes('--issue')) {
    const due = scheduler.dueToday();
    console.log(`\nהזמנות קבועות שבלוז של היום וטרם הונפקו: ${due.length}`);
    for (const d of due) console.log(`  - ${d.office.displayName} (${d.base.items.length} פריטים, בסיס ${d.base.versionId})`);
    console.log('ההנפקה עצמה מתבצעת מתוך האפליקציה הרצה (דרושה שליחת וואטסאפ).');
  }
})().catch((err) => {
  console.error('נכשל:', err.message);
  process.exit(1);
});
