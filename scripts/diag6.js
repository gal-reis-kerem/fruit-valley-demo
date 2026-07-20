// Read-only: is wwebjs's reaction hook actually installed (bulkUpsert wrapped)?
// And what do MsgKey objects look like on this web version?
const { createWhatsAppClient, findGroupByName } = require('../src/whatsapp/client');

(async () => {
  const client = await createWhatsAppClient();
  client.on('ready', async () => {
    const probe = await client.pupPage.evaluate((gid) => {
      const out = {};
      try {
        const m = window.require('WAWebAddonReactionTableMode');
        const src = m.reactionTableMode.bulkUpsert.toString();
        out.hookInstalled = src.includes('onReaction');
        out.fnHead = src.slice(0, 80);
      } catch (e) {
        out.hookErr = e.message;
      }
      try {
        const wid = window.require('WAWebWidFactory').createWid(gid);
        const chat = window.require('WAWebCollections').Chat.get(wid);
        const mine = chat && [...chat.msgs.getModelsArray()].reverse().find((x) => x.id && x.id.fromMe);
        if (mine) {
          const k = mine.id;
          out.keyFields = Object.keys(k).slice(0, 12);
          out.serialized = k._serialized;
          out.dollar1 = k.$1;
          out.manual = [k.fromMe, k.remote && (k.remote._serialized || String(k.remote)), k.id].join('_');
          out.toString = String(k);
        } else out.noMine = true;
      } catch (e) {
        out.keyErr = e.message;
      }
      return out;
    }, process.argv[2]);
    console.log(JSON.stringify(probe, null, 1));
    process.exit(0);
  });
  await client.initialize();
})();
