// Sync fixed (standing) base orders from the customer's Google Drive folder.
//
// Folder layout (per Fruit Valley):
//   <root>/<customer>/<day PDFs>            e.g. "אלמה - שלישי.pdf"
//   <root>/<payer>/<office>/<PDFs>          e.g. "סולראדג׳/מודיעין/... .pdf"
//   "X + Y - <day>.pdf"                     one file feeding TWO customers
//   "<name> תוספת <day>.pdf"                additions on top of that day's base
//   a file with no day token                the standing order for every
//                                           working day (ראשון-חמישי)
//   "<name> שני-חמישי.pdf"                  a day RANGE
//
// The schedule comes from the FILE NAMES: a customer gets a base only for the
// days that have a file - the scheduler will only auto-issue on those days.
// PDFs are parsed with Claude (scans and floor-matrices included). Results
// are cached by content hash so a re-sync does not re-parse unchanged files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const log = require('../logger');
const drive = require('../crm/drive');
const { parseOrderDocument } = require('../ai/docParser');
const baseOrders = require('./baseOrders');
const sheets = require('../crm/sheets');

const DAY_NAMES = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
const WORK_DAYS = [0, 1, 2, 3, 4]; // "כל יום" = ראשון-חמישי (ימי העבודה)

const cacheFile = () => path.join(config.dataDir, 'fixed-orders-cache.json');

