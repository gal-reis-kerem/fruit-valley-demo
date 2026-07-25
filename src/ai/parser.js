const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { managerDirectives } = require('../rules');

const client = new Anthropic();

// FR-03 (message classification), FR-05 (order structure), FR-07 (multilingual
// product names), FR-06 (billing method: weight / unit / package).
const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'company', 'complaint', 'delivery_date', 'customer_note', 'location_detail', 'reply_text', 'items'],
  properties: {
    complaint: {
      type: ['string', 'null'],
      description:
        'If the message contains a complaint about a PAST order/delivery (bad quality, missing items, late delivery, wrong items) - the essence of the complaint in Hebrew, close to the customer wording. A change/removal request for the CURRENT order is NOT a complaint. null when there is no complaint.',
    },
    company: {
      anyOf: [
        { type: 'string', enum: config.companies.map((c) => c.name) },
        { type: 'null' },
      ],
      description:
        'The company this order belongs to, EXACTLY as listed. The rep orders for several companies — detect from phrases like "הזמנה לטריפל", "עבור כרם קפיטל", or a company name anywhere in the message (any spelling/Hebrew/English variation maps to the listed name). null if the message does not indicate a company.',
    },
    reply_text: {
      type: 'string',
      description:
        'A short, warm, natural Hebrew WhatsApp reply to the customer, written like a human operations person (not a bot). Must contain the literal token {{ORDER}} exactly once where the order number belongs, for every order-related classification (new_order/addition/change/cancellation). Vary the phrasing naturally between messages. For general messages: a friendly short reply without {{ORDER}}.',
    },
    location_detail: {
      type: ['string', 'null'],
      description:
        'Short latin qualifier when the order is for a specific floor/building/site, e.g. "f2" for "קומה 2", "b1" for building 1. null when not mentioned.',
    },
    classification: {
      type: 'string',
      enum: ['new_order', 'addition', 'change', 'cancellation', 'general'],
      description:
        'new_order: a full order list. addition: items added to an existing order. change: modification of existing items. cancellation: cancel order/items. general: greeting/question/anything that is not an order.',
    },
    delivery_date: {
      type: ['string', 'null'],
      description:
        'Resolved delivery date as YYYY-MM-DD. Orders are usually for the next day unless the message says otherwise. null only for general messages.',
    },
    customer_note: {
      type: ['string', 'null'],
      description: 'A general note from the customer that applies to the whole order, if any.',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'product_he',
          'product_en',
          'product_th',
          'product_ar',
          'quantity',
          'unit',
          'note',
          'category',
          'vat_exempt',
        ],
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove'],
            description:
              'add: item ordered / added. remove: the customer asks to take this item OFF the order ("תוריד", "בלי", "לבטל את ה...", "להוריד אותם מההזמנה").',
          },
          product_he: { type: 'string', description: 'Clean product name in Hebrew, without quantity or notes' },
          product_en: { type: 'string', description: 'Product name in English' },
          product_th: { type: 'string', description: 'Product name in Thai' },
          product_ar: { type: 'string', description: 'Product name in Arabic' },
          quantity: { type: ['number', 'null'] },
          unit: {
            type: 'string',
            description: 'Order unit in Hebrew, e.g. ק"ג / יחידה / ארגז / מארז / צרור / שקית. If unclear, infer the sensible unit for the product.',
          },
          note: {
            type: ['string', 'null'],
            description: 'Item-level customer note, e.g. "רק אם הם בשלות", "קטן", "קשה"',
          },
          category: {
            type: 'string',
            enum: ['vegetables', 'fruits', 'dairy', 'other'],
            description: 'Picking area. Used to sort the picking sheet.',
          },
          vat_exempt: {
            type: 'boolean',
            description: 'true only for fresh fruits and vegetables. Dairy, eggs, bread and processed goods are NOT exempt.',
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the operations-desk digital worker of "פירות העמק" (Fruit Valley), an Israeli fresh-produce wholesaler.
Customers send free-text WhatsApp messages with orders for fruits, vegetables, dairy and groceries, written in casual human Hebrew.

Your job: turn a raw WhatsApp message into a clean, structured picking list.

Rules:
- Strip all fluff (greetings, "היי", "תודה", emojis, "ההזמנה למחר" headers) — keep only order content.
- Carefully separate: product name vs. quantity vs. unit vs. item note. Example: "מלון קטן 2" -> product "מלון", note "קטן", quantity 2. "תפוח סמיט קשה" -> product "תפוח עץ גרני סמית", note "קשה".
- Distinguish weight-based quantities (ק"ג) from unit/package-based quantities (יחידה, ארגז, מארז). "2 קילו עגבניות" -> quantity 2, unit ק"ג.
- Translate every product name to English, Thai and Arabic (the pickers are Thai workers and Arabic-speaking supervisors).
- Categorize each item into its picking area: vegetables / fruits / dairy / other. This ordering also serves invoicing (VAT-exempt items grouped together).
- vat_exempt = true only for fresh fruits & vegetables.
- Classification: if the message contains a list of products with no reference to a previous order today, it is new_order. Words like "תוסיפו", "עוד", "שכחתי" indicate addition. "תורידו", "במקום", "להוריד מההזמנה" indicate change. "תבטלו" (the whole order) indicates cancellation. Anything with no order content is general.
- Item action: mark items the customer wants REMOVED from the order with action="remove" (e.g. "יכול להוריד את הענבים?" -> item ענבים with action="remove", quantity null). Everything else is action="add". Removing specific items is a change, NOT a cancellation.
- delivery_date: resolve relative dates ("מחר", "ליום ראשון") to an absolute date. Default: tomorrow (orders are normally for the next day).
- Keep item order stable within each category (as written by the customer).
- reply_text: write the WhatsApp reply we send back to the customer. Sound like a friendly human coordinator, in casual Hebrew, 1-2 short sentences, at most one emoji. Include the token {{ORDER}} exactly once (it is replaced with the order number). Examples of tone (do NOT copy verbatim, invent your own variation each time): "קיבלתי 🙌 ההזמנה יצאה לליקוט, מספר הזמנה {{ORDER}}", "מעולה, הכל נקלט! ההזמנה שלך ({{ORDER}}) כבר אצל המלקטים". For additions: acknowledge the addition and mention it joined order {{ORDER}}. Mirror the customer's energy (if they are brief - be brief).
- EXCEPTION - company is null on an order/addition/change: reply_text must instead ASK naturally which company the order is for, listing the options, WITHOUT the {{ORDER}} token (e.g. "קיבלתי! רק לאיזו חברה ההזמנה - כרם קפיטל, טריפל או סולראדג'?").\n- If delivery_date is NOT tomorrow (an explicit future/other date was requested), reply_text must mention the delivery day explicitly (e.g. "רשמתי ליום שלישי 28.7") so mistakes get caught early.\n- Complaints: if the customer complains about a past order ("פעם שעברה הגיע לא טוב", "שכחתם את...", "איחרתם במשלוח") set complaint accordingly, and open reply_text with a short empathetic acknowledgement (התנצלות קצרה + זה הועבר לטיפול) before the order confirmation.`;

/**
 * Parse a raw WhatsApp message into a structured order.
 * @param {string} messageText raw message body
 * @param {Date} now reference time for resolving relative dates
 * @returns {Promise<object>} object matching ORDER_SCHEMA
 */
async function parseOrderMessage(messageText, now = new Date()) {
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
  const dayName = now.toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' });

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: ORDER_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Today is ${dayName}, ${todayStr} (Israel time). The sender is a representative who orders on behalf of these companies: ${config.companies.map((c) => c.name).join(' / ')}.${managerDirectives('naama') ? `\n\nADDITIONAL MANAGER DIRECTIVES (follow them):\n${managerDirectives('naama')}` : ''}

WhatsApp message received:
"""
${messageText}
"""`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Model refused to process the message');
  }
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('No text block in model response');
  return JSON.parse(text.text);
}

// Minimal API call to surface key/billing problems at startup instead of on
// the first live order.
async function checkApiKey() {
  try {
    await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { parseOrderMessage, checkApiKey };
