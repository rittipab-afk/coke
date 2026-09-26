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

// offline guarantee: no external resources
const external = out.match(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/gi);
if (external) throw new Error('External resource / network call found: ' + [...new Set(external)].join(', '));

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'pid-tuner.html'), out);
console.log(`dist/pid-tuner.html: ${(out.length / 1024).toFixed(0)} KB, ${samples.length} embedded samples`);
