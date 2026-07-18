const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { config } = require('../config');
const log = require('../logger');

async function createWhatsAppClient() {
  // whatsapp-web.js bundles its own (older) puppeteer whose Chrome download
  // may be missing/corrupt — always launch the Chrome of the top-level
  // puppeteer install, the same binary the PDF generator uses.
  const executablePath = await puppeteer.executablePath();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    puppeteer: {
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    log.info('סרוק את קוד ה-QR עם וואטסאפ בטלפון (הגדרות ← מכשירים מקושרים):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => log.info('וואטסאפ: אומת בהצלחה'));
  client.on('auth_failure', (msg) => log.error('וואטסאפ: כשל אימות', msg));
  client.on('disconnected', (reason) => log.warn('וואטסאפ: נותק -', reason));

  return client;
}

/** Find a group chat by its exact display name. */
async function findGroupByName(client, name) {
  if (!name) return null;
  const chats = await client.getChats();
  return chats.find((c) => c.isGroup && c.name === name) || null;
}

/** Log all group names — helps filling PICKING_GROUP_NAME in .env */
async function listGroups(client) {
  const chats = await client.getChats();
  return chats.filter((c) => c.isGroup).map((c) => c.name);
}

module.exports = { createWhatsAppClient, findGroupByName, listGroups, MessageMedia };
