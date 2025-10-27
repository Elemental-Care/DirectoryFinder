# Provider Directory Finder (Desktop)

Electron-based desktop wrapper for the Provider Directory search tool. Includes an internal HTTP proxy so the application can call Aetna's FHIR APIs without browser CORS limitations.

## Getting Started

1. Install Node.js 18+ (macOS example: `brew install node`).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the desktop app in development mode:
   ```bash
   npm start
   ```

The app launches a desktop window and a local proxy on `http://127.0.0.1:4123` automatically. Close the window to shut everything down.

## Packaging

Build native installers with electron-builder:

```bash
# macOS .dmg
npm run app:mac

# Windows .exe (requires building on Windows or cross-compilation tooling)
npm run app:win

# Linux AppImage
npm run app:linux
```

Outputs land in the `dist/` folder.

## Project Layout

- `app/` – static assets (the original HTML app).
- `main.js` – Electron main process plus the embedded proxy.
- `preload.js` – Exposes runtime flags to the renderer.
- `config.js` – Shared configuration (proxy port).

## Notes

- Aetna and UHC requests are routed through the local proxy; other APIs continue to hit their public endpoints directly.
- The HTML app detects the Electron runtime and swaps the Aetna base URLs automatically. Running the same HTML in a browser still works, subject to standard CORS behavior.
- The search panel supports NPI lookups plus NPPES individual (name/location) and organization searches. Pick a match to drive the insurance lookup.
- Organization (NPI-2) rows currently surface NPPES details only; insurance network queries still target individual providers (NPI-1).
- UnitedHealthcare’s public FHIR directory is now queried directly (no auth required) and listed alongside BCBS, Aetna, Cigna, and Anthem.
