import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, openLoop, closedLoop, stickyValve } from '../tools/synth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const near = (actual, expected, relTol, msg) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relTol, `${msg}: ${actual} vs ${expected} (±${relTol * 100}%)`);
const F = (a) => Float64Array.from(a);

function healthOf(d, loopType) {
  const ds = { t: F(d.t), pv: F(d.pv), sp: F(d.sp), op: F(d.op), mode: null, hasSP: true, hasOP: true, dt: d.t[1] - d.t[0] };
  const h = core.loopHealth(ds, { sl: 0, sh: 100, loopType });
  return Object.fromEntries(h.findings.map((f) => [f.key, f]));
}

// ─────────────── parsing ───────────────
test('timestamps: PI style, ISO, Thai BE, Excel serial, month names', () => {
  const ref = Date.UTC(2026, 8, 25, 10, 30, 15);
  assert.equal(core.parseTimestamp('25-Sep-26 10:30:15'), ref);
  assert.equal(core.parseTimestamp('25-Sep-2026 10:30:15'), ref);
  assert.equal(core.parseTimestamp('2026-09-25 10:30:15'), ref);
  assert.equal(core.parseTimestamp('2026-09-25T10:30:15'), ref);
  assert.equal(core.parseTimestamp('25/09/2569 10:30:15'), ref, 'Buddhist era 4-digit');
  assert.equal(core.parseTimestamp('25/09/69 10:30:15'), ref, 'Buddhist era 2-digit');
  assert.equal(core.parseTimestamp('2569-09-25 10:30:15'), ref, 'BE year-first');
  assert.equal(core.parseTimestamp('25 ก.ย. 2569 10:30:15'), ref, 'Thai month abbreviation');
  assert.equal(core.parseTimestamp('9/25/2026 10:30:15 AM', 'MDY'), ref);
  assert.equal(core.parseTimestamp('9/25/2026 10:30:15 PM', 'MDY'), ref + 12 * 3600e3);
  const serial = 25569 + ref / 86400000;
  assert.equal(core.parseTimestamp(String(serial)), ref);
  assert.ok(Number.isNaN(core.parseTimestamp('hello')));
});

test('date order detection', () => {
  assert.equal(core.detectDateOrder(['01/02/2026 00:00', '25/09/2026 00:00']), 'DMY');
  assert.equal(core.detectDateOrder(['9/25/2026 10:00', '10/01/2026 10:00']), 'MDY');
  assert.equal(core.detectDateOrder(['01/02/2026 00:00']), 'DMY', 'ambiguous → DMY default');
});

test('numbers: PI bad states, thousands, decimal comma', () => {
  assert.equal(core.parseNumber('1,234.5'), 1234.5);
  assert.equal(core.parseNumber('12,5', true), 12.5);
  assert.equal(core.parseNumber('45%'), 45);
  for (const s of ['Bad', 'I/O Timeout', 'Shutdown', 'No Data', '', 'Calc Failed', '#N/A']) assert.ok(Number.isNaN(core.parseNumber(s)), s);
});

test('parseTable: semicolon + decimal comma, preamble rows, column guessing', () => {
  const txt = [
    'Exported from PI DataLink',
    'Time;FIC101.PV;FIC101.SV;FIC101.MV;FIC101.MODE',
    '25/09/2569 10:00:00;12,5;12,0;40,1;AUT',
    '25/09/2569 10:00:01;I/O Timeout;12,0;40,2;AUT',
    '25/09/2569 10:00:02;12,7;12,0;40,3;MAN',
  ].join('\r\n');
  const t = core.parseTable(txt);
  assert.equal(t.delimiter, ';');
  assert.equal(t.decimalComma, true);
  assert.equal(t.rows.length, 3);
  const map = core.guessColumns(t);
  assert.deepEqual([map.time, map.pv, map.sp, map.op, map.mode], [0, 1, 2, 3, 4]);
  const ds = core.buildDataset(t, map);
  assert.equal(ds.t.length, 3);
  assert.equal(ds.pv[0], 12.5);
  assert.ok(Number.isNaN(ds.pv[1]));
  assert.equal(ds.stats.badValues, 1);
  assert.deepEqual(ds.mode, ['AUT', 'AUT', 'MAN']);
  assert.deepEqual(Array.from(ds.t), [0, 1, 2]);
});

