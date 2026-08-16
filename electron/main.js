// Desktop app shell: hosts the engine (src/engine.js) and the UI (electron/ui).
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const QRCode = require('qrcode');

const engine = require('../src/engine');
const { readSettings, writeSettings } = require('../src/settings');
const sheets = require('../src/crm/sheets');
const { config } = require('../src/config');
const log = require('../src/logger');

let win = null;

// ---- customer portal (external link) health ----
const portalStatus = { configured: false, ok: null, error: null };
async function checkPortal() {
  const { portalUrl } = readSettings();
  portalStatus.configured = Boolean(portalUrl);
  if (!portalUrl) {
    portalStatus.ok = null;
    return portalStatus;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(portalUrl, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    portalStatus.ok = res.ok;
    portalStatus.error = res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    portalStatus.ok = false;
    portalStatus.error = err.message;
  }
  forward('conn', connSnapshot());
  return portalStatus;
}
setInterval(checkPortal, 5 * 60 * 1000);

function connSnapshot() {
  return {
    whatsapp: { state: engine.state.state, error: engine.state.error },
    crm: sheets.getStatus(),
    portal: { ...portalStatus },
    email: engine.getEmailStatus(),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 980,
    minHeight: 700,
    title: 'פירות העמק — Triple Digital Workforce',
    backgroundColor: '#FAF6EC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (process.env.FV_DEBUG) {
    win.webContents.on('console-message', (e, level, message) =>
      require('fs').appendFileSync(process.env.FV_DEBUG, `[${level}] ${message}\n`),
    );
  }
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// ---- engine events -> renderer ----
function forward(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

engine.bus.on('worker', (ev) => forward('worker', ev));
engine.bus.on('status', () => forward('conn', connSnapshot()));
engine.bus.on('crm', (ev) => {
  forward('crm', ev);
  forward('conn', connSnapshot());
});
engine.bus.on('qr', async ({ qr }) => {
  try {
    forward('qr', { dataUrl: await QRCode.toDataURL(qr, { width: 360, margin: 1 }) });
  } catch (err) {
    log.warn('הפקת תמונת QR נכשלה:', err.message);
  }
});

// ---- renderer -> engine ----
ipcMain.handle('get-boot', async () => ({
  settings: readSettings(),
  conn: connSnapshot(),
  companies: config.companies.map((c) => c.name),
  qrDataUrl: engine.state.qr ? await QRCode.toDataURL(engine.state.qr, { width: 360, margin: 1 }) : null,
}));
ipcMain.handle('get-conn', () => connSnapshot());
ipcMain.handle('get-customers', (e, date) => engine.getCustomers(date));
ipcMain.handle('save-phone', (e, phone) => writeSettings({ businessPhone: phone }));
ipcMain.handle('save-sheet', async () => {
  // CRM v2: the central spreadsheet is configured via CRM_SPREADSHEET_ID -
  // the wizard step now just verifies the connection.
  try {
    const companies = await sheets.refresh();
    sheets.startPolling();
    return { ok: true, companies: companies.map((c) => c.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('save-portal', async (e, url) => {
  writeSettings({ portalUrl: (url || '').trim() });
  await checkPortal();
  return { ok: !portalStatus.configured || portalStatus.ok !== false, error: portalStatus.error };
});
ipcMain.handle('save-workers', (e, workers) => writeSettings({ workers }));
ipcMain.handle('finish-setup', () => writeSettings({ setupDone: true }));
ipcMain.handle('reconnect-whatsapp', async () => {
  try {
    await engine.stopWhatsApp();
  } catch (err) { /* keep going */ }
  engine.startWhatsApp().catch((err) => log.error('חיבור מחדש נכשל:', err.message));
});
ipcMain.handle('retry-crm', async () => {
  try {
    await sheets.refresh();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    forward('conn', connSnapshot());
  }
});
ipcMain.handle('retry-portal', () => checkPortal());
ipcMain.handle('save-email', async (e, creds) => {
  try {
    const res = await engine.saveEmailSettings(creds || {});
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    forward('conn', connSnapshot());
  }
});
ipcMain.handle('retry-email', async () => {
  try {
    const email = require('../src/channels/email');
    const res = await email.testConnection();
    if (res.ok) email.startPolling(() => (engine.state.state === 'connected' && engine.state.flow ? engine.state.flow : null));
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    forward('conn', connSnapshot());
  }
});
ipcMain.handle('crm-emails', () => {
  // distinct contact emails from the CRM - prefill for the email step
  const emails = new Set();
  for (const c of config.companies) {
    for (const ct of (c.crm && c.crm.contacts) || []) if (ct.email) emails.add(ct.email);
  }
  return [...emails];
});
ipcMain.handle('open-sheet', () => {
  shell.openExternal(`https://docs.google.com/spreadsheets/d/${config.crmSpreadsheetId}`);
});
ipcMain.handle('crm-readiness', () => sheets.readinessReport());
ipcMain.handle('open-portal', () => {
  const { portalUrl } = readSettings();
  if (portalUrl) shell.openExternal(portalUrl);
});
ipcMain.handle('get-stats-full', (e, period) => engine.getStatsFull(period));
ipcMain.handle('end-day', () => engine.endDay());
ipcMain.handle('resume-day', () => engine.resumeDay());
ipcMain.handle('get-complaints', () => engine.getComplaints());
ipcMain.handle('get-rules', (e, workerId) => engine.getRules(workerId));
ipcMain.handle('worker-chat', async (e, worker, history) => {
  try {
    return await engine.chatWithWorker(worker, history);
  } catch (err) {
    log.error('צ׳אט עובד נכשל:', err.message);
    return { reply: 'מצטער/ת, משהו השתבש אצלי - נסו שוב עוד רגע.', action: 'none' };
  }
});
ipcMain.handle('open-customers-folder', () => shell.openPath(config.outputDir));
ipcMain.handle('open-path', (e, p) => {
  // only paths inside the output folder may be opened from the UI
  if (p && path.resolve(p).startsWith(path.resolve(config.outputDir))) shell.openPath(p);
});

app.whenReady().then(async () => {
  createWindow();
  engine.start({ cli: false, webPanel: false }).catch((err) => {
    log.error('המנוע נפל בעלייה:', err.message);
    forward('conn', connSnapshot());
  });
  checkPortal();

  // screenshot mode for automated verification: FV_SHOT=/path/to.png
  if (process.env.FV_SHOT) {
    setTimeout(async () => {
      try {
        if (process.env.FV_SHOT_JS) await win.webContents.executeJavaScript(process.env.FV_SHOT_JS);
        await new Promise((r) => setTimeout(r, 800));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.FV_SHOT, img.toPNG());
      } finally {
        app.quit();
      }
    }, Number(process.env.FV_SHOT_DELAY || 6000));
  }
});

app.on('window-all-closed', async () => {
  await engine.stopWhatsApp().catch(() => {});
  app.quit();
});
