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
  required: ['customer_name_in_doc', 'days_mentioned', 'orders'],
  properties: {
    customer_name_in_doc: {
      type: ['string', 'null'],
      description: 'The customer/company name as written INSIDE the document (header, address block, delivery-note recipient). null if none appears.',
    },
    days_mentioned: {
      type: 'array',
      items: { type: 'string', enum: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] },
      description: 'Hebrew weekday names that appear in the document header/title as the days this list applies to. Empty when none.',
    },
    orders: {
      type: 'array',
      description:
        'The order list(s) in the document. Almost always ONE entry. Multiple entries ONLY when the document explicitly contains separate lists for separate delivery dates (e.g. a weekly email with a table per day).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['delivery_date', 'items'],
        properties: {
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
- Quantities: distinguish weight (ק"ג) from units/packages. Codes: k=ק"ג, u=יחידה.
- Translate every product to English, Thai and Arabic.
- category: vegetables / fruits / dairy / other (picking areas). vat_exempt=true only for fresh produce.
- Keep the document's item order.
- customer_name_in_doc: report the customer name exactly as the document shows it, even if surprising.
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
 * @param {object} opts { mediaType, hint } - hint is free-text context, e.g.
 *   "base order of אלמה, floors display" or "weekly email of סולאראדג׳ ציפורית"
 * @returns {Promise<{customer_name_in_doc, days_mentioned, orders:[{delivery_date, items}]}>}
 */
async function parseOrderDocument(buffer, { mediaType = 'application/pdf', hint = '' } = {}) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  // stream() because base-order tables can be long (SDK caps non-streaming
  // requests by estimated duration)
  const response = await client.messages.stream({
    model: config.anthropicModel,
    max_tokens: 32000,
    system: [{ type: 'text', text: DOC_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: buildDocSchema() } },
    messages: [
      {
        role: 'user',
        content: [
          mediaBlock(buffer, mediaType),
          { type: 'text', text: `Today is ${todayStr} (Israel).${hint ? ` Context: ${hint}.` : ''}\nExtract the order list(s) from this document.` },
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
    model: config.anthropicModel,
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
