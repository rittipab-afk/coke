// Browser test of dist/pi-check.html against a mocked PI Web API.
// Usage: node pid-tuner/test/e2e.picheck.mjs [screenshotDir]
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startMocks } from './mock-piwebapi.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = pathToFileURL(join(root, 'dist', 'pi-check.html')).href;
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const mocks = await startMocks();
const browser = await chromium.launch();

async function scenario(name, port, { tag = 'FIC101.PV', auth = 'windows', colorScheme = 'light', viewport = { width: 1100, height: 900 } } = {}) {
  const ctx = await browser.newContext({ colorScheme, viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pageUrl);
  await page.fill('#url', `http://127.0.0.1:${port}/piwebapi`);
  await page.selectOption('#auth', auth);
  check(await page.isVisible('#user') === (auth === 'basic'), `${name}: username field only shown for Basic`);
  if (auth === 'basic') { await page.fill('#user', 'GCM\\coke'); await page.fill('#pass', 'secret'); }
  await page.fill('#tag', tag);
  await page.click('#runBtn');
  await page.waitForSelector('#summary .summary', { timeout: 30000 });
  const status = await page.$$eval('.step', (els) => Object.fromEntries(els.map((e) => [e.dataset.step, e.className.replace('step', '').trim()])));
  const text = await page.textContent('#resultCard');
  await page.click('#copyBtn');
  await page.waitForFunction(() => document.querySelector('#copyMsg').textContent !== '');
  const report = await page.evaluate(() => window.__lastReport || '');
  if (shots) await page.screenshot({ path: join(shots, `picheck-${name}.png`), fullPage: true });
  return { page, ctx, status, text, report, errors };
}

// a) everything works
{
  const r = await scenario('ok', mocks.ports.ok);
  check(Object.values(r.status).every((s) => s === 'good' || s === 'warn'), `ok: all steps pass (${JSON.stringify(r.status)})`);
  check(r.status.data === 'warn' && r.text.includes('ถูกบีบอัดมาก'), 'ok: compression note shown on data step');
  check(r.text.includes('Bad/สถานะผิดปกติ 3'), 'ok: bad values counted');
  check(r.text.includes('1.19.0.0') && r.text.includes('GCM\\coke'), 'ok: version and user shown');
  check(r.text.includes('พร้อมแล้ว'), 'ok: summary says ready');
  check(r.report.includes('[GOOD] 2. CORS') && !r.report.includes('CorsOrigins'), 'ok: IT report without CORS request');
  check(await r.page.inputValue('#server') === 'MOCKPI01', 'ok: data server auto-filled');
  // settings remembered, password never stored
  const stored = await r.page.evaluate(() => localStorage.getItem('picheck:form'));
  check(stored.includes('FIC101.PV') && !stored.includes('secret'), 'ok: form remembered (no password)');
  check(r.errors.length === 0, `ok: no page errors (${r.errors.join(' | ')})`);
  await r.ctx.close();
}

// a2) basic auth sends Authorization header through CORS preflight
{
  const r = await scenario('basic', mocks.ports.ok, { auth: 'basic', colorScheme: 'dark' });
  check(r.status.cors === 'good' && r.status.tag === 'good', 'basic: passes with Authorization header');
  const stored = await r.page.evaluate(() => localStorage.getItem('picheck:form'));
  check(!stored.includes('secret'), 'basic: password not stored');
  await r.ctx.close();
}

// b) server reachable but no CORS headers
{
  const r = await scenario('nocors', mocks.ports.nocors);
  check(r.status.reach === 'good' && r.status.cors === 'bad', `nocors: reach ok, CORS fails (${JSON.stringify(r.status)})`);
  check(r.text.includes('CORS') && r.text.includes('"null"') && r.text.includes('ไม่มี PI Web API ที่ URL นี้'), 'nocors: explains both 404-without-CORS and CORS cases');
  check(r.report.includes('CorsOrigins: include "null"') && r.report.includes('CorsSupportsCredentials: true'), 'nocors: IT report lists CORS settings');
  check(r.status.data === 'skip', 'nocors: later steps skipped');
  await r.ctx.close();
}

// c) 401
{
  const r = await scenario('unauth', mocks.ports.unauth);
  check(r.status.cors === 'bad' && r.text.includes('401'), 'unauth: login failure reported');
  await r.ctx.close();
}

// d) tag not found → suggestions → click to retry
{
  const r = await scenario('notag', mocks.ports.notag, { tag: 'FIC101.XX' });
  check(r.status.tag === 'bad', 'notag: tag step fails');
  const chips = await r.page.$$eval('[data-usetag]', (els) => els.map((e) => e.dataset.usetag));
  check(chips.includes('FIC101.PV'), `notag: similar tags suggested (${chips.join(', ')})`);
  await r.ctx.close();
}
{
  // clicking a suggestion re-runs; use the ok server so the retry succeeds
  const r = await scenario('suggest', mocks.ports.ok, { tag: 'FIC101.XX' });
  await r.page.click('[data-usetag="FIC101.PV"]');
  await r.page.waitForFunction(() => document.querySelector('[data-step="data"]')?.className.match(/good|warn/));
  check(await r.page.inputValue('#tag') === 'FIC101.PV', 'suggest: clicking a suggestion re-runs with that tag');
  await r.ctx.close();
}

// e) closed port
{
  const r = await scenario('closed', mocks.ports.closed, { viewport: { width: 390, height: 844 } });
  check(r.status.reach === 'bad' && r.status.cors === 'skip', 'closed: unreachable reported, rest skipped');
  const overflow = await r.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `closed: no horizontal scroll on phone (${overflow}px)`);
  await r.ctx.close();
}

await browser.close();
await mocks.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nall pi-check browser checks passed');
