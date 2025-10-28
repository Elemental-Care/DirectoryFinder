#!/usr/bin/env node
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

function normalizeText(value) {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim();
}

function formatPhone(text) {
  if (!text) return null;
  const match = text.replace(/\s+/g, ' ').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match ? match[0] : text.trim();
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

async function searchCignaProvider(npi, options = {}) {
  const {
    headless = true,
    slowMo = 0,
    timeout = 60000,
    location = 'Crest Hill, IL 60403'
  } = options;

  const result = {
    success: false,
    npi,
    payer: 'Cigna',
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

    // Step 1: Navigate to Cigna provider directory
    console.log('Navigating to Cigna provider directory...');
    await page.goto('https://hcpdirectory.cigna.com/web/public/consumer/directory/search', {
      waitUntil: 'domcontentloaded',
      timeout
    });
    await page.waitForTimeout(3000);

    // Step 2: Enter location
    console.log(`Entering location: ${location}`);
    const locationInput = page.locator('input[placeholder="Enter Address, City, or Zip"]').first();
    await locationInput.click();
    await page.waitForTimeout(500);
    await locationInput.fill(location);
    await page.waitForTimeout(1500);

    // Wait for autocomplete dropdown and select first option
    try {
      const firstSuggestion = page.locator('[role="option"], .typeahead-option, [class*="suggestion"]').first();
      await firstSuggestion.waitFor({ timeout: 3000 });
      await firstSuggestion.click();
      console.log('Selected location from dropdown');
    } catch (e) {
      // If no dropdown appears, just press Enter
      console.log('No dropdown, pressing Enter');
      await locationInput.press('Enter');
    }
    await page.waitForTimeout(2000);

    // Step 3: Click "Doctor by Name" tab (wait for it to be enabled)
    console.log('Waiting for "Doctor by Name" tab to be enabled...');
    const doctorByNameButton = page.locator('button:has-text("Doctor by Name")');
    await doctorByNameButton.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log('Clicking "Doctor by Name" tab...');
    await doctorByNameButton.click();
    await page.waitForTimeout(3000);

    // Step 4: Wait for search form to appear and enter provider name
    console.log(`Searching for provider: ${providerInfo.fullName}`);
    const nameInput = page.locator('.category-search-form__input').or(page.locator('input[type="text"]')).first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.click();
    await page.waitForTimeout(500);
    await nameInput.fill(providerInfo.lastName);
    await page.waitForTimeout(1000);

    // Step 5: Click search button
    console.log('Clicking search button...');
    const searchButton = page.locator('.category-search-form__btn');
    await searchButton.waitFor({ state: 'visible', timeout: 5000 });
    await searchButton.click();
    await page.waitForTimeout(5000);

    // Step 6: Wait for results to load (autocomplete dropdown should appear)
    console.log('Waiting for search results dropdown...');
    await page.waitForTimeout(5000);

    // Step 7: Extract autocomplete dropdown results
    console.log('Looking for provider results...');

    // Look for the autocomplete dropdown results
    // These appear as button[role="option"] inside typeahead-container
    const resultLinkTexts = await page.evaluate(({ lastName }) => {
      const results = [];
      const options = Array.from(document.querySelectorAll('button[role="option"]'));

      for (const option of options) {
        const text = option.textContent.trim();
        // Skip the "Search 'X' in Doctor Names" option
        if (text.includes('Search') && text.includes('in Doctor Names')) {
          continue;
        }
        // Match options that contain the last name
        if (text.toLowerCase().includes(lastName.toLowerCase())) {
          results.push({
            text: text.replace(/<[^>]*>/g, '').trim(), // Remove any HTML tags
            rawText: text
          });
        }
      }

      return results;
    }, { lastName: providerInfo.lastName });

    if (resultLinkTexts.length === 0) {
      // Save debug artifacts
      const artifactDir = ensureArtifactsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basePath = path.join(artifactDir, `cigna-debug-${npiStr}-${timestamp}`);

      await page.screenshot({ path: `${basePath}.png`, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(`${basePath}.html`, html, 'utf8');

      throw new Error('No provider results found. Debug artifacts saved.');
    }

    console.log(`Found ${resultLinkTexts.length} provider(s) matching ${providerInfo.lastName}`);

    // Extract info directly from the dropdown text
    // Format is typically: "LastName, FirstName Credentials (Specialty - City, State)"
    const providers = resultLinkTexts.map(result => {
      const text = result.text;
      const provider = {
        name: null,
        firstName: null,
        lastName: null,
        specialty: null,
        location: null,
        network: 'Cigna Network' // Default assumption
      };

      // Extract name (everything before the opening parenthesis)
      const nameMatch = text.match(/^([^(]+)/);
      if (nameMatch) {
        provider.name = nameMatch[1].trim();

        // Parse first and last name from "LastName, FirstName" format
        const nameParts = provider.name.split(',');
        if (nameParts.length >= 2) {
          provider.lastName = nameParts[0].trim();
          // Remove credentials from first name (everything before first space after comma)
          const firstNamePart = nameParts[1].trim();
          const firstNameMatch = firstNamePart.match(/^([A-Za-z]+)/);
          provider.firstName = firstNameMatch ? firstNameMatch[1] : firstNamePart.split(/\s+/)[0];
        }
      }

      // Extract specialty and location from parentheses
      // Format: (Specialty - Location)
      const detailsMatch = text.match(/\(([^-]+)\s*-\s*([^)]+)\)/);
      if (detailsMatch) {
        provider.specialty = detailsMatch[1].trim();
        provider.location = detailsMatch[2].trim();
      }

      return provider;
    });

    // Filter to only the provider matching the NPI
    // Check if first name and last name match the provider info we got from NPI registry
    const matchingProviders = providers.filter(p => {
      const firstNameMatch = p.firstName?.toLowerCase() === providerInfo.firstName.toLowerCase();
      const lastNameMatch = p.lastName?.toLowerCase() === providerInfo.lastName.toLowerCase();
      return firstNameMatch && lastNameMatch;
    });

    // If we found an exact match, use only that provider. Otherwise, include all results.
    const filteredProviders = matchingProviders.length > 0 ? matchingProviders : providers;

    result.providers = filteredProviders.map(p => ({
      name: normalizeText(p.name),
      specialty: normalizeText(p.specialty),
      location: normalizeText(p.location),
      network: p.network
    }));

    result.metadata.totalResults = providers.length;
    result.metadata.filteredResults = filteredProviders.length;
    result.metadata.filterApplied = matchingProviders.length > 0;

    // Save success artifacts
    const artifactDir = ensureArtifactsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `cigna-${npiStr}-${timestamp}`);

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
    result.metadata.searchedName = providerInfo.fullName;
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
  const [,, npiArg, locationArg] = process.argv;
  if (!npiArg) {
    console.error('Usage: node scripts/cigna-search.js <NPI> [location]');
    process.exit(1);
  }

  const options = {
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0,
    location: locationArg || 'Crest Hill, IL 60403'
  };

  const result = await searchCignaProvider(npiArg.trim(), options);
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

module.exports = { searchCignaProvider };