test('parseTable: tab-separated paste from Excel', () => {
  const txt = 'Timestamp\tPV\tSP\tOP\n2026-09-25 10:00:00\t1\t2\t3\n2026-09-25 10:00:05\t1.5\t2\t3.5\n';
  const t = core.parseTable(txt);
  assert.equal(t.delimiter, '\t');
  const m = core.guessColumns(t);
  assert.deepEqual([m.time, m.pv, m.sp, m.op, m.mode], [0, 1, 2, 3, -1]);
});

test('guessColumns: PI DataLink layout with one timestamp column per tag', () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const ts = `25-Sep-26 10:00:${String(i).padStart(2, '0')}`;
    return [ts, 50 + i / 10, ts, 50, ts, 40 + i / 10, ts, i < 6 ? 'AUT' : 'MAN'].join('\t');
  });
  const t = core.parseTable(['Timestamp\t3AC1102B.PV\t3AC1102B.SV\t3AC1102B.MV\t3AC1102B.MODE', ...rows].join('\n'));
  const m = core.guessColumns(t);
  assert.deepEqual([m.time, m.pv, m.sp, m.op, m.mode], [0, 1, 3, 5, 7]);
  assert.equal(m.headerNames[1], '3AC1102B.PV', 'typed tag names re-assigned to value columns');
  const ds = core.buildDataset(t, m);
  assert.equal(ds.op[11], 41.1);
  assert.equal(ds.mode[11], 'MAN');
});

test('loop tag and type from PI DataLink headers', () => {
  assert.equal(core.loopTagFromHeader('\\\\GCMPPISVR\\3-CTA.2M.3AC1102B.MV'), '3-CTA.2M.3AC1102B');
  assert.equal(core.loopTagFromHeader('FIC101.PV'), 'FIC101');
  assert.equal(core.loopTagFromHeader('3-CTA.2M.3LIC0501.MODE'), '3-CTA.2M.3LIC0501');
  assert.equal(core.loopTagFromHeader('Col2'), '');
  assert.equal(core.guessLoopType('3-CTA.2M.3LIC0501'), 'level');
  assert.equal(core.guessLoopType('3-CTA.2M.3TIC0101'), 'temperature');
  assert.equal(core.guessLoopType('PIC201'), 'pressure');
  assert.equal(core.guessLoopType('3-CTA.2M.3AC1102B'), 'flow', 'unknown letters default to flow');
});

test('guessColumns: full PI paths in headers (\\\\SERVER\\area.loop.PV)', () => {
  const H = ['PV', 'SV', 'MV', 'MODE'].map((x) => `\\\\GCMPPISVR\\3-CTA.2M.3AC1102B.${x}`);
  const rows = Array.from({ length: 12 }, (_, i) => `25-Sep-26 10:00:${String(i).padStart(2, '0')}\t${50 + i}\t50\t${40 + i}\tAUT`);
  const m = core.guessColumns(core.parseTable([['Timestamp', ...H].join('\t'), ...rows].join('\n')));
  assert.deepEqual([m.time, m.pv, m.sp, m.op, m.mode], [0, 1, 2, 3, 4]);
});

test('MODE column with only "Tag not found" is ignored; constant SV is reported', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `26-Sep-26 07:36:${String(i + 10)}\t${56 + i / 100}\t0\t19.17\t${i < 2 ? 'Tag not found' : ''}`);
  const t = core.parseTable(['Timestamp\tX.PV\tX.SV\tX.MV\tX.MODE', ...rows].join('\n'));
  const ds = core.buildDataset(t, core.guessColumns(t));
  assert.equal(ds.mode, null);
  assert.equal(ds.modeIgnored, true);
  assert.equal(ds.spConstant, 0);
  const h = core.loopHealth(core.resample(ds, 0), { sl: 0, sh: 100, loopType: 'flow' });
  assert.equal(h.findings.find((f) => f.key === 'auto').status, 'na');
  assert.notEqual(h.findings.find((f) => f.key === 'err').status, 'na', 'error still computed (not all treated as MAN)');
});

test('guessColumns: no header row → order PV, SV, MV and MODE by value', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `2026-09-25 10:00:${String(i).padStart(2, '0')}\t${50 + i}\t50\t${40 + i}\tCAS`);
  const m = core.guessColumns(core.parseTable(rows.join('\n')));
  assert.deepEqual([m.time, m.pv, m.sp, m.op, m.mode], [0, 1, 2, 3, 4]);
});

