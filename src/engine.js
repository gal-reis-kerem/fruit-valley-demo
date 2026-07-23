// The Fruit Valley engine as a library: used by the CLI (src/index.js) and by
// the desktop app (electron/main.js). Emits everything through src/bus.js.
const { config } = require('./config');
const log = require('./logger');
const bus = require('./bus');
const { createWhatsAppClient, listGroups, resolvePhoneId, installReactionHook } = require('./whatsapp/client');
const { Orchestrator } = require('./flow/orchestrator');
const { startWebServer } = require('./web/server');
const { readSettings } = require('./settings');
const sheets = require('./crm/sheets');
const store = require('./orders/store');

// A single failed operation must not kill the whole digital worker (NFR-07)
process.on('unhandledRejection', (err) => log.error('שגיאה לא מטופלת:', err));

const state = { client: null, state: 'stopped', running: false, qr: null, error: null, flow: null };
let exitOnError = true;

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
  await launchClient(1);
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
    try {
      await client.destroy();
    } catch (err) { /* already dead */ }
    state.client = null;
    if (attempt >= 3) {
      state.running = false;
      fatal('החיבור נכשל 3 פעמים ברצף - נעצר. בדקו חיבור אינטרנט והפעילו מחדש.');
      setState('stopped');
      return;
    }
    log.warn(`${reason} - מפעיל מחדש את החיבור (ניסיון ${attempt + 1}/3)…`);
    launchClient(attempt + 1).catch((err) => log.error('הפעלה מחדש נכשלה:', err.message));
  };

  const watchdog = setInterval(() => {
    if (ready || !state.running || state.client !== client) {
      clearInterval(watchdog);
      return;
    }
    if (state.state === 'qr') return; // human is scanning - keep waiting
    clearInterval(watchdog);
    relaunch('החיבור נתקע (לא הבשיל תוך 90 שניות)');
  }, 90000);

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
    log.info(`קבוצת ליקוט: "${pickingGroup.name}"${photosGroup ? ` | קבוצת תמונות: "${photosGroup.name}"` : ''}`);
    setState('connected');
    log.info('ממתין להזמנות… 🍎');

    // Liveness monitor: detect a silently reloaded page and relaunch.
    const liveness = setInterval(async () => {
      if (!state.running || state.client !== client) {
        clearInterval(liveness);
        return;
      }
      const alive = await client.pupPage
        .evaluate(() => typeof window.WWebJS !== 'undefined')
        .catch(() => false);
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

        if (!isGroup) {
          const phoneId = await resolvePhoneId(client, chatId);
          const crmCompanies = sheets.contactCompanies(phoneId);
          const isRep = phoneId === config.sourceContactId;
          if (isRep || crmCompanies.length) {
            const forcedCompany = !isRep && crmCompanies.length === 1 ? crmCompanies[0] : null;
            await flow.handleCustomerMessage(msg, forcedCompany);
          } else {
            log.info(`הודעה פרטית ממספר לא מוגדר (${chatId}${phoneId !== chatId ? ` = ${phoneId}` : ''}) - מתעלם`);
          }
          return;
        }

        const inPickingGroup = chatId === pickingGroup.id._serialized;
        const inPhotosGroup = photosGroup && chatId === photosGroup.id._serialized;
        if ((inPickingGroup || inPhotosGroup) && msg.hasMedia) {
          await flow.handleGroupMedia(msg);
        }
      } catch (err) {
        log.error('שגיאה בטיפול בהודעה:', err);
      }
    });

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
  if (!state.client) return;
  log.info('עוצר את חיבור הוואטסאפ (הסשן נשמר - לא יידרש QR מחדש)…');
  try {
    await state.client.destroy();
  } catch (err) {
    log.warn('עצירה לא נקייה:', err.message);
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

  log.info('מפעיל את פירות העמק — Triple Digital Workforce…');
  log.info(`נציג: ${config.sourceContact} | חברות: ${config.companies.map((c) => c.name).join(' / ')}`);

  const keyCheck = await require('./ai/parser').checkApiKey();
  if (keyCheck.ok) {
    log.info('מפתח Anthropic תקין ✔');
  } else if (/credit balance is too low/i.test(keyCheck.error)) {
    log.error('למפתח ה-Anthropic אין יתרת קרדיט - טענו קרדיט ב-console.anthropic.com ← Plans & Billing.');
  } else {
    log.error('בדיקת מפתח Anthropic נכשלה:', keyCheck.error);
  }

  // CRM: if a sheet was configured in the wizard, keep companies in sync.
  const settings = readSettings();
  if (settings.sheetUrl) sheets.startPolling(settings.sheetUrl);

  if (webPanel) {
    startWebServer({
      getState: () => ({ state: state.state, running: state.running }),
      getQr: () => state.qr,
      start: startWhatsApp,
      stop: stopWhatsApp,
    });
  }

  await startWhatsApp();
}

// Dashboard data accessors (fresh from disk on every call)
function getStats() {
  return store.todayStats(store.loadDB());
}
function getCustomers() {
  return store.customersOverview(store.loadDB(), config.companies);
}

module.exports = { start, startWhatsApp, stopWhatsApp, state, bus, getStats, getCustomers, config };
