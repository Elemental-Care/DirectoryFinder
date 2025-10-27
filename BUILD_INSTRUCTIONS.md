# Building Provider Directory Finder

This document explains how to build the Provider Directory Finder application for both Windows and Mac.

## Prerequisites

1. **Node.js** (v18 or higher)
2. **npm** (comes with Node.js)
3. **Playwright Chromium Browser** (installed automatically via `npm install`)

### Platform-Specific Requirements

#### For Mac builds:
- macOS 10.13 or higher
- Xcode Command Line Tools: `xcode-select --install`

#### For Windows builds:
- Windows 7 or higher
- No additional requirements

## Installation

1. Install dependencies:
```bash
npm install
```

2. Install Playwright browsers:
```bash
npx playwright install chromium
```

## Running in Development

To run the app in development mode:

```bash
npm start
```

## Building for Distribution

### Build for Mac (DMG):

```bash
npm run build:mac
```

This will create:
- `dist/Provider Directory Finder-1.0.0.dmg` - Mac installer for Intel Macs
- `dist/Provider Directory Finder-1.0.0-arm64.dmg` - Mac installer for Apple Silicon Macs

### Build for Windows (NSIS Installer):

```bash
npm run build:win
```

This will create:
- `dist/Provider Directory Finder Setup 1.0.0.exe` - Windows installer

###Build for Both Platforms:

```bash
npm run build:both
```

## Build Output

All builds will be placed in the `dist/` directory after compilation.

## Important Notes

1. **Playwright Browsers**: The Chromium browser is packaged with the app, so end users don't need to install anything extra.

2. **Application Size**: The final application will be approximately 200-300MB due to the bundled Chromium browser.

3. **Application Icons** (Optional):
   - The package.json references icon files (`build/icon.icns` for Mac and `build/icon.ico` for Windows)
   - If these files don't exist, electron-builder will use default Electron icons
   - To add custom icons, place properly formatted icon files in the `build/` directory:
     - Mac: `build/icon.icns` (512x512px minimum, .icns format)
     - Windows: `build/icon.ico` (256x256px recommended, .ico format)

4. **Code Signing**:

   **Mac Code Signing:**
   - **Without Certificate** (default): The app will build unsigned. Users will see "unidentified developer" warning on first run
   - **With Certificate**: Requires Apple Developer account ($99/year)
     1. Obtain a Developer ID Application certificate from Apple Developer Portal
     2. Update package.json: Change `"identity": null` to `"identity": "Developer ID Application: Your Name (TEAMID)"`
     3. For notarization (recommended for distribution):
        - Set `"notarize": true` in package.json
        - Set environment variables before building:
          ```bash
          export APPLE_ID="your@email.com"
          export APPLE_ID_PASSWORD="app-specific-password"
          export APPLE_TEAM_ID="TEAMID"
          npm run build:mac
          ```

   **Windows Code Signing:**
   - **Without Certificate** (default): The app will build unsigned. Windows SmartScreen may show warnings
   - **With Certificate**: Requires a code signing certificate (~$200-400/year from providers like DigiCert, Sectigo)
     1. Obtain a code signing certificate (.pfx or .p12 file)
     2. Set environment variables and build:
        ```bash
        export CSC_LINK="path/to/certificate.pfx"
        export CSC_KEY_PASSWORD="your-certificate-password"
        npm run build:win
        ```
     3. Or place the certificate file and set the password:
        ```bash
        # Place certificate at: ~/cert.pfx
        export CSC_KEY_PASSWORD="your-certificate-password"
        npm run build:win
        ```

5. **Cross-Platform Building**:
   - You can only build Mac apps on Mac
   - You can build Windows apps on Mac, Windows, or Linux
   - For best results, build on the target platform

## Troubleshooting

### "Playwright browser not found"
Run: `npx playwright install chromium`

### Build fails on Mac with "no valid signing identity"
Either:
- Remove the `hardenedRuntime`, `gatekeeperAssess`, and `entitlements` options from `package.json`
- Or obtain an Apple Developer certificate