test('guessColumns: named columns in any order are matched by name', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `2026-09-25 10:00:${String(i).padStart(2, '0')},AUT,${40 + i},50,${50 + i}`);
  const m = core.guessColumns(core.parseTable(['Time,X.MODE,X.MV,X.SV,X.PV', ...rows].join('\n')));
  assert.deepEqual([m.time, m.pv, m.sp, m.op, m.mode], [0, 4, 3, 2, 1]);
});

test('resample fills a uniform grid and marks long gaps as NaN', () => {
  const ds = {
    t0: 0, t: F([0, 1, 2, 3, 20, 21]), pv: F([0, 1, 2, 3, 20, 21]), sp: F([0, 0, 0, 0, 0, 0]), op: F([0, 0, 0, 0, 0, 0]),
    mode: null, hasSP: true, hasOP: true, stats: {},
  };
  const r = core.resample(ds, 0.5);
  assert.equal(r.t.length, 43);
  assert.equal(r.pv[3], 1.5);
  assert.ok(Number.isNaN(r.pv[10]), 'gap 3→20 s is longer than 5×dt');
});

test('compression check flags stepped / interpolated data', () => {
  const smooth = Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) + 0.01 * Math.cos(i * 1.7));
  const stepped = Array.from({ length: 500 }, (_, i) => Math.round(i / 20));
  assert.equal(core.compressionCheck(smooth).suspicious, false);
  assert.equal(core.compressionCheck(stepped).suspicious, true);
});

// ─────────────── model fitting ───────────────
test('FOPDT fit recovers Kp, τ, θ within 10% (K=2, τ=30 s, θ=5 s, noisy)', () => {
  const model = { type: 'fopdt', Kp: 2, tau: 30, theta: 5 };
  const d = openLoop({ model, dt: 1, T: 600, profile: [[0, 50], [60, 55], [240, 50], [420, 45]], noise: 0.3, seed: 21 });
  const f = core.fitFOPDT(F(d.op), F(d.pv), 1);
  near(f.Kp, 2, 0.1, 'Kp'); near(f.tau, 30, 0.1, 'tau'); near(f.theta, 5, 0.1, 'theta');
  assert.ok(f.r2 > 0.98);
  assert.deepEqual(f.warnings, []);
});

test('FOPDT fit handles negative gain', () => {
  const model = { type: 'fopdt', Kp: -0.8, tau: 12, theta: 3 };
  const d = openLoop({ model, dt: 1, T: 400, profile: [[0, 50], [50, 60], [220, 50]], noise: 0.1, seed: 4 });
  const f = core.fitFOPDT(F(d.op), F(d.pv), 1);
  near(f.Kp, -0.8, 0.1, 'Kp'); near(f.tau, 12, 0.1, 'tau');
});

test('integrating fit recovers Ki, θ and balance OP within 10%', () => {
  const model = { type: 'integrating', Ki: 0.004, theta: 6, ub: 48 };
  const d = openLoop({ model, dt: 2, T: 3600, profile: [[0, 48], [300, 53], [900, 48], [1800, 43], [2400, 48]], noise: 0.1, seed: 9 });
  const f = core.fitIntegrating(F(d.op), F(d.pv), 2);
  near(f.Ki, 0.004, 0.1, 'Ki'); near(f.theta, 6, 0.1, 'theta'); near(f.ub, 48, 0.02, 'ub');
  const resp = core.modelResponse(f, F(d.op), 2);
  assert.ok(Math.abs(resp[resp.length - 1] - f.yfit[f.yfit.length - 1]) < 1e-6, 'modelResponse matches yfit');
});

test('fit warns when OP does not move or step is lost in noise', () => {
  const flat = core.fitFOPDT(F(Array(200).fill(50)), F(Array.from({ length: 200 }, (_, i) => 50 + Math.sin(i))), 1);
  assert.ok(flat.warnings.some((w) => w.includes('OP แทบไม่ขยับ')));
  const model = { type: 'fopdt', Kp: 1, tau: 10, theta: 2 };
  const d = openLoop({ model, dt: 1, T: 300, profile: [[0, 50], [50, 50.6]], noise: 1, seed: 8 });
  const f = core.fitFOPDT(F(d.op), F(d.pv), 1);
  assert.ok(f.warnings.some((w) => w.includes('SNR')));
});

