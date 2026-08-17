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
const complaints = require('../complaints');
const baseOrders = require('../orders/baseOrders');
const crypto = require('crypto');
const { mediaToText } = require('../parsers/registry');
const { parseOrderDocument, parseTextOrders } = require('../ai/docParser');

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
    // An email order waiting for the rep to say which office it belongs to
    this.pendingEmail = null; // { doc, payload, candidates, at }
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

  // All companies referenced by the text. Auto-attribution is allowed only
  // when EXACTLY ONE matches; a payer name shared by several offices yields
  // multiple candidates -> ask, never guess.
  matchCompaniesByText(text) {
    const t = String(text || '').toLowerCase().replace(/[׳'"״]/g, '');
    const hit = (v) => v && t.includes(String(v).toLowerCase().replace(/[׳'"״]/g, ''));
    const full = config.companies.filter((c) => hit(c.name) || hit(c.nameEn));
    if (full.length) return full;
    return config.companies.filter((c) => (c.aliases || []).some(hit));
  }

  matchCompanyByText(text) {
    const list = this.matchCompaniesByText(text);
    return list.length === 1 ? list[0] : null;
  }

  companyOptions() {
    return config.companies.map((c) => c.name).join(' / ');
  }

  // A payer with several offices (סולאראדג׳ הרצליה/ציפורית/מודיעין) must never
  // be resolved to a specific office by guesswork. Returns the sibling list
  // when the chosen company's office is NOT named in the message itself -
  // the caller then asks which office. null = attribution is safe.
  ambiguousOffice(company, text) {
    const crm = company && company.crm;
    if (!crm || !crm.payer) return null;
    const siblings = config.companies.filter((c) => c.crm && c.crm.payer === crm.payer);
    if (siblings.length <= 1) return null;
    const clean = (s) => String(s || '').toLowerCase().replace(/[׳'"״\s]/g, '');
    const t = clean(text);
    if (crm.office && t.includes(clean(crm.office))) return null; // office named explicitly
    return siblings;
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
  // Observe mode: replies to PRIVATE chats (customers) are suppressed and
  // surfaced in the terminal instead; group replies (our demo groups) stay.
  async safeReply(msg, text) {
    if (config.observeMode && !String(msg.from || '').endsWith('@g.us')) {
      log.info(`(מצב תצפית) תשובה ללקוח לא נשלחה: "${String(text).slice(0, 100)}"`);
      bus.naama(`(תצפית - לא נשלח) הייתי עונה ללקוח: ${String(text).slice(0, 80)}`);
      return null;
    }
    try {
      return await msg.reply(text);
    } catch (err) {
      log.warn(`reply נכשל (${err.message}) - שולח בלי ציטוט`);
      return this.client.sendMessage(msg.from, text);
    }
  }

  async safeReact(msg, emoji) {
    if (config.observeMode && !String(msg.from || '').endsWith('@g.us')) return;
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

  // ---------- item removal (floors-aware, plural-tolerant) ----------
  // "תסירו את המלפפונים" must remove מלפפון from EVERY floor; a removal that
  // names a floor removes only there. Hebrew plural/singular forms match.
  static productStem(name) {
    const s = String(name || '')
      .replace(/[׳'"״\s]/g, '')
      // final letters -> regular forms, so "מלפפון" stems equal to "מלפפונים"
      .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
    return s.replace(/(יות|ים|ות|ה)$/u, '');
  }

  static productsMatch(a, b) {
    const sa = Orchestrator.productStem(a);
    const sb = Orchestrator.productStem(b);
    if (!sa || !sb) return false;
    return sa === sb || sa.includes(sb) || sb.includes(sa);
  }

  // Removes ALL matching items (across floors unless the removal names one).
  // Returns { removed: [...], notFound: [...] }.
  static removeItems(items, removals) {
    const removed = [];
    const notFound = [];
    const floorClean = (f) => String(f || '').replace(/[׳'"״\s]/g, '');
    for (const rem of removals) {
      const remFloor = floorClean(rem.floor);
      let hit = false;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (!Orchestrator.productsMatch(items[i].product_he, rem.product_he)) continue;
        if (remFloor && !floorClean(items[i].floor).includes(remFloor)) continue;
        removed.push(...items.splice(i, 1));
        hit = true;
      }
      if (!hit) notFound.push(rem.product_he);
    }
    return { removed, notFound };
  }

  // ---------- Step 1-5: incoming customer message ----------
  // forcedCompany: when the sender is a CRM contact of exactly one company,
  // attribution is automatic and the "which company?" question is skipped.
  async handleCustomerMessage(msg, forcedCompany = null, contactCandidates = null) {
    this.reload();
    const body = (msg.body || '').trim();
    log.info(`הודעה מהנציג: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`);
    bus.naama('הודעה חדשה התקבלה בוואטסאפ');

    // Documents (PDF / Excel) arriving over WhatsApp: extract text and run
    // it through the normal order flow. Idempotent per file content hash.
    let effectiveBody = body;
    let provenance = null;
    if (msg.hasMedia) {
      const media = await msg.downloadMedia().catch(() => null);
      if (media) {
        const hash = crypto.createHash('sha1').update(media.data).digest('hex');
        if (this.isMediaProcessed(hash)) {
          log.info('קובץ שכבר עובד התקבל שוב - מדלגת (idempotency)');
          return;
        }
        const doc = await mediaToText(media, forcedCompany && forcedCompany.crm, body);
        if (doc && doc.manualReview) {
          this.markMediaProcessed(hash);
          this.saveManualReviewFile(media, msg.from);
          bus.naama(`קובץ שלא הצלחתי לקרוא — הועבר לבדיקה ידנית`);
          await this.safeReply(msg, `קיבלתי את הקובץ, אבל לא הצלחתי לקרוא אותו אוטומטית (${doc.manualReview}). נציג אנושי יטפל בו 🙏`);
          return;
        }
        if (doc && doc.doc) {
          // A structured PDF order (Restigo/Zest/delivery-note/scan) - the
          // document parser already produced clean items.
          this.markMediaProcessed(hash);
          bus.naama(`קיבלתי PDF — קראתי אותו (${doc.doc.orders.reduce((n, o) => n + o.items.length, 0)} פריטים)`);
          let company = forcedCompany;
          if (!company && doc.doc.customer_name_in_doc) {
            const hits = this.matchCompaniesByText(doc.doc.customer_name_in_doc);
            if (hits.length === 1) company = hits[0];
          }
          if (!company && body) {
            const hits = this.matchCompaniesByText(body);
            if (hits.length === 1) company = hits[0];
          }
          if (!company) {
            const candidates = (contactCandidates && contactCandidates.length ? contactCandidates : null) || config.companies;
            this.pendingEmail = { doc: doc.doc, payload: { from: 'whatsapp', subject: 'קובץ PDF', media }, candidates, at: Date.now() };
            const options = candidates.slice(0, 8).map((c) => c.name).join(' / ');
            await this.safeReply(msg, `קיבלתי את הקובץ! רק לאיזה לקוח הוא שייך - ${options}? 🙏`);
            return;
          }
          this.saveIncomingFile(media, company.name);
          await this.safeReply(msg, `קיבלתי את הקובץ של ${company.name}, מעבדת אותו 🙌`);
          return this.createOrdersFromDoc(company, doc.doc, `PDF בוואטסאפ${body ? `: ${body.slice(0, 60)}` : ''}`);
        }
        if (doc && doc.text) {
          this.markMediaProcessed(hash);
          provenance = doc.provenance;
          effectiveBody = [body, doc.text].filter(Boolean).join('\n');
          bus.naama(`קיבלתי קובץ (${provenance}) — מחלצת ממנו את ההזמנה`);
          log.info(`מסמך פוענח (${provenance}), ${doc.text.length} תווים`);
        } else if (!body) {
          // plain image: attach to the most recent open order
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
      }
    }
    if (!effectiveBody) return;

    // Is this the answer to "which customer does the EMAIL order belong to?"
    if (this.pendingEmail) {
      const hit = this.pendingEmail.candidates.filter((c) => {
        const clean = (s) => String(s || '').toLowerCase().replace(/[׳'"״]/g, '');
        const b = clean(body);
        return [c.name, ...(c.aliases || [])].some((n) => n && b.includes(clean(n)));
      });
      if (hit.length === 1) {
        const { doc, payload } = this.pendingEmail;
        this.pendingEmail = null;
        bus.naama(`הנציג ענה: ${hit[0].name} — משייכת את ההזמנה`);
        if (payload.media) this.saveIncomingFile(payload.media, hit[0].name);
        await this.safeReply(msg, `תודה! משייכת את ההזמנה ל${hit[0].name} 🙌`);
        return this.createOrdersFromDoc(hit[0], doc, `מייל מ-${payload.from}: ${payload.subject}`);
      }
      // anything else falls through to normal handling (the email stays held)
    }

    // A sheet-channel customer letting us know their sheet was updated
    // ("עדכנתי את הטבלה") triggers an immediate re-read of their sheet.
    if (/עדכנ|שיטס|טבלה|גיליון/.test(body)) {
      const sheetCompanies = config.companies.filter((c) => c.crm && c.crm.channel === 'sheet');
      const target =
        (forcedCompany && forcedCompany.crm && forcedCompany.crm.channel === 'sheet' && forcedCompany) ||
        (() => {
          const hits = this.matchCompaniesByText(body).filter((c) => sheetCompanies.includes(c));
          return hits.length === 1 ? hits[0] : null;
        })();
      if (target) {
        bus.naama(`${target.name} עדכנו שהגיליון השתנה — קוראת אותו עכשיו`);
        await this.safeReply(msg, `מעולה, בודקת את הגיליון של ${target.name} עכשיו 👀`);
        const sheetOrders = require('../orders/sheetOrders');
        await sheetOrders.pollOnce(() => this, { forceOffice: target.crm.key });
        return;
      }
    }

    // Is this the answer to a pending "which company?" question?
    if (this.pending) {
      const fromCandidates = (this.pending.candidates || []).filter((c) =>
        String(body).toLowerCase().includes(c.name.toLowerCase()) ||
        (c.aliases || []).some((a) => String(body).toLowerCase().includes(String(a).toLowerCase())),
      );
      const company = fromCandidates.length === 1 ? fromCandidates[0] : this.matchCompanyByText(body);
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
      parsed = await parseOrderMessage(effectiveBody);
    } catch (err) {
      log.error('פרסור הודעה נכשל:', err.message);
      await this.safeReply(msg, '⚠️ לא הצלחתי לעבד את ההודעה, נציג אנושי יטפל בה.');
      return;
    }

    log.info(`סיווג: ${parsed.classification}, פריטים: ${parsed.items.length}, חברה: ${parsed.company || 'לא צוינה'}`);

    // Complaint detection (FR: complaints page) — on any classification
    if (parsed.complaint) {
      const complainer = (forcedCompany && forcedCompany.name) || parsed.company || null;
      complaints.add({ text: parsed.complaint, company: complainer });
      bus.naama(`זיהיתי תלונה${complainer ? ` מ־${complainer}` : ''} — תויגה בדף התלונות`);
      log.info(`תלונה תויגה: "${parsed.complaint}"`);
    }
    bus.naama(`קוראת את ההודעה: ${parsed.items.length ? `${parsed.items.length} פריטים` : 'הודעה כללית'}${parsed.company ? ` · ${parsed.company}` : ''}`);

    if (parsed.classification === 'general') {
      return this.safeReply(msg, this.customerText(parsed, null, replies.general()));
    }

    // Attribute the order to a company (FR-04). The rep serves several
    // companies — if none was named, ask and hold the draft. A single-company
    // CRM contact is attributed automatically.
    const company =
      forcedCompany || this.findCompany(parsed.company) || this.matchCompanyByText(parsed.company || '');

    // Guard: the parser may have "resolved" a payer-only mention to a specific
    // office (e.g. "הזמנה לסולאראדג׳" -> ציפורית). If the office is not named
    // in the message itself - ask which office, never assume.
    if (company && !forcedCompany && ['new_order', 'addition', 'change', 'cancellation'].includes(parsed.classification)) {
      const siblings = this.ambiguousOffice(company, effectiveBody);
      if (siblings) {
        this.pending = { parsed, rawBody: body, at: Date.now(), candidates: siblings };
        const offices = siblings.map((c) => c.crm.office).join(' / ');
        bus.naama(`ההודעה מציינת את ${company.crm.payer} בלי משרד — שואלת לאיזה משרד ההזמנה`);
        return this.safeReply(msg, `קיבלתי! לאיזה משרד של ${company.crm.payer} ההזמנה - ${offices}? 🙏`);
      }
    }

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
      const textCandidates = this.matchCompaniesByText(parsed.company || effectiveBody);
      const candidates =
        (contactCandidates && contactCandidates.length ? contactCandidates : null) ||
        (textCandidates.length > 1 ? textCandidates : null);
      this.pending = { parsed, rawBody: body, at: Date.now(), candidates };
      bus.naama(candidates
        ? `שיוך לא חד-משמעי (${candidates.length} אפשרויות) — שואלת את הלקוח`
        : 'לא צוין לקוח — שואלת את הלקוח לאיזה לקוח ההזמנה');
      const pool = candidates || config.companies;
      const options = pool.slice(0, 8).map((c) => c.name).join(' / ');
      const more = pool.length > 8 ? ' (או כתבו את שם הלקוח)' : '';
      const question =
        !candidates && parsed.reply_text && !parsed.reply_text.includes('{{ORDER}}')
          ? parsed.reply_text
          : `קיבלתי! לאיזה לקוח שייכת ההזמנה - ${options}?${more} 🙏`;
      return this.safeReply(msg, question);
    }

    return this.dispatchParsed(msg, parsed, effectiveBody, company);
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

    // Fixed-order offices: WhatsApp messages are CHANGES applied on the
    // stored base order (with full audit of base version + changes).
    let items = parsed.items;
    let baseAudit = null;
    const crm = company.crm || null;
    if (crm && crm.orderType === 'fixed') {
      const base = baseOrders.baseFor(crm.key, deliveryDate);
      if (!base) {
        bus.naama(`להזמנה של ${company.name} מוגדרת הזמנת בסיס קבועה - אך היא חסרה במאגר. מועבר לטיפול ידני`);
        log.warn(`הזמנת בסיס חסרה עבור "${company.name}" - manual_review`);
        await this.safeReply(msg, `ההזמנה של ${company.name} מוגדרת כהזמנה קבועה, אבל הזמנת הבסיס עדיין לא נטענה למערכת - נציג אנושי יטפל בהודעה 🙏`);
        return;
      }
      const additions = parsed.items.filter((it) => it.action !== 'remove');
      const removals = parsed.items.filter((it) => it.action === 'remove');
      items = [...base.items];
      const { removed } = Orchestrator.removeItems(items, removals);
      items.push(...additions);
      baseAudit = { baseVersion: base.versionId, added: additions.length, removed: removed.length };
    }

    const order = store.createOrder(this.db, {
      deliveryDate,
      customerName: company.name,
      customerNameEn: company.nameEn,
      initials: company.initials,
      customerNote: parsed.customer_note,
      locationDetail: parsed.location_detail,
      items,
      rawMessage: rawBody,
    });
    if (crm) {
      order.displayMode = crm.displayMode;
      order.sourceChannel = 'whatsapp';
      order.sourceFormat = crm.format === 'pdf' ? 'freetext' : crm.format;
    }
    if (baseAudit) {
      order.baseAudit = baseAudit;
      store.addHistory(order, 'base_order_applied', `בסיס ${baseAudit.baseVersion}: +${baseAudit.added} / -${baseAudit.removed} שינויים`);
    }
    // Floors validation: a floors-mode office whose input has no detectable
    // floors is flagged for review - we never guess a floor.
    if (crm && crm.displayMode === 'floors' && !order.items.some((it) => it.floor)) {
      order.flags = [...(order.flags || []), 'floors_missing'];
      store.addHistory(order, 'manual_review', 'לקוח בחלוקה לקומות אך לא זוהו קומות בקלט');
      bus.naama(`אזהרה: ${company.name} מוגדר בחלוקה לקומות אך לא זוהו קומות בהזמנה — סומן לבדיקה`);
    }
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

    // Remove items floors-wide (or floor-scoped when the removal names one),
    // tolerant to plural/singular ("מלפפונים" removes every "מלפפון")
    const { removed, notFound } = Orchestrator.removeItems(order.items, removals);

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
      order.postPrintChanges = order.postPrintChanges || [];
      order.postPrintChanges.push({ ts: new Date().toISOString(), text: changesList.replace(/\n/g, ' · ') });
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

  // ---------- non-WhatsApp channels: schedule / sheet / email ----------

  // Shared creation path for orders born outside a WhatsApp chat.
  // replaceExisting: an open order for the same date is REPLACED wholesale
  // (the source - a sheet - is the single source of truth), otherwise the new
  // content is refused when an open order exists.
  async createChannelOrder(company, { deliveryDate, items, customerNote = null, sourceChannel, sourceFormat, rawMessage, baseAudit = null, replaceExisting = false }) {
    const crm = company.crm || {};
    const existing = store.findOpenOrderForDate(this.db, company.name, deliveryDate);
    if (existing) {
      if (!replaceExisting) return { order: existing, created: false };
      existing.items = items;
      if (customerNote) existing.customerNote = customerNote;
      existing.version += 1;
      store.addHistory(existing, 'channel_update', `תוכן ההזמנה הוחלף מעדכון ${sourceChannel} (גרסה ${existing.version})`);
      this.save();
      await this.sendPickingSheet(existing, { updated: true });
      return { order: existing, created: false, updated: true };
    }
    const order = store.createOrder(this.db, {
      deliveryDate,
      customerName: company.name,
      customerNameEn: company.nameEn,
      initials: company.initials,
      customerNote,
      locationDetail: null,
      items,
      rawMessage,
    });
    order.displayMode = crm.displayMode;
    order.sourceChannel = sourceChannel;
    order.sourceFormat = sourceFormat;
    if (baseAudit) {
      order.baseAudit = baseAudit;
      store.addHistory(order, 'base_order_applied', `בסיס ${baseAudit.baseVersion} (הנפקה לפי לוז)`);
    }
    if (crm.displayMode === 'floors' && !order.items.some((it) => it.floor)) {
      order.flags = [...(order.flags || []), 'floors_missing'];
      store.addHistory(order, 'manual_review', 'לקוח בחלוקה לקומות אך לא זוהו קומות בקלט');
      bus.naama(`אזהרה: ${company.name} מוגדר בחלוקה לקומות אך לא זוהו קומות — סומן לבדיקה`);
    }
    this.save();
    await this.sendPickingSheet(order);
    return { order, created: true };
  }

  // Scheduled issuance of a fixed order (called by the scheduler on the
  // customer's own delivery days only).
  async issueScheduledOrder(company, deliveryDate) {
    this.reload();
    const crm = company.crm;
    const existing = store.findOpenOrderForDate(this.db, company.name, deliveryDate);
    if (existing) return existing; // the customer beat the schedule via WhatsApp
    const base = baseOrders.baseFor(crm.key, deliveryDate);
    if (!base) throw new Error(`אין הזמנת בסיס של ${company.name} ליום זה`);
    bus.naama(`מנפיקה הזמנה קבועה של ${company.name} לפי הלוז — ${base.items.length} פריטים`, true);
    const { order } = await this.createChannelOrder(company, {
      deliveryDate,
      items: base.items,
      sourceChannel: 'fixed_schedule',
      sourceFormat: 'db',
      rawMessage: `הזמנה קבועה שהונפקה אוטומטית לפי הלוז (בסיס ${base.versionId})`,
      baseAudit: { baseVersion: base.versionId, added: 0, removed: 0, scheduled: true },
    });
    return order;
  }

  // An updated shared Google Sheet: the table content IS the order.
  async handleSheetOrder(company, tableText, { sheetTitle = '' } = {}) {
    this.reload();
    const crm = company.crm || {};
    const floorsHint = crm.displayMode === 'floors'
      ? ' הלקוח עובד בחלוקה לקומות: עמודות כמות נפרדות (למשל "להזמנה 2", "להזמנה 1-") הן קומות נפרדות - צרי פריט לכל קומה עם הכמות שלה, בלי עמודת הסה"כ.'
      : '';
    const parsed = await parseOrderMessage(
      `זהו תוכן גיליון ההזמנות המשותף של ${company.name}${sheetTitle ? ` ("${sheetTitle}")` : ''}. הטבלה כולה היא ההזמנה המלאה (לא תוספת).${floorsHint}\n\n${tableText}`,
    );
    if (!parsed.items.length) {
      log.warn(`עדכון הגיליון של ${company.name} לא הניב פריטים - לא נוצרה הזמנה`);
      return;
    }
    const deliveryDate = parsed.delivery_date ||
      new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const res = await this.createChannelOrder(company, {
      deliveryDate,
      items: parsed.items,
      customerNote: parsed.customer_note,
      sourceChannel: 'sheet',
      sourceFormat: 'gsheet',
      rawMessage: `גיליון משותף: ${sheetTitle || company.name}`,
      replaceExisting: true,
    });
    bus.naama(`הזמנת השיטס של ${company.name} ${res.created ? 'נקלטה' : 'עודכנה'} · ${res.order.id}`);
  }

  // An email order (body text / Excel / PDF attachments). candidates: the CRM
  // companies whose contacts include the sender address - when more than one,
  // the content must identify the office, otherwise we ask the rep on
  // WhatsApp and hold the email (never guess).
  async handleEmailOrder(candidates, payload) {
    this.reload();
    const { from, subject, text, attachments } = payload;

    // 1) collect parsable content
    const excel = attachments.find((a) => /sheet|excel/i.test(a.contentType) || /\.xlsx?$/i.test(a.filename));
    const pdf = attachments.find((a) => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename));
    // The email BODY rides along with any attachment - free-text additions
    // and requests in it ("תוסיפו גם ג'ינג'ר") are applied on top of the file.
    let doc = null;
    try {
      if (excel) {
        const { excelBufferToText } = require('../parsers/registry');
        const combined = [
          `קובץ אקסל "${excel.filename}" מצורף למייל (נושא: ${subject}):`,
          excelBufferToText(excel.content),
          text ? `\nגוף המייל עצמו (החל שינויים/תוספות/בקשות ממנו על הרשימה):\n"""\n${text}\n"""` : '',
        ].filter(Boolean).join('\n');
        doc = await parseTextOrders(combined, {
          hint: `הזמנת מייל של לקוח - אקסל + גוף המייל (נושא: ${subject})`,
        });
      } else if (pdf) {
        doc = await parseOrderDocument(pdf.content, {
          hint: `קובץ מצורף למייל (נושא: ${subject})`,
          accompanyingText: text,
        });
      } else if (text) {
        doc = await parseTextOrders(text, { hint: `גוף מייל הזמנה (נושא: ${subject})` });
      }
    } catch (err) {
      log.error(`פרסור מייל מ-${from} נכשל: ${err.message}`);
    }
    if (!doc || !doc.orders.length || !doc.orders.some((o) => o.items.length)) {
      bus.naama(`מייל מ-${from} לא הניב הזמנה קריאה — הועבר לבדיקה ידנית`);
      log.warn(`מייל מ-${from} ("${subject}") ללא פריטים - manual review`);
      return;
    }

    // 2) resolve the office
    let company = candidates.length === 1 ? candidates[0] : null;
    if (!company) {
      const hay = `${subject}\n${text}\n${doc.customer_name_in_doc || ''}\n${attachments.map((a) => a.filename).join('\n')}`;
      const hits = candidates.filter((c) => {
        const clean = (s) => String(s || '').toLowerCase().replace(/[׳'"״]/g, '');
        const h = clean(hay);
        return [c.name, ...(c.aliases || [])].some((n) => n && h.includes(clean(n)));
      });
      if (hits.length === 1) company = hits[0];
    }
    if (!company) {
      this.pendingEmail = { doc, payload, candidates, at: Date.now() };
      const names = candidates.map((c) => c.name).join(' / ');
      const question = `📧 התקבל מייל הזמנה מ-${from}${subject ? ` ("${subject}")` : ''}, אבל הכתובת משויכת לכמה לקוחות: ${names}.\nלאיזה לקוח שייכת ההזמנה?`;
      if (config.observeMode) {
        bus.naama(`(תצפית - לא נשלח) ${question}`);
        log.info(`(מצב תצפית) שאלת שיוך מייל לא נשלחה לנציג: ${names}`);
        return;
      }
      bus.naama(`מייל הזמנה מ-${from} משויך לכמה לקוחות — שואלת את הנציג בוואטסאפ`);
      await sendAndConfirm(this.client, config.sourceContactId, question);
      return;
    }
    await this.createOrdersFromDoc(company, doc, `מייל מ-${from}: ${subject}`);
  }

  // Materialize docParser output (1..N dated lists, e.g. a weekly email) into
  // orders. Undated lists default to tomorrow.
  async createOrdersFromDoc(company, doc, rawMessage) {
    const tomorrow = () =>
      new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    for (const entry of doc.orders) {
      if (!entry.items.length) continue;
      const res = await this.createChannelOrder(company, {
        deliveryDate: entry.delivery_date || tomorrow(),
        items: entry.items,
        sourceChannel: 'email',
        sourceFormat: 'freetext',
        rawMessage,
        replaceExisting: true,
      });
      bus.naama(`הזמנת מייל של ${company.name} ל-${res.order.deliveryDate} ${res.created ? 'נקלטה' : 'עודכנה'} · ${res.order.id}`);
    }
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

    // The photos group joins the flow only AFTER a picker marks the sheet as
    // printed (reaction) - see handleReaction. Here we only keep it updated
    // when a newer sheet version lands after the photo thread already opened.
    if (order.photoRequestMsgId) {
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

  // FR-12: photo request, attributed to the order - sent once the picker
  // marked the sheet as printed (reaction on the PDF).
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

    // FR-11: the reaction records that the sheet was printed and picking
    // started - and ONLY NOW the photos group is asked for documentation.
    order.reaction = { emoji: reaction.reaction, by: reaction.senderId, at: new Date().toISOString() };
    store.addHistory(order, 'picking_started', `ריאקשן ${reaction.reaction} - הדף הודפס והליקוט החל`);
    this.save();
    log.info(`הזמנה ${order.id}: זוהה ריאקשן ${reaction.reaction} - הליקוט החל`);
    bus.yuval(`מלקט סימן ${reaction.reaction} — הדף הודפס והליקוט התחיל · ${order.id}`);

    if (!order.photoRequestMsgId) {
      await this.sendPhotoRequest(order);
    }
  }

  // ---------- Step 8: photos -> the order becomes "picked" ----------
  // One shipment photo is enough to mark the order picked. Attribution:
  // reply-quote first; a single open order second; otherwise we ask in the
  // group and wait for a text answer.
  // Only orders whose photo thread is open (i.e. the sheet was printed and a
  // photo request went out) are candidates for photo attribution - pre-print
  // orders are not in the photos stage yet.
  openPhotoOrders() {
    return this.db.orders
      .filter((o) => ['awaiting_photos', 'documented'].includes(o.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async handleGroupMedia(msg) {
    this.reload();
    if (!msg.hasMedia) return;

    // 1) reply-quote attribution (robust to the _serialized/$1 rename; the
    // media hook may deliver a raw stanza id - match on the id tail too)
    let order = null;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        const qid = quoted && quoted.id && (quoted.id._serialized || quoted.id.$1 || null);
        if (qid) {
          // compare on the stanza part (3rd segment of fromMe_remote_stanza[...]),
          // which is a long random string - immune to participant suffixes
          const stanzaOf = (s) => {
            const parts = String(s).split('_');
            return parts.length >= 3 ? parts[2] : parts[parts.length - 1];
          };
          const qStanza = stanzaOf(qid);
          const tailMatch = (stored) => stored && (stored === qid || stanzaOf(stored) === qStanza);
          order =
            this.db.orders.find((o) => tailMatch(o.photoRequestMsgId)) ||
            store.findByGroupMsgId(this.db, qid) ||
            this.db.orders.find((o) => tailMatch(o.groupMsgId)) ||
            null;
        }
      } catch (err) {
        log.warn(`שליפת הודעה מצוטטת נכשלה (${err.message})`);
      }
    }

    // 2) a single open order -> obvious attribution
    const open = this.openPhotoOrders().filter((o) => o.status !== 'documented');
    if (!order && open.length === 1) order = open[0];
    if (!order && msg.hasQuotedMsg && open.length) order = open[0];

    if (order) return this.attachShipmentPhoto(msg, order);

    // 3) unknown attribution: stash the photo and ask in the group
    const tempPath = await this.saveMediaToTemp(msg);
    if (!tempPath) return;
    this.pendingPhoto = this.pendingPhoto || { files: [], asked: false };
    this.pendingPhoto.files.push(tempPath);
    this.pendingPhoto.at = Date.now();
    if (!this.pendingPhoto.asked) {
      this.pendingPhoto.asked = true;
      const options = this.openPhotoOrders()
        .slice(0, 6)
        .map((o) => `${o.id} (${o.customerName})`)
        .join(' / ');
      await sendAndConfirm(
        this.client,
        (this.photosGroup || this.pickingGroup).id._serialized,
        `לאיזו הזמנה שייכת התמונה? ${options || 'לא מצאתי הזמנות פתוחות - נא לציין מספר הזמנה'}`,
      );
      bus.yuval('התקבלה תמונה ללא שיוך — שאלתי בקבוצה לאיזו הזמנה היא שייכת');
    }
  }

  async attachShipmentPhoto(msg, order) {
    const savedPath = await this.saveMediaToOrder(msg, order, 'evidence');
    if (!savedPath) return;
    store.addHistory(order, 'photo_attached', path.basename(savedPath));
    bus.yuval(`תמונת תיעוד התקבלה · ${order.id}`);

    if (order.status !== 'documented') {
      order.status = 'documented';
      store.addHistory(order, 'order_picked', 'התקבלה תמונת משלוח - ההזמנה סומנה כלוקטה');
      bus.yuval(`ההזמנה ${order.id} לוקטה — המשלוח מתועד`);
      this.save();
      await this.safeReply(msg, `ההזמנה ${order.id} (${order.customerName}) סומנה כלוקטה ✓`);
    } else {
      this.save();
      await this.safeReact(msg, '👍');
    }
  }

  // Free text in the photos group: answer to a pending "which order?" question
  // or a general remark about an order.
  async handleGroupText(msg) {
    this.reload();
    const body = (msg.body || '').trim();
    if (!body) return;

    // find a referenced order: explicit id first, company name second
    let order = null;
    const idMatch = body.match(/([A-Za-z]{1,3}-\d{8}(?:-\d+)?)/);
    if (idMatch) {
      order = this.db.orders.find((o) => o.id.toLowerCase() === idMatch[1].toLowerCase()) || null;
    }
    if (!order) {
      const company = this.matchCompanyByText(body);
      if (company) {
        order = this.openPhotoOrders().find((o) => o.customerName === company.name) || null;
      }
    }

    // pending unattributed photos + an answer -> attach them
    if (this.pendingPhoto && this.pendingPhoto.files.length) {
      if (!order) {
        await this.safeReply(msg, 'לא זיהיתי את ההזמנה - נא לציין מספר הזמנה (למשל KC-26072026) או שם חברה');
        return;
      }
      const files = this.pendingPhoto.files;
      this.pendingPhoto = null;
      for (const tempPath of files) {
        const fileName = `${store.orderFileBase(order)}-evidence-${order.photos.length + 1}${path.extname(tempPath)}`;
        const finalPath = path.join(store.customerDir(order), fileName);
        try {
          fs.renameSync(tempPath, finalPath);
          order.photos.push({ path: finalPath, from: msg.author || msg.from, at: new Date().toISOString() });
          store.addHistory(order, 'photo_attached', fileName);
        } catch (err) {
          log.error('העברת תמונה ממתינה נכשלה:', err.message);
        }
      }
      if (order.status !== 'documented') {
        order.status = 'documented';
        store.addHistory(order, 'order_picked', 'התמונות שויכו לפי תשובת המלקט - ההזמנה סומנה כלוקטה');
      }
      this.save();
      bus.yuval(`התמונות שויכו להזמנה ${order.id} — ההזמנה לוקטה`);
      await this.safeReply(msg, `התמונות שויכו להזמנה ${order.id} (${order.customerName}) - סומנה כלוקטה ✓`);
      return;
    }

    if (order) {
      bus.yuval(`הודעה בקבוצת התיעוד על ${order.id}: "${body.slice(0, 60)}"`);
      store.addHistory(order, 'group_note', body.slice(0, 200));
      this.save();
    }
  }

  isMediaProcessed(hash) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'processed-media.json'), 'utf8'));
      return list.includes(hash);
    } catch (err) {
      return false;
    }
  }

  markMediaProcessed(hash) {
    const file = path.join(config.dataDir, 'processed-media.json');
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) { /* first time */ }
    list.push(hash);
    if (list.length > 500) list = list.slice(-300);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list));
  }

  // The customer's ORIGINAL file (e.g. a Restigo/Zest PDF) is saved into the
  // customer's folder next to our own picking sheets - audit trail + the
  // local copy the parse worked from.
  saveIncomingFile(media, customerName) {
    try {
      const dir = path.join(config.outputDir, customerName, 'incoming');
      fs.mkdirSync(dir, { recursive: true });
      const ext = (media.mimetype || 'application/pdf').split('/')[1].split(';')[0];
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const base = media.filename ? media.filename.replace(/[/\\]/g, '_') : `הזמנה-${stamp}.${ext}`;
      const filePath = path.join(dir, `${stamp}-${base}`);
      fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
      log.info(`הקובץ המקורי נשמר: ${filePath}`);
      return filePath;
    } catch (err) {
      log.error('שמירת הקובץ המקורי נכשלה:', err.message);
      return null;
    }
  }

  // Unreadable originals are kept with their metadata for later inspection
  saveManualReviewFile(media, from) {
    try {
      const dir = path.join(config.dataDir, 'manual-review');
      fs.mkdirSync(dir, { recursive: true });
      const ext = (media.mimetype || 'bin').split('/')[1].split(';')[0];
      const base = `review-${Date.now()}`;
      fs.writeFileSync(path.join(dir, `${base}.${ext}`), Buffer.from(media.data, 'base64'));
      fs.writeFileSync(
        path.join(dir, `${base}.json`),
        JSON.stringify({ from, mimetype: media.mimetype, filename: media.filename || null, at: new Date().toISOString() }, null, 2),
      );
    } catch (err) {
      log.error('שמירת קובץ לבדיקה ידנית נכשלה:', err.message);
    }
  }

  async saveMediaToTemp(msg) {
    try {
      const media = await msg.downloadMedia();
      if (!media) return null;
      const dir = path.join(config.dataDir, 'pending-photos');
      fs.mkdirSync(dir, { recursive: true });
      const ext = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
      const filePath = path.join(dir, `pending-${Date.now()}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
      return filePath;
    } catch (err) {
      log.error('שמירת תמונה זמנית נכשלה:', err.message);
      return null;
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