// Loose Hebrew name matching: strip punctuation/spaces and the letters ו/י so
// spelling variants collapse (אינומד/אינמוד, סטרטסיס/סטרטסייס, סולראדג׳/סולאראדג׳).
function looseName(s) {
  return String(s || '')
    .replace(/[׳'"״`‏‎\s\-_.()]/g, '')
    .replace(/[וי]/g, '');
}

// Parse a file title into its schedule.
// Returns { days: [0..6], isAddition, nameTokens }.
function parseScheduleFromName(title) {
  const clean = title.replace(/\.[a-z0-9]+$/i, '').replace(/\(\d+\)\s*$/, '').trim();
  const isAddition = /תוספת/.test(clean);
  const days = new Set();
  // ranges like "שני-חמישי"
  const range = clean.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\s*-\s*(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
  if (range) {
    const from = DAY_NAMES[range[1]];
    const to = DAY_NAMES[range[2]];
    for (let d = from; d <= to; d += 1) days.add(d);
  } else {
    // day names may be listed ("ראשון שלישי וחמישי") including a ו' prefix
    for (const [name, idx] of Object.entries(DAY_NAMES)) {
      if (new RegExp(`(^|[\\s\\-]|[\\s\\-]ו)${name}([\\s\\-_.]|$)`).test(clean) ||
          new RegExp(`^ו${name}([\\s\\-_.]|$)`).test(clean)) days.add(idx);
    }
  }
  return { days: [...days].sort(), isAddition, clean };
}

// Single-edit tolerance for names that differ by one letter even after the
// loose normalization (e.g. a missing א: סלראדג vs סלאראדג).
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (Math.min(a.length, b.length) < 4) return false; // too short to fuzz
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (edits++) return false;
    if (s.length === l.length) { i++; j++; } else j++; // substitution / insertion
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

// Resolve a Drive folder/file name to CRM offices.
// scope: optional payer office list to search within (nested folders).
function matchOffices(name, offices, { payerScope = null } = {}) {
  const target = looseName(name);
  if (!target) return [];
  const pool = payerScope || offices;
  // near-exact office-key / display / office-field / payer match
  let hits = pool.filter((o) =>
    [o.displayName, o.office, o.payer].some((v) => v && withinOneEdit(looseName(v), target)));
  if (hits.length) {
    // a payer name alone (e.g. "סולראדג׳") matches every office of that payer
    return hits;
  }
  // containment either way (e.g. "גליל מדיקל" vs "גליל")
  hits = pool.filter((o) =>
    [o.displayName, o.office].some((v) => v && (looseName(v).includes(target) || target.includes(looseName(v)))));
  return hits;
}

// Split combined titles like "ברוקר + אינמוד - שני" into customer name parts.
function combinedNames(title) {
  if (!title.includes('+')) return null;
  const beforeDay = title
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/-\s*(?=(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|תוספת))/)[0];
  const parts = beforeDay.split('+').map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : null;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(cache, null, 2));
}

// Bumped when the doc schema gains fields the sync depends on (sections,
// Hebrew name) - older cache entries are upgraded lazily, only when needed.
const PARSER_VERSION = 2;

async function parsePdfCached(entry, hintOffice, cache, { force = false } = {}) {
  const hint = `הזמנת בסיס קבועה של ${hintOffice}. שם הקובץ: "${entry.title}"`;

  // A Google Sheet inside the fixed folder is a base order too - read as CSV.
  if (entry.kind === 'sheet') {
    const csv = await drive.sheetCsv(entry.id);
    const hash = crypto.createHash('sha1').update(csv).digest('hex');
    if (!force && cache[hash] && (cache[hash].v || 1) >= PARSER_VERSION) return { ...cache[hash], hash, fromCache: true };
    log.info(`מפרסר גיליון בסיס: "${entry.title}"`);
    const { parseTextOrders } = require('../ai/docParser');
    const parsed = await parseTextOrders(csv, { hint });
    cache[hash] = { title: entry.title, parsed, v: PARSER_VERSION, at: new Date().toISOString() };
    saveCache(cache);
    return { title: entry.title, parsed, hash, fromCache: false };
  }

  const buf = await drive.downloadFile(entry.id);
  if (!buf.slice(0, 5).toString().startsWith('%PDF')) {
    throw new Error('הקובץ אינו PDF (זוהה לפי התוכן)');
  }
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const cached = cache[hash];
  const needsSections = entry.title.includes('+');
  const stale = cached && (cached.v || 1) < PARSER_VERSION && needsSections;
  if (!force && cached && !stale) return { ...cached, hash, fromCache: true };
  log.info(`מפרסר קובץ בסיס: "${entry.title}" (${(buf.length / 1024).toFixed(0)}KB)`);
  const parsed = await parseOrderDocument(buf, { hint });
  cache[hash] = { title: entry.title, parsed, v: PARSER_VERSION, at: new Date().toISOString() };
  saveCache(cache);
  return { title: entry.title, parsed, hash, fromCache: false };
}

// Verify the customer named inside the document does not clearly belong to a
// DIFFERENT customer (e.g. an אינפיניון delivery note inside the בוסטון
// לומינס folder). Uses the model's Hebrew normalization when available
// (INFINEON -> אינפיניון), plus word-level matching so "בוסטון קיץ" matches
// "בוסטון לומינס". A null inside-doc name passes.
function docCustomerMismatch(parsed, office) {
  const names = [parsed.customer_name_he, parsed.customer_name_in_doc].filter(Boolean);
  if (!names.length) return false;
  const candidateWords = [office.displayName, office.office, office.payer]
    .filter(Boolean)
    .flatMap((v) => String(v).split(/\s+/))
    .map(looseName)
    .filter((w) => w.length >= 3);
  const candidatesFull = [office.displayName, office.office, office.payer].filter(Boolean).map(looseName);
  for (const raw of names) {
    const doc = looseName(raw);
    if (candidatesFull.some((c) => c.includes(doc) || doc.includes(c) || withinOneEdit(c, doc))) return false;
    // word-level: any meaningful word shared between doc name and customer name
    const docWords = String(raw).split(/\s+/).map(looseName).filter((w) => w.length >= 3);
    if (docWords.some((dw) => candidateWords.some((cw) => cw === dw || withinOneEdit(cw, dw)))) return false;
  }
  return true;
}

/**
 * Sync all fixed base orders from Drive into the base-order store.
 * @returns report { loaded, skipped, gaps, warnings }
 */
async function syncFixedOrders({ force = false } = {}) {
  const report = { loaded: [], gaps: [], warnings: [], filesParsed: 0, filesCached: 0 };
  const crmOffices = sheets.allOffices();
  if (!crmOffices.length) throw new Error('ה-CRM עדיין לא סונכרן - אין משרדים לטעון מולם');
  const cache = loadCache();

  const root = await drive.listFolder(config.fixedOrdersFolderId);
  // customer -> day -> { base: items|null, additions: [items] }
  const plan = new Map();
  const ensure = (key) => {
    if (!plan.has(key)) plan.set(key, {});
    return plan.get(key);
  };

  // Walk: root folders are customers; a nested folder narrows to an office.
  const walk = async (entry, scopeOffices, label) => {
    if (entry.kind === 'folder') {
      const matched = matchOffices(entry.title, crmOffices, { payerScope: scopeOffices });
      if (!matched.length) {
        report.gaps.push(`תיקייה "${label}${entry.title}" לא מזוהה מול אף לקוח ב-CRM`);
        return;
      }
      const children = await drive.listFolder(entry.id);
      if (!children.length) {
        report.gaps.push(`תיקיית "${label}${entry.title}" ריקה - אין קבצי הזמנה קבועה`);
        return;
      }
      for (const child of children) await walk(child, matched, `${label}${entry.title}/`);
      return;
    }
    // files are validated by CONTENT (magic bytes) inside parsePdfCached -
    // renamed files without an extension still load; sheets are read as CSV

    // which customers does this FILE feed?
    let targets = scopeOffices;
    const combo = combinedNames(entry.title);
    if (combo) {
      targets = combo.flatMap((n) => matchOffices(n, crmOffices));
      if (!targets.length) {
        report.gaps.push(`קובץ משולב "${entry.title}" - אף שם לא זוהה מול ה-CRM`);
        return;
      }
    }
    if (!targets || !targets.length) return;
    if (targets.length > 1 && !combo) {
      // a payer folder with several offices and no office-level subfolder
      report.gaps.push(`"${label}${entry.title}": ללקוח כמה משרדים ולא ברור לאיזה משרד הקובץ שייך`);
      return;
    }

    const { days, isAddition } = parseScheduleFromName(entry.title);
    const effectiveDays = days.length ? days : WORK_DAYS;

    let doc;
    try {
      doc = await parsePdfCached(entry, targets.map((t) => t.displayName).join(' + '), cache, { force });
      // Older cache entries lack the Hebrew customer name; when the identity
      // check would reject on the raw name alone, re-parse once to get it
      // (INFINEON -> אינפיניון) before deciding.
      const wouldReject = !combo && targets.every((o) => docCustomerMismatch(doc.parsed, o));
      if (doc.fromCache && wouldReject && doc.parsed.customer_name_he === undefined) {
        doc = await parsePdfCached(entry, targets.map((t) => t.displayName).join(' + '), cache, { force: true });
      }
    } catch (err) {
      report.gaps.push(`פרסור "${entry.title}" נכשל: ${err.message}`);
      return;
    }
    doc.fromCache ? (report.filesCached += 1) : (report.filesParsed += 1);

    const docName = doc.parsed.customer_name_he || doc.parsed.customer_name_in_doc;
    const allItems = doc.parsed.orders.flatMap((o) => o.items);
    if (!allItems.length) {
      report.gaps.push(`"${entry.title}" לא הניב פריטים - לא נטען`);
      return;
    }
    // Per-customer sections inside the doc (combined "ברוקר + אינמוד" files):
    // each target office gets ONLY its own section. Falls back to the whole
    // list when the doc has no sections.
    const sections = doc.parsed.orders.filter((o) => o.customer_name);
    const itemsForOffice = (office) => {
      if (!sections.length) return allItems;
      const mine = sections.filter((s) => {
        const sw = String(s.customer_name).split(/\s+/).map(looseName).filter((w) => w.length >= 2);
        const ow = [office.displayName, office.office, office.payer]
          .filter(Boolean).flatMap((v) => String(v).split(/\s+/)).map(looseName).filter((w) => w.length >= 2);
        return sw.some((a) => ow.some((b) => a === b || withinOneEdit(a, b) || a.includes(b) || b.includes(a)));
      });
      if (!mine.length) {
        report.warnings.push(`"${entry.title}": לא נמצאה בקובץ סקציה של ${office.displayName} - נטענת הרשימה המלאה`);
        return allItems;
      }
      return mine.flatMap((s) => s.items);
    };

    for (const office of targets) {
      // a combined filename ("ברוקר + אינמוד") explicitly names its customers -
      // the inside-doc header may mention only one of them
      if (!combo && docCustomerMismatch(doc.parsed, office)) {
        report.gaps.push(
          `"${entry.title}" בתיקייה של ${office.displayName} אך תוכן המסמך נראה של "${docName}" - לא נטען, דורש בדיקה`);
        continue;
      }
      // filename days win over days written inside the doc - but flag clashes
      const docDays = (doc.parsed.days_mentioned || []).map((d) => DAY_NAMES[d]).filter((d) => d !== undefined);
      if (days.length && docDays.length && !days.some((d) => docDays.includes(d))) {
        report.warnings.push(
          `"${entry.title}": בתוך המסמך מצוינים ימים אחרים (${doc.parsed.days_mentioned.join(', ')}) - שם הקובץ קובע`);
      }
      const officeItems = itemsForOffice(office);
      const perDay = ensure(office.key);
      for (const d of effectiveDays) {
        if (!perDay[d]) perDay[d] = { base: null, additions: [] };
        if (isAddition) perDay[d].additions.push({ items: officeItems, source: entry.title });
        else if (perDay[d].base) report.warnings.push(`ליום ${d} של ${office.displayName} יש יותר מקובץ בסיס אחד - "${entry.title}" דולג`);
        else perDay[d] = { ...perDay[d], base: { items: officeItems, source: entry.title } };
      }
    }
  };

  for (const entry of root) await walk(entry, null, '');

  // Materialize into the base-order store (versioned, only on change).
  for (const [officeKey, dayMap] of plan) {
    const perDay = {};
    for (const [day, slot] of Object.entries(dayMap)) {
      let items = slot.base ? [...slot.base.items] : [];
      if (!slot.base && slot.additions.length) {
        report.warnings.push(`${officeKey}: קיימת תוספת ליום ${day} בלי קובץ בסיס לאותו יום - נטענת התוספת בלבד`);
      }
      for (const add of slot.additions) {
        items = items.concat(add.items.map((it) => ({ ...it, note: [it.note, 'תוספת קבועה'].filter(Boolean).join(' · ') })));
      }
      if (items.length) perDay[day] = items;
    }
    if (!Object.keys(perDay).length) continue;

    const existing = baseOrders.activeBase(officeKey);
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify(perDay)).digest('hex');
    if (existing && existing.fingerprint === fingerprint) {
      report.loaded.push({ office: officeKey, days: Object.keys(perDay).map(Number), changed: false });
      continue;
    }
    const versionId = baseOrders.setBase(officeKey, {
      perDay,
      note: `סונכרן אוטומטית מגוגל דרייב (${new Date().toLocaleDateString('he-IL')})`,
      fingerprint,
    });
    report.loaded.push({ office: officeKey, days: Object.keys(perDay).map(Number), changed: true, versionId });
    log.info(`הזמנת הבסיס של ${officeKey} נטענה (${versionId}) לימים ${Object.keys(perDay).join(',')}`);
  }

  return report;
}

module.exports = { syncFixedOrders, parseScheduleFromName, matchOffices, combinedNames, looseName, DAY_NAMES, WORK_DAYS };
