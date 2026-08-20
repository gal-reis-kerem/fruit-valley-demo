// Order-link fetching. Restigo/Zest customers often send a NOTIFICATION with
// a link ("לצפיה בהזמנה לחץ על הקישור") instead of the order itself - the
// real content sits behind the URL (a PDF or an order web page). Fetch it and
// hand the content to the regular parsers. Read-only GET, no cookies.
const log = require('../logger');

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;

function extractUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0] : null;
}

async function fetchOrderLink(text) {
  const url = extractUrl(text);
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (ct.includes('pdf') || buf.slice(0, 5).toString().startsWith('%PDF')) {
      log.info(`הקישור הניב PDF (${(buf.length / 1024).toFixed(0)}KB)`);
      return { kind: 'pdf', buffer: buf, url };
    }
    const html = buf.toString('utf8');
    const textOut = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    log.info(`הקישור הניב עמוד (${textOut.length} תווי טקסט)`);
    return { kind: 'text', text: textOut, url };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchOrderLink, extractUrl };
