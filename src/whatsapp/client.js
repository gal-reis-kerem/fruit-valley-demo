const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { config } = require('../config');
const log = require('../logger');

async function createWhatsAppClient() {
  // whatsapp-web.js bundles its own (older) puppeteer whose Chrome download
  // may be missing/corrupt — always launch the Chrome of the top-level
  // puppeteer install, the same binary the PDF generator uses.
  const executablePath = await puppeteer.executablePath();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    webVersion: config.wwebVersion,
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    },
    puppeteer: {
      headless: true,
      executablePath,
      protocolTimeout: 180000,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    log.info('סרוק את קוד ה-QR עם וואטסאפ בטלפון (הגדרות ← מכשירים מקושרים):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => log.info('וואטסאפ: אומת בהצלחה'));
  client.on('auth_failure', (msg) => log.error('וואטסאפ: כשל אימות', msg));
  client.on('disconnected', (reason) => log.warn('וואטסאפ: נותק -', reason));

  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WhatsApp's LID privacy layer: private messages can arrive from an anonymized
// '<id>@lid' instead of '<phone>@c.us'. Resolve back to the phone id so we can
// match the configured customer number. Results are cached per session.
const lidCache = new Map();

async function resolvePhoneId(client, chatId) {
  if (!chatId || !chatId.endsWith('@lid')) return chatId;
  if (lidCache.has(chatId)) return lidCache.get(chatId);
  let resolved = chatId;
  try {
    const pn = await client.pupPage.evaluate((id) => {
      const wid = window.require('WAWebWidFactory').createWid(id);
      try {
        const { toPn } = window.require('WAWebLidMigrationUtils');
        const r = toPn(wid);
        if (r && r._serialized) return r._serialized;
      } catch (e) { /* try next strategy */ }
      try {
        const api = window.require('WAWebApiContact');
        if (api.getPhoneNumber) {
          const r = api.getPhoneNumber(wid);
          if (r && r._serialized) return r._serialized;
        }
      } catch (e) { /* try next strategy */ }
      try {
        const contact =
          window.require('WAWebCollections').Contact?.get(wid) ||
          window.require('WAWebContactCollection').ContactCollection?.get(wid);
        const r = contact && contact.phoneNumber;
        if (r) return r._serialized || String(r);
      } catch (e) { /* give up */ }
      return null;
    }, chatId);
    if (pn) resolved = pn;
  } catch (err) {
    log.warn(`תרגום LID נכשל עבור ${chatId}: ${err.message}`);
  }
  lidCache.set(chatId, resolved);
  return resolved;
}

/**
 * List all groups as lightweight {id, name} objects.
 * Right after a first-time QR link, chats are still syncing and
 * client.getChats() can throw — so we retry, and if the wwebjs serializer
 * itself is broken we fall back to querying the WhatsApp Web store directly.
 */
async function listGroups(client, { attempts = 10, delayMs = 10000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    // Path A: raw query on WhatsApp Web's module system — lighter and more
    // resilient than the full wwebjs chat serializer.
    try {
      const groups = await client.pupPage.evaluate(() => {
        const { Chat } = window.require('WAWebCollections');
        return Chat.getModelsArray()
          .filter((c) => c.id && c.id.server === 'g.us')
          .map((c) => ({ id: c.id._serialized, name: c.formattedTitle || c.name || '' }));
      });
      if (groups && groups.length) return groups;
      log.info(`הצ׳אטים עדיין מסתנכרנים (ניסיון ${i}/${attempts}), ממתין…`);
    } catch (err) {
      lastErr = err;
      log.warn(`שאילתת קבוצות ישירה נכשלה (ניסיון ${i}/${attempts}) - ${err.message}`);
    }
    // Path B: the regular wwebjs API
    try {
      const chats = await client.getChats();
      return chats.filter((c) => c.isGroup).map((c) => ({ id: c.id._serialized, name: c.name }));
    } catch (err) {
      lastErr = err;
      log.warn(`getChats נכשל (ניסיון ${i}/${attempts}) - ${err.message}`);
    }
    if (i < attempts) await sleep(delayMs);
  }
  throw lastErr || new Error('לא ניתן לקרוא את רשימת הצ׳אטים');
}

/**
 * Find a group by its exact display name.
 * Returns a lightweight chat-like object: { id: { _serialized }, name }.
 */
async function findGroupByName(client, name, opts) {
  if (!name) return null;
  const groups = await listGroups(client, opts);
  const found = groups.find((g) => g.name === name);
  return found ? { id: { _serialized: found.id }, name: found.name } : null;
}

module.exports = { createWhatsAppClient, findGroupByName, listGroups, resolvePhoneId, MessageMedia };
