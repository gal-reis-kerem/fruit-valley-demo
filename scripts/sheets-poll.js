// One-shot check of the shared-sheets channel: discovery + change detection.
// Run: npm run sheets:poll  (read-only preview; order creation happens in the
// running app which holds the WhatsApp connection)
const sheets = require('../src/crm/sheets');
const sheetOrders = require('../src/orders/sheetOrders');

(async () => {
  await sheets.refresh();
  const { mapped, gaps } = await sheetOrders.discover();
  console.log(`גיליונות שאותרו: ${mapped.length}`);
  for (const m of mapped) console.log(`  ✓ ${m.office.displayName} ← "${m.sheetTitle}"`);
  for (const g of gaps) console.log(`  ✗ ${g}`);
  const report = await sheetOrders.pollOnce(() => null);
  console.log(`\nנבדקו ${report.checked} גיליונות. שינויים שממתינים לאפליקציה הרצה יטופלו בסבב הבא שלה.`);
})().catch((err) => {
  console.error('נכשל:', err.message);
  process.exit(1);
});
