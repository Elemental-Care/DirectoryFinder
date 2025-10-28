const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const { autoUpdater } = require('electron-updater');
const { ensurePlaywrightBrowsers } = require('./install-playwright');
const { searchIllinoisMedicaid } = require('./scripts/il-medicaid-search');
const { searchIllinoisMeridian } = require('./scripts/il-meridian-search');
const { searchWellcareProvider } = require('./scripts/wellcare-search');
const { searchAmbetterProvider } = require('./scripts/ambetter-search');
const { searchAetnaCommercial } = require('./scripts/aetna-commercial-search');
const { searchCignaProvider } = require('./scripts/cigna-search');
const { searchCountyCareProvider } = require('./scripts/countycare-search');

const { PROXY_PORT } = require('./config');
const AETNA_ROOT = 'https://apif1.aetna.com/fhir/v1';
const AETNA_DEMO_ROOT = 'https://vteapif1.aetna.com/fhirdemo/v1';
const AETNA_PROVIDER_DIRECTORY = `${AETNA_ROOT}/providerdirectory`;
const AETNA_MEDICARE_DIRECTORY = `${AETNA_ROOT}/providerdirectorydata`;
const AETNA_TOKEN_ENDPOINT = `${AETNA_ROOT}/fhirserver_auth/oauth2/token`;
const AETNA_DEMO_TOKEN_ENDPOINT = `${AETNA_DEMO_ROOT}/fhirserver_auth/oauth2/token`;
const UHC_BASE = 'https://flex.optum.com/fhirpublic/R4';
const CENTENE_BASE = 'https://prod.api.centene.com/fhir/providerdirectory';
let proxyServer;
let mainWindow;

// Override console methods to send logs to renderer
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function sendToRenderer(level, ...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('main-process-log', { level, message, timestamp: new Date().toISOString() });
    }

    // Still log to terminal
    const originalMethod = level === 'error' ? originalConsoleError :
                           level === 'warn' ? originalConsoleWarn : originalConsoleLog;
    originalMethod.apply(console, args);
}

console.log = (...args) => sendToRenderer('log', ...args);
console.error = (...args) => sendToRenderer('error', ...args);
console.warn = (...args) => sendToRenderer('warn', ...args);

function createProxyServer() {
    if (proxyServer) {
        return;
    }

    proxyServer = http.createServer(async (req, res) => {
        try {
            // Basic CORS support for renderer fetch calls
            const setCorsHeaders = () => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization, Content-Type');
            };

            if (req.method === 'OPTIONS') {
                setCorsHeaders();
                res.writeHead(204);
                res.end();
                return;
            }

            // Determine target URL based on path
            const targetInfo = resolveTarget(req.url);
            if (!targetInfo) {
                setCorsHeaders();
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported proxy path' }));
                return;
            }

            const { targetUrl } = targetInfo;
            const body = await collectRequestBody(req);

            const upstreamHeaders = new Headers();
            Object.entries(req.headers).forEach(([key, value]) => {
                if (!value) return;
                const headerName = key.toLowerCase();
                if (['host', 'origin', 'referer'].includes(headerName)) {
                    return;
                }
                if (Array.isArray(value)) {
                    value.forEach(v => upstreamHeaders.append(key, v));
                } else {
                    upstreamHeaders.set(key, value);
                }
            });

            const upstreamResponse = await fetch(targetUrl, {
                method: req.method,
                headers: upstreamHeaders,
                body: body,
                redirect: 'manual'
            });

            setCorsHeaders();
            upstreamResponse.headers.forEach((value, key) => {
                const lowerKey = key.toLowerCase();
                // Prevent overwriting the CORS headers we just set
                // Also skip content-encoding and content-length since we're buffering/decompressing the response
                if (!['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'content-encoding', 'content-length'].includes(lowerKey)) {
                    res.setHeader(key, value);
                }
            });

            const responseBuffer = upstreamResponse.body ? Buffer.from(await upstreamResponse.arrayBuffer()) : null;
            res.writeHead(upstreamResponse.status);
            if (responseBuffer && responseBuffer.length) {
                res.end(responseBuffer);
            } else {
                res.end();
            }
        } catch (error) {
            console.error('Proxy error:', error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proxy request failed', details: error.message }));
        }
    });

    proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
        console.log(`Aetna proxy listening on http://127.0.0.1:${PROXY_PORT}`);
    });
}

