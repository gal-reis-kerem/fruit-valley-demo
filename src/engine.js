// The Fruit Valley engine as a library: used by the CLI (src/index.js) and by
// the desktop app (electron/main.js). Emits everything through src/bus.js.
const { config } = require('./config');
const log = require('./logger');
const bus = require('./bus');
const { createWhatsAppClient, listGroups, resolvePhoneId, installReactionHook, installMediaHook, fetchMediaById } = require('./whatsapp/client');
const { Orchestrator } = require('./flow/orchestrator');
const { startWebServer } = require('./web/server');
const { readSettings, writeSettings } = require('./settings');
const sheets = require('./crm/sheets');
const store = require('./orders/store');
const rules = require('./rules');
const complaintsStore = require('./complaints');
const statsMod = require('./stats');
const { workerChat } = require('./ai/workerChat');
const { sendAndConfirm } = require('./whatsapp/client');

// A single failed operation must not kill the whole digital worker (NFR-07)
process.on('unhandledRejection', (err) => log.error('שגיאה לא מטופלת:', err));

const state = { client: null, state: 'stopped', running: false, qr: null, error: null, flow: null };
let exitOnError = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// destroy can hang when the page is zombied - never wait more than 10s
async function destroyClient(client) {
  await Promise.race([client.destroy(), sleep(10000)]).catch(() => {});
}

// A crashed Chrome can keep holding the profile lock ("browser is already
// running"). Kill any process bound to our session profile and remove the
// stale lock files, then a fresh launch succeeds.
function killZombieBrowser() {
  try {
    require('child_process').execSync(`pkill -9 -f "${config.authDir}"`, { stdio: 'ignore' });
  } catch (err) { /* nothing to kill */ }
}

function clearProfileLocks() {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(config.authDir, 'session', f), { force: true });
    } catch (err) { /* ignore */ }
  }
}

// launch with automatic recovery from a locked profile; on final failure the
// engine lands in a clean 'error' state that the repair dialog can restart.
async function launchSafe(attempt) {
  try {
    await launchClient(attempt);
  } catch (err) {
    if (/already running/i.test(String(err.message))) {
      log.warn('פרופיל הדפדפן עדיין נעול משיחה קודמת - מנקה ומנסה שוב…');
      killZombieBrowser();
      await sleep(3000);
      clearProfileLocks();
      try {
        await launchClient(attempt);
        return;
      } catch (err2) {
        err = err2;
      }
    }
    state.running = false;
    state.client = null;
    state.error = `החיבור לא הצליח לעלות: ${err.message}`;
    setState('error');
    log.error('העלאת החיבור נכשלה:', err.message);
  }
}

// Dedup between live events and offline backfill
const processedMsgs = new Set();
function markProcessed(key) {
  processedMsgs.add(key);
  if (processedMsgs.size > 400) {
    for (const k of [...processedMsgs].slice(0, 200)) processedMsgs.delete(k);
  }
}

