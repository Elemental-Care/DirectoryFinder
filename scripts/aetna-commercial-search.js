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

async function searchAetnaCommercial(npi, options = {}) {
  const {
    headless = true,
    slowMo = 0,
    timeout = 60000
  } = options;

  const result = {
    success: false,
    npi,
    payer: 'Aetna Commercial',
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

    // Step 1: Navigate to pre-filled search page
    const url = `https://www.aetna.com/docfind/pinHome.do?langpref=en&&site_id=provider2&&search_cat=phys_bhp&&sortOrder=ASC&&button_flag=S&&secureStatus=N&&sortBy=name&&groups=25&&psid=null&&pinSearchType=npi&&npi=${npiStr}&&provType=medical&&pinSearchInd=Y`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Wait for potential CAPTCHA - give user 60 seconds to solve it manually if needed
    console.log('Waiting for page to load (and for manual CAPTCHA solving if needed)...');
    await page.waitForTimeout(60000);

    // Step 2: Click Search button (it's an input type="image" with id="advanced_submit")
    // Try to find either the initial search button or the "search again" button
    const searchButton = page.locator('#advanced_submit').or(page.locator('input[alt="submit search"]'));

    // Check if button exists and is visible
    const buttonCount = await searchButton.count();
    console.log(`Found ${buttonCount} search button(s)`);

    if (buttonCount > 0) {
      const isVisible = await searchButton.first().isVisible().catch(() => false);
      console.log(`Search button visible: ${isVisible}`);

      if (isVisible) {
        await searchButton.first().click();
        await page.waitForTimeout(5000);
      } else {
        console.log('Search button exists but not visible - page may have already loaded results');
      }
    } else {
      console.log('No search button found - page may have already loaded results');
    }

    // Step 3: Extract provider results from Aetna table structure
    const providers = await page.evaluate(() => {
      const results = [];

      // Aetna uses td.result_name_top_rd for provider names
      const nameElements = Array.from(document.querySelectorAll('td.result_name_top_rd'));

      for (const nameEl of nameElements) {
        const name = nameEl.textContent.trim();
        if (!name || name.length < 3) continue;

        // Find the corresponding detail row (next tr with class result_extra_rd)
        let detailRow = nameEl.closest('tr');
        if (detailRow) {
          detailRow = detailRow.nextElementSibling;
        }

        let address = null;
        let phone = null;
        let specialty = null;
        let plansLink = null;

        if (detailRow) {
          const detailText = detailRow.textContent;

          // Extract address - look for street address followed by city, state, zip
          const addressLines = detailText.split('\n').map(l => l.trim()).filter(l => l && l.length > 0);
          let addressParts = [];
          let cityStateZip = null;

          for (let i = 0; i < addressLines.length; i++) {
            const line = addressLines[i];
            // Look for city, state, zip pattern (end of address)
            if (/[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}/.test(line)) {
              cityStateZip = line;
              break;
            }
            // Collect lines that start with a number (street address) or Suite/Unit
            if (/^\d+\s+/.test(line) || /^Suite\s+/i.test(line) || /^Unit\s+/i.test(line)) {
              addressParts.push(line);
            }
          }

          if (addressParts.length > 0 && cityStateZip) {
            address = addressParts.join(' ') + ', ' + cityStateZip;
          } else if (cityStateZip) {
            address = cityStateZip;
          }

          // Extract phone - must start with ( or digit, and be the right format
          // Avoid matching NPI which is 10 digits without formatting
          const phoneMatches = detailText.match(/\(\d{3}\)\s*\d{3}[-.\s]\d{4}/g);
          if (phoneMatches && phoneMatches.length > 0) {
            phone = phoneMatches[0].trim();
          }

          // Find specialty in the specialty column
          const specialtyCell = detailRow.querySelector('.result_specialty_bottom_rd');
          if (specialtyCell) {
            specialty = specialtyCell.textContent.trim() || null;
          }

          // Find the "Accepted Plans and Enrollment IDs" link
          const plansLinkEl = detailRow.querySelector('a[href*="detailplantab=Y"]');
          if (plansLinkEl) {
            plansLink = plansLinkEl.href;
          }
        }

        results.push({
          name,
          address,
          phone,
          specialty,
          plansLink
        });
      }

      return results;
    });

    if (!providers || providers.length === 0) {
      // Save debug artifacts
      const artifactDir = ensureArtifactsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basePath = path.join(artifactDir, `aetna-commercial-debug-${npiStr}-${timestamp}`);

      await page.screenshot({ path: `${basePath}.png`, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(`${basePath}.html`, html, 'utf8');

      throw new Error('No provider results found. Debug artifacts saved.');
    }

    // Step 4: For each provider, click on the plans link to get accepted plans
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      if (!provider.plansLink) continue;

      try {
        // Navigate to the plans page
        await page.goto(provider.plansLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Extract plan information
        const planInfo = await page.evaluate(() => {
          const plans = [];
          const providerType = [];

          // Look for plan names in the page - they're typically in tables or lists
          const textContent = document.body.textContent;

          // Extract provider type (PCP or Specialist)
          if (textContent.includes('Primary Care') || textContent.includes('PCP')) {
            providerType.push('Primary Care Physician (PCP)');
          }
          if (textContent.includes('Specialist') || textContent.includes('Specialty')) {
            providerType.push('Specialist');
          }

          // Look for plan names - they're typically preceded by bullet points or in specific sections
          const planMarkers = ['•', '▪', '-'];
          const lines = textContent.split('\n');

          for (const line of lines) {
            const trimmed = line.trim();

            // Skip obvious non-plan text
            if (trimmed.includes('Home') || trimmed.includes('Contact Us') ||
                trimmed.includes('Education:') || trimmed.includes('Graduated') ||
                trimmed.includes('Languages:') || trimmed.length < 10 || trimmed.length > 150) {
              continue;
            }

            // Look for lines that contain plan indicators
            if (trimmed.includes('Aetna') && (trimmed.includes('®') || trimmed.includes('SM') ||
                trimmed.includes('HMO') || trimmed.includes('PPO') || trimmed.includes('POS') ||
                trimmed.includes('EPO') || trimmed.includes('Plan'))) {

              // Split on bullet points if present
              const parts = trimmed.split(/[•▪]/);
              for (const part of parts) {
                const cleanPart = part.trim();
                if (cleanPart.length > 10 && cleanPart.length < 100 &&
                    (cleanPart.includes('Aetna') || cleanPart.includes('HMO') ||
                     cleanPart.includes('PPO') || cleanPart.includes('POS') ||
                     cleanPart.includes('EPO') || cleanPart.includes('Managed Choice'))) {
                  if (!plans.includes(cleanPart)) {
                    plans.push(cleanPart);
                  }
                }
              }
            }
          }

          return { plans, providerType };
        });

        provider.acceptedPlans = planInfo.plans;
        provider.providerType = planInfo.providerType.join(', ') || null;

        // Go back to results page
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);

      } catch (error) {
        console.error(`Error fetching plans for provider ${i}:`, error.message);
        provider.acceptedPlans = [];
      }
    }

    result.providers = providers.map(p => ({
      name: normalizeText(p.name),
      address: normalizeText(p.address),
      phone: formatPhone(p.phone),
      specialty: p.specialty,
      providerType: p.providerType,
      acceptedPlans: p.acceptedPlans || []
    }));

    // Save success artifacts
    const artifactDir = ensureArtifactsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(artifactDir, `aetna-commercial-${npiStr}-${timestamp}`);

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
  const [,, npiArg] = process.argv;
  if (!npiArg) {
    console.error('Usage: node scripts/aetna-commercial-search.js <NPI>');
    process.exit(1);
  }

  const options = {
    headless: !process.env.PLAYWRIGHT_HEADFUL,
    slowMo: process.env.PLAYWRIGHT_SLOWMO ? parseInt(process.env.PLAYWRIGHT_SLOWMO, 10) : 0
  };

  const result = await searchAetnaCommercial(npiArg.trim(), options);
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

module.exports = { searchAetnaCommercial };
