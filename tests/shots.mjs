/**
 * Screenshots for a human to look at. No assertions, no build, no test runner.
 *
 * This exists because the expensive part of looking at the game was never the
 * looking -- it was that every glance went through a full production build, a
 * fresh browser and the whole assertion suite. Diagnosing one shading bug cost
 * seven of those. Point this at a preview server you already have running and
 * a look costs a few seconds.
 *
 *   npm run preview -- --port 4173 --strictPort     (leave running)
 *   npm run shots -- --label before
 *   ...change something, npm run build...
 *   npm run shots -- --label after
 *
 * Then compare tests/out/before against tests/out/after by eye. See
 * docs/TESTING.md for where this sits relative to the two test tiers.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const LABEL = arg('label', 'shots');
const BASE = arg('url', 'http://localhost:4173/');
const QUERY = arg('query', '');
const OUT_DIR = join('tests', 'out', LABEL);

const CHROMIUM_REVISION = 'chromium-1243';
const executablePath = join(
  process.env.LOCALAPPDATA ?? '',
  'ms-playwright',
  CHROMIUM_REVISION,
  'chrome-win64',
  'chrome.exe',
);

const url = BASE.replace(/\/$/, '/') + QUERY;

// Fail fast and usefully if nothing is serving. Starting a server here would
// mean building, which is the cost this script exists to avoid.
try {
  const res = await fetch(BASE, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(
    `No preview server at ${BASE} (${err.message}).\n` +
      'Start one first, and leave it running:\n' +
      '  npm run build\n' +
      '  npm run preview -- --port 4173 --strictPort',
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200));
});

async function shot(name) {
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  console.log('  ', path);
  return path;
}

console.log(`shots -> ${OUT_DIR}  (${url})`);

// Same stations the smoke suite uses, so a shots run and a smoke run are
// directly comparable against each other and against tests/out/phase0.
const hull = page.waitForResponse((r) => r.url().endsWith('.glb'), { timeout: 60_000 });
await page.goto(url);
await hull.catch(() => console.log('   (no .glb response seen; carrying on)'));
await page.waitForTimeout(1500);
await shot('idle');

await page.keyboard.down('KeyW');
await page.waitForTimeout(4000);
await shot('sailing');

await page.keyboard.down('KeyD');
await page.waitForTimeout(1500);
await shot('turning');
await page.keyboard.up('KeyD');

await page.mouse.wheel(0, 300);
await page.waitForTimeout(1200);
await shot('mid');

await page.mouse.wheel(0, 600);
await page.waitForTimeout(1200);
await shot('far');
await page.keyboard.up('KeyW');

await browser.close();
console.log('done');