// Catch up on everything that arrived while the system was off (computer
// asleep, no internet, app closed). lastSeenTs remembers the last moment we
// were alive; on reconnect every newer message - TEXT AND MEDIA, private
// chats AND our two groups - is pulled from WhatsApp's own message store and
// run through the normal flow. Media is fetched by id via the page helper.
async function backfillOffline(client, flow) {
  const { lastSeenTs } = readSettings();
  if (!lastSeenTs) return;
  const cutoffSec = Math.floor(lastSeenTs / 1000);

  const groupIds = [
    state.flow && state.flow.pickingGroup && state.flow.pickingGroup.id._serialized,
    state.flow && state.flow.photosGroup && state.flow.photosGroup.id._serialized,
  ].filter(Boolean);

  const found = await client.pupPage.evaluate((cutoff, ourGroups) => {
    const out = [];
    const keyToString = (k) =>
      k ? k._serialized || k.$1 || [k.fromMe, k.remote && (k.remote._serialized || String(k.remote)), k.id].join('_') : null;
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    for (const c of chats) {
      if (!c.id) continue;
      const chatId = c.id._serialized;
      const isGroup = c.id.server === 'g.us';
      if (isGroup && !ourGroups.includes(chatId)) continue;
      const msgs = (c.msgs && c.msgs.getModelsArray()) || [];
      for (const m of msgs) {
        if (!m.id || (m.t || 0) <= cutoff) continue;
        const isMedia = ['image', 'document', 'video'].includes(m.type);
        // own messages: only group photos matter (the operator may shoot from
        // the bot's own account); everything else own-sent is ours anyway
        if (m.id.fromMe && !(isMedia && m.type === 'image' && isGroup)) continue;
        if (isMedia) {
          out.push({ chatId, msgId: keyToString(m.id), t: m.t, media: true });
        } else if (m.type === 'chat' && m.body) {
          if (m.id.fromMe) continue;
          out.push({ chatId, body: m.body, t: m.t, media: false });
        }
      }
    }
    return { msgs: out.sort((a, b) => a.t - b.t) };
  }, cutoffSec, groupIds);

  let handled = 0;
  for (const m of found.msgs) {
    if (m.media) {
      // media (files/photos) - fetched and decrypted by id, then routed
      // exactly like live media (routeMediaPayload dedups by message id)
      try {
        const payload = await fetchMediaById(client, m.msgId);
        if (payload && payload.dataB64 && state.routeMediaPayload) {
          handled += 1;
          bus.naama('מטפלת בקובץ שהתקבל כשהמערכת הייתה כבויה');
          await state.routeMediaPayload(payload, 'השלמת השבתה');
        } else {
          log.warn(`קובץ מזמן ההשבתה לא נשלף (${payload && payload.error}) - שלחו אותו שוב`);
        }
      } catch (err) {
        log.error('השלמת קובץ נכשלה:', err.message);
      }
      continue;
    }

    const key = `${m.chatId}|${m.t}`;
    if (processedMsgs.has(key)) continue;
    const phoneId = await resolvePhoneId(client, m.chatId);
    const crmCompanies = sheets.contactCompanies(phoneId);
    const isRep = phoneId === config.sourceContactId;
    const isGroup = m.chatId.endsWith('@g.us');
    if (!isGroup && !isRep && !crmCompanies.length) continue;

    markProcessed(key);
    handled += 1;
    log.info(`משלים הודעה שהתקבלה כשהמערכת הייתה כבויה: "${m.body.slice(0, 60)}"`);
    bus.naama('מטפלת בהודעה שהתקבלה כשהמערכת הייתה כבויה');
    const pseudoMsg = {
      from: m.chatId,
      body: m.body,
      hasMedia: false,
      timestamp: m.t,
      reply: async () => {
        throw new Error('backfill message - plain send instead');
      },
    };
    try {
      if (isGroup) {
        await flow.handleGroupText(pseudoMsg);
      } else {
        const forcedCompany = !isRep && crmCompanies.length === 1 ? crmCompanies[0] : null;
        const candidates = crmCompanies.length > 1 ? crmCompanies : null;
        await flow.handleCustomerMessage(pseudoMsg, forcedCompany, candidates);
      }
    } catch (err) {
      log.error('השלמת הודעה נכשלה:', err.message);
    }
  }
  if (handled) log.info(`הושלמו ${handled} הודעות/קבצים מזמן ההשבתה`);
  writeSettings({ lastSeenTs: Date.now() });
}

function setState(next) {
  state.state = next;
  bus.emit('status', { state: next, error: state.error });
}

function fatal(message) {
  state.error = message;
  log.error(message);
  if (exitOnError) process.exit(1);
  setState('error');
}

async function startWhatsApp() {
  if (state.running) return;
  state.running = true;
  state.error = null;
  await launchSafe(1);
}

