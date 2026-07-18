// End-to-end parse test: raw WhatsApp text -> Claude -> structured order -> PDF.
// Requires ANTHROPIC_API_KEY in .env. Run: npm run test:parse
const { parseOrderMessage } = require('../src/ai/parser');
const { generatePickingSheetPDF, closeBrowser } = require('../src/pdf/generator');

const sampleMessage = `היי, ההזמנה למחר:
2 קילו עגבניות שרי
3 קילו מלפפונים
בננות 3 קילו רק אם הם בשלות
מלון קטן 2
תפוח סמיט קשה 2 קילו
6 קוטג (אם חסר אז גבינה לבנה)
2 מארז צהובה פרוסה
צרור סלרי
לחם שיפון 1
תודהה 🙏`;

(async () => {
  console.log('שולח ל-Claude לפרסור…\n');
  const parsed = await parseOrderMessage(sampleMessage);
  console.log(JSON.stringify(parsed, null, 2));

  const order = {
    id: 'KC-PARSE-TEST',
    customerName: 'כרם קפיטל',
    deliveryDate: parsed.delivery_date || new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10),
    customerNote: parsed.customer_note,
    version: 1,
    items: parsed.items,
  };
  const pdfPath = await generatePickingSheetPDF(order);
  console.log('\nPDF נוצר:', pdfPath);
  await closeBrowser();
})();
