// Diagnose a hang between 'authenticated' and 'ready': log every client
// event; if 'ready' doesn't arrive within 75s, screenshot the hidden page and
// dump its text so we can see what WhatsApp Web is actually showing.
const path = require('path');
const { createWhatsAppClient } = require('../src/whatsapp/client');

const OUT = process.argv[2] || '/tmp/wa-stuck';

(async () => {
  const client = await createWhatsAppClient();
  const t0 = Date.now();
  const stamp = (e) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${e}`);

  for (const ev of ['qr', 'loading_screen', 'authenticated', 'auth_failure', 'change_state', 'disconnected']) {
    client.on(ev, (...args) => stamp(`event: ${ev} ${JSON.stringify(args).slice(0, 120)}`));
  }
  client.on('ready', () => {
    stamp('event: ready ✔ — הכל תקין');
    process.exit(0);
  });

  setTimeout(async () => {
    stamp('ready לא הגיע תוך 75 שניות - מצלם את הדף');
    try {
      await client.pupPage.screenshot({ path: `${OUT}.png` });
      const text = await client.pupPage.evaluate(() => document.body.innerText.slice(0, 600));
      const url = await client.pupPage.url();
      console.log('URL:', url);
      console.log('PAGE TEXT:', JSON.stringify(text));
    } catch (err) {
      console.log('צילום נכשל:', err.message);
    }
    process.exit(1);
  }, 75000);

  await client.initialize();
})();