// Self-healing launcher: stall watchdog + auto-reconnect (see git history).
async function launchClient(attempt) {
  setState('starting');
  state.qr = null;

  const client = await createWhatsAppClient();
  state.client = client;
  let ready = false;

  const relaunch = async (reason) => {
    if (!state.running || state.client !== client) return;
    await destroyClient(client);
    state.client = null;
    if (attempt >= 3) {
      state.running = false;
      fatal('החיבור נכשל 3 פעמים ברצף - נעצר. בדקו חיבור אינטרנט והפעילו מחדש.');
      setState('stopped');
      return;
    }
    log.warn(`${reason} - מפעיל מחדש את החיבור (ניסיון ${attempt + 1}/3)…`);
    await sleep(5000); // let Chrome release the profile lock
    await launchSafe(attempt + 1);
  };

  const watchdog = setInterval(() => {
    if (ready || !state.running || state.client !== client) {
      clearInterval(watchdog);
      return;
    }
    if (state.state === 'qr') return; // human is scanning - keep waiting
    clearInterval(watchdog);
    relaunch('החיבור נתקע (לא הבשיל תוך דקה)');
  }, 60000);

  client.on('qr', (qr) => {
    state.qr = qr;
    setState('qr');
    bus.emit('qr', { qr });
  });
  client.on('authenticated', () => {
    state.qr = null;
    setState('starting');
  });
  client.on('disconnected', () => {
    setState('disconnected');
    setTimeout(() => relaunch('החיבור לוואטסאפ נותק'), 10000);
  });

  client.on('ready', async () => {
    ready = true;
    attempt = 1;
    clearInterval(watchdog);
    log.info('וואטסאפ מחובר ✔ (טוען את רשימת הקבוצות)');

    let groups;
    try {
      groups = await listGroups(client);
    } catch (err) {
      return fatal(`קריאת רשימת הצ׳אטים נכשלה: ${err.message}. המתינו דקה והפעילו מחדש.`);
    }

    const toChatRef = (g) => ({ id: { _serialized: g.id }, name: g.name });
    const pickingGroupRaw = groups.find((g) => g.name === config.pickingGroupName);
    if (!pickingGroupRaw) {
      log.info('קבוצות זמינות בחשבון:');
      groups.forEach((g) => log.info(`  - ${g.name}`));
      return fatal(`קבוצת הליקוט "${config.pickingGroupName}" לא נמצאה. עדכנו את PICKING_GROUP_NAME.`);
    }
    const pickingGroup = toChatRef(pickingGroupRaw);

    let photosGroup = null;
    if (config.photosGroupName) {
      const photosGroupRaw = groups.find((g) => g.name === config.photosGroupName);
      if (photosGroupRaw) photosGroup = toChatRef(photosGroupRaw);
      else log.warn(`קבוצת התמונות "${config.photosGroupName}" לא נמצאה - בקשות תמונות יישלחו לקבוצת הליקוט.`);
    }

    const flow = new Orchestrator(client, { pickingGroup, photosGroup });
    state.flow = flow;
    state.error = null;
    log.info(`קבוצת ליקוט: "${pickingGroup.name}"${photosGroup ? ` | קבוצת תמונות: "${photosGroup.name}"` : ''}`);
    setState('connected');
    log.info('ממתין להזמנות… 🍎');

    // Catch up on messages that arrived while the system was off
    setTimeout(() => backfillOffline(client, flow).catch((err) => log.warn('השלמת הודעות נכשלה:', err.message)), 15000);

    // Liveness monitor: detect a silently reloaded page and relaunch.
    const liveness = setInterval(async () => {
      if (!state.running || state.client !== client) {
        clearInterval(liveness);
        return;
      }
      const alive = await client.pupPage
        .evaluate(() => typeof window.WWebJS !== 'undefined')
        .catch(() => false);
      if (alive) writeSettings({ lastSeenTs: Date.now() });
      if (!alive) {
        clearInterval(liveness);
        log.warn('הדף של וואטסאפ התרענן ואיבד את ההאזנות - מתחבר מחדש אוטומטית…');
        relaunch('הדף התרענן');
      }
    }, 60000);

    // Incoming messages. Route by msg.from; senders may be the configured rep
    // or any contact listed in the CRM sheet (single-company contacts are
    // attributed automatically).
    client.on('message', async (msg) => {
      try {
        const chatId = msg.from;
        const isGroup = chatId.endsWith('@g.us');

        // Media messages arrive here BROKEN on the pinned version (body = the
        // file name, media fields unreadable). Never process them as text -
        // the page hook owns them; after a grace period, try wwebjs's own
        // download as a fallback layer.
        const isMediaMsg = msg.hasMedia || ['image', 'video', 'document', 'sticker', 'ptt', 'audio'].includes(msg.type);
        if (isMediaMsg) {
          log.info(`הודעת מדיה (${msg.type || 'לא ידוע'}) - ממתין להוק הדף לקלוט אותה`);
          setTimeout(async () => {
            try {
              const key = `media|${(msg.id && (msg.id._serialized || msg.id.$1)) || `${chatId}|${msg.timestamp}`}`;
              if (processedMsgs.has(key)) return; // page hook handled it
              log.warn('הוק הדף לא קלט את המדיה תוך 20 שניות - שולף אותה מהדף לפי מזהה');
              const msgId = (msg.id && (msg.id._serialized || msg.id.$1)) || null;
              const payload = msgId ? await fetchMediaById(client, msgId).catch((e) => ({ error: e.message })) : { error: 'אין מזהה הודעה' };
              if (payload && payload.dataB64 && state.routeMediaPayload) {
                await state.routeMediaPayload(payload, 'שליפה לפי מזהה');
              } else {
                log.error(`המדיה לא נקלטה בשתי השכבות (${payload && payload.error}) - הקובץ לא טופל. שלחו את התוכן כטקסט או דווחו ל-Triple`);
              }
            } catch (err) {
              log.error('שכבת הגיבוי למדיה נכשלה:', err.message);
            }
          }, 20000);
          return;
        }

        if (msg.timestamp) markProcessed(`${chatId}|${msg.timestamp}`);
        writeSettings({ lastSeenTs: Date.now() });

        if (!isGroup) {
          const phoneId = await resolvePhoneId(client, chatId);
          const crmCompanies = sheets.contactCompanies(phoneId);
          const isRep = phoneId === config.sourceContactId;
          if (isRep || crmCompanies.length) {
            // unique contact -> automatic attribution; shared phone -> the
            // candidates are passed on and NEVER auto-assigned (FoodiFairy)
            const forcedCompany = !isRep && crmCompanies.length === 1 ? crmCompanies[0] : null;
            const candidates = crmCompanies.length > 1 ? crmCompanies : null;
            await flow.handleCustomerMessage(msg, forcedCompany, candidates);
          } else {
            log.info(`הודעה פרטית ממספר לא מוגדר (${chatId}${phoneId !== chatId ? ` = ${phoneId}` : ''}) - מתעלם`);
          }
          return;
        }

        const inPickingGroup = chatId === pickingGroup.id._serialized;
        const inPhotosGroup = photosGroup && chatId === photosGroup.id._serialized;
        if ((inPickingGroup || inPhotosGroup) && msg.hasMedia) {
          await flow.handleGroupMedia(msg);
        } else if (inPhotosGroup && (msg.body || '').trim()) {
          await flow.handleGroupText(msg);
        }
      } catch (err) {
        log.error('שגיאה בטיפול בהודעה:', err);
      }
    });

    // Media messages (PDFs, photos): on the pinned version wwebjs's 'message'
    // event fires for them WITHOUT the media (body = the file name, hasMedia
    // broken). The page hook downloads the file in-page via WhatsApp's own
    // DownloadManager and hands us plain data; a wwebjs downloadMedia call is
    // the fallback layer. Both funnel into routeMediaPayload; dedup runs on a
    // dedicated `media|` key so the text event never shadows the file.
    // keyed by MESSAGE id (not chat+second) so album photos sent in the same
    // second are each processed
    const mediaKey = (payload) => `media|${payload.msgId || `${payload.chatId}|${payload.timestamp}`}`;
    const routeMediaPayload = async (payload, via) => {
      if (!payload || !payload.dataB64) return;

      const isGroupChat = payload.chatId.endsWith('@g.us');
      const inOurGroups =
        isGroupChat &&
        (payload.chatId === pickingGroup.id._serialized ||
          (photosGroup && payload.chatId === photosGroup.id._serialized));
      // media sent from the bot's own account: only packing PHOTOS in our
      // groups are meaningful (the operator may shoot photos from the same
      // phone the bot is linked to). Everything else own-sent is ignored.
      if (payload.fromMe && !(payload.type === 'image' && inOurGroups)) return;

      const key = mediaKey(payload);
      if (processedMsgs.has(key)) return; // the other layer already handled it
      markProcessed(key);
      writeSettings({ lastSeenTs: Date.now() });
      log.info(`מדיה נקלטה (${via}): ${payload.type} (${payload.filename || payload.mimetype})${payload.fromMe ? ' [מהחשבון של הבוט]' : ''}${payload.caption ? ` + טקסט "${payload.caption.slice(0, 40)}"` : ''}`);

      const pseudoMsg = {
        id: { _serialized: payload.msgId },
        from: payload.chatId,
        author: payload.senderId,
        body: payload.caption || '',
        hasMedia: true,
        type: payload.type,
        timestamp: payload.timestamp,
        hasQuotedMsg: Boolean(payload.quotedId),
        getQuotedMessage: async () => ({ id: { _serialized: payload.quotedId } }),
        downloadMedia: async () => ({
          mimetype: payload.mimetype,
          data: payload.dataB64,
          filename: payload.filename,
        }),
        reply: async (text) => client.sendMessage(payload.chatId, text),
        react: async () => {},
      };

      const isGroup = payload.chatId.endsWith('@g.us');
      if (isGroup) {
        const inPickingGroup = payload.chatId === pickingGroup.id._serialized;
        const inPhotosGroup = photosGroup && payload.chatId === photosGroup.id._serialized;
        if (inPickingGroup || inPhotosGroup) await flow.handleGroupMedia(pseudoMsg);
        return;
      }
      const phoneId = await resolvePhoneId(client, payload.chatId);
      const crmCompanies = sheets.contactCompanies(phoneId);
      const isRep = phoneId === config.sourceContactId;
      if (!isRep && !crmCompanies.length) return;
      const forcedCompany = !isRep && crmCompanies.length === 1 ? crmCompanies[0] : null;
      const candidates = crmCompanies.length > 1 ? crmCompanies : null;
      await flow.handleCustomerMessage(pseudoMsg, forcedCompany, candidates);
    };
    state.routeMediaPayload = routeMediaPayload;

    // Edited messages: dedup per (message, new text) since the collection can
    // fire the change event more than once, then route to the flow.
    const editSeen = new Set();
    const handleEditPayload = async (payload) => {
      if (!payload || !payload.msgId || !payload.newBody) return;
      const editKey = `${payload.msgId}|${require('crypto').createHash('sha1').update(payload.newBody).digest('hex').slice(0, 10)}`;
      if (editSeen.has(editKey)) return;
      editSeen.add(editKey);
      if (payload.chatId.endsWith('@g.us')) return; // group text edits - not order flow
      const phoneId = await resolvePhoneId(client, payload.chatId);
      const crmCompanies = sheets.contactCompanies(phoneId);
      const isRep = phoneId === config.sourceContactId;
      if (!isRep && !crmCompanies.length) return;
      const forcedCompany = !isRep && crmCompanies.length === 1 ? crmCompanies[0] : null;
      const candidates = crmCompanies.length > 1 ? crmCompanies : null;
      await flow.handleEditedMessage(payload, forcedCompany, candidates);
    };

    try {
      await installMediaHook(client, (payload) => {
        if (payload && !payload.dataB64) {
          log.warn(`קובץ מדיה התקבל אך ההורדה בדף נכשלה (${payload.error}) - שכבת הגיבוי תנסה`);
          return;
        }
        routeMediaPayload(payload, 'הוק הדף').catch((err) => log.error('שגיאה בטיפול במדיה:', err));
      }, (payload) => {
        handleEditPayload(payload).catch((err) => log.error('שגיאה בטיפול בעריכה:', err));
      });
    } catch (err) {
      log.error('התקנת הוק המדיה נכשלה:', err.message);
    }

    // Emoji reactions: custom page hook (wwebjs's listener is broken on
    // current WhatsApp Web) + the wwebjs event as backup.
    try {
      await installReactionHook(client, (events) => {
        for (const ev of events) {
          if (!ev.emoji || !ev.parentKey) continue;
          log.info(`ריאקשן נקלט: ${ev.emoji}`);
          flow
            .handleReaction({ reaction: ev.emoji, msgId: ev.parentKey, senderId: ev.sender })
            .catch((err) => log.error('שגיאה בטיפול בריאקשן:', err));
        }
      });
    } catch (err) {
      log.error('התקנת הוק הריאקשנים נכשלה:', err.message);
    }
    client.on('message_reaction', async (reaction) => {
      try {
        await flow.handleReaction(reaction);
      } catch (err) {
        log.error('שגיאה בטיפול בריאקשן:', err);
      }
    });
  });

  await client.initialize();
}

