#!/usr/bin/env node
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

const PLAN_CONFIG = {
  marketplace: 'marketplace'
};

const DEFAULT_LOCATION = 'Crest Hill, IL 60403';

function formatPhone(text) {
  if (!text) return null;
  const match = text.replace(/\s+/g, ' ').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match ? match[0] : text.trim();
}

function normalizeText(value) {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim();
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

async function searchAmbetterProvider(npi, options = {}) {
  const {
    planKey = 'marketplace',
    location = DEFAULT_LOCATION,
    headless = true,
    slowMo = 0,
    timeout = 60000
  } = options;

  const lineOfBusiness = PLAN_CONFIG[planKey];
  if (!lineOfBusiness) {
    throw new Error(`Unknown plan "${planKey}". Valid options: ${Object.keys(PLAN_CONFIG).join(', ')}`);
  }

  const result = {
    success: false,
    npi,
    plan: `Ambetter ${planKey.charAt(0).toUpperCase() + planKey.slice(1)}`,
    locationQuery: location,
    providers: [],
    rawHtmlPath: null,
    screenshotPath: null,
    metadata: {}
  };

  // Validate NPI
  const npiStr = String(npi).trim();
  if (!/^\d{10}$/.test(npiStr)) {
    result.error = `Invalid NPI format: "${npiStr}". NPI must be exactly 10 digits.`;
    return result;
  }

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

    // Step 1: Navigate to location page
    await page.goto(`https://my.ambetterhealth.com/x/findaprovider/${lineOfBusiness}/en/default/location`,
      { waitUntil: 'networkidle', timeout });
    await page.waitForTimeout(2000);

    // Accept cookie banner
    try {
      const acceptButton = page.locator('button:has-text("Accept")');
      if (await acceptButton.count()) {
        await acceptButton.first().click();
        await page.waitForTimeout(500);
      }
    } catch {}

    // Step 2: Fill location
    await page.fill('#autocomplete-input', location);
    await page.waitForTimeout(2000);

    const hasPacItem = await page.locator('.pac-item').count();
    if (hasPacItem > 0) {
      await page.click('.pac-item:first-child');
      await page.waitForTimeout(1000);
    }

    // Step 3: Continue to plan selection
    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(4000);

    // Step 4: Select first medical plan (HMO/PPO, not PDP)
    const selectedPlanName = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[name="plan_choices"]'));

      // Filter for medical plans (exclude PDP which are pharmacy-only)
      for (const input of inputs) {
        const label = input.closest('label');
        if (!label) continue;

        const text = label.textContent.trim().toUpperCase();

        // Skip PDP (prescription drug plans) and look for HMO/PPO
        if (text.includes('(PDP)')) continue;

        // Accept HMO, PPO, or other non-PDP plans
        if (text.includes('(HMO') || text.includes('(PPO') ||
            text.includes('HMO-') || text.includes('PPO-') ||
            (!text.includes('PDP') && !text.includes('PRESCRIPTION'))) {
          input.click();
          return label.textContent.trim();
        }
      }

      // Fallback: select first non-PDP plan
      for (const input of inputs) {
        const label = input.closest('label');
        if (!label) continue;
        const text = label.textContent.trim().toUpperCase();
        if (!text.includes('(PDP)')) {
          input.click();
          return label.textContent.trim();
        }
      }

      return null;
    });

    if (!selectedPlanName) {
      throw new Error('No medical plan found (all plans appear to be PDP/pharmacy-only)');
    }

    result.plan = selectedPlanName;
    await page.waitForTimeout(1000);

    // Step 5: Continue to search page
    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(4000);

    // Step 6: Search by NPI
    const searchInput = page.locator('input[aria-autocomplete="list"]').first();
    await searchInput.fill(npiStr);
    await page.waitForTimeout(2000);

    // Step 7: Click "Search by NPI" option
    const npiOption = page.locator('[role="option"]:has-text("Search by NPI")');
    if (await npiOption.count() === 0) {
      throw new Error(`NPI search option not found for NPI "${npiStr}"`);
    }

    await Promise.all([
      page.waitForURL(/results/, { timeout }),
      npiOption.first().click()
    ]);

    await page.waitForTimeout(3000);

    // Step 8: Extract provider results
    const providers = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="vertical-card"]'));
      if (cards.length === 0) {
        return null; // Signal to take screenshot for debugging
      }

      return cards.map(card => {
        const textFrom = selector => {
          const el = card.querySelector(selector);
          return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
        };

        // Name is in h2 > button[data-testid="link"]
        const name = textFrom('h2 button[data-testid="link"]');

        // Specialty is near the name
        const specialtyText = textFrom('[style*="font-size: 18px"]');

        // Address is in a button link
        const addressLinks = Array.from(card.querySelectorAll('button[data-testid="link"][href=""]'));
        let address = null;
        for (const link of addressLinks) {
          const text = link.textContent.trim();
          // Address typically has numbers and street names
          if (/\d+\s+[A-Z]/.test(text)) {
            address = text;
            break;
          }
        }

        // Phone number - look for tel: links
        const phoneEl = card.querySelector('[href^="tel:"]');
        const phone = phoneEl ? phoneEl.textContent.trim() : null;

        return {
          name,
          address,
          phone,
          specialty: specialtyText
        };
      }).filter(p => p.name);
    });

    if (!providers || providers.length === 0) {
      // Save debug artifacts
      const artifactDir = ensureArtifactsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basePath = path.join(artifactDir, `ambetter-debug-${npiStr}-${timestamp}`);

      await page.screenshot({ path: `${basePath}.png`, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(`${basePath}.html`, html, 'utf8');

      throw new Error('No provider results found. Debug artifacts saved.');
    }

    result.providers = providers.map(p => ({
      name: normalizeText(p.name),
      address: normalizeText(p.address),
      phone: formatPhone(p.phone),
      specialty: normalizeText(p.specialty)
    }));

    // Save success artifacts
    const artifactDir = ensureArtifactsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `ambetter-${planKey}-${npiStr}-${timestamp}`);

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
    console.error('Usage: node scripts/ambetter-search.js <NPI> [--plan=marketplace] [--location="City, ST or ZIP"]');
    process.exit(1);
  }

  let planKey = 'marketplace';
  let location = DEFAULT_LOCATION;

  for (const arg of restArgs) {
    if (arg.startsWith('--plan=')) {
      planKey = arg.slice('--plan='.length).toLowerCase();
    } else if (arg.startsWith('--location=')) {
      location = arg.slice('--location='.length);
    }
  }

  const options = {
    planKey,
    location,
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0
  };

  const result = await searchAmbetterProvider(npiArg.trim(), options);
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

module.exports = { searchAmbetterProvider };
