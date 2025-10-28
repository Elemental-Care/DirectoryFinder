#!/usr/bin/env node
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

// Brand configurations for Centene family
// Note: Wellcare and Ambetter might need different URLs - these are placeholders
const BRAND_CONFIG = {
  meridian: {
    url: 'https://findaprovider.ilmeridian.com/location',
    plans: {
      medicaid: 'MeridianHealth: Medicaid',
      meridiancomplete: 'MeridianComplete (Medicare-Medicaid Plan)'
    }
  },
  wellcare: {
    url: 'https://findaprovider.wellcare.com/location', // May redirect - to be tested
    plans: {
      medicare: 'Medicare',
      medicaid: 'Medicaid'
    }
  },
  ambetter: {
    url: 'https://findaprovider.ambetterhealth.com/location', // May redirect - to be tested
    plans: {
      marketplace: 'Ambetter',
      essential: 'Essential'
    }
  }
};

const DEFAULT_LOCATION = '60403-1201';

function formatPhone(text) {
  if (!text) return null;
  const match = text.replace(/\s+/g, ' ').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match ? match[0] : text.trim();
}

function normalizeText(value) {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim();
}

function cleanSpecialty(text) {
  if (!text) return null;
  return text
    .replace(/\s+—\s*board certified;?/i, '')
    .replace(/;+$/g, '')
    .trim();
}

function ensureArtifactsDir() {
  const os = require('os');
  // Use OS temp directory to avoid ASAR issues when packaged
  const artifactDir = path.join(os.tmpdir(), 'provider-directory-artifacts');
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  return artifactDir;
}

async function acceptCookieBanner(page) {
  try {
    const acceptButton = page.locator('button', { hasText: 'Accept' });
    if (await acceptButton.count()) {
      await acceptButton.first().click();
      await page.waitForTimeout(500);
    }
  } catch {
    // Ignore consent banner issues
  }
}

async function typeLocation(page, locationQuery, timeout) {
  await page.waitForSelector('#location-input', { timeout });
  await page.click('#location-input');
  await page.fill('#location-input', '');
  await page.type('#location-input', locationQuery, { delay: 50 });
  await page.waitForSelector('.pac-item', { timeout });
  await page.click('.pac-item:nth-child(1)');
  await page.waitForTimeout(500);
}

async function selectPlan(page, planLabel, timeout) {
  await page.waitForSelector('#select-network', { timeout });
  const options = await page.$$eval('#select-network option', opts =>
    opts.map(option => ({
      value: option.value,
      text: option.textContent.trim()
    }))
  );

  const match = options.find(opt => opt.text.toLowerCase().includes(planLabel.toLowerCase()));
  if (!match) {
    throw new Error(`Plan containing "${planLabel}" is not available for the chosen location.`);
  }

  await page.selectOption('#select-network', match.value);
  await page.waitForTimeout(500);
}

async function performNpiSearch(page, npi, timeout) {
  await page.waitForSelector('#multitype-comobobox-search', { timeout });
  await page.fill('#multitype-comobobox-search', '');
  await page.type('#multitype-comobobox-search', npi, { delay: 50 });
  await page.waitForSelector('.suggested-multitype-result', { timeout });

  const npiOption = page.locator('.suggested-multitype-result', { hasText: 'Search By NPI' });
  if ((await npiOption.count()) === 0) {
    const suggestions = await page.$$eval('.suggested-multitype-result', nodes =>
      nodes.map(node => node.textContent.trim())
    );
    throw new Error(`Unable to locate "Search By NPI" suggestion. Suggestions: ${JSON.stringify(suggestions)}`);
  }

  await Promise.all([
    page.waitForURL(/search-results/, { timeout }),
    npiOption.first().click()
  ]);

  await page.waitForSelector('search-result md-card', { timeout });
}

