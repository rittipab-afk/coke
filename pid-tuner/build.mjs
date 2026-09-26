// Bundle src/ into one self-contained offline file: dist/pid-tuner.html
// Usage: node pid-tuner/build.mjs   (no npm dependencies)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');
const inline = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;

// embed sample CSVs so the demo works without extra files
const samplesDir = join(root, 'samples');
let samples = [];
if (existsSync(join(samplesDir, 'samples.json'))) {
  const index = JSON.parse(readFileSync(join(samplesDir, 'samples.json'), 'utf8'));
  samples = index.map((meta) => ({ file: meta.file, meta, text: readFileSync(join(samplesDir, meta.file), 'utf8') }));
}

const html = src('index.html');
const start = html.indexOf('<!-- SCRIPTS -->'), end = html.indexOf('<!-- /SCRIPTS -->');
if (start < 0 || end < 0) throw new Error('SCRIPTS markers not found in src/index.html');
const scripts = [
  inline(`window.PID_SAMPLES = ${JSON.stringify(samples)};`),
  inline(src('core.js')),
  inline(src('charts.js')),
  inline(src('app.js')),
].join('\n');
const out = html.slice(0, start) + scripts + html.slice(end + '<!-- /SCRIPTS -->'.length);

// No page may load resources from outside the file (no CDN, fonts, images, stylesheets).
const EXTERNAL_RESOURCE = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import/gi;
// The tuner itself must never talk to the network: plant data stays on the machine.
const NETWORK_CALL = /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/gi;
function assertClean(name, html, allowNetwork) {
  const hits = [...(html.match(EXTERNAL_RESOURCE) || []), ...(allowNetwork ? [] : html.match(NETWORK_CALL) || [])];
  if (hits.length) throw new Error(`${name}: external resource / network call found: ${[...new Set(hits)].join(', ')}`);
}

mkdirSync(join(root, 'dist'), { recursive: true });
assertClean('pid-tuner.html', out, false);
writeFileSync(join(root, 'dist', 'pid-tuner.html'), out);
console.log(`dist/pid-tuner.html: ${(out.length / 1024).toFixed(0)} KB, ${samples.length} embedded samples`);

// PI Web API check page: read-only GETs to the URL the user types, so fetch is allowed here only.
const piCheck = src('pi-check.html');
assertClean('pi-check.html', piCheck, true);
writeFileSync(join(root, 'dist', 'pi-check.html'), piCheck);
console.log(`dist/pi-check.html: ${(piCheck.length / 1024).toFixed(0)} KB`);
