/* global api */
let inDashboard = false;

function go(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('visible'));
  document.getElementById(id).classList.add('visible');
  const order = ['s1', 's2', 's3', 's4'];
  const idx = order.indexOf(id);
  document.querySelectorAll('.stepbar .step').forEach((b) => {
    const bIdx = order.indexOf(b.dataset.s);
    b.classList.toggle('active', b.dataset.s === id);
    b.classList.toggle('done', idx >= 0 && bIdx >= 0 && bIdx < idx);
  });
  document.getElementById('stepbar').style.display = id === 'dash' ? 'none' : 'flex';
  inDashboard = id === 'dash';
}

// ---------- wizard ----------
async function savePhoneAndNext() {
  await api.savePhone(document.getElementById('biz-phone').value.trim());
  go('s3');
}

async function saveSheetAndNext() {
  const btn = document.getElementById('sheet-next');
  const err = document.getElementById('sheet-err');
  btn.disabled = true;
  err.textContent = '';
  const res = await api.saveSheet(document.getElementById('sheet-url').value);
  btn.disabled = false;
  if (res.ok) {
    if (res.companies) err.style.color = '#1E6B34';
    err.textContent = res.companies ? `חוברו ${res.companies.length} לקוחות: ${res.companies.join(', ')}` : '';
    setTimeout(() => go('s4'), res.companies ? 900 : 0);
  } else {
    err.style.color = '#C63B2F';
    err.textContent = res.error;
  }
}

async function finishSetup() {
  await api.finishSetup();
  enterDashboard();
}

// ---------- QR ----------
function renderQr(dataUrl) {
  const boxes = [document.getElementById('qr-box'), document.getElementById('repair-qr')];
  for (const box of boxes) {
    if (!box) continue;
    box.classList.remove('connected');
    box.innerHTML = dataUrl ? `<img src="${dataUrl}">` : '<div class="waiting">ממתין לקוד…</div>';
  }
}

function renderConnectedQrBox() {
  const box = document.getElementById('qr-box');
  box.classList.add('connected');
  box.innerHTML = '<div class="ok-mark">✓</div>';
}

// ---------- status ----------
const STATUS = {
  connected: ['מחובר ופעיל', ''],
  starting: ['מתחבר…', 'wait'],
  qr: ['ממתין לסריקת קוד', 'wait'],
  disconnected: ['החיבור נותק — מתחבר מחדש', 'off'],
  stopped: ['מושבת', 'off'],
  error: ['שגיאה — בדקו את ההגדרות', 'off'],
};
function renderStatus(stateName) {
  const [text, cls] = STATUS[stateName] || [stateName, 'wait'];
  const pill = document.getElementById('status-pill');
  pill.className = 'status-pill' + (cls ? ' ' + cls : '');
  document.getElementById('status-text').textContent = text;
  if (stateName === 'connected') renderConnectedQrBox();
  const modal = document.getElementById('repair-modal');
  modal.classList.toggle('visible', inDashboard && stateName === 'qr');
}

// ---------- worker terminals ----------
const busyTimers = { naama: null, yuval: null };
function workerLine({ worker, text, newJob, at }) {
  const term = document.getElementById(`${worker}-term`);
  if (!term) return;
  const time = new Date(at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const div = document.createElement('div');
  div.className = 'line' + (newJob ? ' hl' : '');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = time;
  div.appendChild(t);
  div.appendChild(document.createTextNode(text));
  term.appendChild(div);
  while (term.children.length > 200) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;

  const busy = document.getElementById(`${worker}-busy`);
  busy.textContent = worker === 'naama' ? 'מטפלת בהזמנה…' : 'מכין מסמכים…';
  clearTimeout(busyTimers[worker]);
  busyTimers[worker] = setTimeout(() => {
    busy.textContent = worker === 'naama' ? 'זמינה' : 'זמין';
  }, 8000);
}

// ---------- stats + customers ----------
async function refreshStats() {
  try {
    const s = await api.getStats();
    document.getElementById('naama-count').textContent = s.naama;
    document.getElementById('yuval-count').textContent = s.yuval;
  } catch (e) { /* engine still booting */ }
}

async function refreshCustomers() {
  try {
    const rows = await api.getCustomers();
    const body = document.getElementById('cust-body');
    body.innerHTML = '';
    let ordered = 0;
    for (const r of rows) {
      if (r.orderedToday) ordered += 1;
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      const b = document.createElement('b');
      b.textContent = r.name;
      name.appendChild(b);

      const status = document.createElement('td');
      status.innerHTML = r.orderedToday
        ? '<span class="badge-status ordered"><span class="d"></span>הזמינה היום</span>'
        : '<span class="badge-status not-yet"><span class="d"></span>טרם הזמינה</span>';

      const last = document.createElement('td');
      last.textContent = r.lastOrderId ? `${r.lastOrderId} · גרסה ${r.lastVersion}` : '—';
      if (!r.lastOrderId) last.className = 'muted';

      const pdf = document.createElement('td');
      if (r.lastPdf) {
        const link = document.createElement('span');
        link.className = 'pdf-link';
        link.textContent = 'פתיחת ה-PDF האחרון';
        link.onclick = () => api.openPath(r.lastPdf);
        pdf.appendChild(link);
      } else {
        pdf.textContent = '—';
        pdf.className = 'muted';
      }

      tr.append(name, status, last, pdf);
      body.appendChild(tr);
    }
    document.getElementById('progress-text').textContent = `${ordered} מתוך ${rows.length} השלימו הזמנה`;
    document.getElementById('progress-bar').style.width = rows.length ? `${(ordered / rows.length) * 100}%` : '0%';
  } catch (e) { /* engine still booting */ }
}

function enterDashboard() {
  go('dash');
  refreshStats();
  refreshCustomers();
}

// ---------- boot ----------
(async function boot() {
  const { settings, state, qrDataUrl } = await api.getBoot();
  if (settings.businessPhone) document.getElementById('biz-phone').value = settings.businessPhone;
  if (settings.sheetUrl) document.getElementById('sheet-url').value = settings.sheetUrl;
  if (qrDataUrl) renderQr(qrDataUrl);
  renderStatus(state);

  api.onQr(({ dataUrl }) => renderQr(dataUrl));
  api.onStatus(({ state: s }) => renderStatus(s));
  api.onWorker(workerLine);
  api.onCrm(() => refreshCustomers());
  setInterval(refreshStats, 5000);
  setInterval(refreshCustomers, 10000);

  if (settings.setupDone) enterDashboard();
  else go('s1');
})();
