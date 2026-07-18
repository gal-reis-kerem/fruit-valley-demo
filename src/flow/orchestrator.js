const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('../logger');
const { parseOrderMessage } = require('../ai/parser');
const store = require('../orders/store');
const { generatePickingSheetPDF } = require('../pdf/generator');
const { MessageMedia } = require('../whatsapp/client');

/**
 * The core business flow (PRD "זרימת המוצר המרכזית", steps 1-8):
 *  1. Office manager sends an order on WhatsApp            -> handleCustomerMessage
 *  2. Ack + classification                                 -> FR-01/02/03
 *  3. Attribution to company (fixed per source number)     -> FR-04
 *  4. Message becomes a structured picking list            -> FR-05/06/07/08
 *  5. Picking sheet PDF is sent to the picking group       -> FR-10
 *  6. Picker reacts with an emoji (= printed, picking)     -> FR-11 -> handleReaction
 *  7. Photo request is created, attributed to the order    -> FR-12
 *  8. Photos are attached to the order                     -> FR-13 -> handleGroupMedia
 */
class Orchestrator {
  constructor(client, { pickingGroup, photosGroup }) {
    this.client = client;
    this.pickingGroup = pickingGroup; // Chat object
    this.photosGroup = photosGroup;   // Chat object or null
    this.db = store.loadDB();
  }

  save() {
    store.saveDB(this.db);
  }

  isAfterCutoff(now = new Date()) {
    const [h, m] = config.changesCutoff.split(':').map(Number);
    const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    return israelNow.getHours() > h || (israelNow.getHours() === h && israelNow.getMinutes() >= m);
  }

  // ---------- Step 1-5: incoming customer message ----------
  async handleCustomerMessage(msg) {
    const body = (msg.body || '').trim();
    log.info(`הודעה מ-${config.customerName}: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`);

    if (!body && msg.hasMedia) {
      // A bare image from the customer (e.g. photo of a specific product) —
      // attach it to the open order if there is one.
      const open = store.findOpenOrder(this.db, config.customerName);
      if (open) {
        await this.saveMediaToOrder(msg, open, 'customer-image');
        store.addHistory(open, 'customer_image_attached', 'תמונה מהלקוח צורפה להזמנה');
        this.save();
        await msg.reply(`📎 התמונה צורפה להזמנה ${open.id}.`);
      }
      return;
    }
    if (!body) return;

    let parsed;
    try {
      parsed = await parseOrderMessage(body);
    } catch (err) {
      log.error('פרסור הודעה נכשל:', err.message);
      await msg.reply('⚠️ לא הצלחתי לעבד את ההודעה, נציג אנושי יטפל בה.');
      return;
    }

    log.info(`סיווג: ${parsed.classification}, פריטים: ${parsed.items.length}`);

    switch (parsed.classification) {
      case 'new_order':
        return this.handleNewOrder(msg, parsed, body);
      case 'addition':
      case 'change':
        return this.handleAddition(msg, parsed, body);
      case 'cancellation':
        return this.handleCancellation(msg, parsed);
      default:
        return msg.reply('👋 ההודעה התקבלה. אם זו הזמנה - נא לשלוח את רשימת הפריטים.');
    }
  }

  async handleNewOrder(msg, parsed, rawBody) {
    const deliveryDate =
      parsed.delivery_date || new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    const order = store.createOrder(this.db, {
      deliveryDate,
      customerName: config.customerName,
      customerNote: parsed.customer_note,
      items: parsed.items,
      rawMessage: rawBody,
    });
    this.save();

    // FR-02: immediate ack with order number + changes-cutoff guidance
    const deliveryHe = new Date(deliveryDate + 'T00:00:00').toLocaleDateString('he-IL');
    await msg.reply(
      `✅ ההזמנה התקבלה!\n` +
        `מספר הזמנה: *${order.id}*\n` +
        `לקוח: ${order.customerName}\n` +
        `אספקה: ${deliveryHe}\n` +
        `פריטים: ${order.items.length}\n\n` +
        `ניתן לשלוח שינויים ותוספות עד השעה ${config.changesCutoff}.`,
    );

    await this.sendPickingSheet(order);
  }

