const fs = require('fs');
const path = require('path');
const { config } = require('../config');

// Simple JSON-file store. One file for the order index; per-order folder for
// PDFs and photo evidence. Every mutation is appended to the order's history
// (FR-14: action history with time, input and result).

const DB_PATH = path.join(config.dataDir, 'orders.json');

function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
}

function loadDB() {
  ensureDirs();
  if (!fs.existsSync(DB_PATH)) return { orders: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  ensureDirs();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function orderDir(order) {
  const dir = path.join(config.outputDir, order.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Order id: KC-YYYYMMDD-NN, numbered per delivery date
function nextOrderId(db, deliveryDate) {
  const datePart = deliveryDate.replace(/-/g, '');
  const count = db.orders.filter((o) => o.deliveryDate === deliveryDate).length;
  return `KC-${datePart}-${String(count + 1).padStart(2, '0')}`;
}

function addHistory(order, action, detail) {
  order.history.push({
    ts: new Date().toISOString(),
    action,
    detail: detail || null,
  });
  order.updatedAt = new Date().toISOString();
}

/**
 * Statuses:
 *   received        -> order parsed, ack sent
 *   sent_to_group   -> picking sheet PDF sent to the picking group
 *   picking         -> emoji reaction detected (sheet printed, picking started)
 *   awaiting_photos -> photo request sent
 *   documented      -> both photos received
 *   cancelled
 */
function createOrder(db, { deliveryDate, customerName, customerNote, items, rawMessage }) {
  const order = {
    id: nextOrderId(db, deliveryDate),
    customerName,
    deliveryDate,
    customerNote: customerNote || null,
    items,
    status: 'received',
    version: 1,
    rawMessages: [rawMessage],
    pdfPath: null,
    groupMsgId: null,        // WhatsApp id of the PDF message in the picking group
    photoRequestMsgId: null, // WhatsApp id of the photo request message
    photos: [],
    reaction: null,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  addHistory(order, 'order_created', `${items.length} פריטים, אספקה ${deliveryDate}`);
  db.orders.push(order);
  return order;
}

// The order that additions/changes/photos should attach to: the most recent
// order of this customer that is not yet documented/cancelled.
function findOpenOrder(db, customerName) {
  const open = db.orders
    .filter((o) => o.customerName === customerName && !['documented', 'cancelled'].includes(o.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return open[0] || null;
}

function findByGroupMsgId(db, msgId) {
  return db.orders.find((o) => o.groupMsgId === msgId) || null;
}

function findAwaitingPhotos(db) {
  const waiting = db.orders
    .filter((o) => o.status === 'awaiting_photos')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return waiting[0] || null;
}

module.exports = {
  loadDB,
  saveDB,
  createOrder,
  findOpenOrder,
  findByGroupMsgId,
  findAwaitingPhotos,
  addHistory,
  orderDir,
};
