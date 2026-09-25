// Generate synthetic sample CSVs in pid-tuner/samples (deterministic seeds).
// Usage: node pid-tuner/tools/gen-samples.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, openLoop, closedLoop, stickyValve, fmt, toCSV } from './synth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'samples');
mkdirSync(outDir, { recursive: true });

const START = Date.UTC(2026, 8, 25, 8, 0, 0); // 25 Sep 2026 08:00
const eng = (pct, sl, sh) => +(sl + (pct / 100) * (sh - sl)).toFixed(3);

export const SAMPLES = [
  {
    file: 'flow_step_test.csv', tag: 'FIC101', loopType: 'flow', sl: 0, sh: 50, unit: 'm3/h',
    current: { PB: 150, TI: 10, TD: 0 }, Ts: 1,
    note: 'Flow step test ใน MAN (Kp=1.6, τ=6 s, θ=2 s)',
    make() {
      const model = { type: 'fopdt', Kp: 1.6, tau: 6, theta: 2 };
      const d = openLoop({ model, dt: 1, T: 900, profile: [[0, 45], [120, 50], [300, 45], [480, 40], [660, 45]], noise: 0.25, seed: 11 });
      return { d, mode: () => 'MAN', ts: fmt.pi };
    },
  },
  {
    file: 'flow_sticky_valve.csv', tag: 'FIC102', loopType: 'flow', sl: 0, sh: 80, unit: 'm3/h',
    current: { PB: 250, TI: 4, TD: 0 }, Ts: 1,
    note: 'Flow loop ใน AUT ที่ valve มี stiction (S=4%, J=2%) ทำให้แกว่งเป็น limit cycle',
    make() {
      const model = { type: 'fopdt', Kp: 1.5, tau: 5, theta: 1 };
      const d = closedLoop({ model, dt: 1, T: 3600, Kc: 0.4, Ti: 4, valve: stickyValve(4, 2), noise: 0.1, seed: 3 });
      return { d, mode: () => 'AUT', ts: fmt.iso };
    },
  },
  {
    file: 'pressure_oscillating.csv', tag: 'PIC201', loopType: 'pressure', sl: 0, sh: 10, unit: 'barg',
    current: null, Ts: 1,
    note: 'Pressure loop ที่ tune แรงเกิน (GM ≈ 1.35) แกว่งแต่ valve ปกติ',
    make() {
      const model = { type: 'fopdt', Kp: 1, tau: 20, theta: 5 };
      let Kc = core.ultimate(model, 1).Ku, Ti = 15;
      while (core.margins(model, { Kc, Ti, Td: 0 }, 1).gm < 1.3) Kc *= 0.95;
      this.current = core.toCentum({ Kc, Ti, Td: 0 });
      this.current.PB = Math.round(this.current.PB);
      const d = closedLoop({ model, dt: 1, T: 3600, Kc: 100 / this.current.PB, Ti, noise: 0.2, seed: 5 });
      return { d, mode: () => 'AUT', ts: fmt.iso };
    },
  },
  {
    file: 'temperature_step_test.csv', tag: 'TIC301', loopType: 'temperature', sl: 150, sh: 250, unit: '°C',
    current: { PB: 80, TI: 600, TD: 0 }, Ts: 2,
    note: 'Temperature step test (Kp=0.9, τ=300 s, θ=60 s) เวลาแบบ พ.ศ.',
    make() {
      const model = { type: 'fopdt', Kp: 0.9, tau: 300, theta: 60 };
      const d = openLoop({ model, dt: 5, T: 3 * 3600, profile: [[0, 40], [600, 45], [4200, 40], [7800, 36]], noise: 0.08, seed: 7 });
      return { d, mode: () => 'MAN', ts: fmt.thaiBE };
    },
  },
  {
    file: 'level_step_test.csv', tag: 'LIC401', loopType: 'level', sl: 0, sh: 100, unit: '%',
    current: { PB: 100, TI: 600, TD: 0 }, Ts: 1,
    note: 'Level (integrating) step test (Ki=0.004 %/s/%, θ=6 s, balance OP 48%)',
    make() {
      const model = { type: 'integrating', Ki: 0.004, theta: 6, ub: 48 };
      const d = openLoop({ model, dt: 2, T: 3600, profile: [[0, 48], [300, 53], [900, 48], [1800, 43], [2400, 48]], noise: 0.1, seed: 9 });
      return { d, mode: () => 'MAN', ts: fmt.iso };
    },
  },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const s of SAMPLES) {
    const { d, mode, ts } = s.make();
    const n = d.t.length;
    const cols = [
      { name: 'Timestamp', get: (i) => ts(new Date(START + d.t[i] * 1000)) },
      { name: `${s.tag}.PV`, get: (i) => eng(d.pv[i], s.sl, s.sh) },
      { name: `${s.tag}.SV`, get: (i) => eng(d.sp ? d.sp[i] : d.pv[0], s.sl, s.sh) },
      { name: `${s.tag}.MV`, get: (i) => +d.op[i].toFixed(2) },
      { name: `${s.tag}.MODE`, get: (i) => mode(i) },
    ];
    writeFileSync(join(outDir, s.file), toCSV(n, cols));
    console.log(`${s.file}: ${n} rows · ${s.note} · current ${JSON.stringify(s.current)}`);
  }
  const index = SAMPLES.map(({ file, tag, loopType, sl, sh, unit, current, Ts, note }) => ({ file, tag, loopType, sl, sh, unit, current, Ts, note }));
  writeFileSync(join(outDir, 'samples.json'), JSON.stringify(index, null, 2) + '\n');
}
