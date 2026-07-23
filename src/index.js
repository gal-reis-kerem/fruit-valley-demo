// CLI entry: run the engine in a terminal (the desktop app uses electron/).
require('./engine')
  .start({ cli: true })
  .catch((err) => {
    console.error('שגיאה קריטית:', err);
    process.exit(1);
  });