function resolveTarget(requestPath) {
    let parsed;
    try {
        parsed = new URL(requestPath, 'http://localhost');
    } catch {
        return null;
    }

    const pathname = parsed.pathname;
    const search = parsed.search || '';

    const routes = [
        {
            prefix: '/aetna-medicare',
            directoryBase: AETNA_MEDICARE_DIRECTORY
        },
        {
            prefix: '/aetna',
            directoryBase: AETNA_PROVIDER_DIRECTORY
        },
        {
            prefix: '/uhc',
            directoryBase: UHC_BASE
        },
        {
            prefix: '/centene',
            directoryBase: CENTENE_BASE
        }
    ];

    for (const route of routes) {
        if (!pathname.startsWith(route.prefix)) continue;

        const remainder = pathname.slice(route.prefix.length) || '';

        if (remainder.startsWith('/token-demo')) {
            return { targetUrl: `${AETNA_DEMO_TOKEN_ENDPOINT}${search}` };
        }

        if (remainder.startsWith('/token')) {
            return { targetUrl: `${AETNA_TOKEN_ENDPOINT}${search}` };
        }

        if (remainder.startsWith('/fhirserver_auth')) {
            return { targetUrl: `${AETNA_ROOT}${remainder}${search}` };
        }

        if (remainder.startsWith('/providerdirectory') || remainder.startsWith('/providerdirectorydata')) {
            const targetBase = remainder.startsWith('/providerdirectorydata')
                ? AETNA_MEDICARE_DIRECTORY
                : AETNA_PROVIDER_DIRECTORY;
            const resourcePath = remainder.replace(/^\/providerdirectory(data)?/, '');
            return { targetUrl: `${targetBase}${resourcePath}${search}` };
        }

        const resourcePath = remainder.startsWith('/') ? remainder : `/${remainder}`;
        return { targetUrl: `${route.directoryBase}${resourcePath}${search}` };
    }

    return null;
}

function collectRequestBody(req) {
    return new Promise((resolve, reject) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
            resolve(undefined);
            return;
        }

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve(undefined);
            } else {
                resolve(Buffer.concat(chunks));
            }
        });
        req.on('error', reject);
    });
}

// Auto-update configuration
function setupAutoUpdater() {
    console.log('[AUTO-UPDATE] Initializing auto-updater...');
    console.log('[AUTO-UPDATE] App version:', app.getVersion());
    console.log('[AUTO-UPDATE] Platform:', process.platform);
    console.log('[AUTO-UPDATE] Is packaged:', app.isPackaged);

    // Configure auto-updater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    console.log('[AUTO-UPDATE] Configuration set: autoDownload=false, autoInstallOnAppQuit=true');

    // Event: Checking for update
    autoUpdater.on('checking-for-update', () => {
        console.log('[AUTO-UPDATE] Checking for updates...');
    });

    // Event: Update available
    autoUpdater.on('update-available', (info) => {
        console.log('[AUTO-UPDATE] Update available:', info.version);
        console.log('[AUTO-UPDATE] Release info:', JSON.stringify(info, null, 2));
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Available',
            message: `A new version (${info.version}) is available!`,
            detail: 'Would you like to download it now? The update will be installed when you restart the app.',
            buttons: ['Download', 'Later'],
            defaultId: 0,
            cancelId: 1
        }).then((result) => {
            if (result.response === 0) {
                console.log('[AUTO-UPDATE] User chose to download update');
                autoUpdater.downloadUpdate();
            } else {
                console.log('[AUTO-UPDATE] User chose to download later');
            }
        });
    });

    // Event: Update downloaded
    autoUpdater.on('update-downloaded', (info) => {
        console.log('[AUTO-UPDATE] Update downloaded:', info.version);
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: `Version ${info.version} has been downloaded.`,
            detail: 'The update will be installed when you restart the application. Would you like to restart now?',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
            cancelId: 1
        }).then((result) => {
            if (result.response === 0) {
                console.log('[AUTO-UPDATE] User chose to restart now');
                autoUpdater.quitAndInstall(false, true);
            } else {
                console.log('[AUTO-UPDATE] User chose to restart later');
            }
        });
    });

    // Event: Download progress
    autoUpdater.on('download-progress', (progressObj) => {
        console.log(`[AUTO-UPDATE] Download progress: ${progressObj.percent.toFixed(2)}%`);
    });

    // Event: Update not available
    autoUpdater.on('update-not-available', (info) => {
        console.log('[AUTO-UPDATE] App is up to date');
        console.log('[AUTO-UPDATE] Current version info:', JSON.stringify(info, null, 2));
    });

    // Event: Error
    autoUpdater.on('error', (err) => {
        // Don't spam console with 404 errors when no releases exist yet
        if (err.statusCode === 404) {
            console.log('[AUTO-UPDATE] No releases found yet (this is normal for new apps)');
        } else {
            console.error('[AUTO-UPDATE] Update error:', err);
            console.error('[AUTO-UPDATE] Error stack:', err.stack);
        }
    });

    // Check for updates when app starts
    console.log('[AUTO-UPDATE] Starting update check...');
    try {
        autoUpdater.checkForUpdatesAndNotify().catch(err => {
            // Silently handle 404s (no releases exist yet)
            if (err.statusCode !== 404) {
                console.error('[AUTO-UPDATE] Update check failed:', err.message);
            }
        });
        console.log('[AUTO-UPDATE] Update check initiated successfully');
    } catch (error) {
        console.error('[AUTO-UPDATE] Failed to initiate update check:', error);
    }
}

