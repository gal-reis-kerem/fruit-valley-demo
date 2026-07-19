// Read-only probe: resolve @lid ids (from the app log) to phone ids.
// Usage: node scripts/diag3.js 124893521793264@lid 106107922043089@lid
const { createWhatsAppClient, resolvePhoneId } = require('../src/whatsapp/client');

const lids = process.argv.slice(2);

(async () => {
  const client = await createWhatsAppClient();
  client.on('ready', async () => {
    for (const lid of lids) {
      const phone = await resolvePhoneId(client, lid);
      console.log(`${lid}  ->  ${phone}`);
    }
    process.exit(0);
  });
  await client.initialize();
})();