test('step detection finds OP steps', () => {
  const op = [...Array(10).fill(40), ...Array(10).fill(45), ...Array(10).fill(45), 44, 43, 42, ...Array(10).fill(42)];
  const s = core.findSteps(op, 1);
  assert.equal(s.length, 2);
  assert.equal(s[0].i, 9); assert.equal(s[0].size, 5);
  assert.equal(s[1].size, -3);
});

// ─────────────── tuning rules ───────────────
test('tuning formulas match hand calculations', () => {
  const m = { type: 'fopdt', Kp: 2, tau: 30, theta: 5 };
  let c = core.tune(m, 'simc', 5, 0);          // Kc = 30/(2·10) = 1.5, Ti = min(30, 40) = 30
  near(c.Kc, 1.5, 1e-9, 'SIMC Kc'); near(c.Ti, 30, 1e-9, 'SIMC Ti');
  c = core.tune(m, 'simc', 1, 0);              // Ti = min(30, 4·6=24) = 24
  near(c.Ti, 24, 1e-9, 'SIMC Ti clipped');
  c = core.tune(m, 'lambda', 25, 0);           // Kc = 30/(2·30) = 0.5, Ti = 30
  near(c.Kc, 0.5, 1e-9, 'Lambda Kc'); near(c.Ti, 30, 1e-9, 'Lambda Ti');
  c = core.tune(m, 'imc-pid', 10, 0);          // Kc = 32.5/(2·12.5)=1.3, Ti=32.5, Td=150/65
  near(c.Kc, 1.3, 1e-9, 'IMC Kc'); near(c.Ti, 32.5, 1e-9, 'IMC Ti'); near(c.Td, 150 / 65, 1e-9, 'IMC Td');
  c = core.tune(m, 'simc', 5, 2);              // Ts=2 → θeff=6 → Kc=30/(2·11)
  near(c.Kc, 30 / 22, 1e-9, 'ZOH half-sample delay');
  const li = { type: 'integrating', Ki: 0.01, theta: 10 };
  c = core.tune(li, 'simc-int', 10, 0);        // Kc = 1/(0.01·20) = 5, Ti = 80
  near(c.Kc, 5, 1e-9, 'SIMC-int Kc'); near(c.Ti, 80, 1e-9, 'SIMC-int Ti');
  c = core.tune(li, 'lambda-int', 90, 0);      // Kc = 190/(0.01·100²) = 1.9, Ti = 190
  near(c.Kc, 1.9, 1e-9, 'Lambda-int Kc'); near(c.Ti, 190, 1e-9, 'Lambda-int Ti');
});

test('CENTUM conversion PB = 100/Kc', () => {
  assert.deepEqual(core.toCentum({ Kc: 2, Ti: 30, Td: 0 }), { PB: 50, TI: 30, TD: 0 });
  assert.deepEqual(core.fromCentum(200, 0, 0), { Kc: 0.5, Ti: Infinity, Td: 0 });
});

test('guard rails flag big jumps in gain and TI', () => {
  const n = core.compareTuning({ Kc: 1, Ti: 10 }, { Kc: 3, Ti: 50 });
  assert.equal(n.length, 2);
  assert.equal(core.compareTuning({ Kc: 1, Ti: 10 }, { Kc: 1.3, Ti: 12 }).length, 0);
});

// ─────────────── robustness ───────────────
test('gain margin = 2 at half the ultimate gain (P-only FOPDT)', () => {
  const m = { type: 'fopdt', Kp: 2, tau: 30, theta: 5 };
  const u = core.ultimate(m, 0);
  const g = core.margins(m, { Kc: u.Ku / 2, Ti: Infinity, Td: 0 }, 0);
  near(g.gm, 2, 0.01, 'GM');
  near(g.w180, u.wu, 0.01, 'ω180');
});

test('SIMC with τc = θ gives textbook margins (GM≈3, PM≈60°)', () => {
  const m = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
  const g = core.margins(m, core.tune(m, 'simc', 5, 0), 0);
  near(g.gm, 3, 0.1, 'GM'); near(g.pm, 61, 0.1, 'PM');
  assert.ok(g.ms < 1.8 && g.stable);
});

