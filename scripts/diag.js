// Diagnostic probe: what does the injected WhatsApp Web page actually expose?
const { createWhatsAppClient } = require('../src/whatsapp/client');

(async () => {
  const client = await createWhatsAppClient();

  client.on('ready', async () => {
    try {
      console.log('WWeb version:', await client.getWWebVersion());
    } catch (e) {
      console.log('getWWebVersion failed:', e.message);
    }
    try {
      const probe = await client.pupPage.evaluate(() => ({
        hasStore: typeof window.Store,
        hasWWebJS: typeof window.WWebJS,
        storeKeys: window.Store ? Object.keys(window.Store).slice(0, 15) : null,
        hasRequire: typeof window.require,
        debugVersion: window.Debug ? window.Debug.VERSION : null,
      }));
      console.log('Page probe:', JSON.stringify(probe, null, 2));
    } catch (e) {
      console.log('probe failed:', e.message);
    }
    try {
      await client.getChats();
      console.log('getChats: OK');
    } catch (e) {
      console.log('getChats failed, full stack:\n', e.stack);
    }
    process.exit(0);
  });

  await client.initialize();
})();
