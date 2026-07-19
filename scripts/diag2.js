// Read-only probe: which WhatsApp Web internal modules (that wwebjs depends
// on) are missing in the currently pinned web version? Sends nothing.
const { createWhatsAppClient } = require('../src/whatsapp/client');

const MODULES = ["WABase64","WADeprecatedSendIq","WALinkify","WAMediaCalculateFilehash","WAPhoneFindCC","WAWap","WAWebApiContact","WAWebChatGetters","WAWebChatSendMessages","WAWebCmd","WAWebCollections","WAWebContactCollection","WAWebContactGetters","WAWebFindChatAction","WAWebImageUtils","WAWebJidToWid","WAWebLidMigrationUtils","WAWebMediaDataUtils","WAWebMediaInMemoryBlobCache","WAWebMediaOpaqueData","WAWebMediaStorage","WAWebMmsMediaTypes","WAWebMsgDataFromModel","WAWebMsgKey","WAWebMsgReply","WAWebPrepRawMedia","WAWebSendMsgChatAction","WAWebSendReactionMsgAction","WAWebSendSeen","WAWebUploadManager","WAWebUserPrefsGeneral","WAWebUserPrefsMeUser","WAWebWidFactory","WAWebWidToJid"];

(async () => {
  const client = await createWhatsAppClient();
  client.on('ready', async () => {
    const result = await client.pupPage.evaluate((mods) => {
      const missing = [];
      const ok = [];
      for (const m of mods) {
        try {
          const r = window.require(m);
          (r ? ok : missing).push(m);
        } catch (e) {
          missing.push(m);
        }
      }
      return { missing, okCount: ok.length };
    }, MODULES);
    console.log('OK modules:', result.okCount, '/', MODULES.length);
    console.log('MISSING:', JSON.stringify(result.missing, null, 1));
    process.exit(0);
  });
  await client.initialize();
})();