async function stopWhatsApp() {
  if (state.client) {
    log.info('עוצר את חיבור הוואטסאפ (הסשן נשמר - לא יידרש QR מחדש)…');
    await destroyClient(state.client);
  }
  state.client = null;
  state.running = false;
  state.qr = null;
  setState('stopped');
}

async function start({ cli = false, webPanel = true } = {}) {
  exitOnError = cli;

  if (!process.env.ANTHROPIC_API_KEY) {
    return fatal('חסר ANTHROPIC_API_KEY - העתיקו את .env.example ל-.env ומלאו את המפתח.');
  }
  if (!config.pickingGroupName) {
    return fatal('חסר PICKING_GROUP_NAME בקובץ .env (שם קבוצת הליקוט בוואטסאפ).');
  }

  log.info(`מפעיל את פירות העמק — Triple Digital Workforce… [גרסת קוד: ${require('./version').getVersion().label}]`);
  log.info(`נציג: ${config.sourceContact} | חברות: ${config.companies.map((c) => c.name).join(' / ')}`);

  const keyCheck = await require('./ai/parser').checkApiKey();
  if (keyCheck.ok) {
    log.info('מפתח Anthropic תקין ✔');
  } else if (/credit balance is too low/i.test(keyCheck.error)) {
    log.error('למפתח ה-Anthropic אין יתרת קרדיט - טענו קרדיט ב-console.anthropic.com ← Plans & Billing.');
  } else {
    log.error('בדיקת מפתח Anthropic נכשלה:', keyCheck.error);
  }

  // CRM v2 is the central source of truth - always sync and keep polling.
  sheets.startPolling();

  // Channel workers. Each is independent and self-healing: a failure logs a
  // warning and the next interval retries; nothing here can kill the engine.
  const getFlow = () => (state.state === 'connected' && state.flow ? state.flow : null);

  // Fixed base orders from Drive (per-customer schedule). First run shortly
  // after the CRM settles, then refreshed every 30 minutes (cached by content
  // hash - unchanged files are never re-parsed).
  const fixedSync = require('./orders/fixedSync');
  const runFixedSync = async () => {
    try {
      const r = await fixedSync.syncFixedOrders();
      const changed = r.loaded.filter((l) => l.changed);
      log.info(`סנכרון הזמנות קבועות: ${r.loaded.length} לקוחות במאגר (${changed.length} עודכנו, ${r.filesParsed} קבצים פורסרו)`);
      for (const g of r.gaps) log.warn(`הזמנות קבועות: ${g}`);
      if (changed.length) bus.yuval(`עדכנתי הזמנות בסיס מהדרייב: ${changed.map((l) => l.office).join(', ')}`);
    } catch (err) {
      log.warn(`סנכרון הזמנות קבועות נכשל: ${err.message}`);
    }
  };
  setTimeout(runFixedSync, 20000);
  setInterval(runFixedSync, 30 * 60 * 1000);

  // Per-schedule issuance of fixed orders (only on days that have a base).
  const scheduler = require('./orders/scheduler');
  setInterval(() => scheduler.tick(getFlow).catch((err) => log.warn(`לוז קבועות: ${err.message}`)), 60 * 1000);

  // Shared-sheet orders: poll the customers' sheets folder.
  const sheetOrders = require('./orders/sheetOrders');
  const runSheetPoll = () => sheetOrders.pollOnce(getFlow).catch((err) => log.warn(`ערוץ שיטס: ${err.message}`));
  setTimeout(runSheetPoll, 30000);
  setInterval(runSheetPoll, 5 * 60 * 1000);

  // Email inbox (if configured here or later via the connections screen).
  const email = require('./channels/email');
  setTimeout(() => {
    if (email.configured()) email.startPolling(getFlow);
    else log.info('ערוץ המייל לא מוגדר עדיין (מסך החיבורים באפליקציה או EMAIL_USER ב-.env)');
  }, 25000);

  if (webPanel) {
    startWebServer({
      getState: () => ({ state: state.state, running: state.running }),
      getQr: () => state.qr,
      start: startWhatsApp,
      stop: stopWhatsApp,
    });
  }

  if (readSettings().dayEnded) {
    log.info('מצב סוף יום פעיל - ממתין ללחיצה על "התחברות" באפליקציה');
    setState('stopped');
  } else {
    await startWhatsApp();
  }
}

