// Manager <-> digital-worker chat. The worker answers in character, with its
// rulebook as context, and decides: adopt a new rule (within its authority),
// escalate to the Triple team (out of scope), or just converse.
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

const client = new Anthropic();

const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'action', 'rule_text', 'escalation_text'],
  properties: {
    reply: { type: 'string', description: 'התשובה למנהל, בעברית, בגוף ראשון' },
    action: {
      type: 'string',
      enum: ['none', 'add_rule', 'escalate'],
      description:
        'add_rule: the manager raised a gap/instruction WITHIN my authority - I adopt it into my rulebook. escalate: outside my authority / needs the Triple team. none: regular conversation.',
    },
    rule_text: {
      type: ['string', 'null'],
      description: 'When action=add_rule: the new rule, one concise Hebrew sentence, actionable.',
    },
    escalation_text: {
      type: ['string', 'null'],
      description: 'When action=escalate: a one-line Hebrew summary of the request for the Triple team.',
    },
  },
};

async function workerChat(worker, rulebook, history) {
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 4000,
    system: [
      {
        type: 'text',
        text:
          `את/ה ${worker.name}, עובד/ת דיגיטלי/ת של Triple בצוות של פירות העמק, בתפקיד: ${worker.role}. ` +
          `את/ה משוחח/ת עם המנהל/ת. דבר/י עברית חמה, טבעית וקצרה, בגוף ראשון, כמו עמית/ה בצוות.\n\n` +
          `ספר החוקים שלך:\n---\n${rulebook}\n---\n\n` +
          `כללי החלטה:\n` +
          `1. אם המנהל מעלה פער, בקשה או הנחיה שבתחום האחריות והסמכות שלך — אמץ/י אותה: הסבר/י בקצרה איך תיישם/י, וקבע/י action=add_rule עם ניסוח כלל תמציתי ב-rule_text. ציין/י בתשובה שהוספת את זה לספר החוקים שלך.\n` +
          `2. אם הבקשה מחוץ לסמכותך, סותרת את "מה לא בסמכותי", או דורשת שינוי מערכתי — אמר/י בחום שזה חשוב ושאת/ה מעביר/ה את זה לחבר'ה של Triple (הם יקבלו הודעת וואטסאפ), וקבע/י action=escalate עם escalation_text.\n` +
          `3. אחרת — שיחה רגילה, action=none.\n` +
          `לעולם אל תמציא/י יכולות שאין לך.`,
      },
    ],
    output_config: { format: { type: 'json_schema', schema: CHAT_SCHEMA } },
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  if (response.stop_reason === 'refusal') throw new Error('worker chat refused');
  const text = response.content.find((b) => b.type === 'text');
  return JSON.parse(text.text);
}

module.exports = { workerChat };
