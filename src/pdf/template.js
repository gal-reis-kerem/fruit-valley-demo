// Picking-sheet HTML template (rendered to PDF via headless Chrome).
// FR-07: sorted by picking areas, product names in Hebrew/English/Arabic/Thai.
// FR-08: picker fields - V/X, picked quantity, customer note, picker note.
// Column headers carry a Thai translation (the pickers are Thai workers).

const fs = require('fs');
const path = require('path');

const CATEGORY_ORDER = ['vegetables', 'fruits', 'dairy', 'other'];
const CATEGORY_LABELS = {
  vegetables: 'ירקות · ผัก',
  fruits: 'פירות · ผลไม้',
  dairy: 'מוצרי חלב · ผลิตภัณฑ์นม',
  other: 'אחר / יבשים · อื่นๆ',
};

// Optional real logo: drop assets/logo.png (or .jpg/.svg) into the project.
// Falls back to an inline SVG placeholder.
function logoDataUri() {
  const assetsDir = path.resolve(__dirname, '../../assets');
  for (const [file, mime] of [
    ['logo.png', 'image/png'],
    ['logo.jpg', 'image/jpeg'],
    ['logo.svg', 'image/svg+xml'],
  ]) {
    const p = path.join(assetsDir, file);
    if (fs.existsSync(p)) {
      return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <circle cx="24" cy="40" r="14" fill="#e53935"/>
    <circle cx="42" cy="38" r="16" fill="#fb8c00"/>
    <path d="M42 22 q4 -8 12 -8 q-2 8 -12 8" fill="#2e7d32"/>
    <path d="M24 26 q2 -6 8 -6 q-1 6 -8 6" fill="#43a047"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtQty(q) {
  if (q === null || q === undefined) return '';
  return String(q);
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
      <td class="picked">
        <div class="write-space"></div>
        <div class="unit-options">ק"ג &nbsp;·&nbsp; יחידה &nbsp;·&nbsp; מארז</div>
      </td>
      <td class="picker-note"></td>
    </tr>`;
}

// Floors mode: group by floor in first-appearance order; items keep their
// received order inside each floor and are NEVER merged across floors.
function floorSections(items) {
  const floors = [];
  const byFloor = new Map();
  for (const it of items) {
    const key = it.floor || 'ללא שיוך קומה';
    if (!byFloor.has(key)) {
      byFloor.set(key, []);
      floors.push(key);
    }
    byFloor.get(key).push(it);
  }
  let html = '';
  let idx = 1;
  for (const floor of floors) {
    html += `\n    <tr class="cat-row floor-row"><td colspan="8">🏢 ${esc(floor)}</td></tr>`;
    for (const it of byFloor.get(floor)) html += itemRow(it, idx++);
  }
  return html;
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
  if (order.displayMode === 'floors' && order.items.some((it) => it.floor)) {
    body = floorSections(order.items);
  } else {
    let idx = 1;
    for (const cat of CATEGORY_ORDER) {
      const items = order.items.filter((it) => it.category === cat);
      const section = categorySection(cat, items, idx);
      body += section.html;
      idx = section.nextIdx;
    }
  }

  // Five blank rows for hand-written changes after the sheet is printed
  const manualRows = Array.from({ length: 5 })
    .map(
      () => `
    <tr class="manual">
      <td class="num"></td>
      <td class="check"></td>
      <td class="product"></td>
      <td class="qty"></td>
      <td class="unit"></td>
      <td class="note"></td>
      <td class="picked"><div class="write-space"></div><div class="unit-options">ק"ג &nbsp;·&nbsp; יחידה &nbsp;·&nbsp; מארז</div></td>
      <td class="picker-note"></td>
    </tr>`,
    )
    .join('');
  body += `
    <tr class="cat-row manual-head"><td colspan="8">✍️ תוספות בכתב יד · เพิ่มเติมด้วยลายมือ</td></tr>
    ${manualRows}`;

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
  .brand-wrap { display: flex; align-items: center; gap: 10px; }
  .brand-wrap img { width: 46px; height: 46px; }
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
  th .th-thai { display: block; font-size: 10px; font-weight: normal; color: #555; }
  td.num { width: 26px; text-align: center; color: #777; }
  td.check { width: 44px; }
  td.product .he { font-weight: bold; font-size: 14px; }
  td.product .translations { color: #555; font-size: 11px; margin-top: 2px; }
  td.qty { width: 56px; text-align: center; font-weight: bold; font-size: 14px; }
  td.unit { width: 60px; text-align: center; }
  td.note { width: 120px; color: #b00020; }
  td.picked { width: 96px; padding: 3px 4px; }
  td.picked .write-space { height: 20px; }
  td.picked .unit-options { font-size: 8.5px; color: #777; text-align: center; border-top: 1px dotted #bbb; padding-top: 2px; }
  td.picker-note { width: 100px; }
  tr.cat-row td { background: #2e7d32; color: #fff; font-weight: bold; font-size: 14px; padding: 4px 8px; }
  tr.cat-row .vat { font-weight: normal; font-size: 11px; opacity: 0.85; }
  tr.floor-row td { background: #3E6B9B; font-size: 15px; }
  tr.cat-row.manual-head td { background: #616161; }
  tr.manual td { height: 30px; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px; color: #fff; vertical-align: middle; }
  .badge.added { background: #d84315; }
  .badge.late { background: #6a1b9a; }
  footer { margin-top: 14px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #555; border-top: 1px solid #ccc; padding-top: 8px; }
  .powered { font-size: 11px; color: #2e7d32; font-weight: bold; }
</style>
</head>
<body>
  <header>
    <div class="brand-wrap">
      <img src="${logoDataUri()}" alt="logo">
      <div class="brand">פירות העמק<small>דף ליקוט · ใบเก็บสินค้า</small></div>
    </div>
    <div class="meta">
      <div>הזמנה: <b>${esc(order.id)}</b> (גרסה ${order.version})</div>
      <div>לקוח: <b>${esc(order.customerName)}</b>${order.locationDetail ? ` · ${esc(order.locationDetail)}` : ''}</div>
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
        <th>פריט<span class="th-thai">สินค้า</span></th>
        <th>כמות מהלקוח<span class="th-thai">จำนวนที่สั่ง</span></th>
        <th>יחידה<span class="th-thai">หน่วย</span></th>
        <th>הערת לקוח<span class="th-thai">หมายเหตุลูกค้า</span></th>
        <th>כמות שנלקטה<span class="th-thai">จำนวนที่เก็บจริง</span></th>
        <th>הערת מלקט<span class="th-thai">หมายเหตุผู้เก็บ</span></th>
      </tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>

  <footer>
    <div>סגירת שינויים: ${esc(cutoff)} · תוספות לאחר הסגירה יופיעו כתגובה בקבוצה · סה"כ ${order.items.length} פריטים</div>
    <div class="powered">Powered by Triple Digital Workforce</div>
  </footer>
</body>
</html>`;
}

module.exports = { buildPickingSheetHTML, CATEGORY_ORDER };
