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

// One flat folder per customer: output/<Customer Name>/, PDFs and photos
// side by side (no per-order subfolders).
function customerDir(order) {
  const dir = path.join(config.outputDir, order.customerNameEn);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// File-name base: "Kerem-Capital[-<detail>]-<ddmmyyyy>[-<seq>]-V<version>"
// <detail> is an optional per-order qualifier (floor/building, e.g. "f2").
function orderFileBase(order) {
  const [y, m, d] = order.deliveryDate.split('-');
  const parts = [order.customerNameEn.replace(/\s+/g, '-')];
  if (order.locationDetail) parts.push(String(order.locationDetail).replace(/\s+/g, '-'));
  parts.push(`${d}${m}${y}`);
  const seqSuffix = order.id && order.id.match(/-(\d+)$/u);
  if (seqSuffix && order.id.endsWith(`-${seqSuffix[1]}`) && seqSuffix[1].length <= 2) parts.push(seqSuffix[1]);
  parts.push(`V${order.version}`);
  return parts.join('-');
}

// Unified order number: <initials>-<ddmmyyyy>, e.g. KC-20072026. One order per
// customer per delivery date (the daily "board") — the same number appears in
// the customer ack, the PDF, the group caption and the photo request. The
// PDF file version (Vx) advances with each sheet update. In the rare case a
// second separate order is opened for a date whose board was already closed,
// a -2/-3 suffix is added.
function nextOrderId(db, deliveryDate, initials) {
  const [y, m, d] = deliveryDate.split('-');
  const base = `${initials}-${d}${m}${y}`;
  let id = base;
  let seq = 1;
  while (db.orders.some((o) => o.id === id)) {
    seq += 1;
    id = `${base}-${seq}`;
  }
  return id;
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
function createOrder(db, { deliveryDate, customerName, customerNameEn, initials, customerNote, locationDetail, items, rawMessage }) {
  const order = {
    id: nextOrderId(db, deliveryDate, initials),
    customerName,
    customerNameEn,
    locationDetail: locationDetail || null,
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

const CLOSED_STATUSES = ['documented', 'cancelled', 'archived'];

function todayIsrael() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// The order that additions/changes/photos should attach to: the most recent
// order of this customer that is still open and not stale (delivery today or
// later — old test boards must not swallow new messages).
function findOpenOrder(db, customerName) {
  const open = db.orders
    .filter(
      (o) =>
        o.customerName === customerName &&
        !CLOSED_STATUSES.includes(o.status) &&
        o.deliveryDate >= todayIsrael(),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return open[0] || null;
}

// The daily board: the open order of this customer for a specific delivery
// date. A second "new order" message for the same date merges into it.
function findOpenOrderForDate(db, customerName, deliveryDate) {
  return (
    db.orders.find(
      (o) =>
        o.customerName === customerName &&
        o.deliveryDate === deliveryDate &&
        !CLOSED_STATUSES.includes(o.status),
    ) || null
  );
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

// Daily stats for the dashboard: how many orders Naama handled today and
// how many sheets Yuval produced today (by history timestamps, Israel time).
function todayStats(db) {
  const today = todayIsrael();
  const isToday = (ts) =>
    new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) === today;
  const naamaActions = ['order_created', 'addition_received', 'order_updated', 'order_cancelled'];
  const yuvalActions = ['pdf_sent_to_group', 'pdf_regenerated'];
  const naamaOrders = new Set();
  let sheets = 0;
  for (const o of db.orders) {
    for (const h of o.history || []) {
      if (!isToday(h.ts)) continue;
      if (naamaActions.includes(h.action)) naamaOrders.add(o.id);
      if (yuvalActions.includes(h.action)) sheets += 1;
    }
  }
  return { naama: naamaOrders.size, yuval: sheets };
}

// Per-company overview for the dashboard customers table.
function customersOverview(db, companies) {
  const today = todayIsrael();
  const isToday = (ts) =>
    new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) === today;
  return companies.map((c) => {
    const orders = db.orders
      .filter((o) => o.customerName === c.name)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const todayOrder = orders.find(
      (o) => (o.history || []).some((h) => isToday(h.ts)) && !['cancelled', 'archived'].includes(o.status),
    );
    const last = orders.find((o) => o.status !== 'archived');
    return {
      name: c.name,
      orderedToday: Boolean(todayOrder),
      lastOrderId: last ? last.id : null,
      lastVersion: last ? last.version : null,
      lastPdf: last && last.pdfPath ? last.pdfPath : null,
    };
  });
}

module.exports = {
  todayStats,
  customersOverview,
  loadDB,
  saveDB,
  createOrder,
  findOpenOrder,
  findOpenOrderForDate,
  findByGroupMsgId,
  findAwaitingPhotos,
  addHistory,
  customerDir,
  orderFileBase,
};
