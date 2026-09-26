// Reference results from the web app core (src/core.js) for verify_workbook.py.
// Prints JSON: { datasets: [{ name, loopType, sl, sh, t[], pv[], sp[], op[], mode[], js{...} }], tuning: [...] }
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, closedLoop, stickyValve, rng } from '../tools/synth.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = { datasets: [], tuning: [] };
const T0 = Date.UTC(2026, 8, 26, 8, 0, 0);

function jsHealth(t, pv, sp, op, mode, cfg) {
  const F = (a) => Float64Array.from(a, (v) => (v == null ? NaN : v));
  const ds = { t: F(t), pv: F(pv), sp: F(sp), op: F(op), mode: mode ? mode.map(core.modeClass) : null, hasSP: true, hasOP: true, dt: t[1] - t[0] };
  if (ds.mode && !ds.mode.some((m) => m)) ds.mode = null;
  const h = core.loopHealth(ds, cfg);
  const M = h.metrics;
  // loopHealth stops early when the whole window is in MAN; data-quality checks are still defined
  const comp = M.compression || core.compressionCheck(ds.pv);
  const span = cfg.sh - cfg.sl;
  const spp = Array.from(ds.sp, (v) => (v - cfg.sl) / span * 100), pvp = Array.from(ds.pv, (v) => (v - cfg.sl) / span * 100);
  const spStd = core.std(spp), pvStd = core.std(pvp);
  const spMoving = M.spMoving ?? (pvStd > 0 && spStd >= 0.5 * pvStd && spStd > 0.05);
  return {
    errStd: M.errStd ?? null, errMean: M.errMean ?? null, opLowPct: M.opLowPct ?? null, opHighPct: M.opHighPct ?? null,
    noise: M.noise ?? null, flatFrac: comp.flatFrac, linFrac: comp.linFrac, compressed: comp.suspicious,
    spMoving, oscillating: !!(M.osc && M.osc.oscillating), period: M.osc ? M.osc.period : null,
    summary: core.healthSummary(h).level,
  };
}
function add(name, loopType, sl, sh, t, pv, sp, op, mode) {
  out.datasets.push({ name, loopType, sl, sh, t: t.map((s) => T0 + s * 1000), pv, sp, op, mode, js: jsHealth(t, pv, sp, op, mode, { sl, sh, loopType }) });
}

// 1) committed samples
const meta = JSON.parse(readFileSync(join(root, 'samples', 'samples.json'), 'utf8'));
for (const m of meta) {
  const tb = core.parseTable(readFileSync(join(root, 'samples', m.file), 'utf8'));
  const ds = core.buildDataset(tb, core.guessColumns(tb));
  add(m.file, m.loopType, m.sl, m.sh, Array.from(ds.t), Array.from(ds.pv), Array.from(ds.sp), Array.from(ds.op), ds.modeRaw);
}

// 2) compressed sticky valve, cascade (moving SP), well-tuned loop — %span data with SL=0, SH=100
const compress = (a, k) => { const o = a.slice(); for (let i = 0; i < a.length; i += k) { const j = Math.min(i + k, a.length - 1); for (let q = i + 1; q < j; q++) o[q] = a[i] + (a[j] - a[i]) * (q - i) / (j - i); } return o; };
{
  const d = closedLoop({ model: { type: 'fopdt', Kp: 1.5, tau: 5, theta: 1 }, dt: 1, T: 3600, Kc: 0.4, Ti: 4, valve: stickyValve(4, 2), noise: 0.1, seed: 3 });
  add('sticky_compressed', 'flow', 0, 100, d.t, compress(d.pv, 60), d.sp, compress(d.op, 60), null);
  const r = rng(12); let w = 0;
  const sp = d.sp.map((v, i) => { if (i % 5 === 0) w += r.gauss() * 0.6; return v + w; });
  add('cascade_moving_sp', 'flow', 0, 100, d.t, d.pv.map((v, i) => v + (sp[i] - d.sp[i])), sp, d.op, null);
}
{
  const m = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
  const c = core.tune(m, 'simc', 5, 1);
  const d = closedLoop({ model: m, dt: 1, T: 3600, Kc: c.Kc, Ti: c.Ti, noise: 0.2, seed: 6 });
  add('well_tuned_pressure', 'pressure', 0, 100, d.t, d.pv, d.sp, d.op, d.t.map(() => 'AUT'));
}

// 3) tuning cases
const tcases = [
  { model: 'FOPDT', Kp: 2, tau: 30, theta: 5, Ts: 1, method: 'Lambda', lam: 25, loopType: 'flow' },
  { model: 'FOPDT', Kp: 2, tau: 30, theta: 5, Ts: 1, method: 'SIMC', lam: 5, loopType: 'pressure' },
  { model: 'FOPDT', Kp: 2, tau: 30, theta: 5, Ts: 2, method: 'IMC-PID', lam: 10, loopType: 'temperature' },
  { model: 'Integrating', Ki: 0.01, theta: 10, Ts: 1, method: 'SIMC tight level', lam: 10, loopType: 'level' },
  { model: 'Integrating', Ki: 0.01, theta: 10, Ts: 1, method: 'Lambda averaging level', lam: 90, loopType: 'level' },
  { model: 'FOPDT', Kp: 1.6, tau: 6, theta: 2, Ts: 1, method: 'อัตโนมัติ', lam: null, loopType: 'flow' },
  { model: 'FOPDT', Kp: 0.9, tau: 300, theta: 60, Ts: 2, method: 'อัตโนมัติ', lam: null, loopType: 'temperature' },
  { model: 'Integrating', Ki: 0.004, theta: 6, Ts: 1, method: 'อัตโนมัติ', lam: null, loopType: 'level' },
];
const idMap = { Lambda: 'lambda', SIMC: 'simc', 'IMC-PID': 'imc-pid', 'SIMC tight level': 'simc-int', 'Lambda averaging level': 'lambda-int' };
for (const tc of tcases) {
  const model = tc.model === 'Integrating' ? { type: 'integrating', Ki: tc.Ki, theta: tc.theta } : { type: 'fopdt', Kp: tc.Kp, tau: tc.tau, theta: tc.theta };
  let method = idMap[tc.method], lam = tc.lam;
  if (tc.method === 'อัตโนมัติ') { const d = core.defaultTuning(model, tc.loopType, tc.Ts); method = d.method; lam = d.lam; }
  const c = core.tune(model, method, lam, tc.Ts);
  out.tuning.push({ ...tc, expect: { PB: 100 / c.Kc, TI: c.Ti, TD: c.Td } });
}
process.stdout.write(JSON.stringify(out));
