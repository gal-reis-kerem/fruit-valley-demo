/* global api */
let inDashboard = false;
let currentView = 'table';
let lastConn = null;

// ---------- avatar factory (kibbutznik style: tembel hat + work shirt) ----------
function avatarSvg({ bg, skin, hair, style, beard, glasses, size = 54 }) {
  const parts = [];
  parts.push(`<circle cx="32" cy="32" r="32" fill="${bg}"/>`);
  if (style === 'braids') {
    for (const [x, sign] of [[17.2, -1], [46.8, 1]]) {
      parts.push(`<circle cx="${x}" cy="33.5" r="3.3" fill="${hair}"/><circle cx="${x + sign * -0.7}" cy="39.5" r="3" fill="${hair}"/><circle cx="${x + sign * -1.3}" cy="45" r="2.7" fill="${hair}"/>`);
    }
  }
  if (style === 'pony') {
    parts.push(`<circle cx="17.5" cy="34" r="3.4" fill="${hair}"/><circle cx="16.6" cy="40.5" r="3" fill="${hair}"/><circle cx="16" cy="46.5" r="2.7" fill="${hair}"/>`);
  }
  parts.push(`<path d="M12 64 C17 49 47 49 52 64 Z" fill="#3E6B9B"/>`);
  parts.push(`<path d="M26 55 L32 61 L38 55" stroke="#DDE8F5" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  parts.push(`<rect x="28.5" y="42" width="7" height="8" rx="3" fill="${skin}"/>`);
  parts.push(`<circle cx="32" cy="31" r="13" fill="${skin}"/>`);
  parts.push(`<path d="M20 26.7 Q32 21 44 26.7 L44 29.3 Q32 24 20 29.3 Z" fill="${hair}"/>`);
  if (style === 'short') {
    parts.push(`<rect x="19.2" y="29" width="2.6" height="6.5" rx="1.3" fill="${hair}"/><rect x="42.2" y="29" width="2.6" height="6.5" rx="1.3" fill="${hair}"/>`);
  }
  if (style === 'bun') {
    parts.push(`<circle cx="45" cy="17.5" r="4.6" fill="${hair}"/>`);
  }
  if (beard) {
    parts.push(`<path d="M22.5 34 Q23 45 32 45.5 Q41 45 41.5 34 Q40.5 42.5 32 43 Q23.5 42.5 22.5 34 Z" fill="${hair}" opacity=".85"/>`);
  }
  parts.push(`<path d="M19.5 24 C21.5 11.5 42.5 11.5 44.5 24 Z" fill="#F3ECD4"/>`);
  parts.push(`<path d="M17 24.4 Q32 29.5 47 24.4 Q32 21 17 24.4 Z" fill="#E7DDBC"/>`);
  parts.push(`<circle cx="27.5" cy="31" r="1.6" fill="#33241A"/><circle cx="36.5" cy="31" r="1.6" fill="#33241A"/>`);
  if (glasses) {
    parts.push(`<circle cx="27.5" cy="31" r="4" fill="none" stroke="#4A4A46" stroke-width="1.3"/><circle cx="36.5" cy="31" r="4" fill="none" stroke="#4A4A46" stroke-width="1.3"/><path d="M31.5 31 h1" stroke="#4A4A46" stroke-width="1.3"/>`);
  }
  parts.push(`<circle cx="24" cy="35" r="2" fill="#EFA987" opacity=".45"/><circle cx="40" cy="35" r="2" fill="#EFA987" opacity=".45"/>`);
  parts.push(`<path d="M27.5 ${beard ? 37.5 : 36.5} Q32 ${beard ? 40.8 : 40.5} 36.5 ${beard ? 37.5 : 36.5}" stroke="#A9663F" stroke-width="1.7" fill="none" stroke-linecap="round"/>`);
  return `<svg class="avatar-svg" style="width:${size}px;height:${size}px" viewBox="0 0 64 64">${parts.join('')}</svg>`;
}

const WORKERS = [
  {
    id: 'naama', name: 'נעמה', role: 'סידור הזמנות וקשרי לקוחות', active: true,
    avatar: { bg: '#DCEBDD', skin: '#F2C79A', hair: '#6E4523', style: 'braids' },
    intro: 'היי, אני נעמה, עובדת סידור ההזמנות וקשרי הלקוחות של פירות העמק. אני קוראת כל הודעת הזמנה בוואטסאפ, מבינה אותה גם כשהיא כתובה בשפה חופשית, מנקה ומסדרת אותה — ודואגת שכל לקוח יקבל אישור מיידי. חשוב לי שאף הזמנה לא תיפול בין הכיסאות.',
  },
  {
    id: 'yuval', name: 'יובל', role: 'הכנת מסמכים וקשר מלקטים', active: true,
    avatar: { bg: '#F6DFD3', skin: '#EDBA8B', hair: '#4A3320', style: 'short' },
    intro: 'היי, אני יובל, עובד הכנת המסמכים וקשר המלקטים של פירות העמק. אני הופך כל הזמנה לדף ליקוט מסודר בעברית, אנגלית ותאית, שולח אותו למלקטים, עוקב אחרי ההדפסה והליקוט ומוודא שכל משלוח מתועד בתמונות. חשוב לי שלמלקטים תמיד יהיה דף מדויק ועדכני ביד.',
  },
  {
    id: 'oren', name: 'אורן', role: 'קשרי ספקים', active: false,
    avatar: { bg: '#E4EDF6', skin: '#E8B98A', hair: '#3B2C1D', style: 'short', beard: true },
    intro: 'היי, אני אורן, עובד קשרי הספקים של Triple. כשאצטרף לצוות של פירות העמק — ארכז את הביקושים מכל ההזמנות, אזהה חוסרים, אכין הזמנות לספקים ואעקוב אחרי האספקות. חשוב לי שהמחסן תמיד יהיה מוכן ליום המחר.',
  },
  {
    id: 'adi', name: 'עדי', role: 'שכר וגבייה', active: false,
    avatar: { bg: '#F3E8F1', skin: '#F2C79A', hair: '#5C3A22', style: 'bun', glasses: true },
    intro: 'היי, אני עדי, עובדת השכר והגבייה של Triple. כשאצטרף לצוות של פירות העמק — אכין חשבוניות ותעודות משלוח מנתוני הליקוט, אעקוב אחרי תשלומים ואדאג שהגבייה תמיד תהיה מסודרת. חשוב לי שכל שקל יגיע למקום הנכון.',
  },
  {
    id: 'yoni', name: 'יוני', role: 'ניהול משלוחים', active: false,
    avatar: { bg: '#FDF1D7', skin: '#EDBA8B', hair: '#6E4523', style: 'short' },
    intro: 'היי, אני יוני, עובד ניהול המשלוחים של Triple. כשאצטרף לצוות של פירות העמק — אשבץ הזמנות לנהגים ולמסלולים, אכין רשימות העמסה ואעקוב אחרי כל מסירה עד הלקוח. חשוב לי שאף משלוח לא יאחר.',
  },
  {
    id: 'eden', name: 'עדן', role: 'מזכירה אישית', active: false,
    avatar: { bg: '#E8F1EA', skin: '#F2C79A', hair: '#7A4A21', style: 'pony' },
    intro: 'היי, אני עדן, המזכירה האישית של Triple. כשאצטרף לצוות של פירות העמק — אתזכר, אסכם את היום, אענה על שאלות ואוודא שכלום לא נשכח. חשוב לי שיהיה לכם ראש שקט.',
  },
];

// ---------- navigation ----------
function go(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('visible'));
  document.getElementById(id).classList.add('visible');
  const order = ['s1', 's2', 's3', 's4', 's5w'];
  const idx = order.indexOf(id);
  document.querySelectorAll('.stepbar .step').forEach((b) => {
    const bIdx = order.indexOf(b.dataset.s);
    b.classList.toggle('active', b.dataset.s === id);
    b.classList.toggle('done', idx >= 0 && bIdx >= 0 && bIdx < idx);
  });
  document.getElementById('stepbar').style.display = idx >= 0 ? 'flex' : 'none';
  inDashboard = id === 'dash';
  if (lastConn) applyConn(lastConn);
}

function goSelect() {
  renderWorkerGrid();
  go('select');
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

async function savePortalAndNext() {
  const btn = document.getElementById('portal-next');
  const err = document.getElementById('portal-err');
  btn.disabled = true;
  err.textContent = '';
  const res = await api.savePortal(document.getElementById('portal-url').value);
  btn.disabled = false;
  if (!res.ok) {
    err.style.color = '#C63B2F';
    err.textContent = `שימו לב: הפורטל לא הגיב (${res.error}) — אפשר להמשיך ולבדוק אחר כך`;
    setTimeout(() => go('s5w'), 1600);
  } else {
    go('s5w');
  }
  await api.finishSetup();
}

// ---------- worker selection ----------
function renderWorkerGrid() {
  const grid = document.getElementById('worker-grid');
  grid.innerHTML = '';
  for (const w of WORKERS) {
    const card = document.createElement('div');
    card.className = 'wcard ' + (w.active ? 'active' : 'locked');
    card.innerHTML = `
      ${avatarSvg({ ...w.avatar, size: 84 })}
      <b>${w.name}</b>
      <span class="role">${w.role}</span>
      <span class="tag">${w.active ? 'פעיל אצלכם' : 'בקרוב'}</span>`;
    const info = document.createElement('button');
    info.className = 'info-btn';
    info.textContent = 'i';
    info.onclick = (e) => {
      e.stopPropagation();
      document.getElementById('info-avatar').innerHTML = avatarSvg({ ...w.avatar, size: 84 });
      document.getElementById('info-name').textContent = `${w.name} · ${w.role}`;
      document.getElementById('info-text').textContent = w.intro;
      document.getElementById('info-modal').classList.add('visible');
    };
    card.appendChild(info);
    grid.appendChild(card);
  }
}

// ---------- connections (whatsapp / crm / portal) ----------
const WA_LABEL = {
  connected: 'וואטסאפ', starting: 'וואטסאפ: מתחבר…', qr: 'וואטסאפ: סרקו קוד',
  disconnected: 'וואטסאפ: מנותק', stopped: 'וואטסאפ: כבוי', error: 'וואטסאפ: שגיאה',
};
function chip(label, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'chip ' + cls;
  b.innerHTML = `<span class="led"></span>${label}`;
  if (onclick && cls === 'down') b.onclick = onclick;
  else b.disabled = true;
  b.style.pointerEvents = cls === 'down' ? 'auto' : 'none';
  return b;
}

function applyConn(conn) {
  lastConn = conn;
  const wrap = document.getElementById('conns');
  wrap.innerHTML = '';

  const wa = conn.whatsapp.state;
  const waDown = ['disconnected', 'stopped', 'error', 'qr'].includes(wa);
  wrap.appendChild(chip(
    WA_LABEL[wa] || wa,
    wa === 'connected' ? 'ok' : wa === 'starting' ? 'warn' : 'down',
    () => {
      if (wa === 'qr') document.getElementById('repair-modal').classList.add('visible');
      else api.reconnectWhatsapp();
    },
  ));

  const crm = conn.crm;
  const crmDown = crm.configured && crm.ok === false;
  wrap.appendChild(chip(
    !crm.configured ? 'CRM: לא חובר' : crmDown ? 'CRM: אין גישה' : 'CRM לקוחות',
    !crm.configured ? '' : crmDown ? 'down' : 'ok',
    () => api.retryCrm(),
  ));

  const portal = conn.portal;
  const portalDown = portal.configured && portal.ok === false;
  wrap.appendChild(chip(
    !portal.configured ? 'פורטל: לא חובר' : portalDown ? 'פורטל: אין גישה' : 'פורטל הזמנות',
    !portal.configured ? '' : portalDown ? 'down' : 'ok',
    () => api.retryPortal(),
  ));

  // degraded page when a configured connection is down
  const degraded = waDown || crmDown || portalDown;
  document.getElementById('dash').classList.toggle('degraded', inDashboard && degraded);
  document.getElementById('repair-modal').classList.toggle(
    'visible',
    inDashboard && wa === 'qr' && document.getElementById('repair-modal').classList.contains('visible'),
  );
  if (!(inDashboard && wa === 'qr')) document.getElementById('repair-modal').classList.remove('visible');
}

// ---------- QR ----------
function renderQr(dataUrl) {
  for (const box of [document.getElementById('qr-box'), document.getElementById('repair-qr')]) {
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

// ---------- customers: table + kanban + date ----------
const STAGES = [
  { key: 'none', title: 'טרם נשלחה הזמנה', badge: 'st-none' },
  { key: 'received', title: 'הזמנה התקבלה', badge: 'st-received' },
  { key: 'picking', title: 'הודפסה ובליקוט', badge: 'st-picking' },
  { key: 'picked', title: 'לוקטה', badge: 'st-picked' },
  { key: 'invoice', title: 'חשבונית ותעודת משלוח', locked: true },
  { key: 'shipped', title: 'משלוח יצא', locked: true },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

function selectedDate() {
  return document.getElementById('date-pick').value;
}

function setView(view) {
  currentView = view;
  document.getElementById('vt-table').classList.toggle('on', view === 'table');
  document.getElementById('vt-kanban').classList.toggle('on', view === 'kanban');
  document.getElementById('cust-table').style.display = view === 'table' ? 'table' : 'none';
  document.getElementById('kanban').classList.toggle('visible', view === 'kanban');
}

function pdfLinkEl(r) {
  const link = document.createElement('span');
  link.className = 'pdf-link';
  link.textContent = 'פתיחת ה-PDF האחרון';
  link.onclick = () => api.openPath(r.lastPdf);
  return link;
}

async function refreshCustomers() {
  try {
    const rows = await api.getCustomers(selectedDate());
    let ordered = 0;

    // table
    const body = document.getElementById('cust-body');
    body.innerHTML = '';
    for (const r of rows) {
      if (r.stage !== 'none') ordered += 1;
      const stage = STAGE_BY_KEY[r.stage];
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const b = document.createElement('b');
      b.textContent = r.name;
      name.appendChild(b);
      const status = document.createElement('td');
      status.innerHTML = `<span class="badge-status ${stage.badge}"><span class="d"></span>${stage.title}</span>`;
      const last = document.createElement('td');
      last.textContent = r.lastOrderId ? `${r.lastOrderId} · גרסה ${r.lastVersion}` : '—';
      if (!r.lastOrderId) last.className = 'muted';
      const pdf = document.createElement('td');
      if (r.lastPdf) pdf.appendChild(pdfLinkEl(r));
      else {
        pdf.textContent = '—';
        pdf.className = 'muted';
      }
      tr.append(name, status, last, pdf);
      body.appendChild(tr);
    }

    // kanban
    const kb = document.getElementById('kanban');
    kb.innerHTML = '';
    for (const s of STAGES) {
      const col = document.createElement('div');
      col.className = 'kcol' + (s.locked ? ' locked' : '');
      const h = document.createElement('h4');
      h.textContent = s.title;
      col.appendChild(h);
      if (s.locked) {
        const note = document.createElement('div');
        note.className = 'locked-note';
        note.textContent = 'המודול ייפתח בקרוב';
        col.appendChild(note);
      } else {
        for (const r of rows.filter((x) => x.stage === s.key)) {
          const card = document.createElement('div');
          card.className = 'kcard';
          const b = document.createElement('b');
          b.textContent = r.name;
          card.appendChild(b);
          if (r.lastOrderId) {
            const kid = document.createElement('div');
            kid.className = 'kid';
            kid.textContent = `${r.lastOrderId} · V${r.lastVersion}`;
            card.appendChild(kid);
          }
          if (r.lastPdf) card.appendChild(pdfLinkEl(r));
          col.appendChild(card);
        }
      }
      kb.appendChild(col);
    }

    document.getElementById('progress-text').textContent = `${ordered} מתוך ${rows.length} שלחו הזמנה`;
    document.getElementById('progress-bar').style.width = rows.length ? `${(ordered / rows.length) * 100}%` : '0%';
  } catch (e) { /* engine still booting */ }
}

function enterDashboard(saveSelection) {
  if (saveSelection) api.saveWorkers(WORKERS.filter((w) => w.active).map((w) => w.id));
  go('dash');
  refreshCustomers();
}

// ---------- boot ----------
(async function boot() {
  document.getElementById('ava-naama').innerHTML = avatarSvg(WORKERS[0].avatar);
  document.getElementById('ava-yuval').innerHTML = avatarSvg(WORKERS[1].avatar);
  const dp = document.getElementById('date-pick');
  dp.value = new Date().toLocaleDateString('en-CA');
  dp.onchange = refreshCustomers;

  const { settings, conn, qrDataUrl } = await api.getBoot();
  if (settings.businessPhone) document.getElementById('biz-phone').value = settings.businessPhone;
  if (settings.sheetUrl) document.getElementById('sheet-url').value = settings.sheetUrl;
  if (settings.portalUrl) document.getElementById('portal-url').value = settings.portalUrl;
  if (qrDataUrl) renderQr(qrDataUrl);

  api.onQr(({ dataUrl }) => renderQr(dataUrl));
  api.onConn((c) => {
    applyConn(c);
    if (c.whatsapp.state === 'connected') renderConnectedQrBox();
  });
  api.onWorker(workerLine);
  api.onCrm(() => refreshCustomers());
  setInterval(() => api.getConn().then(applyConn), 10000);
  setInterval(refreshCustomers, 10000);

  applyConn(conn);
  if (settings.setupDone && settings.workers) enterDashboard(false);
  else if (settings.setupDone) goSelect();
  else go('s1');
})();