function createWindow() {
    createProxyServer();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

    // Open DevTools in development mode
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }
}

ipcMain.handle('medicaid-search', async (event, npi) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const response = await searchIllinoisMedicaid(String(npi), { headless: true });
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Illinois Medicaid search failed')
        };
    } catch (error) {
        console.error('Medicaid search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Medicaid search failure'
        };
    }
});

ipcMain.handle('meridian-search', async (event, { npi, planKey, location }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            planKey: planKey || 'medicaid',
            location: location || 'Crest Hill, IL 60403',
            headless: true
        };
        const response = await searchIllinoisMeridian(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Illinois Meridian search failed')
        };
    } catch (error) {
        console.error('Meridian search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Meridian search failure'
        };
    }
});

ipcMain.handle('wellcare-search', async (event, { npi, planKey, location }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            planKey: planKey || 'medicare',
            location: location || 'Crest Hill, IL 60403',
            headless: true
        };
        const response = await searchWellcareProvider(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Wellcare search failed')
        };
    } catch (error) {
        console.error('Wellcare search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Wellcare search failure'
        };
    }
});

ipcMain.handle('ambetter-search', async (event, { npi, planKey, location }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            planKey: planKey || 'marketplace',
            location: location || 'Crest Hill, IL 60403',
            headless: true
        };
        const response = await searchAmbetterProvider(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Ambetter search failed')
        };
    } catch (error) {
        console.error('Ambetter search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Ambetter search failure'
        };
    }
});

ipcMain.handle('aetna-commercial-search', async (event, { npi }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            headless: true
        };
        const response = await searchAetnaCommercial(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Aetna Commercial search failed')
        };
    } catch (error) {
        console.error('Aetna Commercial search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Aetna Commercial search failure'
        };
    }
});

ipcMain.handle('cigna-search', async (event, { npi, location }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            location: location || 'Crest Hill, IL 60403',
            headless: true
        };
        const response = await searchCignaProvider(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'Cigna search failed')
        };
    } catch (error) {
        console.error('Cigna search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected Cigna search failure'
        };
    }
});

ipcMain.handle('countycare-search', async (event, { npi, location }) => {
    if (!npi) {
        return {
            ok: false,
            error: 'Missing NPI value'
        };
    }

    try {
        const options = {
            location: location || 'Crest Hill, IL 60403',
            headless: true
        };
        const response = await searchCountyCareProvider(String(npi), options);
        return {
            ok: Boolean(response?.success),
            data: response,
            error: response?.success ? null : (response?.error || 'County Care search failed')
        };
    } catch (error) {
        console.error('County Care search failed:', error);
        return {
            ok: false,
            error: error.message || 'Unexpected County Care search failure'
        };
    }
});

app.whenReady().then(async () => {
    // Ensure Playwright browsers are installed on first run
    await ensurePlaywrightBrowsers();

    createWindow();
    setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('quit', () => {
    if (proxyServer) {
        proxyServer.close();
    }
});
