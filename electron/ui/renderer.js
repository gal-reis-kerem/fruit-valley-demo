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
  const order = ['s1', 's2', 's3', 's3b', 's4', 's5w'];
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
    err.textContent = res.companies ? `חוברו ${res.companies.length} לקוחות: ${res.companies.slice(0, 6).join(', ')}${res.companies.length > 6 ? '…' : ''}` : '';
    // prefill the email step with an address from the CRM
    api.crmEmails().then((emails) => {
      const input = document.getElementById('email-user');
      if (emails.length && !input.value) input.value = emails[0];
    }).catch(() => {});
    setTimeout(() => go('s3b'), res.companies ? 900 : 0);
  } else {
    err.style.color = '#C63B2F';
    err.textContent = res.error;
  }
}

async function saveEmailAndNext() {
  const btn = document.getElementById('email-next');
  const err = document.getElementById('email-err');
  const user = document.getElementById('email-user').value.trim();
  const password = document.getElementById('email-pass').value.trim();
  err.style.color = '#C63B2F';
  if (!user || !password) {
    err.textContent = 'נדרשות כתובת מייל וסיסמת אפליקציה (או "דלג בינתיים")';
    return;
  }
  btn.disabled = true;
  err.textContent = 'בודק את החיבור…';
  err.style.color = '#6b7361';
  const res = await api.saveEmail({ user, password });
  btn.disabled = false;
  if (res.ok) {
    err.style.color = '#1E6B34';
    err.textContent = 'תיבת המייל חוברה ✓';
    setTimeout(() => go('s4'), 900);
  } else {
    err.style.color = '#C63B2F';
    err.textContent = res.error || 'החיבור נכשל';
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
function chip(label, cls, kind) {
  const b = document.createElement('button');
  b.className = 'chip ' + cls;
  b.innerHTML = `<span class="led"></span>${label}`;
  if (cls === 'down') b.onclick = () => openRepair(kind);
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
    'whatsapp',
  ));

  const crm = conn.crm;
  const crmDown = crm.configured && crm.ok === false;
  wrap.appendChild(chip(
    !crm.configured ? 'CRM: לא חובר' : crmDown ? 'CRM: אין גישה' : 'CRM לקוחות',
    !crm.configured ? '' : crmDown ? 'down' : 'ok',
    'crm',
  ));

  const portal = conn.portal;
  const portalDown = portal.configured && portal.ok === false;
  wrap.appendChild(chip(
    !portal.configured ? 'פורטל: לא חובר' : portalDown ? 'פורטל: אין גישה' : 'פורטל הזמנות',
    !portal.configured ? '' : portalDown ? 'down' : 'ok',
    'portal',
  ));

  const email = conn.email || { configured: false };
  const emailDown = email.configured && email.ok === false;
  const emailChip = chip(
    !email.configured ? 'מייל: לא חובר' : emailDown ? 'מייל: אין גישה' : 'מייל הזמנות',
    !email.configured ? '' : emailDown ? 'down' : 'ok',
    'email',
  );
  if (!email.configured) {
    // an unconfigured inbox is a click away from the setup screen
    emailChip.disabled = false;
    emailChip.style.pointerEvents = 'auto';
    emailChip.onclick = () => go('s3b');
  }
  wrap.appendChild(emailChip);

  // degraded page when a configured connection is down
  const degraded = waDown || crmDown || portalDown || emailDown;
  document.getElementById('dash').classList.toggle('degraded', inDashboard && degraded);

  // live-refresh the repair dialog; auto-close when the connection recovers
  if (fixKind) {
    const fixed =
      (fixKind === 'whatsapp' && wa === 'connected') ||
      (fixKind === 'crm' && crm.configured && crm.ok) ||
      (fixKind === 'portal' && portal.configured && portal.ok) ||
      (fixKind === 'email' && email.configured && email.ok);
    if (fixed) {
      document.getElementById('fix-status').textContent = 'החיבור חזר לפעול ✓';
      document.getElementById('fix-error').textContent = '';
      setTimeout(closeFix, 1400);
    } else {
      renderFix();
    }
  }
}

// ---------- repair dialog ----------
let fixKind = null;

function fixAction(label, fn, primary) {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? '' : ' yellow');
  b.style.cssText = 'font-size:14px;padding:9px 22px';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function openRepair(kind) {
  fixKind = kind;
  renderFix();
  document.getElementById('fix-modal').classList.add('visible');
}

function closeFix() {
  fixKind = null;
  document.getElementById('fix-modal').classList.remove('visible');
}

