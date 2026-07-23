const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('../logger');
const { parseOrderMessage } = require('../ai/parser');
const store = require('../orders/store');
const { generatePickingSheetPDF } = require('../pdf/generator');
const { MessageMedia, sendAndConfirm, resolvePhoneId } = require('../whatsapp/client');
const replies = require('./replies');
const bus = require('../bus');

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
    // A parsed order waiting for the rep to answer "which company?"
    this.pending = null; // { parsed, rawBody, at }
  }

  // ---------- company resolution (the rep orders for several companies) ----
  findCompany(name) {
    if (!name) return null;
    const n = String(name).trim().toLowerCase();
    return (
      config.companies.find(
        (c) => c.name.toLowerCase() === n || c.nameEn.toLowerCase() === n,
      ) || null
    );
  }

  matchCompanyByText(text) {
    const t = String(text || '').toLowerCase();
    return (
      config.companies.find(
        (c) =>
          t.includes(c.name.toLowerCase()) ||
          t.includes(c.nameEn.toLowerCase()) ||
          (c.aliases || []).some((a) => t.includes(a.toLowerCase())),
      ) || null
    );
  }

  companyOptions() {
    return config.companies.map((c) => c.name).join(' / ');
  }

  save() {
    store.saveDB(this.db);
  }

  // Re-read the DB from disk at every entry point, so external cleanup or
  // edits (e.g. wiping orders.json) take effect immediately — the in-memory
  // copy must never resurrect deleted data.
  reload() {
    this.db = store.loadDB();
  }

  // msg.reply quotes the original message; on broken WhatsApp Web versions the
  // quoting path can fail, so fall back to a plain send to the same chat.
  async safeReply(msg, text) {
    try {
      return await msg.reply(text);
    } catch (err) {
      log.warn(`reply נכשל (${err.message}) - שולח בלי ציטוט`);
      return this.client.sendMessage(msg.from, text);
    }
  }

  async safeReact(msg, emoji) {
    try {
      await msg.react(emoji);
    } catch (err) {
      log.warn(`react נכשל (${err.message}) - ממשיך בלעדיו`);
    }
  }

  isAfterCutoff(now = new Date()) {
    const [h, m] = config.changesCutoff.split(':').map(Number);
    const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    return israelNow.getHours() > h || (israelNow.getHours() === h && israelNow.getMinutes() >= m);
  }

  // ---------- Step 1-5: incoming customer message ----------
  // forcedCompany: when the sender is a CRM contact of exactly one company,
  // attribution is automatic and the "which company?" question is skipped.
  async handleCustomerMessage(msg, forcedCompany = null) {
    this.reload();
    const body = (msg.body || '').trim();
    log.info(`הודעה מהנציג: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`);
    bus.naama('הודעה חדשה התקבלה בוואטסאפ');

    if (!body && msg.hasMedia) {
      // A bare image from the customer (e.g. photo of a specific product) —
      // attach it to the most recent open order across all companies.
      const open = config.companies
        .map((c) => store.findOpenOrder(this.db, c.name))
        .filter(Boolean)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (open) {
        await this.saveMediaToOrder(msg, open, 'customer-image');
        store.addHistory(open, 'customer_image_attached', 'תמונה מהלקוח צורפה להזמנה');
        this.save();
        await this.safeReply(msg, `📎 התמונה צורפה להזמנה ${open.id}.`);
      }
      return;
    }
    if (!body) return;

    // Is this the answer to a pending "which company?" question?
    if (this.pending) {
      const company = this.matchCompanyByText(body);
      if (company) {
        const { parsed, rawBody } = this.pending;
        this.pending = null;
        log.info(`החברה זוהתה מהתשובה: ${company.name}`);
        bus.naama(`הלקוח ענה: ${company.name} — משייכת את ההזמנה`);
        return this.dispatchParsed(msg, parsed, rawBody, company);
      }
      // Not a company answer — drop the pending draft and process normally
      log.info('התקבלה הודעה שאינה תשובת חברה - הטיוטה הממתינה נמחקת');
      this.pending = null;
    }

    let parsed;
    try {
      parsed = await parseOrderMessage(body);
    } catch (err) {
      log.error('פרסור הודעה נכשל:', err.message);
      await this.safeReply(msg, '⚠️ לא הצלחתי לעבד את ההודעה, נציג אנושי יטפל בה.');
      return;
    }

    log.info(`סיווג: ${parsed.classification}, פריטים: ${parsed.items.length}, חברה: ${parsed.company || 'לא צוינה'}`);
    bus.naama(`קוראת את ההודעה: ${parsed.items.length ? `${parsed.items.length} פריטים` : 'הודעה כללית'}${parsed.company ? ` · ${parsed.company}` : ''}`);

    if (parsed.classification === 'general') {
      return this.safeReply(msg, this.customerText(parsed, null, replies.general()));
    }

    // Attribute the order to a company (FR-04). The rep serves several
    // companies — if none was named, ask and hold the draft. A single-company
    // CRM contact is attributed automatically.
    const company =
      forcedCompany || this.findCompany(parsed.company) || this.matchCompanyByText(parsed.company || '');
    if (!company) {
      // An addition/change/cancellation with exactly one open order overall
      // attaches to it without nagging the rep.
      if (['addition', 'change', 'cancellation'].includes(parsed.classification)) {
        const opens = config.companies
          .map((c) => store.findOpenOrder(this.db, c.name))
          .filter(Boolean);
        if (opens.length === 1) {
          const only = this.findCompany(opens[0].customerName);
          if (only) {
            log.info(`אין ציון חברה אבל יש הזמנה פתוחה יחידה (${opens[0].id}) - משייך אליה`);
            return this.dispatchParsed(msg, parsed, body, only);
          }
        }
      }
      this.pending = { parsed, rawBody: body, at: Date.now() };
      bus.naama('לא צוינה חברה — שואלת את הלקוח לאיזו חברה ההזמנה');
      const question =
        parsed.reply_text && !parsed.reply_text.includes('{{ORDER}}')
          ? parsed.reply_text
          : `קיבלתי! לאיזו חברה ההזמנה - ${this.companyOptions()}? 🙏`;
      return this.safeReply(msg, question);
    }

    return this.dispatchParsed(msg, parsed, body, company);
  }

  dispatchParsed(msg, parsed, rawBody, company) {
    switch (parsed.classification) {
      case 'new_order':
        return this.handleNewOrder(msg, parsed, rawBody, company);
      case 'addition':
      case 'change':
        return this.handleAddition(msg, parsed, rawBody, company);
      case 'cancellation':
        return this.handleCancellation(msg, parsed, company);
      default:
        return this.safeReply(msg, this.customerText(parsed, null, replies.general()));
    }
  }

  // Claude writes the customer-facing reply (natural, varies every message);
  // {{ORDER}} is replaced with the unified order number. Falls back to the
  // static variants if the model omitted the token.
  customerText(parsed, order, fallback) {
    const t = parsed && parsed.reply_text;
    if (!t) return fallback;
    if (!order) return t;
    if (!t.includes('{{ORDER}}')) return fallback;
    return t.split('{{ORDER}}').join(order.id);
  }

  async handleNewOrder(msg, parsed, rawBody, company) {
    const deliveryDate =
      parsed.delivery_date || new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    // One board per company per delivery date: a second "new order" message
    // for the same date merges into the existing open order.
    const existing = store.findOpenOrderForDate(this.db, company.name, deliveryDate);
    if (existing) {
      log.info(`כבר קיימת הזמנה פתוחה של ${company.name} ל-${deliveryDate} (${existing.id}) - ההודעה מתמזגת לתוכה`);
      return this.applyAddition(msg, existing, parsed, rawBody);
    }

    const order = store.createOrder(this.db, {
      deliveryDate,
      customerName: company.name,
      customerNameEn: company.nameEn,
      initials: company.initials,
      customerNote: parsed.customer_note,
      locationDetail: parsed.location_detail,
      items: parsed.items,
      rawMessage: rawBody,
    });
    this.save();

    // FR-02: immediate, human-sounding ack with the unified order number
    bus.naama(`הזמנה חדשה של ${order.customerName} — ${order.items.length} פריטים`, true);
    await this.safeReply(msg, this.customerText(parsed, order, replies.newOrder(order, config.changesCutoff)));
    bus.naama(`שלחה אישור ללקוח · מספר הזמנה ${order.id}`);
    bus.naama('מעבירה את ההזמנה הנקייה ליובל');

    await this.sendPickingSheet(order);
  }

  async handleAddition(msg, parsed, rawBody, company) {
    const order = store.findOpenOrder(this.db, company.name);
    if (!order) {
      // No open order for this company — treat the addition as a new order
      log.info(`אין הזמנה פתוחה ל-${company.name} - התוספת נפתחת כהזמנה חדשה`);
      return this.handleNewOrder(msg, parsed, rawBody, company);
    }
    return this.applyAddition(msg, order, parsed, rawBody);
  }

  // FR-09: apply an addition/change (including item removals) to the order
  // and record whether it arrived before or after picking started.
  async applyAddition(msg, order, parsed, rawBody) {
    const printed = Boolean(order.reaction); // a reaction means the sheet is printed
    const late = this.isAfterCutoff();

    const added = parsed.items.filter((it) => it.action !== 'remove');
    const removals = parsed.items.filter((it) => it.action === 'remove');

    for (const item of added) {
      order.items.push({ ...item, addedAfterPrint: printed, addedLate: !printed && late });
    }

    // Remove items by (normalized) Hebrew-name match
    const removed = [];
    const notFound = [];
    for (const rem of removals) {
      const needle = rem.product_he.trim();
      const idx = order.items.findIndex(
        (it) => it.product_he.includes(needle) || needle.includes(it.product_he),
      );
      if (idx >= 0) removed.push(...order.items.splice(idx, 1));
      else notFound.push(needle);
    }

    if (parsed.customer_note) {
      order.customerNote = order.customerNote ? `${order.customerNote} | ${parsed.customer_note}` : parsed.customer_note;
    }
    order.rawMessages.push(rawBody);
    store.addHistory(
      order,
      'order_updated',
      `+${added.length} פריטים, -${removed.length} הוסרו${notFound.length ? ` (לא נמצאו: ${notFound.join(', ')})` : ''}` +
        ` (${printed ? 'אחרי תחילת ליקוט' : late ? 'אחרי שעת הסגירה' : 'לפני הדפסה'})`,
    );

    bus.naama(`עדכון להזמנה ${order.id}: ${added.length ? `+${added.length} פריטים` : ''}${removed.length ? ` -${removed.length} הוסרו` : ''}`.trim());
    const fmt = (it) => `• ${it.product_he}${it.quantity ? ` - ${it.quantity} ${it.unit}` : ''}${it.note ? ` (${it.note})` : ''}`;
    const changesList = [
      ...added.map((it) => `➕ ${fmt(it).slice(2)}`),
      ...removed.map((it) => `➖ ${it.product_he}`),
    ].join('\n');

    await this.safeReply(
      msg,
      this.customerText(parsed, order, printed ? replies.additionAfterPrint(order) : replies.addition(order)),
    );
    if (notFound.length) {
      await this.safeReply(msg, `לא מצאתי בהזמנה את: ${notFound.join(', ')} - אפשר לבדוק את הניסוח? 🙏`);
    }

    if (printed) {
      // Picking already started: don't resend the sheet - update the pickers
      // as a reply to the PDF message (mirrors the real-world practice).
      await sendAndConfirm(
        this.client,
        this.pickingGroup.id._serialized,
        `✏️ *עדכון להזמנה ${order.id}* (${order.customerName}):\n${changesList}`,
        order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {},
      );
      store.addHistory(order, 'update_sent_to_group', 'העדכון נשלח כתגובה לקבוצת הליקוט');

      // Backend-only: regenerate the final sheet into the customer folder so
      // the admin always has the latest full version for invoicing. The
      // pickers keep working off the printed page + the text update.
      order.version += 1;
      order.pdfPath = await generatePickingSheetPDF(order);
      store.addHistory(order, 'pdf_regenerated', `גרסה ${order.version} הופקה לתיקייה בלבד (השינוי הגיע אחרי ההדפסה)`);
      bus.yuval(`שינוי אחרי הדפסה — מעדכן מלקטים ומפיק גרסה ${order.version} לתיקיית הלקוח`);

      // Alert the photos group so the manager can reconcile post-print changes
      const what =
        added.length && removed.length
          ? 'נוספו והוסרו פריטים'
          : removed.length
            ? 'הוסרו פריטים'
            : 'נוספו פריטים';
      const alertChat = this.photosGroup || this.pickingGroup;
      await sendAndConfirm(
        this.client,
        alertChat.id._serialized,
        `⚠️ שימו לב שבהזמנה *${order.id}* של *${order.customerName}* ${what} אחרי ההדפסה:\n${changesList}`,
        order.photoRequestMsgId ? { quotedMessageId: order.photoRequestMsgId } : {},
      );
      store.addHistory(order, 'postprint_notice_sent', 'הודעת שינוי אחרי הדפסה נשלחה לקבוצת התמונות');
      this.save();
    } else {
      // Regenerate the sheet (new version) and resend
      order.version += 1;
      this.save();
      await this.sendPickingSheet(order, { updated: true });
    }
  }

  async handleCancellation(msg, parsed, company) {
    const order = store.findOpenOrder(this.db, company.name);
    if (!order) {
      return this.safeReply(msg, 'לא נמצאה הזמנה פתוחה לביטול.');
    }
    order.status = 'cancelled';
    store.addHistory(order, 'order_cancelled', 'בוטלה לבקשת הלקוח');
    this.save();
    await this.safeReply(msg, this.customerText(parsed, order, replies.cancellation(order)));
    await sendAndConfirm(
      this.client,
      this.pickingGroup.id._serialized,
      `🚫 *הזמנה ${order.id} (${order.customerName}) בוטלה* - נא לא ללקט.`,
      order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {},
    );
  }

  // ---------- Step 5: PDF to the picking group ----------
  async sendPickingSheet(order, { updated = false } = {}) {
    bus.yuval(`${updated ? 'מעדכן' : 'מכין'} דף ליקוט ${order.id} (גרסה ${order.version}) בעברית, אנגלית ותאית…`, !updated);
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

    const msgId = await sendAndConfirm(this.client, this.pickingGroup.id._serialized, media, {
      caption,
      sendMediaAsDocument: true,
    });

    if (msgId) {
      order.groupMsgId = msgId;
    } else {
      log.warn('לא אותר מזהה להודעת ה-PDF - ריאקשן יזוהה לפי ההזמנה האחרונה שנשלחה');
    }
    order.status = 'sent_to_group';
    store.addHistory(order, 'pdf_sent_to_group', `גרסה ${order.version} נשלחה לקבוצה "${this.pickingGroup.name}"`);
    this.save();
    log.info(`דף ליקוט ${order.id} v${order.version} נשלח לקבוצת הליקוט`);
    bus.yuval(`דף הליקוט ${order.id} נשלח לקבוצת ההדפסות`);

    // The photos-group side runs in lockstep with every PDF, so no shipment
    // falls between the chairs: first send opens the photo thread, updates
    // announce the latest sheet version.
    if (!order.photoRequestMsgId) {
      await this.sendPhotoRequest(order);
    } else {
      const noticeChat = this.photosGroup || this.pickingGroup;
      await sendAndConfirm(
        this.client,
        noticeChat.id._serialized,
        `⚠️ שימו לב שבמשלוח של *${order.customerName}* הגרסה העדכנית ביותר היא גרסה *${order.version}*`,
        order.photoRequestMsgId ? { quotedMessageId: order.photoRequestMsgId } : {},
      );
      store.addHistory(order, 'version_notice_sent', `הודעת גרסה ${order.version} נשלחה לקבוצת התמונות`);
      bus.yuval(`עדכנתי את קבוצת התיעוד: הגרסה העדכנית של ${order.customerName} היא ${order.version}`);
      this.save();
    }
  }

  // FR-12: photo request, attributed to the order - sent together with the
  // first picking sheet.
  async sendPhotoRequest(order) {
    const requestText =
      `📸 אנא השב להודעה זו עבור ההזמנה של:\n` +
      `*${order.customerName}*\n` +
      `מספר הזמנה\n` +
      `*${order.id}*\n\n` +
      `1. תמונה של דף הליקוט\n` +
      `2. תמונה של המשלוח המוכן`;

    const targetChat = this.photosGroup || this.pickingGroup;
    const opts = !this.photosGroup && order.groupMsgId ? { quotedMessageId: order.groupMsgId } : {};
    const requestMsgId = await sendAndConfirm(this.client, targetChat.id._serialized, requestText, opts);

    order.photoRequestMsgId = requestMsgId; // null is fine — photos attach via fallback
    order.status = 'awaiting_photos';
    store.addHistory(order, 'photo_request_sent', `נשלחה לקבוצה "${targetChat.name}"`);
    this.save();
    log.info(`הזמנה ${order.id}: בקשת תמונות נשלחה לקבוצת התמונות`);
    bus.yuval(`שלחתי בקשת תמונות לקבוצת התיעוד · ${order.id}`);
  }

  // ---------- Step 6-7: emoji reaction -> photo request ----------
  // `reaction` comes either from wwebjs (msgId is a key object) or from our
  // own page hook (msgId is already a serialized string).
  async handleReaction(reaction) {
    this.reload();
    if (!reaction.reaction) return; // reaction removed
    const rawKey = reaction.msgId;
    const msgId =
      typeof rawKey === 'string'
        ? rawKey
        : rawKey && (rawKey._serialized || rawKey.$1 || null);

    // A reaction from the customer (e.g. on the ack) must not start picking
    const senderId = typeof reaction.senderId === 'string' ? reaction.senderId : null;
    if (senderId) {
      const senderPhone = await resolvePhoneId(this.client, senderId).catch(() => senderId);
      if (senderPhone === config.sourceContactId) return;
    }

    let order = msgId ? store.findByGroupMsgId(this.db, msgId) : null;
    // Fallback: the PDF's message id may be unknown or serialized differently.
    // If the reaction happened in the picking group, adopt the most recent
    // order that is waiting for one.
    const inPickingGroup = msgId && msgId.includes(this.pickingGroup.id._serialized);
    if (!order && inPickingGroup) {
      order =
        this.db.orders
          .filter((o) => ['sent_to_group', 'awaiting_photos'].includes(o.status) && !o.reaction)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
      if (order && !order.groupMsgId) {
        order.groupMsgId = msgId;
        store.addHistory(order, 'group_msg_adopted', 'מזהה הודעת ה-PDF אומץ מהריאקשן');
      }
    }
    if (!order || !['sent_to_group', 'awaiting_photos'].includes(order.status)) return;
    if (order.reaction) return; // picking start already recorded

    // The photo request already went out with the PDF — the reaction just
    // records that the sheet was printed and picking started (FR-11).
    order.reaction = { emoji: reaction.reaction, by: reaction.senderId, at: new Date().toISOString() };
    store.addHistory(order, 'picking_started', `ריאקשן ${reaction.reaction} - הדף הודפס והליקוט החל`);
    this.save();
    log.info(`הזמנה ${order.id}: זוהה ריאקשן ${reaction.reaction} - הליקוט החל`);
    bus.yuval(`מלקט סימן ${reaction.reaction} — הדף הודפס והליקוט התחיל · ${order.id}`);
  }

  // ---------- Step 8: photos -> attached to the order ----------
  async handleGroupMedia(msg) {
    this.reload();
    if (!msg.hasMedia) return;

    // Prefer explicit attribution: a reply to the photo request / PDF message.
    let order = null;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        const qid = quoted.id._serialized;
        order =
          this.db.orders.find((o) => o.photoRequestMsgId === qid) ||
          store.findByGroupMsgId(this.db, qid);
      } catch (err) {
        log.warn(`שליפת הודעה מצוטטת נכשלה (${err.message}) - משייך לפי הזמנה ממתינה`);
      }
    }
    // Fallback (FR-13): attribute to the most recent order awaiting photos.
    if (!order) order = store.findAwaitingPhotos(this.db);
    if (!order || !['awaiting_photos', 'picking'].includes(order.status)) return;

    const savedPath = await this.saveMediaToOrder(msg, order, 'evidence');
    if (!savedPath) return;

    store.addHistory(order, 'photo_attached', path.basename(savedPath));
    log.info(`הזמנה ${order.id}: צורפה תמונה (${order.photos.length}/2)`);
    bus.yuval(`תמונת תיעוד ${order.photos.length}/2 התקבלה · ${order.id}`);

    // Documentation is complete after the two required photos (marked sheet +
    // packed shipment).
    if (order.photos.length >= 2 && order.status !== 'documented') {
      order.status = 'documented';
      store.addHistory(order, 'order_documented', 'התקבלו שתי תמונות התיעוד - ההזמנה מתועדת ומוכנה להמשך תהליך');
      bus.yuval(`ההזמנה ${order.id} תועדה במלואה — דף מסומן + משלוח ארוז`);
      this.save();
      await this.safeReply(msg, replies.documented(order));
    } else {
      this.save();
      await this.safeReact(msg, '👍');
    }
  }

  async saveMediaToOrder(msg, order, prefix) {
    try {
      const media = await msg.downloadMedia();
      if (!media) return null;
      const ext = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
      const fileName = `${store.orderFileBase(order)}-${prefix}-${order.photos.length + 1}.${ext}`;
      const filePath = path.join(store.customerDir(order), fileName);
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
