// Document (PDF) parsing with Claude's native PDF understanding. Text
// extraction is useless for much of the real material - scanned pages,
// per-floor matrix tables, letter-spaced Hebrew - so the file itself is sent
// to the model. Generic: one parser for every customer/format (Restigo, Zest,
// delivery notes, base-order tables), never a per-customer strategy.
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

const client = new Anthropic();

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['floor', 'product_he', 'product_en', 'product_th', 'product_ar', 'quantity', 'unit', 'note', 'category', 'vat_exempt'],
  properties: {
    floor: {
      type: ['string', 'null'],
      description:
        'Floor/section when the document splits quantities by floor or department (e.g. columns "קומה 2" / "מטבח קומה 3" / "קפיטריה", or rows grouped under floor headers). Keep the document wording. A product with quantities in several floor columns becomes SEVERAL items, one per floor - never merge across floors. null when the document has no floor split.',
    },
    product_he: { type: 'string', description: 'Clean product name in Hebrew, without quantity or notes' },
    product_en: { type: 'string' },
    product_th: { type: 'string' },
    product_ar: { type: 'string' },
    quantity: { type: ['number', 'null'] },
    unit: { type: 'string', description: 'ק"ג / יחידה / ארגז / מארז / צרור / שקית... "k"=ק"ג, "u"=יחידה. Infer sensibly when unclear.' },
    note: { type: ['string', 'null'] },
    category: { type: 'string', enum: ['vegetables', 'fruits', 'dairy', 'other'] },
    vat_exempt: { type: 'boolean', description: 'true only for fresh fruits and vegetables' },
  },
};

const buildDocSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['customer_name_in_doc', 'customer_name_he', 'days_mentioned', 'orders'],
  properties: {
    customer_name_in_doc: {
      type: ['string', 'null'],
      description: 'The customer/company name as written INSIDE the document (header, address block, delivery-note recipient). null if none appears.',
    },
    customer_name_he: {
      type: ['string', 'null'],
      description: 'The same customer name normalized to its common HEBREW form (e.g. "INFINEON TECHNOLOGIES" -> "אינפיניון", "בוסטון קיץ" -> "בוסטון"). null when no name appears or you cannot identify it.',
    },
    days_mentioned: {
      type: 'array',
      items: { type: 'string', enum: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] },
      description: 'Hebrew weekday names that appear in the document header/title as the days this list applies to. Empty when none.',
    },
    orders: {
      type: 'array',
      description:
        'The order list(s) in the document. Usually ONE entry. Multiple entries when the document contains separate lists - either per delivery date (weekly email with a table per day) or per CUSTOMER (e.g. a combined "ברוקר + אינמוד" file with a section per customer).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['customer_name', 'delivery_date', 'items'],
        properties: {
          customer_name: {
            type: ['string', 'null'],
            description:
              'When the document is split into sections per customer, the customer this list belongs to (as written in the section header). null when the whole document is for one customer.',
          },
          delivery_date: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD when the document states an explicit date for this list, else null.',
          },
          items: { type: 'array', items: ITEM_SCHEMA },
        },
      },
    },
  },
});

const DOC_SYSTEM = `You read order documents for "פירות העמק" (Fruit Valley), an Israeli fresh-produce wholesaler, and extract clean structured picking lists.

Documents arrive in many shapes: free tables, exported delivery notes (Restigo/Zest style), scanned pages, Excel-like grids, and per-floor matrix tables where columns are floors (e.g. "מטבח קומה 2", "קפיטריה") and cells are quantities.

Rules:
- Extract ONLY real order lines. Skip headers, totals, prices, signatures, page numbers.
- Per-floor matrices: one item PER floor with that floor's quantity. Skip floors with quantity 0/empty. Never merge quantities across floors. Floor label = the column/section header as written.
- A "סה״כ" (total) column is a checksum, not a floor - ignore it when per-floor quantities exist.
- Per-CUSTOMER sections: when the document contains separate sections for separate customers (e.g. a combined "ברוקר + אינמוד" list with a heading per customer), return one orders[] entry per customer with customer_name set to that section's customer. NEVER merge items of different customers into one list.
- Quantities: distinguish weight (ק"ג) from units/packages. Codes: k=ק"ג, u=יחידה.
- Translate every product to English, Thai and Arabic.
- category: vegetables / fruits / dairy / other (picking areas). vat_exempt=true only for fresh produce.
- Keep the document's item order.
- customer_name_in_doc: report the customer name exactly as the document shows it, even if surprising. customer_name_he: the same name in its common Hebrew form.
- If an accompanying free-text message is provided (WhatsApp caption / email body), APPLY it to the extracted list: additions, removals, replacements, quantity changes and special requests. The message wins over the document.
- Hebrew is RTL - scanned or reversed text may appear backwards; read it correctly.`;

function mediaBlock(buffer, mediaType) {
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
}

/**
 * Parse an order document (PDF buffer or image) into structured lists.
 * @param {Buffer} buffer file content
 * @param {object} opts { mediaType, hint, accompanyingText } - hint is free-text
 *   context ("base order of אלמה, floors display"); accompanyingText is the
 *   customer's own message sent WITH the document (caption / email body) whose
 *   changes and requests are applied on top of the document.
 * @returns {Promise<{customer_name_in_doc, customer_name_he, days_mentioned, orders:[{customer_name, delivery_date, items}]}>}
 */
async function parseOrderDocument(buffer, { mediaType = 'application/pdf', hint = '', accompanyingText = '' } = {}) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const textParts = [`Today is ${todayStr} (Israel).${hint ? ` Context: ${hint}.` : ''}`];
  if (accompanyingText) {
    textParts.push(`Accompanying message from the customer (apply its changes/requests on top of the document):\n"""\n${accompanyingText}\n"""`);
  }
  textParts.push('Extract the order list(s) from this document.');
  // stream() because base-order tables can be long (SDK caps non-streaming
  // requests by estimated duration)
  const response = await client.messages.stream({
    model: config.anthropicDocModel,
    max_tokens: 32000,
    system: [{ type: 'text', text: DOC_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: buildDocSchema() } },
    messages: [
      {
        role: 'user',
        content: [
          mediaBlock(buffer, mediaType),
          { type: 'text', text: textParts.join('\n\n') },
        ],
      },
    ],
  }).finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('המודל סירב לעבד את המסמך');
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('אין תוכן בתשובת המודל');
  return JSON.parse(text.text);
}

/**
 * Same multi-order extraction, but for TEXT content (e.g. an Excel converted
 * to a table, or a weekly email body with a list per day).
 */
async function parseTextOrders(text, { hint = '' } = {}) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const response = await client.messages.stream({
    model: config.anthropicDocModel,
    max_tokens: 32000,
    system: [{ type: 'text', text: DOC_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: buildDocSchema() } },
    messages: [
      {
        role: 'user',
        content: `Today is ${todayStr} (Israel).${hint ? ` Context: ${hint}.` : ''}\nExtract the order list(s) from this content:\n"""\n${text}\n"""`,
      },
    ],
  }).finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('המודל סירב לעבד את התוכן');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('אין תוכן בתשובת המודל');
  return JSON.parse(block.text);
}

module.exports = { parseOrderDocument, parseTextOrders };
