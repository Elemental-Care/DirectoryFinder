const { contextBridge, ipcRenderer } = require('electron');
const { PROXY_PORT } = require('./config');

const origin = `http://127.0.0.1:${PROXY_PORT}`;
const proxyBases = {
    aetna: `${origin}/aetna`,
    aetnaMedicare: `${origin}/aetna-medicare`,
    uhc: `${origin}/uhc`,
    centene: `${origin}/centene`
};

const api = {
    isElectron: true,
    proxyBase: proxyBases.aetna,
    medicareProxyBase: proxyBases.aetnaMedicare,
    uhcProxyBase: proxyBases.uhc,
    centeneProxyBase: proxyBases.centene,
    proxyBases,
    searchIllinoisMedicaid: (npi) => ipcRenderer.invoke('medicaid-search', npi),
    searchIllinoisMeridian: ({ npi, planKey, location }) => ipcRenderer.invoke('meridian-search', { npi, planKey, location }),
    searchWellcare: ({ npi, planKey, location }) => ipcRenderer.invoke('wellcare-search', { npi, planKey, location }),
    searchAmbetter: ({ npi, planKey, location }) => ipcRenderer.invoke('ambetter-search', { npi, planKey, location }),
    searchAetnaCommercial: (npi) => ipcRenderer.invoke('aetna-commercial-search', { npi }),
    searchCigna: ({ npi, location }) => ipcRenderer.invoke('cigna-search', { npi, location }),
    searchCountyCare: ({ npi, location }) => ipcRenderer.invoke('countycare-search', { npi, location })
};

contextBridge.exposeInMainWorld('providerDesktop', api);
