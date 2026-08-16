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

  // WhatsApp sometimes shows a promo modal ("What's new on WhatsApp Web…")
  // that covers the app and blocks wwebjs's ready detection forever. Poll for
  // blocking dialogs during startup and click their confirm button.
  const dismisser = setInterval(async () => {
    try {
      if (!client.pupPage) return;
      const clicked = await client.pupPage.evaluate(() => {
        const dialogs = document.querySelectorAll('[data-animate-modal-popup="true"], [role="dialog"]');
        for (const dialog of dialogs) {
          const buttons = [...dialog.querySelectorAll('button, div[role="button"]')];
          const target = buttons.find((b) =>
            /^(Continue|המשך|OK|אישור|Got it|הבנתי|Close|סגור)$/i.test((b.textContent || '').trim()),
          );
          if (target) {
            target.click();
            return (target.textContent || '').trim();
          }
        }
        return null;
      });
      if (clicked) log.info(`נסגר דיאלוג חוסם של וואטסאפ ("${clicked}")`);
    } catch (err) { /* page not up yet - keep polling */ }
  }, 2500);
  // keep a short grace period after ready (the dialog can pop late)
  client.on('ready', () => setTimeout(() => clearInterval(dismisser), 45000));
  client.on('disconnected', () => clearInterval(dismisser));

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

// wwebjs's own reaction listener fails to install on current WhatsApp Web
// (its injection chain breaks earlier, so message_reaction never fires).
// Install our own hook directly on the reactions table: every upsert is
// forwarded to the callback with plain-string keys (handles the _serialized
// -> $1 rename too). Call after 'ready'; safe to call again after relaunch.
async function installReactionHook(client, onReactions) {
  try {
    await client.pupPage.exposeFunction('onTripleReaction', (events) => {
      try {
        onReactions(events || []);
      } catch (err) {
        log.error('טיפול בריאקשן נכשל:', err.message);
      }
    });
  } catch (err) {
    // already exposed on this page - fine
  }
  await client.pupPage.evaluate(() => {
    const mod = window.require('WAWebAddonReactionTableMode');
    const target = mod.reactionTableMode;
    if (!target || target.__tripleHooked) return;
    const orig = target.bulkUpsert.bind(target);
    target.bulkUpsert = (...args) => {
      try {
        const items = Array.isArray(args[0]) ? args[0] : [];
        window.onTripleReaction(
          items.map((r) => ({
            emoji: r.reactionText ?? r.text ?? r.reaction ?? '',
            parentKey: r.reactionParentKey ? String(r.reactionParentKey) : null,
            sender: (r.author || r.from) ? String(r.author || r.from) : null,
          })),
        );
      } catch (e) { /* never break WhatsApp itself */ }
      return orig(...args);
    };
    target.__tripleHooked = true;
  });
  log.info('הוק ריאקשנים הותקן ✔');
}