  async handleAddition(msg, parsed, rawBody) {
    const order = store.findOpenOrder(this.db, config.customerName);
    if (!order) {
      // No open order — treat the addition as a new order
      log.info('אין הזמנה פתוחה - התוספת נפתחת כהזמנה חדשה');
      return this.handleNewOrder(msg, parsed, rawBody);
    }

    // FR-09: attach the addition to the right order and record whether it
    // arrived before or after the sheet was printed.
    const printed = ['picking', 'awaiting_photos'].includes(order.status);
    const late = this.isAfterCutoff();
    for (const item of parsed.items) {
      order.items.push({ ...item, addedAfterPrint: printed, addedLate: !printed && late });
    }
    order.rawMessages.push(rawBody);
    store.addHistory(
      order,
      'addition_received',
      `${parsed.items.length} פריטים (${printed ? 'אחרי הדפסה' : late ? 'אחרי שעת הסגירה' : 'לפני הדפסה'})`,
    );

    const itemsList = parsed.items
      .map((it) => `• ${it.product_he}${it.quantity ? ` - ${it.quantity} ${it.unit}` : ''}${it.note ? ` (${it.note})` : ''}`)
      .join('\n');

    await msg.reply(
      `✅ התוספת נקלטה ושויכה להזמנה *${order.id}*:\n${itemsList}` +
        (printed ? `\n\n⚠️ דף הליקוט כבר הודפס - התוספת תועבר למלקטים כתגובה בקבוצה.` : ''),
    );

    if (printed) {
      // Sheet already printed: reply to the PDF message in the picking group
      // (mirrors the real-world "reply to the PDF" practice).
      await this.client.sendMessage(
        this.pickingGroup.id._serialized,
        `➕ *תוספת להזמנה ${order.id}* (${order.customerName}):\n${itemsList}`,
        order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {},
      );
      store.addHistory(order, 'addition_sent_to_group', 'התוספת נשלחה כתגובה לקבוצת הליקוט');
      this.save();
    } else {
      // Not printed yet: regenerate the sheet (new version) and resend
      order.version += 1;
      this.save();
      await this.sendPickingSheet(order, { updated: true });
    }
  }

  async handleCancellation(msg, parsed) {
    const order = store.findOpenOrder(this.db, config.customerName);
    if (!order) {
      return msg.reply('לא נמצאה הזמנה פתוחה לביטול.');
    }
    order.status = 'cancelled';
    store.addHistory(order, 'order_cancelled', 'בוטלה לבקשת הלקוח');
    this.save();
    await msg.reply(`🚫 הזמנה *${order.id}* בוטלה.`);
    await this.client.sendMessage(
      this.pickingGroup.id._serialized,
      `🚫 *הזמנה ${order.id} (${order.customerName}) בוטלה* - נא לא ללקט.`,
      order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {},
    );
  }

  // ---------- Step 5: PDF to the picking group ----------
  async sendPickingSheet(order, { updated = false } = {}) {
    const pdfPath = await generatePickingSheetPDF(order);
    order.pdfPath = pdfPath;

    const deliveryHe = new Date(order.deliveryDate + 'T00:00:00').toLocaleDateString('he-IL');
    const media = MessageMedia.fromFilePath(pdfPath);
    const caption =
      `${updated ? '🔄 *דף ליקוט מעודכן*' : '🧺 *דף ליקוט חדש*'}\n` +
      `לקוח: ${order.customerName}\n` +
      `הזמנה: ${order.id} (גרסה ${order.version})\n` +
      `אספקה: ${deliveryHe}\n` +
      `פריטים: ${order.items.length}\n\n` +
      `👍 סמנו בריאקשן על ההודעה כשהדף הודפס והליקוט החל`;

    const sent = await this.client.sendMessage(this.pickingGroup.id._serialized, media, {
      caption,
      sendMediaAsDocument: true,
    });

    order.groupMsgId = sent.id._serialized;
    order.status = 'sent_to_group';
    store.addHistory(order, 'pdf_sent_to_group', `גרסה ${order.version} נשלחה לקבוצה "${this.pickingGroup.name}"`);
    this.save();
    log.info(`דף ליקוט ${order.id} v${order.version} נשלח לקבוצת הליקוט`);
  }

