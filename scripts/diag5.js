// Read-only probe: (1) does the reaction-hook module exist on the pinned web
// version? (2) why did the last-own-message lookup fail for the picking group?
// Usage: node scripts/diag5.js "<picking group name>"
const { createWhatsAppClient, findGroupByName } = require('../src/whatsapp/client');

const groupName = process.argv[2];

async function run(attempt) {
  const client = await createWhatsAppClient();
  let ready = false;
  const watchdog = setTimeout(async () => {
    if (ready) return;
    console.log(`תקיעה (ניסיון ${attempt}/3) - מפעיל דפדפן מחדש…`);
    try { await client.destroy(); } catch (e) { /* ignore */ }
    if (attempt < 3) run(attempt + 1);
    else { console.log('נכשל 3 פעמים'); process.exit(1); }
  }, 75000);
  client.on('ready', async () => {
    ready = true;
    clearTimeout(watchdog);
    const probe = await client.pupPage.evaluate(() => {
      const out = {};
      try {
        const m = window.require('WAWebAddonReactionTableMode');
        out.reactionModule = m ? Object.keys(m).slice(0, 10) : null;
        out.bulkUpsertType = m && m.reactionTableMode ? typeof m.reactionTableMode.bulkUpsert : 'no reactionTableMode';
      } catch (e) {
        out.reactionModule = 'REQUIRE FAILED: ' + e.message;
      }
      try {
        out.reactionsCollection = !!window.require('WAWebCollections').Reactions;
      } catch (e) {
        out.reactionsCollection = 'err';
      }
      return out;
    });
    console.log('reaction probe:', JSON.stringify(probe, null, 1));

    const group = await findGroupByName(client, groupName);
    console.log('group found:', group && group.id._serialized);
    if (group) {
      const msgProbe = await client.pupPage.evaluate((gid) => {
        const out = {};
        try {
          const wid = window.require('WAWebWidFactory').createWid(gid);
          const coll = window.require('WAWebCollections').Chat;
          const byWid = coll.get(wid);
          const byStr = coll.get(gid);
          const scan = coll.getModelsArray().find((c) => c.id && c.id._serialized === gid);
          out.byWid = !!byWid; out.byStr = !!byStr; out.byScan = !!scan;
          const chat = byWid || byStr || scan;
          if (chat) {
            const msgs = chat.msgs.getModelsArray();
            out.msgCount = msgs.length;
            const lastMine = [...msgs].reverse().find((m) => m.id && m.id.fromMe);
            out.lastMineId = lastMine ? lastMine.id._serialized : null;
            if (lastMine) {
              out.lastMineHasReactionsProp = 'reactions' in lastMine;
              try { out.reactionsSize = lastMine.reactions ? lastMine.reactions.getModelsArray().length : null; } catch (e) { out.reactionsSize = 'err: ' + e.message; }
            }
          }
        } catch (e) {
          out.error = e.message;
        }
        return out;
      }, group.id._serialized);
      console.log('msg probe:', JSON.stringify(msgProbe, null, 1));
    }
    process.exit(0);
  });
  await client.initialize();
}
run(1);