// Media messages (PDFs, photos) never reach wwebjs's 'message' event on the
// pinned WhatsApp Web version - its serializer chokes on media models, so the
// event dies silently. Install our own hook on the Msg collection: every NEW
// incoming media message is downloaded and decrypted IN PAGE (via WhatsApp's
// own DownloadManager) and forwarded to the callback as plain data. Call
// after 'ready'; safe to call again after relaunch.
async function installMediaHook(client, onMedia) {
  try {
    await client.pupPage.exposeFunction('onTripleMedia', (payload) => {
      try {
        onMedia(payload);
      } catch (err) {
        log.error('טיפול במדיה נכשל:', err.message);
      }
    });
  } catch (err) {
    // already exposed on this page - fine
  }
  await client.pupPage.evaluate(() => {
    const Collections = window.require('WAWebCollections');
    const Msg = Collections.Msg;
    if (!Msg) return;

    const keyToString = (k) =>
      k
        ? k._serialized || k.$1 || [k.fromMe, k.remote && (k.remote._serialized || String(k.remote)), k.id].join('_')
        : null;

    const toB64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    };

    // The exact recipe whatsapp-web.js itself uses on this pinned version:
    // resolve the media stage via the model's own downloadMedia, then decrypt
    // through the DownloadManager with a mock telemetry object (downloadQpl -
    // without it the call dies on `addAnnotations`).
    const download = async (m) => {
      if (m.mediaData && m.mediaData.mediaStage === 'REUPLOADING') {
        throw new Error('המדיה פגה (REUPLOADING)');
      }
      if ((!m.mediaData || m.mediaData.mediaStage !== 'RESOLVED') && typeof m.downloadMedia === 'function') {
        await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      }
      if (m.mediaData && (String(m.mediaData.mediaStage).includes('ERROR') || m.mediaData.mediaStage === 'FETCHING')) {
        throw new Error(`mediaStage=${m.mediaData.mediaStage}`);
      }
      const mockQpl = {
        addAnnotations: function () { return this; },
        addPoint: function () { return this; },
      };
      const dm = window.require('WAWebDownloadManager').downloadManager;
      const buf = await dm.downloadAndMaybeDecrypt({
        directPath: m.directPath,
        encFilehash: m.encFilehash,
        filehash: m.filehash,
        mediaKey: m.mediaKey,
        mediaKeyTimestamp: m.mediaKeyTimestamp,
        type: m.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
      if (window.WWebJS && window.WWebJS.arrayBufferToBase64Async) {
        return await window.WWebJS.arrayBufferToBase64Async(buf);
      }
      return toB64(buf);
    };

    const buildPayload = async (m) => {
      let dataB64 = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3 && !dataB64; attempt += 1) {
        try {
          dataB64 = await download(m);
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      let quotedId = null;
      const stanza = m.quotedStanzaID;
      if (stanza) {
        const q = Msg.getModelsArray().find((x) => x.id && x.id.id === stanza);
        quotedId = q ? keyToString(q.id) : stanza;
      }
      return {
        msgId: keyToString(m.id),
        chatId: m.id.remote ? (m.id.remote._serialized || String(m.id.remote)) : String(m.from || ''),
        senderId: m.author ? (m.author._serialized || String(m.author)) : null,
        timestamp: m.t || Math.floor(Date.now() / 1000),
        type: m.type,
        mimetype: m.mimetype || (m.type === 'image' ? 'image/jpeg' : 'application/octet-stream'),
        filename: m.filename || null,
        caption: m.caption || (m.type === 'document' ? '' : m.body || '') || '',
        quotedId,
        dataB64,
        error: dataB64 ? null : (lastErr && (lastErr.message || String(lastErr))) || 'download failed',
      };
    };

    // On-demand fetch by message id / stanza id - the node-side fallback layer.
    window.__tripleFetchMedia = async (idStr) => {
      try {
        let m = Msg.get(idStr) || null;
        if (!m && Msg.getMessagesById) {
          try {
            const res = await Msg.getMessagesById([idStr]);
            m = (res && res.messages && res.messages[0]) || null;
          } catch (e) { /* fall through to scan */ }
        }
        if (!m) {
          const tail = String(idStr).split('_')[2] || idStr;
          m = Msg.getModelsArray().find((x) => x.id && (x.id.id === tail || keyToString(x.id) === idStr)) || null;
        }
        if (!m) return { error: 'message not found in page collection' };
        return await buildPayload(m);
      } catch (e) {
        return { error: (e && e.message) || String(e) };
      }
    };

    if (Msg.__tripleMediaHooked) return;
    Msg.on('add', (m) => {
      try {
        if (!m || !m.isNewMsg || !m.id || m.id.fromMe) return;
        if (!['image', 'document', 'video'].includes(m.type)) return;
        (async () => {
          window.onTripleMedia(await buildPayload(m));
        })();
      } catch (e) { /* never break WhatsApp itself */ }
    });
    Msg.__tripleMediaHooked = true;
  });
  log.info('הוק מדיה הותקן ✔ (קבצים ותמונות נקלטים ישירות מהדף)');
}

// Node-side fallback: fetch + decrypt a specific message's media via the
// page-side helper (works even when the wwebjs Message object is broken).
async function fetchMediaById(client, msgId) {
  return client.pupPage.evaluate(
    (id) => (window.__tripleFetchMedia ? window.__tripleFetchMedia(id) : { error: 'hook not installed' }),
    msgId,
  );
}

// On the pinned WhatsApp Web version, client.sendMessage often DELIVERS the
// message but resolves to undefined (the response serializer is broken).
// Send, then recover the real message id from the chat's own message log so
// reaction-matching and quoted replies keep working.
async function sendAndConfirm(client, chatId, content, options = {}) {
  let sent = null;
  try {
    sent = await client.sendMessage(chatId, content, options);
  } catch (err) {
    log.warn(`sendMessage זרק שגיאה (${err.message}) - בודק אם ההודעה בכל זאת נשלחה`);
  }
  if (sent && sent.id && sent.id._serialized) return sent.id._serialized;

  // Fallback: fetch the id of the last message we sent in this chat
  try {
    await sleep(1500);
    const msgId = await client.pupPage.evaluate((id) => {
      const wid = window.require('WAWebWidFactory').createWid(id);
      const chat = window.require('WAWebCollections').Chat.get(wid);
      if (!chat) return null;
      const msgs = chat.msgs.getModelsArray();
      for (let i = msgs.length - 1; i >= 0; i--) {
        const k = msgs[i].id;
        if (k && k.fromMe) {
          // recent WhatsApp Web builds renamed _serialized — reconstruct manually
          return (
            k._serialized ||
            k.$1 ||
            [k.fromMe, k.remote && (k.remote._serialized || String(k.remote)), k.id].join('_')
          );
        }
      }
      return null;
    }, chatId);
    if (msgId) {
      log.info('ההודעה נשלחה (המזהה אותר בערוץ הגיבוי)');
      return msgId;
    }
  } catch (err) {
    log.warn(`אחזור מזהה הודעה נכשל: ${err.message}`);
  }
  return null;
}

module.exports = {
  createWhatsAppClient,
  findGroupByName,
  listGroups,
  resolvePhoneId,
  sendAndConfirm,
  installReactionHook,
  installMediaHook,
  fetchMediaById,
  MessageMedia,
};
