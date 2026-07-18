const path = require('path');
const puppeteer = require('puppeteer');
const { buildPickingSheetHTML } = require('./template');
const { orderDir } = require('../orders/store');
const { config } = require('../config');

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

/**
 * Render the picking sheet for an order to a PDF file.
 * @returns {Promise<string>} absolute path of the generated PDF
 */
async function generatePickingSheetPDF(order) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const html = buildPickingSheetHTML(order, { changesCutoff: config.changesCutoff });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const fileName = `${order.id}-v${order.version}.pdf`;
    const pdfPath = path.join(orderDir(order), fileName);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    return pdfPath;
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { generatePickingSheetPDF, closeBrowser };