test('closed-loop sim: SIMC settles, too-high gain diverges or oscillates', () => {
  const m = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
  const opts = { Ts: 1, T: 800, spStep: 5, spTime: 10, distStep: 5, distTime: 400 };
  const good = core.simulateClosedLoop(m, core.tune(m, 'simc', 5, 1), opts);
  assert.equal(good.metrics.diverged, false);
  assert.ok(good.metrics.overshoot < 20 && isFinite(good.metrics.settle));
  assert.equal(good.metrics.notSettled, false);
  const u = core.ultimate(m, 1);
  const bad = core.simulateClosedLoop(m, { Kc: u.Ku * 1.3, Ti: 20, Td: 0 }, opts);
  assert.ok(bad.metrics.diverged || bad.metrics.notSettled || !isFinite(bad.metrics.settle));
  // I-PD: no proportional kick on SP change
  const ipd = core.simulateClosedLoop(m, core.tune(m, 'simc', 5, 1), { ...opts, algorithm: 'i-pd' });
  assert.ok(ipd.metrics.opPeakSp < good.metrics.opPeakSp);
});

test('integrating sim settles with averaging-level tuning', () => {
  const m = { type: 'integrating', Ki: 0.004, theta: 6 };
  const c = core.tune(m, 'lambda-int', 300, 1);
  const r = core.simulateClosedLoop(m, c, { Ts: 1, T: core.suggestSimTime(m, [c]), spStep: 5, spTime: 10, distStep: 5, distTime: core.suggestSimTime(m, [c]) / 2 });
  assert.equal(r.metrics.diverged, false);
  assert.equal(r.metrics.notSettled, false);
  assert.ok(core.margins(m, c, 1).stable);
});

// ─────────────── loop health ───────────────
test('health: sticky valve → oscillation + stiction likely', () => {
  const m = { type: 'fopdt', Kp: 1.5, tau: 5, theta: 1 };
  const d = closedLoop({ model: m, dt: 1, T: 3600, Kc: 0.4, Ti: 4, valve: stickyValve(4, 2), noise: 0.1, seed: 3 });
  const h = healthOf(d, 'flow');
  assert.equal(h.osc.status, 'bad');
  assert.equal(h.stiction.status, 'bad');
});

test('health: aggressive tuning → oscillation, stiction unlikely', () => {
  const m = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
  let Kc = core.ultimate(m, 1).Ku;
  while (core.margins(m, { Kc, Ti: 15, Td: 0 }, 1).gm < 1.3) Kc *= 0.95;
  const d = closedLoop({ model: m, dt: 1, T: 3600, Kc, Ti: 15, noise: 0.2, seed: 5 });
  const h = healthOf(d, 'pressure');
  assert.equal(h.osc.status, 'bad');
  assert.equal(h.stiction.status, 'good');
  assert.match(h.stiction.value, /ไม่น่าใช่/);
});

test('health: well-tuned loop → no oscillation', () => {
  const m = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
  const c = core.tune(m, 'simc', 5, 1);
  const d = closedLoop({ model: m, dt: 1, T: 3600, Kc: c.Kc, Ti: c.Ti, noise: 0.2, seed: 6 });
  const h = healthOf(d, 'pressure');
  assert.equal(h.osc.status, 'good');
  assert.equal(h.sat.status, 'good');
  assert.equal(h.stiction, undefined);
});

// ─────────────── end-to-end on committed sample files ───────────────
test('sample CSVs parse and fit to their generating models', () => {
  const load = (f) => {
    const t = core.parseTable(readFileSync(join(here, '..', 'samples', f), 'utf8'));
    const ds = core.buildDataset(t, core.guessColumns(t));
    return core.resample(ds, 0);
  };
  const flow = load('flow_step_test.csv');
  const pv = F(flow.pv).map((v) => (v / 50) * 100);
  const f = core.fitFOPDT(flow.op, pv, flow.dt);
  near(f.Kp, 1.6, 0.1, 'flow Kp'); near(f.tau, 6, 0.15, 'flow tau');

  const temp = load('temperature_step_test.csv');
  assert.equal(temp.dt, 5);
  const tp = F(temp.pv).map((v) => ((v - 150) / 100) * 100);
  const ft = core.fitFOPDT(temp.op, tp, temp.dt);
  near(ft.Kp, 0.9, 0.1, 'temp Kp'); near(ft.tau, 300, 0.1, 'temp tau'); near(ft.theta, 60, 0.1, 'temp theta');

  const lvl = load('level_step_test.csv');
  const fl = core.fitIntegrating(lvl.op, lvl.pv, lvl.dt);
  near(fl.Ki, 0.004, 0.1, 'level Ki');
});