function renderFix() {
  if (!fixKind || !lastConn) return;
  const titleEl = document.getElementById('fix-title');
  const statusEl = document.getElementById('fix-status');
  const errorEl = document.getElementById('fix-error');
  const tipsEl = document.getElementById('fix-tips');
  const actionsEl = document.getElementById('fix-actions');
  const qrEl = document.getElementById('fix-qr');
  tipsEl.innerHTML = '';
  actionsEl.innerHTML = '';
  qrEl.style.display = 'none';

  const addTips = (tips) => {
    for (const t of tips) {
      const li = document.createElement('li');
      li.textContent = t;
      tipsEl.appendChild(li);
    }
  };

  if (fixKind === 'whatsapp') {
    const wa = lastConn.whatsapp;
    titleEl.textContent = 'תיקון חיבור הוואטסאפ';
    statusEl.textContent = WA_LABEL[wa.state] || wa.state;
    errorEl.textContent = wa.error || '';
    if (wa.state === 'qr') {
      qrEl.style.display = 'flex';
      addTips([
        'החיבור לטלפון של העסק פג — נדרשת סריקה מחדש.',
        'בטלפון של העסק: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרקו את הקוד שמוצג כאן.',
      ]);
    } else {
      addTips([
        'ודאו שלמחשב הזה יש חיבור אינטרנט.',
        'ודאו שהטלפון של העסק דלוק, מחובר לרשת, ושוואטסאפ נפתח בו לאחרונה.',
        'ודאו שהתוכנה לא פתוחה פעמיים במקביל.',
        ...(wa.error && wa.error.includes('קבוצת הליקוט')
          ? ['שם קבוצת הליקוט לא נמצא בחשבון — בדקו את שם הקבוצה בהגדרות.']
          : []),
        'לחצו "התחברות מחדש" — התהליך לוקח עד חצי דקה.',
      ]);
      actionsEl.appendChild(fixAction('התחברות מחדש', () => {
        statusEl.textContent = 'מתחבר מחדש… (עד חצי דקה)';
        errorEl.textContent = '';
        api.reconnectWhatsapp();
      }, true));
    }
  }

  if (fixKind === 'crm') {
    const crm = lastConn.crm;
    titleEl.textContent = 'תיקון חיבור טבלת הלקוחות';
    statusEl.textContent = !crm.configured ? 'לא חובר גיליון' : crm.ok === false ? 'אין גישה לגיליון' : 'תקין';
    errorEl.textContent = crm.error || '';
    addTips([
      'ודאו שהגיליון משותף: שיתוף ← "כל מי שיש לו את הקישור" ← צפייה.',
      'ודאו שהקישור שהוזן הוא לגיליון הנכון.',
      'פתחו את הגיליון בדפדפן וודאו שהוא נטען.',
    ]);
    actionsEl.appendChild(fixAction('ניסיון חוזר', async () => {
      statusEl.textContent = 'בודק גישה לגיליון…';
      const res = await api.retryCrm();
      if (!res.ok) {
        statusEl.textContent = 'עדיין אין גישה';
        errorEl.textContent = res.error || '';
      }
    }, true));
    actionsEl.appendChild(fixAction('פתיחת הגיליון', () => api.openSheet(), false));
  }

  if (fixKind === 'portal') {
    const portal = lastConn.portal;
    titleEl.textContent = 'תיקון חיבור פורטל ההזמנות';
    statusEl.textContent = !portal.configured ? 'לא חובר פורטל' : portal.ok === false ? 'הפורטל לא מגיב' : 'תקין';
    errorEl.textContent = portal.error || '';
    addTips([
      'ייתכן שהאתר של הפורטל לא זמין כרגע — נסו לפתוח אותו בדפדפן.',
      'אם הכתובת השתנתה — עדכנו אותה בהגדרות.',
    ]);
    actionsEl.appendChild(fixAction('בדיקה חוזרת', () => {
      statusEl.textContent = 'בודק את הפורטל…';
      api.retryPortal();
    }, true));
    actionsEl.appendChild(fixAction('פתיחה בדפדפן', () => api.openPortal(), false));
  }

  if (fixKind === 'email') {
    const email = lastConn.email || {};
    titleEl.textContent = 'תיקון חיבור המייל';
    statusEl.textContent = !email.configured ? 'לא חוברה תיבת מייל' : email.ok === false ? 'אין גישה לתיבה' : 'תקין';
    errorEl.textContent = email.error || '';
    addTips([
      'ודאו שסיסמת האפליקציה (App Password) עדיין בתוקף — אפשר לחדש ב-myaccount.google.com ← אבטחה.',
      'אם שיניתם סיסמה לחשבון Google — סיסמאות האפליקציה מתבטלות וצריך ליצור חדשה.',
      'ודאו שיש חיבור אינטרנט תקין.',
    ]);
    actionsEl.appendChild(fixAction('בדיקה חוזרת', async () => {
      statusEl.textContent = 'בודק את תיבת המייל…';
      const res = await api.retryEmail();
      if (!res.ok) {
        statusEl.textContent = 'עדיין אין גישה';
        errorEl.textContent = res.error || '';
      }
    }, true));
  }
}

