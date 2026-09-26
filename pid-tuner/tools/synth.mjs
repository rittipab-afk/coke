// Synthetic plant data generators (shared by gen-samples.mjs and the tests).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const core = require('../src/core.js');

export function rng(seed = 1) {
  let a = seed >>> 0;
  const uni = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());
  return { uni, gauss };
}

/**
 * Open-loop step test: OP follows `profile` [[t, op], ...] (held), process in %span.
 * model: { type:'fopdt', Kp, tau, theta } | { type:'integrating', Ki, theta, ub }
 */
export function openLoop({ model, dt, T, profile, y0 = 50, noise = 0.2, seed = 1, drift = 0 }) {
  const r = rng(seed);
  const n = Math.round(T / dt) + 1;
  const sub = 20, h = dt / sub;
  const nd = Math.round(model.theta / h);
  const buf = new Array(nd + 1).fill(profile[0][1]);
  let bi = 0, x = 0, d = 0;
  const out = { t: [], op: [], pv: [] };
  const opAt = (t) => { let v = profile[0][1]; for (const [tt, o] of profile) if (t >= tt) v = o; return v; };
  const u0 = model.type === 'integrating' ? model.ub : profile[0][1];
  for (let k = 0; k < n; k++) {
    const t = k * dt;
    const op = opAt(t);
    out.t.push(t); out.op.push(op);
    d += drift * r.gauss() * Math.sqrt(dt);
    out.pv.push(y0 + x + d + noise * r.gauss());
    for (let s = 0; s < sub; s++) {
      buf[bi] = op; const uin = buf[(bi + 1) % (nd + 1)]; bi = (bi + 1) % (nd + 1);
      if (model.type === 'fopdt') { const a = Math.exp(-h / model.tau); x = a * x + (1 - a) * model.Kp * (uin - u0); }
      else x += h * model.Ki * (uin - u0);
    }
  }
  return out;
}

/** Valve with stick-slip (S = stickband+deadband, J = slip jump), both in %. */
export function stickyValve(S, J) {
  let x = null;
  return (u) => {
    if (x === null) x = u;
    const err = u - x;
    if (Math.abs(err) > S) x = u - Math.sign(err) * (S - J);
    return x;
  };
}

/**
 * Closed-loop operation with a velocity PI(D) controller, measurement noise and a slow load disturbance.
 * Returns { t, pv, sp, op } with PV/SP in %span.
 */
export function closedLoop({ model, dt, T, Kc, Ti, sp = 50, u0 = 50, noise = 0.2, load = 0.3, seed = 2, valve = null }) {
  const r = rng(seed);
  const n = Math.round(T / dt) + 1;
  const sub = 20, h = dt / sub;
  const nd = Math.round(model.theta / h);
  const buf = new Array(nd + 1).fill(0);
  let bi = 0, x = 0, u = u0, e1 = 0, dist = 0;
  const out = { t: [], op: [], pv: [], sp: [] };
  for (let k = 0; k < n; k++) {
    const t = k * dt;
    const y = sp + x + noise * r.gauss();
    const e = sp - y;
    if (k > 0) u = Math.min(100, Math.max(0, u + Kc * ((e - e1) + (dt / Ti) * e)));
    e1 = e;
    out.t.push(t); out.op.push(u); out.pv.push(y); out.sp.push(sp);
    dist = 0.995 * dist + load * r.gauss() * 0.1;
    const pos = valve ? valve(u) : u;
    for (let s = 0; s < sub; s++) {
      buf[bi] = pos - u0 + dist; const uin = buf[(bi + 1) % (nd + 1)]; bi = (bi + 1) % (nd + 1);
      if (model.type === 'fopdt') { const a = Math.exp(-h / model.tau); x = a * x + (1 - a) * model.Kp * uin; }
      else x += h * model.Ki * uin;
    }
  }
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (v) => String(v).padStart(2, '0');
export const fmt = {
  pi: (d) => `${p2(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${p2(d.getUTCFullYear() % 100)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
  thaiBE: (d) => `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear() + 543} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
  iso: (d) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
};

/** Write rows as CSV. cols: [{ name, get(i) }]. */
export function toCSV(n, cols, delim = ',') {
  const lines = [cols.map((c) => c.name).join(delim)];
  for (let i = 0; i < n; i++) lines.push(cols.map((c) => c.get(i)).join(delim));
  return lines.join('\n') + '\n';
}