  // ---------- Step 6-7: emoji reaction -> photo request ----------
  async handleReaction(reaction) {
    if (!reaction.reaction) return; // reaction removed
    const msgId = reaction.msgId && reaction.msgId._serialized;
    if (!msgId) return;

    const order = store.findByGroupMsgId(this.db, msgId);
    if (!order || order.status !== 'sent_to_group') return;

    order.status = 'picking';
    order.reaction = { emoji: reaction.reaction, by: reaction.senderId, at: new Date().toISOString() };
    store.addHistory(order, 'picking_started', `ריאקשן ${reaction.reaction} - הדף הודפס והליקוט החל`);
    this.save();
    log.info(`הזמנה ${order.id}: זוהה ריאקשן ${reaction.reaction} - הליקוט החל`);

    // FR-12: photo request with company, order number and date
    const deliveryHe = new Date(order.deliveryDate + 'T00:00:00').toLocaleDateString('he-IL');
    const requestText =
      `📸 *בקשת תמונות תיעוד*\n` +
      `חברה: ${order.customerName}\n` +
      `הזמנה: ${order.id}\n` +
      `תאריך אספקה: ${deliveryHe}\n\n` +
      `בסיום הליקוט נא לצרף כתגובה להודעה זו:\n` +
      `1️⃣ תמונת דף הליקוט המסומן (עם ההערות)\n` +
      `2️⃣ תמונת המשלוח הארוז`;

    const targetChat = this.photosGroup || this.pickingGroup;
    const opts = !this.photosGroup && order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {};
    const sent = await this.client.sendMessage(targetChat.id._serialized, requestText, opts);

    order.photoRequestMsgId = sent.id._serialized;
    order.status = 'awaiting_photos';
    store.addHistory(order, 'photo_request_sent', `נשלחה לקבוצה "${targetChat.name}"`);
    this.save();
  }

  // ---------- Step 8: photos -> attached to the order ----------
  async handleGroupMedia(msg) {
    if (!msg.hasMedia) return;

    // Prefer explicit attribution: a reply to the photo request / PDF message.
    let order = null;
    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      const qid = quoted.id._serialized;
      order =
        this.db.orders.find((o) => o.photoRequestMsgId === qid) ||
        store.findByGroupMsgId(this.db, qid);
    }
    // Fallback (FR-13): attribute to the most recent order awaiting photos.
    if (!order) order = store.findAwaitingPhotos(this.db);
    if (!order || !['awaiting_photos', 'picking'].includes(order.status)) return;

    const savedPath = await this.saveMediaToOrder(msg, order, 'evidence');
    if (!savedPath) return;

    store.addHistory(order, 'photo_attached', path.basename(savedPath));
    log.info(`הזמנה ${order.id}: צורפה תמונה (${order.photos.length}/2)`);

    // Documentation is complete after the two required photos (marked sheet +
    // packed shipment).
    if (order.photos.length >= 2 && order.status !== 'documented') {
      order.status = 'documented';
      store.addHistory(order, 'order_documented', 'התקבלו שתי תמונות התיעוד - ההזמנה מתועדת ומוכנה להמשך תהליך');
      this.save();
      await msg.reply(`✅ הזמנה *${order.id}* תועדה במלואה (דף מסומן + משלוח ארוז). תודה!`);
    } else {
      this.save();
      await msg.react('👍');
    }
  }

  async saveMediaToOrder(msg, order, prefix) {
    try {
      const media = await msg.downloadMedia();
      if (!media) return null;
      const ext = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
      const fileName = `${prefix}-${order.photos.length + 1}-${Date.now()}.${ext}`;
      const filePath = path.join(store.orderDir(order), fileName);
      fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
      order.photos.push({ path: filePath, from: msg.author || msg.from, at: new Date().toISOString() });
      return filePath;
    } catch (err) {
      log.error('שמירת מדיה נכשלה:', err.message);
      return null;
    }
  }
}

module.exports = { Orchestrator };