// End-of-day: stop cleanly and remember not to auto-connect on next launch.
async function endDay() {
  writeSettings({ dayEnded: true, lastSeenTs: Date.now() });
  await stopWhatsApp();
  bus.naama('סיימנו את יום העבודה - נתראה מחר');
  bus.yuval('נסגר היום - כל ההזמנות והקבצים שמורים');
}

async function resumeDay() {
  writeSettings({ dayEnded: false });
  await startWhatsApp();
}

// Dashboard data accessors (fresh from disk on every call)
function getStats() {
  return store.todayStats(store.loadDB());
}

function getStatsFull(period) {
  return statsMod.fullStats(config.companies, period);
}

function getComplaints() {
  return complaintsStore.list();
}

function getRules(workerId) {
  return rules.readRules(workerId);
}

// Manager <-> worker chat: answer in character, adopt rules, escalate to the
// Triple team over WhatsApp when out of scope.
async function chatWithWorker(worker, history) {
  const rulebook = rules.readRules(worker.id) || '(אין עדיין ספר חוקים)';
  const result = await workerChat(worker, rulebook, history);
  const busLine = worker.id === 'naama' ? bus.naama : bus.yuval;

  if (result.action === 'add_rule' && result.rule_text) {
    rules.addManagerRule(worker.id, result.rule_text);
    busLine(`עדכנתי את ספר החוקים שלי: ${result.rule_text}`);
  }

  if (result.action === 'escalate' && result.escalation_text) {
    const text =
      `🔔 הודעה מ${worker.name} (העובד/ת הדיגיטלי/ת של פירות העמק):
` +
      `המנהל העלה נושא שדורש את צוות Triple:
"${result.escalation_text}"`;
    if (state.client && state.state === 'connected') {
      const sent = await sendAndConfirm(state.client, config.tripleContactId, text).catch(() => null);
      busLine(sent ? 'שלחתי הודעה לצוות Triple בוואטסאפ' : 'לא הצלחתי לשלוח לצוות Triple - אנסה שוב מאוחר יותר');
      result.escalated = Boolean(sent);
    } else {
      busLine('אשלח לצוות Triple ברגע שחיבור הוואטסאפ יחזור');
      result.escalated = false;
    }
  }
  return result;
}
function getCustomers(date) {
  return store.customersOverview(store.loadDB(), config.companies, date);
}

// Email channel controls for the connections screen
function getEmailStatus() {
  return require('./channels/email').getStatus();
}
async function saveEmailSettings({ user, password, host }) {
  writeSettings({ emailUser: user || '', emailPassword: password || '', emailHost: host || '' });
  const email = require('./channels/email');
  const check = await email.testConnection();
  if (check.ok) {
    email.startPolling(() => (state.state === 'connected' && state.flow ? state.flow : null));
    bus.naama(`חיבור המייל הוגדר (${user}) - מתחילה לעקוב אחרי הזמנות במייל`);
  }
  return check;
}

module.exports = { start, startWhatsApp, stopWhatsApp, endDay, resumeDay, state, bus, getStats, getStatsFull, getComplaints, getRules, chatWithWorker, getCustomers, config, getEmailStatus, saveEmailSettings };
