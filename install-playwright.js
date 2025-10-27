const { app } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Ensures Playwright browsers are installed on first run
 * This is needed because electron-builder doesn't run postinstall for end users
 */
async function ensurePlaywrightBrowsers() {
  const userDataPath = app.getPath('userData');
  const installMarkerPath = path.join(userDataPath, '.playwright-installed');

  // Check if we've already installed browsers
  if (fs.existsSync(installMarkerPath)) {
    console.log('Playwright browsers already installed');
    return true;
  }

  console.log('Installing Playwright browsers (first-time setup)...');

  try {
    // Determine the correct playwright executable path
    let playwrightPath;

    if (app.isPackaged) {
      // In packaged app, playwright is unpacked in resources
      const resourcesPath = process.resourcesPath;
      playwrightPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright', 'cli.js');
    } else {
      // In development
      playwrightPath = path.join(__dirname, 'node_modules', 'playwright', 'cli.js');
    }

    // Install chromium browser
    console.log('Running: node', playwrightPath, 'install', 'chromium');
    execSync(`node "${playwrightPath}" install chromium`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(userDataPath, 'playwright-browsers')
      }
    });

    // Create marker file to indicate successful installation
    fs.writeFileSync(installMarkerPath, new Date().toISOString());
    console.log('Playwright browsers installed successfully');
    return true;
  } catch (error) {
    console.error('Failed to install Playwright browsers:', error);
    return false;
  }
}

module.exports = { ensurePlaywrightBrowsers };
