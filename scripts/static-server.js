// Tiny static server for design mockups (npm start is NOT needed for this).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const MIME = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, urlPath === '/' ? 'design/mockups.html' : urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': (MIME[path.extname(filePath)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`design server on http://localhost:${PORT}`));