### Windows build creates unsigned installer
This is normal. To sign, you need a Windows code signing certificate.

## Distribution

### Mac:
- Users can drag the .app to Applications folder from the DMG
- First run may show "unidentified developer" warning (bypass with right-click > Open)

### Windows:
- Users run the installer
- Windows Defender SmartScreen may show a warning for unsigned apps (users can click "More info" > "Run anyway")

## Automatic Updates

This application includes automatic update functionality using GitHub Releases. When configured, users will be notified when new versions are available.

### How Auto-Updates Work

1. App checks for updates on startup
2. If update found, prompts user to download
3. Downloads in background
4. Prompts to restart when ready
5. Auto-installs on restart

### Setting Up Auto-Updates

**Prerequisites:**
- GitHub account (free)
- GitHub repository for your project
- GitHub Personal Access Token

**Step 1: Create GitHub Repository**

1. Go to https://github.com/new
2. Create a new private repository named `provider-directory-desktop`
3. Do NOT initialize with README (you'll push existing code)

**Step 2: Update package.json**

Replace `YOUR_USERNAME` in package.json with your actual GitHub username:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/YOUR_USERNAME/provider-directory-desktop.git"
},
"build": {
  "publish": {
    "provider": "github",
    "owner": "YOUR_USERNAME",
    "repo": "provider-directory-desktop"
  },
  ...
}
```

**Step 3: Create GitHub Personal Access Token**

1. Go to https://github.com/settings/tokens
2. Click "Generate new token" > "Generate new token (classic)"
3. Name it "electron-builder"
4. Select scope: `repo` (full control of private repositories)
5. Click "Generate token"
6. **IMPORTANT**: Copy the token immediately (you won't see it again)

**Step 4: Set Environment Variable**

On Mac/Linux:
```bash
export GH_TOKEN="your_token_here"
```

On Windows (PowerShell):
```powershell
$env:GH_TOKEN="your_token_here"
```

Or add to your shell profile (~/.bash_profile, ~/.zshrc, etc.):
```bash
export GH_TOKEN="your_token_here"
```

**Step 5: Push Code to GitHub**

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/provider-directory-desktop.git
git push -u origin main
```

**Step 6: Publish Your First Release**

1. Update version in package.json (e.g., from 1.0.0 to 1.0.1)
2. Build and publish:

For Mac:
```bash
npm run publish:mac
```

For Windows:
```bash
npm run publish:win
```

For both:
```bash
npm run publish:both
```

This will:
- Build the application
- Create a GitHub Release
- Upload the installers
- Users' apps will now detect this as an available update

### Publishing Future Updates

When you make changes and want to release an update:

1. **Bump version** in package.json:
   ```json
   "version": "1.0.1"  // Change to 1.0.2, 1.1.0, 2.0.0, etc.
   ```

2. **Commit your changes**:
   ```bash
   git add .
   git commit -m "Description of changes"
   git push
   ```

3. **Publish the release**:
   ```bash
   npm run publish:both
   ```

4. **Users get notified**: When they launch the app, they'll see a dialog offering the update.

### Update Workflow Example

```bash
# Make code changes
# ...

# Update version
# Edit package.json: "version": "1.0.1" -> "1.0.2"

# Commit and push
git add .
git commit -m "Fix provider search bug"
git push

# Build and publish
npm run publish:both

# Done! Users will be notified of the update.
```

### Troubleshooting Auto-Updates

**"No updates available" but you published a release:**
- Ensure version in package.json was bumped
- Check GitHub repository has the release
- Verify GH_TOKEN environment variable is set
- Check repository URL in package.json matches your GitHub repo

**Build fails with "GitHub token not set":**
- Set GH_TOKEN environment variable (see Step 4 above)

**Users not getting updates:**
- Ensure they're running a version older than the latest release
- Check they have internet connection
- Verify the release on GitHub is published (not draft)

## Support

For issues, please contact the developer or check the project documentation.
