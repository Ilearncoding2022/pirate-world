import { defineConfig } from 'playwright/test';
import { existsSync, readdirSync } from 'node:fs';
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

/**
 * Where to look, in order. The owner's Windows cache is still the one this
 * project is tuned for and still the last word on the revision; the two
 * before it exist because the smoke suite now also has to run somewhere that
 * is not that machine (a Linux container, CI) and refusing to start at all
 * there cost more than it protected. Neither changes what runs on Windows:
 * `%LOCALAPPDATA%` is checked exactly as before once the other two miss.
 *
 *  1. `PLAYWRIGHT_CHROMIUM_PATH` -- an explicit executable, for the case
 *     where none of the guesses below are right.
 *  2. `PLAYWRIGHT_BROWSERS_PATH` -- Playwright's own cache variable. A
 *     container that pre-installs browsers sets it, and the build inside it
 *     will not be `CHROMIUM_REVISION`, so the revision is discovered rather
 *     than assumed. Headless shell is preferred when both are present: the
 *     smoke suite never opens a window.
 *  3. `%LOCALAPPDATA%/ms-playwright/<CHROMIUM_REVISION>/chrome-win64`.
 */
function resolveCachedChromium(): string {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`playwright.config.ts: PLAYWRIGHT_CHROMIUM_PATH is set but there is nothing at ${explicit}.`);
    }
    return explicit;
  }

  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath && existsSync(browsersPath)) {
    const candidates = readdirSync(browsersPath)
      .filter((entry) => entry.startsWith('chromium'))
      // `chromium_headless_shell-*` before `chromium-*`: underscore sorts
      // after the hyphen, so reverse gives the shell first.
      .sort()
      .reverse()
      .flatMap((entry) => [
        join(browsersPath, entry, 'chrome-linux', 'headless_shell'),
        join(browsersPath, entry, 'chrome-linux', 'chrome'),
        join(browsersPath, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      'playwright.config.ts: no Chromium found. Set PLAYWRIGHT_CHROMIUM_PATH to an ' +
        'executable, or PLAYWRIGHT_BROWSERS_PATH to a Playwright browser cache. On ' +
        'Windows, %LOCALAPPDATA% is read instead and the build is expected under ' +
        `<LOCALAPPDATA>/ms-playwright/${CHROMIUM_REVISION}/chrome-win64/chrome.exe.`,
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
  /*
   * 90 s, raised from 60.
   *
   * The battle case is what moved it. A fight used to render a second, empty
   * scene -- one flat plane, two hulls and a handful of spheres -- and now
   * renders the live world it is being fought in: globe water, the
   * displacement patch, the reflection cube, the cloud deck and the weather,
   * all of it on a software rasteriser. It came in at 50 s against this
   * budget before that change and 66 s after, which is not a regression to
   * chase so much as the honest cost of drawing the world instead of an
   * empty room, paid on a renderer that is roughly a hundred times slower
   * than the one a player has.
   *
   * It is NOT a statement about frame rate on real hardware, and must not be
   * read as one: docs/TESTING.md's note on this tier is that SwiftShader is
   * for looking at what is drawn, never for how fast.
   */
  timeout: 90_000,
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
    // Serve only -- do NOT build here. The npm scripts build exactly once
    // (`test:smoke` and `test:all` each run `npm run build` first), and having
    // this command build as well meant every full run compiled the project
    // twice. See docs/TESTING.md.
    command: `npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium' }],
});