async function extractProviderResults(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('search-result md-card'));
    return cards.map(card => {
      const textFrom = selector => {
        const el = card.querySelector(selector);
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
      };

      const getIndicator = selector => {
        const el = card.querySelector(selector);
        if (!el) return null;
        const raw = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!raw) return null;
        if (raw.includes('accepting')) return true;
        if (raw.includes('not accepting')) return false;
        if (raw.includes('in network') || raw.includes('in-network')) return true;
        if (raw.includes('out of network')) return false;
        return raw;
      };

      const specialties = Array.from(card.querySelectorAll('.specialty-item'))
        .map(el => el.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const phoneLink = card.querySelector('a[href^="tel:"]');

      return {
        name: textFrom('h2'),
        organization: textFrom('[id^="provider-org-name"] span'),
        address: textFrom('[id^="provider-formatted-address"] span'),
        phoneRaw: phoneLink ? phoneLink.textContent : null,
        specialties,
        acceptingNewPatients: getIndicator('[id^="accept-new-patients"] webl-component'),
        inNetwork: getIndicator('[id^="in-network"] webl-component'),
        primaryCareProvider: getIndicator('[id^="primary-care-provider"] webl-component')
      };
    });
  });
}

async function searchCenteneProvider(npi, options = {}) {
  const {
    brand = 'meridian',
    planKey = 'medicaid',
    location = DEFAULT_LOCATION,
    headless = true,
    slowMo = 0,
    timeout = 60000,
    waitAfterSelectionMs = 1000
  } = options;

  const brandConfig = BRAND_CONFIG[brand];
  if (!brandConfig) {
    throw new Error(`Unknown brand "${brand}". Valid options: ${Object.keys(BRAND_CONFIG).join(', ')}`);
  }

  const planLabel = brandConfig.plans[planKey];
  if (!planLabel) {
    throw new Error(`Unknown plan "${planKey}" for brand "${brand}". Valid options: ${Object.keys(brandConfig.plans).join(', ')}`);
  }

  const result = {
    success: false,
    npi,
    brand,
    plan: planLabel,
    locationQuery: location,
    providers: [],
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
    const start = Date.now();
    await page.goto(brandConfig.url, { waitUntil: 'networkidle', timeout });
    await acceptCookieBanner(page);

    await typeLocation(page, location, timeout);
    await Promise.all([
      page.waitForResponse(resp => resp.url().includes('productmapping/v2') && resp.request().method() === 'POST', { timeout }).catch(() => null),
      page.click('#continue-submit-button')
    ]);

    await selectPlan(page, planLabel, timeout);
    await Promise.all([
      page.waitForURL(/restrictSites=true/, { timeout }),
      page.click('#continue-submit-button')
    ]);

    await page.waitForTimeout(waitAfterSelectionMs);
    await performNpiSearch(page, npi, timeout);
    await page.waitForTimeout(waitAfterSelectionMs);

    const providerCards = await extractProviderResults(page);
    if (!providerCards.length) {
      throw new Error('No provider results returned for the supplied NPI.');
    }

    result.providers = providerCards.map(provider => {
      const { phoneRaw, ...rest } = provider;
      return {
        ...rest,
        name: normalizeText(rest.name),
        organization: normalizeText(rest.organization),
        address: normalizeText(rest.address),
        specialties: Array.isArray(rest.specialties)
          ? rest.specialties.map(cleanSpecialty).map(normalizeText).filter(Boolean)
          : [],
        phone: formatPhone(phoneRaw),
        rawPhone: normalizeText(phoneRaw)
      };
    });

    const artifactDir = ensureArtifactsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `${brand}-${planKey}-${npi}-${timestamp}`);

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

    result.metadata.durationMs = Date.now() - start;
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
  const [,, npiArg, ...restArgs] = process.argv;
  if (!npiArg) {
    console.error('Usage: node scripts/centene-search.js <NPI> [--brand=meridian|wellcare|ambetter] [--plan=<plan_key>] [--location="City, ST or ZIP"]');
    process.exit(1);
  }

  let brand = 'meridian';
  let planKey = 'medicaid';
  let location = DEFAULT_LOCATION;

  for (const arg of restArgs) {
    if (arg.startsWith('--brand=')) {
      brand = arg.slice('--brand='.length).toLowerCase();
    } else if (arg.startsWith('--plan=')) {
      planKey = arg.slice('--plan='.length).toLowerCase();
    } else if (arg.startsWith('--location=')) {
      location = arg.slice('--location='.length);
    }
  }

  const options = {
    brand,
    planKey,
    location,
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0
  };

  const result = await searchCenteneProvider(npiArg.trim(), options);
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

module.exports = { searchCenteneProvider };
