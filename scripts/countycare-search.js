#!/usr/bin/env node
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

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

// Fetch provider name from NPI Registry
async function getProviderNameFromNPI(npi) {
  try {
    const response = await fetch(`https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`);
    const data = await response.json();

    if (data.result_count > 0) {
      const provider = data.results[0];
      const basic = provider.basic;

      if (basic.first_name && basic.last_name) {
        return {
          firstName: basic.first_name,
          lastName: basic.last_name,
          fullName: `${basic.first_name} ${basic.last_name}`
        };
      }
    }
  } catch (error) {
    console.error('Error fetching NPI data:', error.message);
  }
  return null;
}

async function searchCountyCareProvider(npi, options = {}) {
  const {
    headless = true,
    slowMo = 0,
    timeout = 60000,
    location = '60403'
  } = options;

  const result = {
    success: false,
    npi,
    payer: 'County Care',
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

  // Get provider name from NPI registry
  console.log(`Looking up provider name for NPI ${npiStr}...`);
  const providerInfo = await getProviderNameFromNPI(npiStr);
  if (!providerInfo) {
    result.error = 'Could not retrieve provider name from NPI registry';
    return result;
  }

  console.log(`Found provider: ${providerInfo.fullName}`);

  const browser = await playwright.chromium.launch({
    headless,
    slowMo,
    chromiumSandbox: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  // Remove automation indicators
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    const start = Date.now();

    // Step 1: Navigate to County Care provider directory
    console.log('Navigating to County Care provider directory...');
    await page.goto('https://www.countycare.com/find-a-provider', {
      waitUntil: 'domcontentloaded',
      timeout
    });
    await page.waitForTimeout(3000);

    // Step 2: Click "Choose a location"
    console.log(`Setting location: ${location}...`);
    const chooseLocationBtn = page.locator('button:has-text("Choose a location")');
    await chooseLocationBtn.click();
    await page.waitForTimeout(2000);

    // Step 3: Enter location
    const locationInput = page.locator('input[type="text"]').first();
    await locationInput.click();
    await locationInput.fill(location);
    await page.waitForTimeout(2000);

    // Step 4: Select first location from dropdown
    const firstLocationOption = page.locator('button').filter({ hasText: location.split(',')[0] }).first();
    await firstLocationOption.click();
    await page.waitForTimeout(2000);

    // Step 5: Click "Yes, this is correct"
    const confirmBtn = page.locator('button:has-text("Yes, this is correct")');
    await confirmBtn.click();
    await page.waitForTimeout(3000);

    // Step 6: Click "Doctors by name" to access doctor search
    console.log('Clicking "Doctors by name"...');
    const doctorsByNameCard = page.locator('div').filter({ hasText: /^Doctors by name$/ }).first();
    await doctorsByNameCard.click();
    await page.waitForTimeout(5000);

    // Step 7: Enter provider name in the HealthSparq autosuggest search
    console.log(`Searching for provider: ${providerInfo.fullName}...`);
    const searchInput = page.locator('input#SEARCH_AUTOSUGGEST_INPUT, input[type="text"]').first();
    await searchInput.click();
    await searchInput.fill(providerInfo.fullName);
    await page.waitForTimeout(3000);

    // Wait for autocomplete suggestions or press Enter to search
    const suggestionExists = await page.locator('[role="option"], .autocomplete-suggestion').first().isVisible({ timeout: 3000 }).catch(() => false);

    if (suggestionExists) {
      // Click first autocomplete suggestion if available
      console.log('Clicking autocomplete suggestion...');
      await page.locator('[role="option"], .autocomplete-suggestion').first().click();
      await page.waitForTimeout(5000);
    } else {
      // Otherwise submit the search
      console.log('Submitting search...');
      await searchInput.press('Enter');
      await page.waitForTimeout(5000);
    }

    // Step 8: Check for actual results
    console.log('Checking for results...');

    // Check page text for "no results" or actual results count
    const pageText = await page.textContent('body');

    // Check for specific "no results" messages (be specific to avoid false positives)
    const noResultsPatterns = [
      /no providers found/i,
      /no matches found/i,
      /didn't find any/i,
      /couldn't find any/i,
      /0 results/i,
      /0 search results/i
    ];

    const hasNoResults = noResultsPatterns.some(pattern => pattern.test(pageText));

    // Also check if we have actual result indicators
    const hasResults = /\d+\s+search results/i.test(pageText) || /displaying \d+-\d+ of \d+/i.test(pageText);

    if (hasNoResults && !hasResults) {
      console.log('No results found - provider not in County Care network');
      result.error = 'Provider not found in County Care network';
      result.success = false;
      result.providers = [];
      result.metadata.durationMs = Date.now() - start;

      // Save artifacts for debugging
      const artifactDir = ensureArtifactsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basePath = path.join(artifactDir, `countycare-noresults-${npiStr}-${timestamp}`);

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

      return result;
    }

    // Step 9: Extract results (only if we didn't get "no results")
    console.log('Extracting search results...');
    const providers = await page.evaluate(({ firstName, lastName }) => {
      const results = [];
      const seen = new Set();

      // More specific selectors - avoid generic cards and divs
      // Look for actual provider result cards with more structure
      const resultElements = document.querySelectorAll([
        '[data-test="provider-card"]',
        '[data-provider-id]',
        '[data-providerid]',
        '.provider-card',
        '.provider-result',
        '.search-result-item',
        '[class*="ProviderCard"]',
        '[class*="provider-card"]'
      ].join(', '));

      // If no specific provider cards found, fall back but with stricter validation
      let elementsToCheck = resultElements.length > 0 ? resultElements :
                            document.querySelectorAll('.card, [class*="result-item"]');

      elementsToCheck.forEach(el => {
        const text = el.textContent || '';

        // Skip elements that are clearly error messages or UI chrome
        const skipPatterns = [
          /search area/i,
          /suggestions to get you back/i,
          /try again/i,
          /refine your search/i,
          /no results/i,
          /filter by/i,
          /sort by/i,
          /^(map|list|grid)$/i
        ];

        if (skipPatterns.some(pattern => pattern.test(text))) {
          return;
        }

        // Check if this element contains provider information
        if (text.includes(lastName) || text.includes(firstName)) {
          const provider = {
            name: null,
            specialty: null,
            location: null,
            phone: null,
            accepting: null
          };

          // Try to extract name - prioritize headings and name-specific elements
          const nameEl = el.querySelector('[class*="name"], [class*="Name"], h2, h3, h4, h5, strong');
          if (nameEl) {
            const nameText = nameEl.textContent.trim();
            // Filter out common UI text that isn't a provider name
            if (nameText &&
                !nameText.toLowerCase().includes('accepting new patients') &&
                !nameText.toLowerCase().includes('local providers') &&
                !nameText.toLowerCase().includes('search area') &&
                !nameText.toLowerCase().includes('suggestions') &&
                nameText.length > 5 &&
                nameText.length < 100) {
              provider.name = nameText;
            }
          }

          // Must have actual contact info or specialty to be considered valid
          const hasContactInfo = el.querySelector('[class*="phone"], [class*="Phone"], [class*="address"], [class*="Address"]');
          const hasSpecialty = el.querySelector('[class*="specialty"], [class*="Specialty"]');

          if (!hasContactInfo && !hasSpecialty && provider.name) {
            // This is likely not a real provider result
            return;
          }

          // Try to extract specialty
          const specialtyEl = el.querySelector('[class*="specialty"], [class*="Specialty"]');
          if (specialtyEl) {
            provider.specialty = specialtyEl.textContent.trim();
          }

          // Try to extract location
          const locationEl = el.querySelector('[class*="address"], [class*="Address"], [class*="location"], [class*="Location"]');
          if (locationEl) {
            provider.location = locationEl.textContent.trim();
          }

          // Try to extract phone
          const phoneEl = el.querySelector('[class*="phone"], [class*="Phone"]');
          if (phoneEl) {
            provider.phone = phoneEl.textContent.trim();
          }

          // Check if accepting new patients
          if (text.toLowerCase().includes('accepting new patients')) {
            provider.accepting = 'Yes';
          } else if (text.toLowerCase().includes('not accepting')) {
            provider.accepting = 'No';
          }

          // Only add if we have a valid provider name and it hasn't been seen before
          if (provider.name) {
            const normalizedName = provider.name.toLowerCase().replace(/\s+/g, ' ').trim();
            if (!seen.has(normalizedName)) {
              seen.add(normalizedName);
              results.push(provider);
            }
          }
        }
      });

      return results;
    }, { firstName: providerInfo.firstName, lastName: providerInfo.lastName });

    // Filter and format providers
    result.providers = providers
      .filter(p => p.name && p.name.trim().length > 0) // Ensure valid name
      .map(p => ({
        name: normalizeText(p.name),
        specialty: normalizeText(p.specialty),
        location: normalizeText(p.location),
        phone: normalizeText(p.phone),
        acceptingNewPatients: p.accepting,
        network: 'County Care Network'
      }));

    result.metadata.totalResults = providers.length;
    result.metadata.searchedName = providerInfo.fullName;

    // Save artifacts
    const artifactDir = ensureArtifactsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `countycare-${npiStr}-${timestamp}`);

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
    result.success = providers.length > 0;

    if (!result.success) {
      result.error = 'No providers found in County Care network';
      result.metadata.note = 'Provider may not be in County Care network or search method needs adjustment';
    }

  } catch (error) {
    result.error = error.message;

    // Save debug artifacts on error
    try {
      const artifactDir = ensureArtifactsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basePath = path.join(artifactDir, `countycare-error-${npiStr}-${timestamp}`);

      await page.screenshot({ path: `${basePath}.png`, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(`${basePath}.html`, html, 'utf8');
    } catch (debugErr) {
      // Ignore debug save errors
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  const [,, npiArg, locationArg] = process.argv;
  if (!npiArg) {
    console.error('Usage: node scripts/countycare-search.js <NPI> [location]');
    process.exit(1);
  }

  const options = {
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0,
    location: locationArg || '60403'
  };

  const result = await searchCountyCareProvider(npiArg.trim(), options);
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

module.exports = { searchCountyCareProvider };
