// Minimal local control panel (no framework): connection status, QR pairing,
// start/stop, and a support-email shortcut. Open http://localhost:<WEB_PORT>.
const http = require('http');
const QRCode = require('qrcode');
const { config } = require('../config');
const log = require('../logger');

const SUPPORT_EMAIL = 'gal@triplep.co.il';

function page() {
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('תקלה - פירות העמק דמו')}&body=${encodeURIComponent('תיאור התקלה:\n\n\nמה ניסיתי:\n\n')}`;
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>פירות העמק · Triple</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f4f7f4; margin: 0; padding: 24px; color: #1b2b1b; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 2px 14px rgba(0,0,0,.08); padding: 24px; }
  h1 { font-size: 20px; color: #2e7d32; margin: 0 0 4px; }
  .sub { color: #777; font-size: 13px; margin-bottom: 18px; }
  .status { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; background: #f2f2f2; margin-bottom: 16px; font-weight: 600; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: #bbb; }
  .connected .dot { background: #2e7d32; } .connected { background: #e8f5e9; }
  .qr .dot { background: #f9a825; } .qr { background: #fff8e1; }
  .stopped .dot { background: #c62828; } .stopped { background: #fdecea; }
  #qr-wrap { text-align: center; display: none; }
  #qr-wrap img { width: 240px; height: 240px; }
  #qr-wrap p { font-size: 13px; color: #555; }
  .btns { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button, .btn { flex: 1; min-width: 130px; padding: 12px; border: 0; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; display: inline-block; color: #fff; }
  .stop { background: #c62828; } .start { background: #2e7d32; } .support { background: #546e7a; }
  .meta { font-size: 12px; color: #888; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <h1>🍎 פירות העמק — עובדת דיגיטלית</h1>
    <div class="sub">Powered by Triple Digital Workforce</div>
    <div id="status" class="status"><span class="dot"></span><span id="status-text">טוען…</span></div>
    <div id="qr-wrap">
      <p>סרקו עם וואטסאפ בטלפון: הגדרות ← מכשירים מקושרים ← קישור מכשיר</p>
      <img id="qr-img" alt="QR">
    </div>
    <div class="btns">
      <button id="toggle" class="stop" onclick="toggle()">…</button>
      <a class="btn support" href="${mailto}">📧 דיווח תקלה</a>
    </div>
    <div class="meta">נציג: ${config.sourceContact} · חברות: ${config.companies.map((c) => c.name).join(' / ')}</div>
  </div>
<script>
let running = true;
async function refresh() {
  try {
    const s = await (await fetch('/status')).json();
    running = s.running;
    const el = document.getElementById('status');
    const txt = document.getElementById('status-text');
    el.className = 'status ' + (s.state === 'connected' ? 'connected' : s.state === 'qr' ? 'qr' : !s.running ? 'stopped' : '');
    txt.textContent = s.label;
    document.getElementById('toggle').textContent = s.running ? '⏹ עצירת החיבור' : '▶️ הפעלה מחדש';
    document.getElementById('toggle').className = s.running ? 'stop' : 'start';
    const qrWrap = document.getElementById('qr-wrap');
    if (s.state === 'qr' && s.qrDataUrl) {
      qrWrap.style.display = 'block';
      document.getElementById('qr-img').src = s.qrDataUrl;
    } else qrWrap.style.display = 'none';
  } catch (e) { document.getElementById('status-text').textContent = 'אין קשר לשרת'; }
}
async function toggle() {
  document.getElementById('toggle').disabled = true;
  await fetch(running ? '/stop' : '/start', { method: 'POST' });
  document.getElementById('toggle').disabled = false;
  refresh();
}
refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

/**
 * @param {object} controller {
 *   getState: () => ({ state, running }),   state: starting|qr|connected|stopped|disconnected
 *   getQr: () => string|null,
 *   start: async () => void,
 *   stop: async () => void,
 * }
 */
function startWebServer(controller) {
  const labels = {
    starting: 'מתחבר לוואטסאפ…',
    qr: 'ממתין לסריקת QR',
    connected: 'מחובר ופעיל ✔',
    stopped: 'החיבור מושבת',
    disconnected: 'החיבור נותק',
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      if (req.url === '/status' && req.method === 'GET') {
        const { state, running } = controller.getState();
        const qr = controller.getQr();
        const qrDataUrl = state === 'qr' && qr ? await QRCode.toDataURL(qr) : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state, running, label: labels[state] || state, qrDataUrl }));
      }
      if (req.url === '/stop' && req.method === 'POST') {
        await controller.stop();
        res.writeHead(200);
        return res.end('ok');
      }
      if (req.url === '/start' && req.method === 'POST') {
        await controller.start();
        res.writeHead(200);
        return res.end('ok');
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      log.error('שגיאת שרת ווב:', err.message);
      res.writeHead(500);
      res.end('error');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`נראה שהאפליקציה כבר רצה (פורט ${config.webPort} תפוס).`);
      log.info('עצור את ההרצה הקודמת (Ctrl+C בטרמינל שלה) והפעל שוב, או בדוק את http://localhost:' + config.webPort);
      process.exit(1);
    }
    log.error('שגיאת שרת ווב:', err.message);
  });
  server.listen(config.webPort, () => {
    log.info(`מסך בקרה: http://localhost:${config.webPort}`);
  });
  return server;
}

module.exports = { startWebServer };
