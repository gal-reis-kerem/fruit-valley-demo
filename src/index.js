const { config } = require('./config');
const log = require('./logger');
const { createWhatsAppClient, listGroups, resolvePhoneId, installReactionHook } = require('./whatsapp/client');
const { Orchestrator } = require('./flow/orchestrator');
const { startWebServer } = require('./web/server');

// A single failed operation must not kill the whole digital worker (NFR-07)
process.on('unhandledRejection', (err) => log.error('שגיאה לא מטופלת:', err));

// Shared connection state, exposed to the local control panel
const state = { client: null, state: 'stopped', running: false, qr: null };

async function startWhatsApp() {
  if (state.running) return;
  state.running = true;
  await launchClient(1);
}

// Self-healing launcher. Right after the Mac wakes from sleep the network may
// not be up yet and WhatsApp Web can hang forever between 'authenticated' and
// 'ready' — a watchdog detects the stall and relaunches the browser (up to 3
// attempts). A mid-day disconnect triggers an automatic reconnect too.
async function launchClient(attempt) {
  state.state = 'starting';
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
      state.state = 'stopped';
      log.error('החיבור נכשל 3 פעמים ברצף - נעצר. בדוק חיבור אינטרנט והפעל מחדש ממסך הבקרה או npm start.');
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
    state.state = 'qr';
  });
  client.on('authenticated', () => {
    state.qr = null;
    state.state = 'starting';
  });
  client.on('disconnected', () => {
    state.state = 'disconnected';
    setTimeout(() => relaunch('החיבור לוואטסאפ נותק'), 10000);
  });

  client.on('ready', async () => {
    ready = true;
    attempt = 1; // a successful connection resets the retry budget
    clearInterval(watchdog);
    log.info('וואטסאפ מחובר ✔ (טוען את רשימת הקבוצות - אחרי קישור ראשון זה יכול לקחת עד דקה)');

    let groups;
    try {
      groups = await listGroups(client);
    } catch (err) {
      log.error('קריאת רשימת הצ׳אטים נכשלה גם אחרי מספר ניסיונות:', err.message);
      log.info('בדרך כלל זה קורה מיד אחרי קישור ראשון, בזמן שהצ׳אטים מסתנכרנים. המתן דקה והפעל שוב: npm start');
      process.exit(1);
    }

    const toChatRef = (g) => ({ id: { _serialized: g.id }, name: g.name });
    const pickingGroupRaw = groups.find((g) => g.name === config.pickingGroupName);
    if (!pickingGroupRaw) {
      log.error(`קבוצת הליקוט "${config.pickingGroupName}" לא נמצאה.`);
      log.info('קבוצות זמינות בחשבון:');
      groups.forEach((g) => log.info(`  - ${g.name}`));
      log.info('עדכן את PICKING_GROUP_NAME בקובץ .env והפעל שוב.');
      process.exit(1);
    }
    const pickingGroup = toChatRef(pickingGroupRaw);

    let photosGroup = null;
    if (config.photosGroupName) {
      const photosGroupRaw = groups.find((g) => g.name === config.photosGroupName);
      if (photosGroupRaw) photosGroup = toChatRef(photosGroupRaw);
      else log.warn(`קבוצת התמונות "${config.photosGroupName}" לא נמצאה - בקשות תמונות יישלחו לקבוצת הליקוט.`);
    }

    const flow = new Orchestrator(client, { pickingGroup, photosGroup });
    log.info(`קבוצת ליקוט: "${pickingGroup.name}"${photosGroup ? ` | קבוצת תמונות: "${photosGroup.name}"` : ''}`);
    state.state = 'connected';
    log.info('ממתין להזמנות… 🍎');

    // Liveness monitor: WhatsApp Web occasionally reloads its page silently
    // (e.g. a version nudge). The process keeps running but every listener is
    // gone — messages stop arriving with no error. Detect the dead page and
    // relaunch automatically.
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

    // Incoming messages. Everything is derived from msg.from directly —
    // msg.getChat() goes through wwebjs's chat serializer, which is broken on
    // current WhatsApp Web versions.
    client.on('message', async (msg) => {
      try {
        const chatId = msg.from; // '<phone>@c.us' private / '<id>@g.us' group
        const isGroup = chatId.endsWith('@g.us');

        // 1) Private message from the configured customer number -> order flow.
        // chatId may be an anonymized '@lid' — resolve it to the phone id first.
        if (!isGroup) {
          const phoneId = await resolvePhoneId(client, chatId);
          if (phoneId === config.sourceContactId) {
            await flow.handleCustomerMessage(msg);
          } else {
            log.info(`הודעה פרטית ממספר לא מוגדר (${chatId}${phoneId !== chatId ? ` = ${phoneId}` : ''}) - מתעלם`);
          }
          return;
        }

        // 2) Media inside the picking/photos group -> evidence photos
        const inPickingGroup = chatId === pickingGroup.id._serialized;
        const inPhotosGroup = photosGroup && chatId === photosGroup.id._serialized;
        if ((inPickingGroup || inPhotosGroup) && msg.hasMedia) {
          await flow.handleGroupMedia(msg);
        }
      } catch (err) {
        log.error('שגיאה בטיפול בהודעה:', err);
      }
    });

    // Emoji reactions (FR-11: sheet printed, picking started).
    // wwebjs's own listener is broken on current WhatsApp Web, so reactions
    // arrive through our page hook; the wwebjs event stays as a backup.
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
  state.state = 'stopped';
  state.qr = null;
  log.info('החיבור נעצר. אפשר להפעיל מחדש מהמסך או עם npm start');
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('חסר ANTHROPIC_API_KEY - העתק את .env.example ל-.env ומלא את המפתח.');
    process.exit(1);
  }
  if (!config.pickingGroupName) {
    log.error('חסר PICKING_GROUP_NAME בקובץ .env (שם קבוצת הליקוט בוואטסאפ).');
    process.exit(1);
  }

  log.info('מפעיל את הדמו של פירות העמק…');
  log.info(`לקוח: ${config.customerName} | מספר מקור: ${config.sourceContact}`);

  const keyCheck = await require('./ai/parser').checkApiKey();
  if (keyCheck.ok) {
    log.info('מפתח Anthropic תקין ✔');
  } else if (/credit balance is too low/i.test(keyCheck.error)) {
    log.error('למפתח ה-Anthropic אין יתרת קרדיט - יש לטעון קרדיט ב-console.anthropic.com ← Plans & Billing.');
    log.warn('האפליקציה תעלה, אבל פרסור הזמנות ייכשל עד שיהיה קרדיט.');
  } else {
    log.error('בדיקת מפתח Anthropic נכשלה:', keyCheck.error);
    log.warn('האפליקציה תעלה, אבל פרסור הזמנות עלול להיכשל.');
  }

  startWebServer({
    getState: () => ({ state: state.state, running: state.running }),
    getQr: () => state.qr,
    start: startWhatsApp,
    stop: stopWhatsApp,
  });

  await startWhatsApp();
}

main().catch((err) => {
  log.error('שגיאה קריטית:', err);
  process.exit(1);
});
