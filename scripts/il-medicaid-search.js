#!/usr/bin/env node
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

function formatZip(text) {
  if (!text) return text;
  return text.replace(/(\d{5})(\d{4})\b/, '$1-$2');
}

async function searchIllinoisMedicaid(npi, options = {}) {
  const {
    headless = true,
    timeout = 45000,
    slowMo = 0,
    waitAfterExpandMs = 3000
  } = options;

  const baseUrl = 'https://ext2.hfs.illinois.gov/hfsindprovdirectory';
  const searchUrl = `${baseUrl}/Main/SearchByNPI`;

  const result = {
    success: false,
    npi,
    providerName: null,
    providerRow: [],
    addresses: [],
    categoriesOfService: [],
    rawHtmlPath: null,
    screenshotPath: null,
    metadata: {}
  };

  const browser = await playwright.chromium.launch({
    headless,
    slowMo,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const startTime = Date.now();
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout });

    await page.fill('#NPI', npi);

    await Promise.all([
      page.click('#btnSearch'),
      page.waitForSelector('.e-grid', { timeout })
    ]);

    const headerLabels = await page.$$eval('.e-grid .e-headercell .e-headercelldiv', headers =>
      headers.map(h => h.innerText.trim())
    );

    const mainRows = await page.$$eval('.e-grid .e-row:not(.e-detailrow)', rows =>
      rows.map(row => Array.from(row.querySelectorAll('.e-rowcell')).map(cell => cell.innerText.trim()))
    );

    if (!mainRows.length) {
      throw new Error('No rows returned for the provided NPI');
    }

    result.providerRow = {
      headers: headerLabels,
      values: mainRows[0]
    };

    const nameIndex = headerLabels.findIndex(label => /provider name/i.test(label));
    if (nameIndex >= 0) {
      result.providerName = mainRows[0][nameIndex] || null;
    }

    await page.click('.e-grid .e-detailrowcollapse');

    await page.waitForSelector('.e-detailrow', { timeout });
    if (waitAfterExpandMs > 0) {
      await page.waitForTimeout(waitAfterExpandMs);
    }

    const addressRows = await page.$$eval(`.e-detailrow #ChildGridOne${npi} .e-row`, rows =>
      rows.map(row => {
        const cells = Array.from(row.querySelectorAll('.e-rowcell')).map(cell => cell.innerText.trim());
        return cells.slice(1).filter(Boolean);
      }).filter(parts => parts.length)
    ).catch(() => []);

    result.addresses = addressRows.map(parts => formatZip(parts.join(', ')));

    const categoryRows = await page.$$eval(`.e-detailrow #ChildGridTwo${npi} .e-row`, rows =>
      rows.map(row => {
        const cells = Array.from(row.querySelectorAll('.e-rowcell')).map(cell => cell.innerText.trim());
        return {
          providerType: cells[1] || null,
          categoryOfService: cells[2] || null
        };
      })
    ).catch(() => []);

    result.categoriesOfService = categoryRows.filter(row => row.providerType || row.categoryOfService);

    const detailText = await page.textContent('#content').catch(() => '');
    result.metadata.contentSnippet = detailText ? detailText.slice(0, 600) : '';
    result.metadata.durationMs = Date.now() - startTime;

    const artifactDir = path.resolve(__dirname, '..', 'artifacts');
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `il-medicaid-${npi}-${timestamp}`);

    try {
      await page.screenshot({ path: `${basePath}.png`, fullPage: true });
      result.screenshotPath = `${basePath}.png`;
    } catch (err) {
      result.metadata.screenshotError = err.message;
    }

    try {
      const html = await page.content();
      fs.writeFileSync(`${basePath}.html`, html, 'utf8');
      result.rawHtmlPath = `${basePath}.html`;
    } catch (err) {
      result.metadata.htmlError = err.message;
    }

    result.success = true;
  } catch (error) {
    result.error = error.message;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  const npi = process.argv[2];
  if (!npi) {
    console.error('Usage: node scripts/il-medicaid-search.js <NPI>');
    process.exit(1);
  }

  const options = {
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0
  };

  const result = await searchIllinoisMedicaid(npi, options);
  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { searchIllinoisMedicaid };
