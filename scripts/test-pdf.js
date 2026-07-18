// Generates a sample picking-sheet PDF from a fixture order - no WhatsApp and
// no API key needed. Run: npm run test:pdf
const { generatePickingSheetPDF, closeBrowser } = require('../src/pdf/generator');

const sampleOrder = {
  id: 'KC-DEMO-01',
  customerName: 'כרם קפיטל',
  deliveryDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10),
  customerNote: 'נא להקפיד על טריות - האירוע מחר בצהריים',
  version: 1,
  items: [
    { product_he: 'עגבניות שרי', product_en: 'Cherry tomatoes', product_th: 'มะเขือเทศเชอร์รี่', product_ar: 'طماطم كرزية', quantity: 2, unit: 'ק"ג', note: null, category: 'vegetables', vat_exempt: true },
    { product_he: 'מלפפון', product_en: 'Cucumber', product_th: 'แตงกวา', product_ar: 'خيار', quantity: 3, unit: 'ק"ג', note: null, category: 'vegetables', vat_exempt: true },
    { product_he: 'פלפל אדום', product_en: 'Red bell pepper', product_th: 'พริกหวานแดง', product_ar: 'فلفل أحمر', quantity: 1.5, unit: 'ק"ג', note: null, category: 'vegetables', vat_exempt: true },
    { product_he: 'סלרי עלים', product_en: 'Leaf celery', product_th: 'ขึ้นฉ่าย', product_ar: 'كرفس ورقي', quantity: 2, unit: 'צרור', note: null, category: 'vegetables', vat_exempt: true },
    { product_he: 'בננות', product_en: 'Bananas', product_th: 'กล้วย', product_ar: 'موز', quantity: 3, unit: 'ק"ג', note: 'רק אם הן בשלות', category: 'fruits', vat_exempt: true },
    { product_he: 'מלון', product_en: 'Melon', product_th: 'เมล่อน', product_ar: 'شمام', quantity: 2, unit: 'יחידה', note: 'קטן', category: 'fruits', vat_exempt: true },
    { product_he: 'תפוח עץ גרני סמית', product_en: 'Granny Smith apple', product_th: 'แอปเปิ้ลเขียว', product_ar: 'تفاح أخضر', quantity: 2, unit: 'ק"ג', note: 'קשה', category: 'fruits', vat_exempt: true },
    { product_he: 'נקטרינה', product_en: 'Nectarine', product_th: 'เนคทารีน', product_ar: 'نكتارين', quantity: 3, unit: 'ק"ג', note: null, category: 'fruits', vat_exempt: true },
    { product_he: 'קוטג\' 5%', product_en: 'Cottage cheese 5%', product_th: 'คอทเทจชีส 5%', product_ar: 'جبنة قريش 5%', quantity: 6, unit: 'יחידה', note: 'אם חסר - גבינה לבנה', category: 'dairy', vat_exempt: false },
    { product_he: 'גבינה צהובה פרוסה', product_en: 'Sliced yellow cheese', product_th: 'ชีสเหลืองแผ่น', product_ar: 'جبنة صفراء شرائح', quantity: 2, unit: 'מארז', note: null, category: 'dairy', vat_exempt: false },
    { product_he: 'לחם שיפון מלא', product_en: 'Whole rye bread', product_th: 'ขนมปังไรย์', product_ar: 'خبز الجاودار', quantity: 1, unit: 'יחידה', note: null, category: 'other', vat_exempt: false, addedAfterPrint: true },
  ],
};

(async () => {
  const pdfPath = await generatePickingSheetPDF(sampleOrder);
  console.log('PDF נוצר:', pdfPath);
  await closeBrowser();
})();
