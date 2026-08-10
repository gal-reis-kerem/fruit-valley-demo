// Load or update a fixed base order for an office.
// Usage:
//   node scripts/set-base-order.js "סולאראדג׳ מודיעין" base-items.json "הערה"
// base-items.json is either an array of items (same base every day) or
// { perDay: { "0": [...], ..., "6": [...] } } (0 = Sunday).
const fs = require('fs');
const baseOrders = require('../src/orders/baseOrders');

const [officeKey, file, note] = process.argv.slice(2);
if (!officeKey || !file) {
  console.log('שימוש: node scripts/set-base-order.js "<לקוח משלם + משרד>" <items.json> [הערה]');
  console.log('קיימות במאגר:', JSON.stringify(baseOrders.listBases(), null, 2));
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const payload = Array.isArray(data) ? { items: data } : data;
const id = baseOrders.setBase(officeKey, { ...payload, note: note || '' });
console.log(`הזמנת הבסיס של "${officeKey}" נשמרה כגרסה ${id}`);
