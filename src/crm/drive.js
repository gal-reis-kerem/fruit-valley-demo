// Read-only access to PUBLIC Google Drive folders (link-shared). No API key
// needed: folder listing via the embeddedfolderview page, file download via
// the direct-download endpoint, Google Sheets via CSV export. Never writes.
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) FruitValley/1.0' };

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`Drive HTTP ${res.status} עבור ${url.slice(0, 80)}`);
  return res.text();
}

// List a public folder. Returns [{ id, title, kind: 'folder'|'sheet'|'file' }].
async function listFolder(folderId) {
  const html = await fetchText(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`);
  const entries = [];
  const re = /href="(https:\/\/(?:docs|drive)\.google\.com\/[^"]+)"[^>]*>[\s\S]*?class="flip-entry-title">([^<]+)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, url, title] = m;
    const idMatch = url.match(/\/d\/([\w-]+)|folders\/([\w-]+)|[?&]id=([\w-]+)/);
    if (!idMatch) continue;
    const id = idMatch[1] || idMatch[2] || idMatch[3];
    const kind = url.includes('spreadsheets') ? 'sheet' : url.includes('/folders/') ? 'folder' : 'file';
    entries.push({ id, title: title.trim(), kind });
  }
  return entries;
}

// Download a public file (e.g. PDF) as a Buffer.
async function downloadFile(fileId) {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, {
    headers: UA,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`הורדת קובץ ${fileId} נכשלה (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  // large files get an interstitial HTML confirmation page instead of bytes
  if (buf.slice(0, 15).toString().toLowerCase().includes('<!doctype html')) {
    throw new Error(`קובץ ${fileId} מחזיר דף אישור במקום תוכן (גדול מדי או לא משותף)`);
  }
  return buf;
}

// Read a public Google Sheet (first tab or by gid) as CSV text.
async function sheetCsv(sheetId, gid = null) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  const text = await fetchText(url);
  if (text.trimStart().startsWith('<')) {
    throw new Error(`גיליון ${sheetId} לא נגיש ציבורית (נדרש שיתוף "כל מי שיש לו קישור")`);
  }
  return text;
}

module.exports = { listFolder, downloadFile, sheetCsv };
