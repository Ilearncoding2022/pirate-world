import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Playwright must not download its own browsers here (`npm install` runs
 * with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, see the release notes for T).
 * A Chromium matching this playwright-core's expected revision is already
 * cached under `%LOCALAPPDATA%/ms-playwright`; this points straight at it.
 *
 * The revision number is tied to the installed `playwright` version
 * (`node_modules/playwright-core/browsers.json`) and has to be bumped by
 * hand if that package is ever upgraded to one that expects a different
 * Chromium build.
 */
const CHROMIUM_REVISION = 'chromium-1243';

function resolveCachedChromium(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      'playwright.config.ts: %LOCALAPPDATA% is not set, so the cached Chromium ' +
        `cannot be located. Expected it under <LOCALAPPDATA>/ms-playwright/${CHROMIUM_REVISION}/chrome-win64/chrome.exe.`,
    );
  }
  const executablePath = join(localAppData, 'ms-playwright', CHROMIUM_REVISION, 'chrome-win64', 'chrome.exe');
  if (!existsSync(executablePath)) {
    throw new Error(
      `playwright.config.ts: no cached Chromium at ${executablePath}. ` +
        'This project does not let `npm install` download browsers ' +
        '(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1) -- install one manually with ' +
        '`npx playwright install chromium`, or point CHROMIUM_REVISION at ' +
        'whatever build actually landed under %LOCALAPPDATA%/ms-playwright.',
    );
  }
  return executablePath;
}

/**
 * Flags that make headless Chromium render WebGL2 under software rasterising
 * (SwiftShader) rather than refusing to create a context at all -- see
 * docs/RENDER_PLAN.md's "Hard-won environment facts".
 */
const SOFTWARE_WEBGL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * Port 4173 only. Port 5173 is the owner's own `vite dev` server and must
 * never be touched or killed by anything here.
 */
const PREVIEW_PORT = 4173;

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    launchOptions: {
      executablePath: resolveCachedChromium(),
      args: SOFTWARE_WEBGL_ARGS,
    },
  },
  webServer: {
    // `npm run test:smoke` is just `playwright test`, so the server has to
    // build and serve itself: a fresh production build on 4173, never 5173.
    command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium' }],
});
