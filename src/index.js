const { config } = require('./config');
const log = require('./logger');
const { createWhatsAppClient, listGroups, resolvePhoneId } = require('./whatsapp/client');

// A single failed operation must not kill the whole digital worker (NFR-07)
process.on('unhandledRejection', (err) => log.error('שגיאה לא מטופלת:', err));
const { Orchestrator } = require('./flow/orchestrator');

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

  const client = await createWhatsAppClient();

  client.on('ready', async () => {
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
    log.info('ממתין להזמנות… 🍎');

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

    // Emoji reactions (FR-11: sheet printed, picking started)
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

main().catch((err) => {
  log.error('שגיאה קריטית:', err);
  process.exit(1);
});
