const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

const client = new Anthropic();

// FR-03 (message classification), FR-05 (order structure), FR-07 (multilingual
// product names), FR-06 (billing method: weight / unit / package).
const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'delivery_date', 'customer_note', 'items'],
  properties: {
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
- Classification: if the message contains a list of products with no reference to a previous order today, it is new_order. Words like "תוסיפו", "עוד", "שכחתי" indicate addition. "תורידו", "במקום" indicate change. "תבטלו" indicates cancellation. Anything with no order content is general.
- delivery_date: resolve relative dates ("מחר", "ליום ראשון") to an absolute date. Default: tomorrow (orders are normally for the next day).
- Keep item order stable within each category (as written by the customer).`;

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
        content: `Today is ${dayName}, ${todayStr} (Israel time). Customer: ${config.customerName}.

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
