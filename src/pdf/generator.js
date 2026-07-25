const path = require('path');
const puppeteer = require('puppeteer');
const { buildPickingSheetHTML } = require('./template');
const { customerDir, orderFileBase } = require('../orders/store');
const { config } = require('../config');
const log = require('../logger');

// Singleton browser for PDF rendering. It can die behind our back (crash,
// cleanup kills, OS pressure) — never trust the cached promise: verify the
// connection and relaunch when needed.
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    browserPromise = null;
    log.warn('דפדפן ה-PDF נסגר - מפעיל חדש');
  }
  browserPromise = puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const browser = await browserPromise;
  browser.on('disconnected', () => {
    browserPromise = null;
  });
  return browser;
}

async function renderOnce(order) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const html = buildPickingSheetHTML(order, { changesCutoff: config.changesCutoff });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const fileName = `${orderFileBase(order)}.pdf`;
    const pdfPath = path.join(customerDir(order), fileName);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    return pdfPath;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render the picking sheet for an order to a PDF file.
 * One automatic retry with a fresh browser if the first attempt fails.
 * @returns {Promise<string>} absolute path of the generated PDF
 */
async function generatePickingSheetPDF(order) {
  try {
    return await renderOnce(order);
  } catch (err) {
    log.warn(`הפקת PDF נכשלה (${err.message}) - מנסה שוב עם דפדפן חדש`);
    browserPromise = null;
    return renderOnce(order);
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = { generatePickingSheetPDF, closeBrowser };
