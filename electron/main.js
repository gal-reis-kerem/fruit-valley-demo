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
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// ---- engine events -> renderer ----
function forward(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

engine.bus.on('worker', (ev) => forward('worker', ev));
engine.bus.on('status', (ev) => forward('status', ev));
engine.bus.on('crm', (ev) => forward('crm', ev));
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
  state: engine.state.state,
  error: engine.state.error,
  companies: config.companies.map((c) => c.name),
  qrDataUrl: engine.state.qr ? await QRCode.toDataURL(engine.state.qr, { width: 360, margin: 1 }) : null,
}));
ipcMain.handle('get-stats', () => engine.getStats());
ipcMain.handle('get-customers', () => engine.getCustomers());
ipcMain.handle('save-phone', (e, phone) => writeSettings({ businessPhone: phone }));
ipcMain.handle('save-sheet', async (e, url) => {
  if (!url || !url.trim()) {
    writeSettings({ sheetUrl: '' });
    return { ok: true, skipped: true };
  }
  try {
    const companies = await sheets.refresh(url.trim());
    writeSettings({ sheetUrl: url.trim() });
    sheets.startPolling(url.trim());
    return { ok: true, companies: companies.map((c) => c.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('finish-setup', () => writeSettings({ setupDone: true }));
ipcMain.handle('open-customers-folder', () => shell.openPath(config.outputDir));
ipcMain.handle('open-path', (e, p) => {
  // only paths inside the output folder may be opened from the UI
  if (p && path.resolve(p).startsWith(path.resolve(config.outputDir))) shell.openPath(p);
});

app.whenReady().then(async () => {
  createWindow();
  engine.start({ cli: false, webPanel: false }).catch((err) => {
    log.error('המנוע נפל בעלייה:', err.message);
    forward('status', { state: 'error', error: err.message });
  });

  // screenshot mode for automated verification: FV_SHOT=/path/to.png
  if (process.env.FV_SHOT) {
    setTimeout(async () => {
      try {
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
