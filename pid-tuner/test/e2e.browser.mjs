// Browser smoke test of dist/pid-tuner.html with Playwright (Chromium).
// Usage: node pid-tuner/test/e2e.browser.mjs [screenshotDir]
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'dist', 'pid-tuner.html')).href;
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch();
async function run({ name, colorScheme = 'light', viewport = { width: 1280, height: 900 } }) {
  const page = await browser.newPage({ colorScheme, viewport });
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  await page.goto(url);
  const shot = async (n) => shots && page.screenshot({ path: join(shots, `${name}-${n}.png`), fullPage: true });
  return { page, errors, requests, shot };
}

// ── 1. full walkthrough with the flow step test sample
{
  const { page, errors, requests, shot } = await run({ name: 'flow' });
  await page.selectOption('#sampleSel', '0');
  await page.click('#sampleBtn');
  await page.waitForSelector('#overviewCard:not([hidden])');
  check((await page.textContent('#loadMsg')).includes('901'), 'sample loads 901 rows');
  check(await page.inputValue('#cfgTag') === 'FIC101', 'tag guessed from header');
  await shot('1-data');
  await page.click('nav.tabs [data-tab="health"]');
  await page.waitForSelector('#hList .status');
  await shot('2-health');
  await page.click('nav.tabs [data-tab="model"]');
  await page.waitForSelector('#fitOut table');
  const fitTxt = await page.textContent('#fitOut');
  const kp = Number(/Process gain Kp\s*([-\d.]+)/.exec(fitTxt)?.[1]);
  check(Math.abs(kp - 1.6) < 0.16, `flow fit Kp ≈ 1.6 (got ${kp})`);
  check(fitTxt.includes('Reverse'), 'direction = Reverse for positive gain');
  await shot('3-model');
  await page.click('nav.tabs [data-tab="tune"]');
  await page.waitForSelector('#tTable tbody tr');
  const pb = await page.textContent('#tOut div:first-child .big');
  check(Number(pb) > 0, `proposed PB rendered (${pb})`);
  check((await page.textContent('#tTable')).includes('Gain margin'), 'comparison table rendered');
  await page.click('[data-preset="0.5"]');
  const pbFast = await page.textContent('#tOut div:first-child .big');
  check(Number(pbFast) < Number(pb), `aggressive preset lowers PB (${pb} → ${pbFast})`);
  await shot('4-tune');
  await page.click('nav.tabs [data-tab="report"]');
  await page.waitForSelector('#repSim canvas');
  check((await page.textContent('#reportBody')).includes('FIC101'), 'report shows tag');
  await page.check('#hideTag');
  check(!(await page.textContent('#reportBody')).includes('FIC101'), 'hide tag works');
  await shot('5-report');
  // drag-select a different window on the model chart
  await page.click('nav.tabs [data-tab="model"]');
  const box = await (await page.$('#mChart canvas')).boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check((await page.textContent('#fitOut')).includes('Process gain'), 'drag-select refits model');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  check(requests.length === 0, `no network requests (${requests.join(', ')})`);
  await page.close();
}

// ── 2. sticky valve → health flags stiction; tuning banner warns
{
  const { page, errors, shot } = await run({ name: 'sticky', colorScheme: 'dark' });
  await page.selectOption('#sampleSel', '1');
  await page.click('#sampleBtn');
  await page.click('nav.tabs [data-tab="health"]');
  await page.waitForSelector('#hList .status');
  const txt = await page.textContent('#hList');
  check(txt.includes('สงสัย stiction'), 'sticky valve sample → stiction suspected');
  check(await page.isVisible('#ccfCard'), 'CCF chart shown');
  await shot('2-health');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await page.close();
}

// ── 3. aggressive pressure loop → oscillation, not stiction
{
  const { page, errors } = await run({ name: 'pressure' });
  await page.selectOption('#sampleSel', '2');
  await page.click('#sampleBtn');
  await page.click('nav.tabs [data-tab="health"]');
  await page.waitForSelector('#hList .status');
  const txt = await page.textContent('#hList');
  check(txt.includes('Oscillation') && txt.includes('ไม่น่าใช่ stiction'), 'pressure sample → oscillation from tuning');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await page.close();
}

// ── 4. temperature (Thai BE dates) and level (integrating) on a phone viewport
for (const [i, name, re] of [[3, 'temperature', /Dead time θ\s*([\d.]+)/], [4, 'level', /Integrating gain Ki\s*([\d.e-]+)/]]) {
  const { page, errors, shot } = await run({ name, viewport: { width: 390, height: 844 } });
  await page.selectOption('#sampleSel', String(i));
  await page.click('#sampleBtn');
  check((await page.textContent('#dataInfo')).includes('2026'), `${name}: dates parsed to 2026`);
  await page.click('nav.tabs [data-tab="model"]');
  await page.waitForSelector('#fitOut table');
  const v = Number(re.exec(await page.textContent('#fitOut'))?.[1]);
  const expect = name === 'temperature' ? 60 : 0.004;
  check(Math.abs(v - expect) / expect < 0.1, `${name}: model parameter ≈ ${expect} (got ${v})`);
  await page.click('nav.tabs [data-tab="tune"]');
  await page.waitForSelector('#tTable tbody tr');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${name}: no horizontal page scroll on phone (${overflow}px)`);
  await shot('4-tune');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await page.close();
}

// ── 5. paste path with a semicolon/decimal-comma table
{
  const { page, errors } = await run({ name: 'paste' });
  const csv = readFileSync(join(root, 'samples', 'flow_step_test.csv'), 'utf8')
    .split('\n').map((l) => l.replace(/,/g, ';').replace(/(\d)\.(\d)/g, '$1,$2')).join('\n');
  await page.fill('#paste', csv);
  await page.click('#pasteBtn');
  await page.waitForSelector('#overviewCard:not([hidden])');
  check((await page.textContent('#loadMsg')).includes('ทศนิยมแบบ comma'), 'decimal-comma paste detected');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await page.close();
}

await browser.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nall browser checks passed');
