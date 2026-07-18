// Picking-sheet HTML template (rendered to PDF via headless Chrome).
// FR-07: sorted by picking areas, product names in Hebrew/English/Arabic/Thai.
// FR-08: picker fields - V/X, picked quantity, customer note, picker note.

const CATEGORY_ORDER = ['vegetables', 'fruits', 'dairy', 'other'];
const CATEGORY_LABELS = {
  vegetables: 'ירקות',
  fruits: 'פירות',
  dairy: 'מוצרי חלב',
  other: 'אחר / יבשים',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtQty(q) {
  if (q === null || q === undefined) return '';
  return Number.isInteger(q) ? String(q) : String(q);
}

function itemRow(item, idx) {
  const addedBadge = item.addedAfterPrint
    ? '<span class="badge added">תוספת</span> '
    : item.addedLate
      ? '<span class="badge late">תוספת מאוחרת</span> '
      : '';
  return `
    <tr>
      <td class="num">${idx}</td>
      <td class="check"></td>
      <td class="product">
        ${addedBadge}<span class="he">${esc(item.product_he)}</span>
        <div class="translations">${esc(item.product_en)} · ${esc(item.product_th)} · ${esc(item.product_ar)}</div>
      </td>
      <td class="qty">${fmtQty(item.quantity)}</td>
      <td class="unit">${esc(item.unit)}</td>
      <td class="note">${esc(item.note || '')}</td>
      <td class="picked"></td>
      <td class="picker-note"></td>
    </tr>`;
}

function categorySection(cat, items, startIdx) {
  if (!items.length) return { html: '', nextIdx: startIdx };
  let idx = startIdx;
  const rows = items.map((it) => itemRow(it, idx++)).join('');
  const vat = cat === 'vegetables' || cat === 'fruits' ? 'פטור ממע"מ' : 'חייב במע"מ';
  const html = `
    <tr class="cat-row"><td colspan="8">${CATEGORY_LABELS[cat]} <span class="vat">(${vat})</span></td></tr>
    ${rows}`;
  return { html, nextIdx: idx };
}

/**
 * @param {object} order order object from the store
 * @param {object} opts  { changesCutoff }
 */
function buildPickingSheetHTML(order, opts = {}) {
  const cutoff = opts.changesCutoff || '14:00';
  const deliveryDate = new Date(order.deliveryDate + 'T00:00:00');
  const dayName = deliveryDate.toLocaleDateString('he-IL', { weekday: 'long' });
  const dateStr = deliveryDate.toLocaleDateString('he-IL');
  const generatedAt = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  let body = '';
  let idx = 1;
  for (const cat of CATEGORY_ORDER) {
    const items = order.items.filter((it) => it.category === cat);
    const section = categorySection(cat, items, idx);
    body += section.html;
    idx = section.nextIdx;
  }

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Arial Hebrew", "Noto Sans Hebrew", Arial, "Noto Sans Thai", "Noto Sans Arabic", sans-serif;
    font-size: 13px; color: #111; padding: 24px;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2e7d32; padding-bottom: 10px; margin-bottom: 12px; }
  .brand { font-size: 22px; font-weight: bold; color: #2e7d32; }
  .brand small { display: block; font-size: 11px; color: #666; font-weight: normal; }
  .meta { text-align: left; font-size: 12px; line-height: 1.6; }
  .meta b { font-size: 15px; }
  .title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .title-row h1 { font-size: 18px; }
  .title-row .day { font-size: 15px; color: #333; }
  .customer-note { background: #fff8e1; border: 1px solid #f0c020; border-radius: 4px; padding: 6px 10px; margin-bottom: 10px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 6px; vertical-align: top; }
  th { background: #e8f5e9; font-size: 12px; }
  td.num { width: 26px; text-align: center; color: #777; }
  td.check { width: 44px; }
  td.product .he { font-weight: bold; font-size: 14px; }
  td.product .translations { color: #555; font-size: 11px; margin-top: 2px; }
  td.qty { width: 52px; text-align: center; font-weight: bold; font-size: 14px; }
  td.unit { width: 60px; text-align: center; }
  td.note { width: 130px; color: #b00020; }
  td.picked { width: 80px; }
  td.picker-note { width: 110px; }
  tr.cat-row td { background: #2e7d32; color: #fff; font-weight: bold; font-size: 14px; padding: 4px 8px; }
  tr.cat-row .vat { font-weight: normal; font-size: 11px; opacity: 0.85; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px; color: #fff; vertical-align: middle; }
  .badge.added { background: #d84315; }
  .badge.late { background: #6a1b9a; }
  footer { margin-top: 14px; display: flex; justify-content: space-between; font-size: 11px; color: #555; border-top: 1px solid #ccc; padding-top: 8px; }
</style>
</head>
<body>
  <header>
    <div class="brand">פירות העמק<small>Triple Digital Workforce · דף ליקוט</small></div>
    <div class="meta">
      <div>הזמנה: <b>${esc(order.id)}</b> (גרסה ${order.version})</div>
      <div>לקוח: <b>${esc(order.customerName)}</b></div>
      <div>הופק: ${esc(generatedAt)}</div>
    </div>
  </header>

  <div class="title-row">
    <h1>רשימת ליקוט — ${esc(order.customerName)}</h1>
    <div class="day">${esc(dayName)} · ${esc(dateStr)}</div>
  </div>

  ${order.customerNote ? `<div class="customer-note"><b>הערת לקוח:</b> ${esc(order.customerNote)}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>✓ / ✗</th>
        <th>פריט</th>
        <th>כמות</th>
        <th>יחידה</th>
        <th>הערת לקוח</th>
        <th>כמות שנלקטה</th>
        <th>הערת מלקט</th>
      </tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>

  <footer>
    <div>סגירת שינויים: ${esc(cutoff)} · תוספות לאחר הסגירה יופיעו כתגובה בקבוצה</div>
    <div>סה"כ ${order.items.length} פריטים</div>
  </footer>
</body>
</html>`;
}

module.exports = { buildPickingSheetHTML, CATEGORY_ORDER };
