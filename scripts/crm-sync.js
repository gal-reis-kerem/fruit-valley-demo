// Manual CRM sync + readiness report. Run: npm run crm:sync
const source = require('../src/crm/source');

(async () => {
  console.log('מסנכרן את ה-CRM…\n');
  try {
    const snap = await source.sync();
    const report = source.readinessReport(snap);

    console.log(`ספירות (${snap.syncedAt}):`);
    console.log(JSON.stringify(snap.counts, null, 2));

    if (snap.validationIssues.length) {
      console.log('\nאזהרות ולידציה:');
      for (const issue of snap.validationIssues) console.log(`  - ${issue}`);
    } else {
      console.log('\nולידציה מול הספירות הצפויות: תקינה');
    }

    console.log('\nסטטוס מוכנות:');
    const byStatus = {};
    for (const o of report.offices) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    console.log(' ', JSON.stringify(byStatus));

    if (report.gaps.length) {
      console.log('\nפערים הדורשים השלמה מפירות העמק:');
      for (const gap of report.gaps) console.log(`  - ${gap}`);
    }

    require('fs').writeFileSync(
      require('path').join(require('../src/config').config.dataDir, 'crm-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('\nהדוח המלא נשמר ב-data/crm-report.json');
  } catch (err) {
    console.error('הסנכרון נכשל:', err.message);
    process.exit(1);
  }
})();