// ---------- QR ----------
function renderQr(dataUrl) {
  for (const box of [document.getElementById('qr-box'), document.getElementById('fix-qr')]) {
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

// picking-evidence photos, shown once the order is picked
function photoLinksEl(r) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-links';
  r.photos.forEach((p, i) => {
    const link = document.createElement('span');
    link.className = 'pdf-link';
    link.textContent = r.photos.length > 1 ? `תמונת ליקוט ${i + 1}` : 'תמונת הליקוט';
    link.onclick = (e) => {
      e.stopPropagation();
      api.openPath(p);
    };
    wrap.appendChild(link);
  });
  return wrap;
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
      const changes = document.createElement('td');
      if (r.postPrintChanges && r.postPrintChanges.length) {
        changes.className = 'changes-cell';
        changes.textContent = r.postPrintChanges.join(' | ');
      } else {
        changes.textContent = '—';
        changes.className = 'muted';
      }
      const pdf = document.createElement('td');
      if (r.lastPdf) pdf.appendChild(pdfLinkEl(r));
      if (r.photos && r.photos.length) pdf.appendChild(photoLinksEl(r));
      if (!r.lastPdf && !(r.photos && r.photos.length)) {
        pdf.textContent = '—';
        pdf.className = 'muted';
      }
      tr.append(name, status, last, changes, pdf);
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
          if (r.photos && r.photos.length) card.appendChild(photoLinksEl(r));
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

// ---------- worker chat ----------
const chatHistories = { naama: [], yuval: [] };
let chatWorkerId = null;

function chatBubble(kind, text) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = `bubble ${kind}`;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function openChat(workerId) {
  chatWorkerId = workerId;
  const w = WORKERS.find((x) => x.id === workerId);
  document.getElementById('chat-avatar').innerHTML = avatarSvg({ ...w.avatar, size: 40 });
  document.getElementById('chat-name').textContent = `${w.name} · ${w.role}`;
  const msgs = document.getElementById('chat-msgs');
  msgs.innerHTML = '';
  if (!chatHistories[workerId].length) {
    chatBubble('worker', `היי! כאן ${w.name}. אפשר לשאול אותי על העבודה שלי, להעיר, או לעדכן אותי בהנחיות חדשות.`);
  } else {
    for (const m of chatHistories[workerId]) chatBubble(m.role === 'user' ? 'me' : 'worker', m.content);
  }
  document.getElementById('chat-modal').classList.add('visible');
  document.getElementById('chat-text').focus();
}

async function sendChat() {
  const input = document.getElementById('chat-text');
  const text = input.value.trim();
  if (!text || !chatWorkerId) return;
  const w = WORKERS.find((x) => x.id === chatWorkerId);
  input.value = '';
  chatHistories[chatWorkerId].push({ role: 'user', content: text });
  chatBubble('me', text);
  const typing = chatBubble('worker', '…');
  document.getElementById('chat-send').disabled = true;
  const res = await api.workerChat({ id: w.id, name: w.name, role: w.role }, chatHistories[chatWorkerId]);
  document.getElementById('chat-send').disabled = false;
  typing.remove();
  chatHistories[chatWorkerId].push({ role: 'assistant', content: res.reply });
  chatBubble('worker', res.reply);
  if (res.action === 'add_rule' && res.rule_text) chatBubble('note', `נוסף לספר החוקים: ${res.rule_text}`);
  if (res.action === 'escalate') chatBubble('note', res.escalated ? 'נשלחה הודעה לצוות Triple בוואטסאפ' : 'יועבר לצוות Triple כשהחיבור יתאפשר');
}

async function openRules() {
  if (!chatWorkerId) return;
  const w = WORKERS.find((x) => x.id === chatWorkerId);
  const content = await api.getRules(chatWorkerId);
  document.getElementById('rules-title').textContent = `ספר החוקים של ${w.name}`;
  document.getElementById('rules-body').textContent = content || '(עדיין ריק)';
  document.getElementById('rules-modal').classList.add('visible');
}

// ---------- stats page ----------
let statsPeriod = 'today';

async function openStats() {
  const { totals, perCustomer } = await api.getStatsFull(statsPeriod);
  document.querySelectorAll('#stats-period button').forEach((b) => b.classList.toggle('on', b.dataset.p === statsPeriod));
  const cards = [
    [totals.orders, 'הזמנות סה"כ'],
    [totals.avgItems ?? '—', 'ממוצע פריטים להזמנה'],
    [totals.avgOrderHour ?? '—', 'שעת הזמנה ממוצעת'],
    [totals.postPrintChanges, 'שינויים אחרי הדפסה'],
  ];
  document.getElementById('stat-cards').innerHTML = cards
    .map(([v, l]) => `<div class="stat-card"><b>${v}</b><span>${l}</span></div>`)
    .join('');
  const body = document.getElementById('stats-body');
  body.innerHTML = '';
  for (const r of perCustomer) {
    const tr = document.createElement('tr');
    for (const val of [r.name, r.orders, r.avgItems ?? '—', r.avgOrderHour ?? '—', r.totalChanges, r.postPrintChanges, r.avgVersions ?? '—']) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  document.getElementById('stats-page').classList.add('visible');
}

// ---------- complaints page ----------
async function openComplaints() {
  const list = await api.getComplaints();
  const body = document.getElementById('complaints-body');
  body.innerHTML = '';
  document.getElementById('complaints-empty').style.display = list.length ? 'none' : 'block';
  for (const c of list) {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = new Date(c.ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = document.createElement('td');
    who.textContent = c.company || 'לא זוהה';
    const what = document.createElement('td');
    what.textContent = c.text;
    tr.append(when, who, what);
    body.appendChild(tr);
  }
  document.getElementById('complaints-page').classList.add('visible');
}

// ---------- end of day ----------
async function endDay() {
  document.getElementById('dayend-overlay').classList.add('visible');
  await api.endDay();
}

async function resumeDay() {
  const btn = document.getElementById('resume-btn');
  btn.disabled = true;
  btn.textContent = 'מתחבר… (עד חצי דקה)';
  await api.resumeDay();
}

// ---------- boot ----------
(async function boot() {
  document.getElementById('ava-naama').innerHTML = avatarSvg(WORKERS[0].avatar);
  document.getElementById('ava-yuval').innerHTML = avatarSvg(WORKERS[1].avatar);
  const dp = document.getElementById('date-pick');
  dp.value = new Date().toLocaleDateString('en-CA');
  dp.onchange = refreshCustomers;

  const { settings, conn, qrDataUrl, version } = await api.getBoot();
  if (version) {
    const v = document.getElementById('code-ver');
    if (v) v.textContent = `גרסה ${version}`;
  }
  if (settings.businessPhone) document.getElementById('biz-phone').value = settings.businessPhone;
  if (settings.sheetUrl) document.getElementById('sheet-url').value = settings.sheetUrl;
  if (settings.portalUrl) document.getElementById('portal-url').value = settings.portalUrl;
  if (qrDataUrl) renderQr(qrDataUrl);

  api.onQr(({ dataUrl }) => renderQr(dataUrl));
  api.onConn((c) => {
    applyConn(c);
    if (c.whatsapp.state === 'connected') {
      renderConnectedQrBox();
      const overlay = document.getElementById('dayend-overlay');
      if (overlay.classList.contains('visible')) {
        overlay.classList.remove('visible');
        const btn = document.getElementById('resume-btn');
        btn.disabled = false;
        btn.textContent = 'התחברות והתחלת יום עבודה';
      }
    }
  });
  document.querySelectorAll('#stats-period button').forEach((b) => {
    b.onclick = () => {
      statsPeriod = b.dataset.p;
      openStats();
    };
  });
  api.onWorker(workerLine);
  api.onCrm(() => refreshCustomers());
  setInterval(() => api.getConn().then(applyConn), 10000);
  setInterval(refreshCustomers, 10000);

  applyConn(conn);
  if (settings.setupDone && settings.workers) enterDashboard(false);
  else if (settings.setupDone) goSelect();
  else go('s1');
  if (settings.dayEnded && settings.setupDone) document.getElementById('dayend-overlay').classList.add('visible');
})();
