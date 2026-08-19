// Order statistics derived from the orders DB (data/orders.json is the
// organized per-customer order archive; nothing extra to maintain).
const store = require('./orders/store');

const IL = { timeZone: 'Asia/Jerusalem' };

function hourOf(ts) {
  const d = new Date(ts);
  return Number(d.toLocaleString('en-US', { ...IL, hour: 'numeric', hour12: false })) +
    Number(d.toLocaleString('en-US', { ...IL, minute: 'numeric' })) / 60;
}

function fmtHour(h) {
  if (h == null) return null;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function statsFor(orders) {
  const n = orders.length;
  const postPrint = orders.reduce((s, o) => s + (o.postPrintChanges ? o.postPrintChanges.length : 0), 0);
  const changes = orders.reduce(
    (s, o) => s + (o.history || []).filter((h) => ['addition_received', 'order_updated'].includes(h.action)).length,
    0,
  );
  // The average receive-hour is meaningful only for VARIABLE orders - fixed
  // orders are issued by OUR schedule (config.fixedIssueHour), so their hour
  // says nothing about the customer.
  const variable = orders.filter((o) => o.sourceChannel !== 'fixed_schedule');
  return {
    orders: n,
    avgItems: n ? Math.round(avg(orders.map((o) => o.items.length)) * 10) / 10 : null,
    avgOrderHour: fmtHour(avg(variable.map((o) => hourOf(o.createdAt)))),
    totalChanges: changes,
    postPrintChanges: postPrint,
    avgVersions: n ? Math.round(avg(orders.map((o) => o.version)) * 10) / 10 : null,
  };
}

// period: today | week | month | year | all
function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'week':
      return now.getTime() - 7 * 24 * 3600 * 1000;
    case 'month':
      return now.getTime() - 30 * 24 * 3600 * 1000;
    case 'year':
      return now.getTime() - 365 * 24 * 3600 * 1000;
    default:
      return 0;
  }
}

function fullStats(companies, period = 'all') {
  const db = store.loadDB();
  const start = periodStart(period);
  const real = db.orders.filter(
    (o) => o.status !== 'archived' && new Date(o.createdAt).getTime() >= start,
  );
  return {
    totals: statsFor(real),
    perCustomer: companies.map((c) => ({
      name: c.name,
      ...statsFor(real.filter((o) => o.customerName === c.name)),
    })),
  };
}

module.exports = { fullStats };
