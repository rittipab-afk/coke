/* PID Loop Tuner — core math (no DOM).
 * Loaded as a classic script in the browser (window.PIDCore) and via require() in Node tests.
 *
 * Units used throughout:
 *   time            seconds
 *   PV, SP          %span  = (value - SL) / (SH - SL) * 100
 *   OP (MV)         %      (0–100)
 *   Kp (FOPDT)      %span per %OP  (dimensionless)
 *   Ki (integrating) %span per second per %OP
 *   Kc              %OP per %span  (CENTUM: PB = 100 / Kc)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PIDCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────────── small helpers ─────────────────────────────
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function mean(a) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += a[i]; n++; }
    return n ? s / n : NaN;
  }
  function std(a) {
    const m = mean(a);
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += (a[i] - m) ** 2; n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
  }
  function median(a) {
    const b = Array.from(a).filter(isNum).sort((x, y) => x - y);
    if (!b.length) return NaN;
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }
  function minmax(a) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    return [lo, hi];
  }
  /** Noise estimate from first differences (robust to slow trends). */
  function diffNoise(a) {
    const d = [];
    for (let i = 1; i < a.length; i++) if (isNum(a[i]) && isNum(a[i - 1])) d.push(a[i] - a[i - 1]);
    return d.length > 2 ? std(d) / Math.SQRT2 : NaN;
  }

  // ───────────────────────────── parsing ─────────────────────────────
  const BAD_STATES = /^(bad|i\/o timeout|shutdown|no data|calc failed|pt created|scan off|comm fail|over range|under range|configure|not connected|intf shut|arc off-line|error|#n\/a|#value!|n\/a|nan|-)$/i;

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    const cands = ['\t', ';', ','];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      const counts = lines.map((l) => splitLine(l, d).length);
      const m = median(counts);
      const consistent = counts.filter((c) => c === m).length / (counts.length || 1);
      const score = m > 1 ? m * consistent : 0;
      if (score > bestScore + 1e-9) { best = d; bestScore = score; }
    }
    return best;
  }

  function splitLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function parseNumber(s, decimalComma) {
    if (typeof s === 'number') return s;
    if (s == null) return NaN;
    let t = String(s).trim();
    if (!t || BAD_STATES.test(t)) return NaN;
    t = t.replace(/%$/, '').replace(/\s/g, '');
    if (decimalComma) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return NaN;
    return Number(t);
  }

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
    'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12,
  };
  function monthFromName(s) {
    const k = s.toLowerCase();
    if (MONTHS[k]) return MONTHS[k];
    if (MONTHS[k.slice(0, 3)] && /^[a-z]+$/.test(k)) return MONTHS[k.slice(0, 3)];
    const kd = k.endsWith('.') ? k : k + '.';
    return MONTHS[kd] || 0;
  }
  /** 4-digit Buddhist-era years (> 2400) → CE. 2-digit: 00–49 → 20xx, 50–99 → BE 25xx → CE (e.g. 69 → 2026). */
  function normYear(y, digits) {
    if (digits <= 2) y = y < 50 ? 2000 + y : 2500 + y;
    if (y > 2400) y -= 543;
    return y;
  }
  const TIME_RE = '(?:[T\\s,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}(?:\\.\\d+)?))?\\s*(AM|PM|am|pm|น\\.)?)?';
  const RE_YMD = new RegExp('^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})' + TIME_RE + '\\s*(Z|[+-]\\d{2}:?\\d{2})?$');
  const RE_NUM = new RegExp('^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2}|\\d{4})' + TIME_RE + '$');
  const RE_NAME = new RegExp('^(\\d{1,2})[-\\s/]+([A-Za-z]{3,9}\\.?|[ก-๙]{1,3}\\.[ก-๙]{1,2}\\.?)[-\\s/]+(\\d{2}|\\d{4})' + TIME_RE + '$');

  function timeParts(m, i) {
    let hh = m[i] ? +m[i] : 0;
    const mi = m[i + 1] ? +m[i + 1] : 0;
    const ss = m[i + 2] ? parseFloat(m[i + 2]) : 0;
    const ap = m[i + 3] ? m[i + 3].toUpperCase() : '';
    if (ap === 'PM' && hh < 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    return [hh, mi, ss];
  }
  function utc(y, mo, d, hh, mi, ss) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh <= 24 && mi < 60 && ss < 61)) return NaN;
    return Date.UTC(y, mo - 1, d, hh, mi, 0) + ss * 1000;
  }

  /**
   * Parse a timestamp to "naive" epoch ms (wall-clock time treated as UTC, so only differences matter).
   * order: 'DMY' | 'MDY' for ambiguous numeric dates.
   */
  function parseTimestamp(s, order) {
    if (s == null) return NaN;
    if (typeof s === 'number') return numericTime(s);
    const t = String(s).trim();
    if (!t) return NaN;
    if (/^[-+]?\d+(\.\d+)?$/.test(t)) return numericTime(Number(t));
    let m = RE_YMD.exec(t);
    if (m) {
      const [hh, mi, ss] = timeParts(m, 4);
      return utc(normYear(+m[1], 4), +m[2], +m[3], hh, mi, ss);
    }
    m = RE_NUM.exec(t);
    if (m) {
      const a = +m[1], b = +m[2];
      const [d, mo] = order === 'MDY' ? [b, a] : [a, b];
      const [hh, mi, ss] = timeParts(m, 4);
      return utc(normYear(+m[3], m[3].length), mo, d, hh, mi, ss);
    }
    m = RE_NAME.exec(t);
    if (m) {
      const mo = monthFromName(m[2]);
      if (!mo) return NaN;
      const [hh, mi, ss] = timeParts(m, 4);
      return utc(normYear(+m[3], m[3].length), mo, +m[1], hh, mi, ss);
    }
    return NaN;
  }
  function numericTime(v) {
    if (v > 1e11) return v;                 // epoch ms
    if (v > 1e8) return v * 1000;           // epoch s
    if (v > 20000 && v < 80000) return Math.round((v - 25569) * 86400000); // Excel serial (1900 system)
    return NaN;
  }
  /** Decide DMY vs MDY from a sample of values. Defaults to DMY (Thai/European Excel). */
  function detectDateOrder(values) {
    let dmy = 0, mdy = 0;
    for (const v of values) {
      const m = RE_NUM.exec(String(v).trim());
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    return mdy > dmy ? 'MDY' : 'DMY';
  }

  /**
   * Parse CSV / pasted Excel text into a table.
   * Returns { delimiter, decimalComma, headers, rows, headerRow }.
   */
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '');
    const delimiter = detectDelimiter(text);
    const rawLines = text.split(/\r?\n/).filter((l) => l.trim());
    // Excel copies a full rectangle, so rows carry trailing empty cells; drop them.
    const lines = rawLines.map((l) => {
      const r = splitLine(l, delimiter);
      while (r.length > 1 && r[r.length - 1] === '') r.pop();
      return r;
    });
    // decimal comma: only possible when the delimiter is not a comma
    let decimalComma = false;
    if (delimiter !== ',') {
      let dc = 0, dp = 0;
      for (const row of lines.slice(0, 200)) for (const f of row) {
        if (/^-?\d+,\d+$/.test(f)) dc++;
        else if (/^-?\d+\.\d+$/.test(f)) dp++;
      }
      decimalComma = dc > dp;
    }
    const isDataField = (f) => isNum(parseNumber(f, decimalComma)) || isNum(parseTimestamp(f, 'DMY'));
    // first row where most fields are numbers/timestamps = data start
    // (judged on non-empty cells, so blank or text cells such as "Tag not found" do not hide a data row)
    let start = -1;
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const cells = lines[i].filter((f) => f !== '');
      const ok = cells.filter(isDataField).length;
      if (cells.length > 1 && ok >= Math.max(2, Math.ceil(cells.length * 0.6))) { start = i; break; }
    }
    if (start < 0) start = 0;
    const width = Math.max(...lines.slice(start, start + 50).map((r) => r.length), 1);
    let headers;
    if (start > 0) {
      const h = lines[start - 1];
      headers = Array.from({ length: width }, (_, i) => (h[i] && h[i].trim()) || `Col${i + 1}`);
    } else {
      headers = Array.from({ length: width }, (_, i) => `Col${i + 1}`);
    }
    // de-duplicate header names
    const seen = {};
    headers = headers.map((h) => { seen[h] = (seen[h] || 0) + 1; return seen[h] > 1 ? `${h} (${seen[h]})` : h; });
    return { delimiter, decimalComma, headers, rows: lines.slice(start), headerRow: start > 0 ? start - 1 : -1 };
  }

  /** Guess column roles from header names (CENTUM uses SV for setpoint and MV for output). */
  /**
   * Guess column roles. Handles the usual layouts from PI DataLink / Excel:
   *  - Timestamp | PV | SV | MV | MODE (names in the header)
   *  - one timestamp column per tag (Time | PV | Time | SV | ...), header names possibly misaligned
   *  - no header at all (order PV, SV, MV; MODE found from its AUT/MAN/CAS values)
   * CENTUM names: SV = setpoint, MV = output.
   */
  function guessColumns(table) {
    const width = table.headers.length;
    const sample = table.rows.slice(0, 50);
    const colVals = (c) => sample.map((r) => r[c]).filter((v) => v != null && v !== '');
    const frac = (vals, f) => (vals.length ? vals.filter(f).length / vals.length : 0);
    const kind = [];
    for (let c = 0; c < width; c++) {
      const vals = colVals(c);
      const order = detectDateOrder(vals);
      const tsFrac = frac(vals, (v) => isNum(parseTimestamp(v, order)));
      const numFrac = frac(vals, (v) => isNum(parseNumber(v, table.decimalComma)));
      const modeFrac = frac(vals, (v) => modeClass(v) !== null);
      const nameLike = /TIME|DATE|เวลา|วันที่/i.test(table.headers[c]);
      if (!vals.length) kind.push('empty');
      else if (tsFrac > 0.8 && (nameLike || numFrac < 0.5 || numericLooksLikeTime(vals))) kind.push('time');
      else if (numFrac > 0.5) kind.push('num');
      else if (modeFrac > 0.5) kind.push('mode');
      else kind.push('text');
    }
    const time = kind.indexOf('time');
    const valueCols = kind.map((k, c) => (k === 'num' || k === 'mode' ? c : -1)).filter((c) => c >= 0);

    // Header names to use for value columns. With one timestamp column per tag the typed names
    // usually do not line up with the data, so re-assign the tag-like names to value columns in order.
    let names = table.headers.slice();
    if (kind.filter((k) => k === 'time').length > 1) {
      const tagNames = table.headers.filter((x) => x && !/^COL\d+$/i.test(x) && !/TIME|DATE|เวลา|วันที่/i.test(x));
      names = new Array(width).fill('');
      if (tagNames.length === valueCols.length) valueCols.forEach((c, k) => { names[c] = tagNames[k]; });
    }
    const used = new Set([time]);
    const pick = (re, want) => {
      const c = names.findIndex((x, i) => re.test(x.toUpperCase()) && !used.has(i) && want.includes(kind[i]));
      if (c >= 0) used.add(c);
      return c;
    };
    let pv = pick(/(\.|\b|_)PV\b|PROCESS\s*VALUE/, ['num']);
    let sp = pick(/(\.|\b|_)(SV|SP)\b|SET\s*POINT|SETPOINT/, ['num']);
    let op = pick(/(\.|\b|_)(MV|OP|OUT)\b|OUTPUT/, ['num']);
    let mode = pick(/MODE/, ['mode', 'text']);
    if (mode < 0) { mode = kind.findIndex((k, i) => k === 'mode' && !used.has(i)); if (mode >= 0) used.add(mode); }
    // fallback: remaining numeric columns in order PV, SV, MV
    const rest = kind.map((k, c) => (k === 'num' && !used.has(c) ? c : -1)).filter((c) => c >= 0);
    if (pv < 0) pv = rest.shift() ?? -1;
    if (sp < 0) sp = rest.shift() ?? -1;
    if (op < 0) op = rest.shift() ?? -1;
    return { time, pv, sp, op, mode, headerNames: names };
  }
  /**
   * Loop tag from a column header. Accepts plain names and PI DataLink paths:
   *   "FIC101.PV" → "FIC101"
   *   "\\GCMPPISVR\3-CTA.2M.3AC1102B.MV" → "3-CTA.2M.3AC1102B"
   */
  function loopTagFromHeader(h) {
    let t = String(h || '').trim();
    if (t.includes('\\')) t = t.slice(t.lastIndexOf('\\') + 1); // drop \\server\ prefix
    const m = /^(.*)\.(PV|SV|SP|MV|OP|OUT|MODE)$/i.exec(t);
    return m ? m[1] : t.includes('.') ? t.slice(0, t.lastIndexOf('.')) : '';
  }
  /** Loop type from the instrument letters of the last tag segment (3FIC101 → flow, LIC → level ...). */
  function guessLoopType(tag) {
    const seg = String(tag || '').split('.').pop().replace(/^[\d-]+/, '').toUpperCase();
    return { F: 'flow', P: 'pressure', T: 'temperature', L: 'level' }[seg[0]] || 'flow';
  }
  function numericLooksLikeTime(vals) {
    const n = vals.map(Number).filter(isNum);
    return n.length > 0 && n.every((v) => (v > 20000 && v < 80000) || v > 1e8);
  }

  function modeClass(s) {
    if (s == null || s === '') return null;
    const u = String(s).toUpperCase();
    if (/CAS/.test(u)) return 'CAS';
    if (/MAN/.test(u)) return 'MAN';
    if (/AUT/.test(u)) return 'AUT';
    return null;
  }

  /**
   * Build a time-sorted dataset from a parsed table and a column map.
   * map: { time, pv, sp, op, mode } column indices (-1 = missing). opts: { dateOrder }
   */
  function buildDataset(table, map, opts = {}) {
    const rows = table.rows;
    const dc = table.decimalComma;
    const order = opts.dateOrder || detectDateOrder(rows.slice(0, 500).map((r) => r[map.time]));
    const recs = [];
    let bad = 0, badTime = 0;
    for (const r of rows) {
      const tm = parseTimestamp(r[map.time], order);
      if (!isNum(tm)) { badTime++; continue; }
      const get = (c) => (c >= 0 ? parseNumber(r[c], dc) : NaN);
      const pv = get(map.pv), sp = get(map.sp), op = get(map.op);
      if (!isNum(pv) || (map.op >= 0 && !isNum(op))) bad++;
      recs.push({ tm, pv, sp, op, mode: map.mode >= 0 ? r[map.mode] : null });
    }
    recs.sort((a, b) => a.tm - b.tm);
    const uniq = recs.filter((r, i) => i === 0 || r.tm !== recs[i - 1].tm);
    const t0 = uniq.length ? uniq[0].tm : 0;
    const n = uniq.length;
    // A MODE column without any AUT/MAN/CAS value (e.g. DataLink "Tag not found") is ignored.
    const modeUsable = map.mode >= 0 && uniq.some((r) => modeClass(r.mode) !== null);
    const ds = {
      t0, dateOrder: order,
      t: new Float64Array(n), pv: new Float64Array(n), sp: new Float64Array(n), op: new Float64Array(n),
      mode: modeUsable ? uniq.map((r) => modeClass(r.mode)) : null,
      modeRaw: modeUsable ? uniq.map((r) => r.mode) : null,
      modeIgnored: map.mode >= 0 && !modeUsable,
      hasSP: map.sp >= 0, hasOP: map.op >= 0,
      stats: { rows: rows.length, used: n, badValues: bad, badTime, duplicates: recs.length - n },
      spConstant: map.sp >= 0 && uniq.length > 1 && uniq.every((r) => r.sp === uniq[0].sp) ? uniq[0].sp : null,
    };
    for (let i = 0; i < n; i++) {
      ds.t[i] = (uniq[i].tm - t0) / 1000;
      ds.pv[i] = uniq[i].pv; ds.sp[i] = uniq[i].sp; ds.op[i] = uniq[i].op;
    }
    return ds;
  }

  /** Resample to a uniform grid. Gaps longer than maxGapFactor × dt become NaN. */
  function resample(ds, dtWanted, opts = {}) {
    const n = ds.t.length;
    if (n < 2) return Object.assign({}, ds, { dt: NaN });
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(ds.t[i] - ds.t[i - 1]);
    const dtData = median(diffs);
    let dt = dtWanted > 0 ? dtWanted : dtData;
    const span = ds.t[n - 1] - ds.t[0];
    const maxPts = opts.maxPoints || 200000;
    if (span / dt + 1 > maxPts) dt = span / (maxPts - 1);
    const m = Math.floor(span / dt + 1e-9) + 1;
    const maxGap = (opts.maxGapFactor || 5) * Math.max(dtData, dt);
    const out = {
      t0: ds.t0, dt, dtData, dateOrder: ds.dateOrder, hasSP: ds.hasSP, hasOP: ds.hasOP, stats: ds.stats,
      t: new Float64Array(m), pv: new Float64Array(m), sp: new Float64Array(m), op: new Float64Array(m),
      mode: ds.mode ? new Array(m) : null,
    };
    let j = 0;
    for (let k = 0; k < m; k++) {
      const tk = k * dt;
      out.t[k] = tk;
      while (j < n - 2 && ds.t[j + 1] <= tk) j++;
      const ta = ds.t[j], tb = ds.t[j + 1];
      const f = tb > ta ? clamp((tk - ta) / (tb - ta), 0, 1) : 0;
      const gap = tb - ta > maxGap;
      for (const key of ['pv', 'sp', 'op']) {
        const a = ds[key][j], b = ds[key][j + 1];
        out[key][k] = gap ? NaN : a + (b - a) * f;
      }
      if (ds.mode) out.mode[k] = f < 1 ? ds.mode[j] : ds.mode[j + 1];
    }
    return out;
  }

  /** Detect PI compression / stepped-interpolation artefacts. */
  function compressionCheck(y) {
    let flat = 0, lin = 0, n = 0;
    const [lo, hi] = minmax(y);
    const tol = Math.max(1e-12, (hi - lo) * 1e-7);
    for (let i = 1; i < y.length - 1; i++) {
      if (!isNum(y[i - 1]) || !isNum(y[i]) || !isNum(y[i + 1])) continue;
      n++;
      const d1 = y[i] - y[i - 1];
      if (Math.abs(d1) <= tol) flat++;
      else if (Math.abs(y[i + 1] - 2 * y[i] + y[i - 1]) <= tol * 10) lin++;
    }
    const flatFrac = n ? flat / n : 0, linFrac = n ? lin / n : 0;
    return { flatFrac, linFrac, suspicious: flatFrac > 0.3 || linFrac > 0.3 };
  }

  // ───────────────────────────── FFT / correlation ─────────────────────────────
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  function demeaned(a) {
    const m = mean(a);
    return Float64Array.from(a, (v) => (isNum(v) ? v - m : 0));
  }
  /** Normalised auto-correlation for lags 0..maxLag. */
  function acf(x, maxLag) {
    const d = demeaned(x);
    const n = d.length;
    let size = 1; while (size < 2 * n) size <<= 1;
    const re = new Float64Array(size), im = new Float64Array(size);
    re.set(d);
    fft(re, im, false);
    for (let i = 0; i < size; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im, true);
    const r0 = re[0] || 1;
    const out = new Float64Array(Math.min(maxLag, n - 1) + 1);
    for (let k = 0; k < out.length; k++) out[k] = re[k] / r0;
    return out;
  }
  /** Normalised cross-correlation r_uy(k) = E[u(i) y(i+k)] for k = -L..L. Returns { lags, r }. */
  function ccf(u, y, L) {
    const a = demeaned(u), b = demeaned(y);
    const n = Math.min(a.length, b.length);
    let size = 1; while (size < 2 * n) size <<= 1;
    const ar = new Float64Array(size), ai = new Float64Array(size);
    const br = new Float64Array(size), bi = new Float64Array(size);
    ar.set(a.subarray(0, n)); br.set(b.subarray(0, n));
    fft(ar, ai, false); fft(br, bi, false);
    const cr = new Float64Array(size), ci = new Float64Array(size);
    for (let i = 0; i < size; i++) { // conj(A) * B
      cr[i] = ar[i] * br[i] + ai[i] * bi[i];
      ci[i] = ar[i] * bi[i] - ai[i] * br[i];
    }
    fft(cr, ci, true);
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i] * a[i]; sb += b[i] * b[i]; }
    const norm = Math.sqrt(sa * sb) || 1;
    L = Math.min(L, n - 1);
    const lags = [], r = [];
    for (let k = -L; k <= L; k++) { lags.push(k); r.push(cr[(k + size) % size] / norm); }
    return { lags, r };
  }

  // ───────────────────────────── loop health ─────────────────────────────
  /**
   * Oscillation detection (Thornhill, Huang & Zhang 2003): regularity of ACF zero crossings.
   * r > 1 → regular (significant) oscillation.
   */
  function detectOscillation(e, dt) {
    const n = e.length;
    const res = { oscillating: false, regularity: 0, period: NaN, periodSamples: NaN, acfPeak: 0, crossings: 0 };
    if (n < 20) return res;
    const raw = acf(e, Math.floor(n / 2));
    // light smoothing so measurement noise does not create spurious crossings
    const r = Float64Array.from(raw, (v, k) => (k === 0 || k === raw.length - 1 ? v : (raw[k - 1] + v + raw[k + 1]) / 3));
    const zc = [];
    for (let k = 1; k < r.length && zc.length < 12; k++) {
      if ((r[k - 1] > 0) !== (r[k] > 0)) {
        const x = k - 1 + r[k - 1] / (r[k - 1] - r[k]);
        if (!zc.length || x - zc[zc.length - 1] >= 2) zc.push(x);
      }
    }
    res.crossings = zc.length;
    if (zc.length < 4) return res;
    const periods = [];
    for (let i = 0; i + 2 < zc.length; i++) periods.push(zc[i + 2] - zc[i]);
    const mp = mean(periods), sp = std(periods);
    res.regularity = sp > 1e-9 ? mp / (3 * sp) : 99;
    // height of the first ACF peak after lag 0 (between 2nd and 3rd crossing)
    let peak = 0;
    for (let k = Math.ceil(zc[1]); k <= Math.floor(zc[2]) && k < r.length; k++) peak = Math.max(peak, r[k]);
    res.acfPeak = peak;
    res.periodSamples = mp;
    res.period = mp * dt;
    res.oscillating = res.regularity > 1 && peak > 0.2;
    return res;
  }

  /**
   * Horch (2000) cross-correlation stiction test for self-regulating loops (flow/pressure).
   * Odd CCF between OP and PV → stiction likely; even → oscillation from tuning/disturbance.
   */
  function stictionHorch(op, pv, periodSamples) {
    const L = Math.max(2, Math.round(periodSamples / 4));
    const { lags, r } = ccf(op, pv, Math.max(L, Math.round(periodSamples)));
    const mid = (lags.length - 1) / 2;
    let odd = 0, even = 0;
    for (let k = 0; k <= L && mid + k < r.length; k++) {
      const a = r[mid + k], b = r[mid - k];
      odd += (a - b) ** 2; even += (a + b) ** 2;
    }
    const oddness = odd / (odd + even || 1);
    const verdict = oddness > 0.7 ? 'likely' : oddness < 0.3 ? 'unlikely' : 'inconclusive';
    return { oddness, verdict, lags, r };
  }

  /** Longest run of indices where mask is true and all arrays are finite. */
  function longestSegment(mask, arrays) {
    let best = [0, 0], s = -1;
    const n = mask.length;
    for (let i = 0; i <= n; i++) {
      const ok = i < n && mask[i] && arrays.every((a) => isNum(a[i]));
      if (ok && s < 0) s = i;
      if (!ok && s >= 0) { if (i - s > best[1] - best[0]) best = [s, i]; s = -1; }
    }
    return best;
  }

  /**
   * Loop health from normal operating data.
   * ds: resampled dataset. cfg: { sl, sh, loopType, opLo, opHi }
   * Returns metrics + findings[] ({ key, label, value, status: good|warn|bad|na, msg }).
   */
  function loopHealth(ds, cfg) {
    const span = cfg.sh - cfg.sl;
    const n = ds.t.length;
    const opLo = cfg.opLo ?? 0, opHi = cfg.opHi ?? 100;
    const pvp = Float64Array.from(ds.pv, (v) => (v - cfg.sl) / span * 100);
    const spp = Float64Array.from(ds.sp, (v) => (v - cfg.sl) / span * 100);
    const closed = new Array(n);
    let nMode = 0, nClosed = 0;
    for (let i = 0; i < n; i++) {
      const m = ds.mode ? ds.mode[i] : null;
      if (m) nMode++;
      closed[i] = ds.mode ? (m === 'AUT' || m === 'CAS') : true;
      if (closed[i] && m) nClosed++;
    }
    const e = [];
    const opC = [];
    for (let i = 0; i < n; i++) {
      if (!closed[i]) continue;
      if (ds.hasSP && isNum(pvp[i]) && isNum(spp[i])) e.push(spp[i] - pvp[i]);
      if (ds.hasOP && isNum(ds.op[i])) opC.push(ds.op[i]);
    }
    const out = { findings: [], metrics: {} };
    const M = out.metrics;
    const add = (key, label, value, status, msg) => out.findings.push({ key, label, value, status, msg });

    // time in auto
    if (ds.mode && nMode > 0) {
      M.pctAuto = (nClosed / nMode) * 100;
      if (nClosed === 0) {
        add('auto', 'เวลาอยู่ใน AUTO/CAS', '0%', 'na', 'ช่วงนี้อยู่ใน MAN ทั้งหมด (เช่นระหว่าง step test) จึงประเมิน closed-loop ไม่ได้ ให้เลือกช่วงที่ loop อยู่ใน AUTO หรือไปใช้ Tab 3 หา model');
        return out;
      }
      const st = M.pctAuto >= 90 ? 'good' : M.pctAuto >= 70 ? 'warn' : 'bad';
      add('auto', 'เวลาอยู่ใน AUTO/CAS', `${M.pctAuto.toFixed(1)}%`, st,
        st === 'good' ? 'loop อยู่ใน AUTO/CAS เกือบตลอด' : 'loop ถูกเปลี่ยนเป็น MAN บ่อย ควรถาม operator ว่าเพราะอะไร (tuning, valve หรือ process upset)');
    } else {
      add('auto', 'เวลาอยู่ใน AUTO/CAS', '—', 'na', 'ไม่มี column MODE จึงวิเคราะห์ข้อมูลทั้งหมดเหมือนเป็น closed-loop');
    }

    // control error
    if (e.length > 10) {
      M.errMean = mean(e); M.errStd = std(e);
      M.iae = mean(e.map(Math.abs));
      const st = M.errStd < 1 ? 'good' : M.errStd < 3 ? 'warn' : 'bad';
      add('err', 'Error (SP−PV) std', `${M.errStd.toFixed(2)} %span`, st,
        st === 'good' ? 'PV อยู่ใกล้ SP ดี' : 'PV แกว่งห่าง SP ค่อนข้างมาก ดูผล oscillation/stiction ด้านล่างประกอบ');
      if (Math.abs(M.errMean) > 1) add('offset', 'Offset เฉลี่ย', `${M.errMean.toFixed(2)} %span`, 'warn',
        'มี offset ค้าง ซึ่งปกติ integral ต้องกำจัดได้ ถ้า OP ติดขอบแสดงว่า valve สุดแล้ว (ขนาดไม่พอหรือ process เปลี่ยน)');
    } else {
      add('err', 'Error (SP−PV)', '—', 'na', ds.hasSP ? 'ข้อมูลช่วง closed-loop น้อยเกินไป' : 'ไม่มี column SP');
    }

    // OP saturation
    if (opC.length > 10) {
      const r = opHi - opLo;
      const low = opC.filter((v) => v <= opLo + 0.02 * r).length / opC.length * 100;
      const high = opC.filter((v) => v >= opHi - 0.02 * r).length / opC.length * 100;
      M.opLowPct = low; M.opHighPct = high; M.opMean = mean(opC); M.opStd = std(opC);
      const sat = low + high;
      const st = sat < 5 ? 'good' : sat < 20 ? 'warn' : 'bad';
      add('sat', 'OP ติดขอบ (≤2% / ≥98%)', `${low.toFixed(1)}% / ${high.toFixed(1)}%`, st,
        st === 'good' ? 'OP มีช่วงให้ขยับพอ' : 'OP ติดขอบบ่อย ช่วงนั้น loop คุมไม่ได้ ตรวจขนาด valve, bypass หรือ SP ที่เป็นไปไม่ได้');
      if (M.opMean < 10 || M.opMean > 90) add('opmean', 'OP เฉลี่ย', `${M.opMean.toFixed(1)}%`, 'warn',
        'OP เฉลี่ยใกล้ขอบมาก valve อาจ oversize/undersize ซึ่งทำให้ gain ไม่เป็นเชิงเส้นและ tune ยาก');
    }

    // PV noise
    const noise = diffNoise(pvp);
    M.noise = noise;
    if (isNum(noise)) {
      const st = noise < 0.2 ? 'good' : noise < 1 ? 'warn' : 'bad';
      add('noise', 'PV noise', `${noise.toFixed(3)} %span`, st,
        st === 'good' ? 'noise ต่ำ ใช้ derivative ได้ถ้าจำเป็น' : 'noise สูง ไม่ควรใช้ derivative (TD) หรือต้องมี PV filter และระวัง gain สูงจะทำให้ valve วิ่งตาม noise');
    }

    // oscillation + stiction on the longest clean closed-loop segment
    const [s0, s1] = longestSegment(closed, ds.hasSP ? [pvp, spp] : [pvp]);
    const segLen = s1 - s0;
    M.segment = [s0, s1];
    if (segLen >= 50) {
      const eSeg = new Float64Array(segLen);
      for (let i = 0; i < segLen; i++) eSeg[i] = ds.hasSP ? spp[s0 + i] - pvp[s0 + i] : -pvp[s0 + i];
      const osc = detectOscillation(eSeg, ds.dt);
      M.osc = osc;
      if (osc.oscillating) {
        add('osc', 'Oscillation', `คาบ ≈ ${fmtDuration(osc.period)} (r = ${osc.regularity.toFixed(1)})`, 'bad',
          `พบการแกว่งอย่างสม่ำเสมอ คาบประมาณ ${fmtDuration(osc.period)} อาจเกิดจาก tuning แรงเกิน, valve stiction หรือ loop อื่นที่แกว่งมารบกวน`);
      } else {
        add('osc', 'Oscillation', osc.crossings >= 4 ? `ไม่สม่ำเสมอ (r = ${osc.regularity.toFixed(1)})` : 'ไม่พบ', 'good', 'ไม่พบการแกว่งที่เป็นคาบชัดเจน');
      }
      if (osc.oscillating && ds.hasOP) {
        if (cfg.loopType === 'level') {
          add('stiction', 'Stiction indicator', 'N/A', 'na', 'วิธี cross-correlation ใช้กับ level (integrating) ไม่ได้ ให้ดู OP vs PV plot และทำ valve test ในสนาม');
        } else {
          const opSeg = ds.op.subarray(s0, s1), pvSeg = pvp.subarray(s0, s1);
          const st = stictionHorch(opSeg, pvSeg, osc.periodSamples);
          M.stiction = st;
          const map = {
            likely: ['bad', 'สงสัย stiction', 'CCF ระหว่าง OP กับ PV เป็นแบบ odd ซึ่งเป็นลักษณะของ valve stiction ให้ยืนยันด้วย valve signature หรือ bump test (ขยับ OP ทีละน้อยใน MAN) ถ้าใช่ต้องแก้ valve ก่อน เพราะ tuning ช่วยไม่ได้'],
            unlikely: ['good', 'ไม่น่าใช่ stiction', 'CCF เป็นแบบ even การแกว่งน่าจะมาจาก tuning แรงเกินหรือ disturbance ภายนอก'],
            inconclusive: ['warn', 'ไม่ชัดเจน', 'ผลอยู่ก้ำกึ่ง ให้ดูรูป OP vs PV (ถ้าเป็นสี่เหลี่ยมด้านขนาน = stiction) และทดสอบในสนาม'],
          }[st.verdict];
          add('stiction', 'Stiction indicator', `${map[1]} (oddness ${st.oddness.toFixed(2)})`, map[0], map[2]);
        }
      }
    } else {
      add('osc', 'Oscillation', '—', 'na', 'ช่วงข้อมูล closed-loop ที่ต่อเนื่องสั้นเกินไป (ต้องมีอย่างน้อย 50 จุด)');
    }
    return out;
  }

  function fmtDuration(s) {
    if (!isNum(s)) return '—';
    if (s < 120) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
    if (s < 7200) return `${(s / 60).toFixed(1)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  // ───────────────────────────── step detection & model fit ─────────────────────────────
  /** Find OP step events (|ΔOP| ≥ minStep within `merge` samples). */
  function findSteps(op, minStep = 0.5, merge = 3) {
    const steps = [];
    let i = 1;
    while (i < op.length) {
      if (!isNum(op[i]) || !isNum(op[i - 1])) { i++; continue; }
      if (Math.abs(op[i] - op[i - 1]) >= minStep * 0.25) {
        const start = i - 1;
        let end = i;
        while (end + 1 < op.length && end - start < merge + 2 && isNum(op[end + 1]) && Math.abs(op[end + 1] - op[end]) >= minStep * 0.25 && Math.sign(op[end + 1] - op[end]) === Math.sign(op[i] - op[i - 1])) end++;
        const size = op[end] - op[start];
        if (Math.abs(size) >= minStep) steps.push({ i: start, end, size });
        i = end + 1;
      } else i++;
    }
    return steps;
  }

  /** Linear interpolation of u at fractional index (clamped). */
  function uAt(u, idx) {
    if (idx <= 0) return u[0];
    const n = u.length - 1;
    if (idx >= n) return u[n];
    const i = Math.floor(idx), f = idx - i;
    return u[i] + (u[i + 1] - u[i]) * f;
  }

  /** Unit-gain FOPDT response x(k) to u(k)-u0 with fractional delay. */
  function simFOPDTUnit(u, dt, tau, theta) {
    const n = u.length;
    const x = new Float64Array(n);
    const a = Math.exp(-dt / tau);
    const d = theta / dt;
    const u0 = u[0];
    for (let k = 1; k < n; k++) x[k] = a * x[k - 1] + (1 - a) * (uAt(u, k - 1 - d) - u0);
    return x;
  }
  /** Cumulative integral of the delayed input (for integrating model). */
  function integDelayed(u, dt, theta) {
    const n = u.length;
    const x = new Float64Array(n);
    const d = theta / dt;
    for (let k = 1; k < n; k++) x[k] = x[k - 1] + dt * uAt(u, k - 1 - d);
    return x;
  }

  /** Least squares y ≈ X·b for small column counts via normal equations (Gaussian elimination). */
  function lstsq(cols, y) {
    const p = cols.length, n = y.length;
    const A = Array.from({ length: p }, () => new Float64Array(p + 1));
    for (let i = 0; i < p; i++) {
      for (let j = i; j < p; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += cols[i][k] * cols[j][k];
        A[i][j] = s; A[j][i] = s;
      }
      let s = 0;
      for (let k = 0; k < n; k++) s += cols[i][k] * y[k];
      A[i][p] = s;
    }
    for (let c = 0; c < p; c++) {
      let piv = c;
      for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-12 * (1 + Math.abs(A[c][p]))) return null;
      for (let r = 0; r < p; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
      }
    }
    const b = new Float64Array(p);
    for (let i = 0; i < p; i++) b[i] = A[i][p] / A[i][i];
    let sse = 0;
    for (let k = 0; k < n; k++) {
      let yh = 0;
      for (let i = 0; i < p; i++) yh += b[i] * cols[i][k];
      sse += (y[k] - yh) ** 2;
    }
    return { b, sse };
  }

  function nelderMead(f, x0, steps, opts = {}) {
    const n = x0.length;
    const maxIter = opts.maxIter || 300;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; simplex.push(x); }
    let vals = simplex.map(f);
    for (let it = 0; it < maxIter; it++) {
      const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
      simplex = idx.map((i) => simplex[i]); vals = idx.map((i) => vals[i]);
      if (Math.abs(vals[n] - vals[0]) <= 1e-10 * (Math.abs(vals[0]) + 1e-12)) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
      const refl = c.map((cj, j) => cj + (cj - simplex[n][j]));
      const fr = f(refl);
      if (fr < vals[0]) {
        const exp = c.map((cj, j) => cj + 2 * (cj - simplex[n][j]));
        const fe = f(exp);
        if (fe < fr) { simplex[n] = exp; vals[n] = fe; } else { simplex[n] = refl; vals[n] = fr; }
      } else if (fr < vals[n - 1]) { simplex[n] = refl; vals[n] = fr; }
      else {
        const con = c.map((cj, j) => cj + 0.5 * (simplex[n][j] - cj));
        const fc = f(con);
        if (fc < vals[n]) { simplex[n] = con; vals[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = f(simplex[i]); }
        }
      }
    }
    return { x: simplex[0], f: vals[0] };
  }

  function sliceWindow(t, u, y, i0, i1) {
    const tt = [], uu = [], yy = [];
    for (let i = i0; i < i1; i++) if (isNum(u[i]) && isNum(y[i])) { tt.push(t[i] - t[i0]); uu.push(u[i]); yy.push(y[i]); }
    return { t: Float64Array.from(tt), u: Float64Array.from(uu), y: Float64Array.from(yy) };
  }

  function fitQuality(y, yfit) {
    const m = mean(y);
    let sst = 0, sse = 0;
    for (let i = 0; i < y.length; i++) { sst += (y[i] - m) ** 2; sse += (y[i] - yfit[i]) ** 2; }
    return { r2: sst > 0 ? 1 - sse / sst : 0, sse };
  }

  /**
   * Fit FOPDT y = y0 + Kp·x(τ, θ) on an open-loop window.
   * u: OP (%), y: PV (%span), dt: sample time. Returns { Kp, tau, theta, r2, yfit, warnings }.
   */
  function fitFOPDT(u, y, dt) {
    const n = y.length;
    const T = (n - 1) * dt;
    const ones = new Float64Array(n).fill(1);
    const cost = (tau, theta) => {
      if (!(tau > 0) || theta < 0 || theta > T * 0.6) return Infinity;
      const x = simFOPDTUnit(u, dt, tau, theta);
      const r = lstsq([ones, x], y);
      return r ? r.sse : Infinity;
    };
    // coarse grid
    let best = { f: Infinity, tau: dt, theta: 0 };
    const tauMin = dt * 0.5, tauMax = T * 3;
    for (let a = 0; a <= 30; a++) {
      const tau = tauMin * Math.pow(tauMax / tauMin, a / 30);
      for (let b = 0; b <= 24; b++) {
        const theta = (T * 0.5) * (b / 24) ** 2;
        const f = cost(tau, theta);
        if (f < best.f) best = { f, tau, theta };
      }
    }
    // refine in (log τ, θ)
    const r = nelderMead(([lt, th]) => cost(Math.exp(lt), th), [Math.log(best.tau), best.theta], [0.3, Math.max(dt, T * 0.02)], { maxIter: 400 });
    const tau = Math.exp(r.x[0]), theta = Math.max(0, r.x[1]);
    const x = simFOPDTUnit(u, dt, tau, theta);
    const ls = lstsq([ones, x], y);
    const [y0, Kp] = ls ? ls.b : [mean(y), 0];
    const yfit = Float64Array.from(x, (v) => y0 + Kp * v);
    const q = fitQuality(y, yfit);
    const model = { type: 'fopdt', Kp, tau, theta, y0, r2: q.r2, yfit };
    model.warnings = fitWarnings(model, u, y, T);
    return model;
  }

  /** Fit integrating + dead time: y = c0 + c1·t + Ki·∫u(t-θ)dt  (Ki·ub = -c1, ub = balance OP). */
  function fitIntegrating(u, y, dt) {
    const n = y.length;
    const T = (n - 1) * dt;
    const ones = new Float64Array(n).fill(1);
    const tt = Float64Array.from({ length: n }, (_, k) => k * dt);
    const fitAt = (theta) => {
      if (theta < 0 || theta > T * 0.6) return null;
      const x = integDelayed(u, dt, theta);
      return lstsq([ones, tt, x], y);
    };
    let best = { f: Infinity, theta: 0 };
    for (let b = 0; b <= 60; b++) {
      const theta = (T * 0.5) * (b / 60) ** 2;
      const r = fitAt(theta);
      if (r && r.sse < best.f) best = { f: r.sse, theta };
    }
    // golden-section refine
    let lo = Math.max(0, best.theta - T * 0.03), hi = Math.min(T * 0.6, best.theta + T * 0.03);
    const g = (Math.sqrt(5) - 1) / 2;
    const fth = (th) => { const r = fitAt(th); return r ? r.sse : Infinity; };
    let c = hi - g * (hi - lo), d = lo + g * (hi - lo), fc = fth(c), fd = fth(d);
    for (let i = 0; i < 40; i++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - g * (hi - lo); fc = fth(c); }
      else { lo = c; c = d; fc = fd; d = lo + g * (hi - lo); fd = fth(d); }
    }
    let theta = (lo + hi) / 2;
    if (fth(theta) > best.f) theta = best.theta;
    const x = integDelayed(u, dt, theta);
    const ls = lstsq([ones, tt, x], y);
    const [c0, c1, Ki] = ls ? ls.b : [mean(y), 0, 0];
    const yfit = Float64Array.from(x, (v, k) => c0 + c1 * tt[k] + Ki * v);
    const q = fitQuality(y, yfit);
    const model = { type: 'integrating', Ki, theta, y0: c0, ub: Ki ? -c1 / Ki : NaN, r2: q.r2, yfit };
    model.warnings = fitWarnings(model, u, y, T);
    return model;
  }

  function fitWarnings(model, u, y, T) {
    const w = [];
    const [ulo, uhi] = minmax(u);
    const du = uhi - ulo;
    if (du < 0.5) w.push('OP แทบไม่ขยับในช่วงนี้ (< 0.5%) จึงหา model ไม่ได้ ให้เลือกช่วงที่มีการ step OP');
    const noise = diffNoise(y);
    const gainPart = model.type === 'fopdt' ? Math.abs(model.Kp) * du : Math.abs(model.Ki) * du * T * 0.2;
    const snr = noise > 0 ? gainPart / noise : Infinity;
    model.snr = snr;
    if (snr < 5) w.push(`step เล็กเมื่อเทียบกับ noise (SNR ≈ ${snr.toFixed(1)}) ควร step ใหญ่ขึ้นเพื่อให้ model เชื่อถือได้`);
    if (model.r2 < 0.8) w.push(`model fit ไม่ดี (R² = ${model.r2.toFixed(2)}) อาจมี disturbance ระหว่าง test หรือ process ไม่ใช่ FOPDT/integrating`);
    if (model.type === 'fopdt') {
      if (model.tau > T * 1.5) w.push('τ ยาวกว่าช่วงข้อมูล (PV ยังไม่เข้า steady state) ให้เลือกช่วงข้อมูลยาวขึ้นหลัง step');
      if (model.theta > T * 0.45) w.push('dead time เกือบเท่าครึ่งช่วงข้อมูล ผลอาจไม่น่าเชื่อถือ');
    }
    if (model.type === 'integrating' && model.Ki === 0) w.push('หา Ki ไม่ได้');
    return w;
  }

  /** Simulate a fitted model over a window for overlay (same as model.yfit but callable with edited params). */
  function modelResponse(model, u, dt) {
    if (model.type === 'fopdt') {
      const x = simFOPDTUnit(u, dt, model.tau, model.theta);
      return Float64Array.from(x, (v) => (model.y0 || 0) + model.Kp * v);
    }
    const x = integDelayed(u, dt, model.theta);
    return Float64Array.from(x, (v, k) => (model.y0 || 0) + model.Ki * (v - (model.ub || 0) * k * dt));
  }

  // ───────────────────────────── tuning rules ─────────────────────────────
  const METHODS = {
    fopdt: [
      { id: 'lambda', name: 'Lambda (PI)', param: 'λ', note: 'นิยมกับ flow/pressure ให้ response แบบ first-order ไม่มี overshoot' },
      { id: 'simc', name: 'SIMC (PI)', param: 'τc', note: 'Skogestad: ต้าน disturbance ดีกว่า Lambda เมื่อ τ ยาว' },
      { id: 'imc-pid', name: 'IMC (PID)', param: 'λ', note: 'สำหรับ loop ที่ dead time สูง เช่น temperature ต้องการ PV ที่ noise ต่ำ' },
    ],
    integrating: [
      { id: 'lambda-int', name: 'Lambda averaging level (PI)', param: 'λ (arrest time)', note: 'ให้ level แกว่งได้ในกรอบ เพื่อให้ flow ออกนิ่ง เหมาะกับ surge tank/buffer' },
      { id: 'simc-int', name: 'SIMC tight level (PI)', param: 'τc', note: 'คุม level แน่น ใช้เมื่อ level สำคัญกว่าความนิ่งของ flow ออก' },
    ],
  };

  /** Effective delay adds half the controller sample period (ZOH). */
  function effDelay(theta, Ts) { return theta + (Ts > 0 ? Ts / 2 : 0); }

  function tune(model, methodId, lam, Ts) {
    const th = effDelay(model.theta, Ts);
    if (model.type === 'fopdt') {
      const K = Math.abs(model.Kp), tau = model.tau;
      switch (methodId) {
        case 'simc': return { Kc: tau / (K * (lam + th)), Ti: Math.min(tau, 4 * (lam + th)), Td: 0 };
        case 'lambda': return { Kc: tau / (K * (lam + th)), Ti: tau, Td: 0 };
        case 'imc-pid': return { Kc: (tau + th / 2) / (K * (lam + th / 2)), Ti: tau + th / 2, Td: (tau * th) / (2 * tau + th) };
      }
    } else {
      const Ki = Math.abs(model.Ki);
      switch (methodId) {
        case 'simc-int': return { Kc: 1 / (Ki * (lam + th)), Ti: 4 * (lam + th), Td: 0 };
        case 'lambda-int': return { Kc: (2 * lam + th) / (Ki * (lam + th) ** 2), Ti: 2 * lam + th, Td: 0 };
      }
    }
    throw new Error('unknown method ' + methodId);
  }

  /** Default method + λ/τc (seconds) and slider range, by loop type. */
  function defaultTuning(model, loopType, Ts) {
    const th = Math.max(effDelay(model.theta, Ts), Ts || 0);
    if (model.type === 'integrating') {
      // averaging level: arrest time such that a 5% OP-equivalent flow upset moves the level ≈ 10 %span
      const lam = Math.max(10 * th, 2 / Math.abs(model.Ki));
      return { method: 'lambda-int', lam, min: Math.max(th, 1), max: Math.max(lam * 10, 3600) };
    }
    const tau = model.tau;
    switch (loopType) {
      case 'flow': return { method: 'lambda', lam: Math.max(tau, th), min: Math.max(0.2 * tau, th * 0.5, 0.1), max: Math.max(5 * tau, 5 * th) };
      case 'temperature': {
        const ratio = model.theta / tau;
        return { method: ratio > 0.3 ? 'imc-pid' : 'simc', lam: Math.max(th, 0.25 * tau), min: Math.max(0.3 * th, 0.05 * tau, 0.1), max: Math.max(3 * tau, 6 * th) };
      }
      default: return { method: 'simc', lam: Math.max(th, 0.2 * tau), min: Math.max(0.3 * th, 0.05 * tau, 0.1), max: Math.max(3 * tau, 6 * th) };
    }
  }

  /** CENTUM PID: PB [%] = 100 / Kc ; TI, TD in seconds (TI = 0/blank → no integral). */
  function toCentum(c) { return { PB: 100 / c.Kc, TI: isFinite(c.Ti) ? c.Ti : 0, TD: c.Td || 0 }; }
  function fromCentum(PB, TI, TD) { return { Kc: 100 / PB, Ti: TI > 0 ? TI : Infinity, Td: TD > 0 ? TD : 0 }; }

  /** Guard rails comparing a proposed tuning with the current one. */
  function compareTuning(cur, prop) {
    const notes = [];
    if (!cur || !isNum(cur.Kc)) return notes;
    const gr = prop.Kc / cur.Kc;
    if (gr > 2) notes.push({ status: 'warn', msg: `Gain ใหม่แรงกว่าเดิม ${gr.toFixed(1)} เท่า ควรเปลี่ยนเป็นขั้น (เช่นทีละ ~50%) แล้วดูผลก่อนขยับต่อ` });
    if (gr < 0.5) notes.push({ status: 'warn', msg: `Gain ใหม่อ่อนกว่าเดิม ${(1 / gr).toFixed(1)} เท่า loop จะตอบสนองช้าลงชัดเจน แจ้ง operator ก่อน` });
    if (isFinite(cur.Ti) && isFinite(prop.Ti)) {
      const tr = prop.Ti / cur.Ti;
      if (tr > 3 || tr < 1 / 3) notes.push({ status: 'warn', msg: `TI เปลี่ยน ${tr > 1 ? tr.toFixed(1) + ' เท่า' : '1/' + (1 / tr).toFixed(1)} ควรทำเป็นขั้นและเฝ้าดูผล` });
    }
    return notes;
  }

  // ───────────────────────────── frequency response / margins ─────────────────────────────
  /** Loop L(jω) = C·G as { mag, phase } with continuous phase (rad). α = derivative filter ratio. */
  function loopAt(model, ctrl, Ts, w, alpha = 0.1) {
    // controller
    let cr = 1, ci = 0;
    if (isFinite(ctrl.Ti) && ctrl.Ti > 0) ci -= 1 / (w * ctrl.Ti);
    if (ctrl.Td > 0) {
      const a = alpha * ctrl.Td * w, b = ctrl.Td * w; // jb/(1+ja) = (ab + jb)/(1+a²)
      cr += (a * b) / (1 + a * a); ci += b / (1 + a * a);
    }
    let mag = ctrl.Kc * Math.hypot(cr, ci);
    let phase = Math.atan2(ci, cr);
    const delay = effDelay(model.theta, Ts);
    if (model.type === 'fopdt') {
      mag *= Math.abs(model.Kp) / Math.hypot(1, w * model.tau);
      phase += -Math.atan(w * model.tau);
    } else {
      mag *= Math.abs(model.Ki) / w;
      phase += -Math.PI / 2;
    }
    phase -= w * delay;
    return { mag, phase };
  }

  function margins(model, ctrl, Ts) {
    const tchar = Math.max(model.theta || 0, model.tau || 0, ctrl.Ti && isFinite(ctrl.Ti) ? ctrl.Ti : 0, Ts || 0, 1e-3);
    const wmin = 1e-4 / tchar;
    const wmax = Ts > 0 ? Math.PI / Ts : 1e3 / Math.max(model.theta || 0, 1e-3);
    const N = 3000;
    let gm = Infinity, pm = Infinity, ms = 0, wc = NaN, w180 = NaN;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const w = wmin * Math.pow(wmax / wmin, i / N);
      const L = loopAt(model, ctrl, Ts, w);
      const re = 1 + L.mag * Math.cos(L.phase), im = L.mag * Math.sin(L.phase);
      ms = Math.max(ms, 1 / Math.hypot(re, im));
      if (prev) {
        // phase crossover (-180°)
        if ((prev.L.phase + Math.PI) * (L.phase + Math.PI) <= 0 && prev.L.phase !== L.phase) {
          const f = (prev.L.phase + Math.PI) / (prev.L.phase - L.phase);
          const m = prev.L.mag * Math.pow(L.mag / prev.L.mag, f);
          if (1 / m < gm) { gm = 1 / m; w180 = prev.w * Math.pow(w / prev.w, f); }
        }
        // gain crossover (|L| = 1)
        if ((prev.L.mag - 1) * (L.mag - 1) <= 0 && prev.L.mag !== L.mag) {
          const f = Math.log(prev.L.mag) / (Math.log(prev.L.mag) - Math.log(L.mag));
          const ph = prev.L.phase + f * (L.phase - prev.L.phase);
          const p = 180 + (ph * 180) / Math.PI;
          if (p < pm) { pm = p; wc = prev.w * Math.pow(w / prev.w, f); }
        }
      }
      prev = { w, L };
    }
    const stable = gm > 1 && pm > 0;
    return { gm, pm, ms, wc, w180, stable };
  }

  /** Ultimate gain/period of FOPDT (for tests and reference). */
  function ultimate(model, Ts) {
    const th = effDelay(model.theta, Ts);
    // solve ω·θ + atan(ω·τ) = π
    let lo = 1e-9, hi = Math.PI / Math.max(th, 1e-9);
    for (let i = 0; i < 200; i++) {
      const w = (lo + hi) / 2;
      if (w * th + Math.atan(w * model.tau) > Math.PI) hi = w; else lo = w;
    }
    const w = (lo + hi) / 2;
    const Ku = Math.hypot(1, w * model.tau) / Math.abs(model.Kp);
    return { Ku, Pu: (2 * Math.PI) / w, wu: w };
  }

  // ───────────────────────────── closed-loop simulation ─────────────────────────────
  /**
   * Closed-loop sim of a model + CENTUM-style velocity PID (inherently anti-windup, OP clamped).
   * opts: { Ts, T, u0, spStep, spTime, distStep, distTime, algorithm: 'pid'|'i-pd'|'pi-d', gainMult, delayMult, y0 }
   * Process is simulated with |gain| (controller action assumed set correctly).
   */
  function simulateClosedLoop(model, ctrl, opts) {
    const Ts = Math.max(opts.Ts || 1, 1e-3);
    const T = opts.T;
    const theta = (model.theta || 0) * (opts.delayMult || 1);
    const gain = (model.type === 'fopdt' ? Math.abs(model.Kp) : Math.abs(model.Ki)) * (opts.gainMult || 1);
    // integration step
    const fast = model.type === 'fopdt' ? Math.min(model.tau / 20, theta > 0 ? theta / 10 : Infinity) : (theta > 0 ? theta / 10 : Ts);
    const sub = Math.max(1, Math.min(200, Math.ceil(Ts / Math.max(fast, 1e-3))));
    const h = Ts / sub;
    const nSteps = Math.ceil(T / h);
    const nd = Math.round(theta / h);
    const a = model.type === 'fopdt' ? Math.exp(-h / model.tau) : 0;
    const u0 = opts.u0 ?? 50, y0 = opts.y0 ?? 50;
    const buf = new Float64Array(nd + 1).fill(0);
    let bi = 0;
    let x = 0, u = u0;
    const Kc = ctrl.Kc, Ti = ctrl.Ti, Td = ctrl.Td || 0;
    const ki = isFinite(Ti) && Ti > 0 ? Ts / Ti : 0;
    const kd = Td / Ts;
    const alg = opts.algorithm || 'pid';
    let e1 = 0, e2 = 0, y1 = y0, y2 = y0;
    const maxPts = 3000;
    const every = Math.max(1, Math.floor(nSteps / maxPts));
    const tt = [], spA = [], pvA = [], opA = [];
    let diverged = false;
    for (let k = 0; k <= nSteps; k++) {
      const t = k * h;
      const sp = y0 + (t >= opts.spTime ? opts.spStep : 0);
      const dist = t >= opts.distTime ? opts.distStep : 0;
      const y = y0 + x;
      if (k % sub === 0) {
        const e = sp - y;
        let du;
        if (alg === 'i-pd') du = Kc * (-(y - y1) + ki * e - kd * (y - 2 * y1 + y2));
        else if (alg === 'pi-d') du = Kc * ((e - e1) + ki * e - kd * (y - 2 * y1 + y2));
        else du = Kc * ((e - e1) + ki * e + kd * (e - 2 * e1 + e2));
        if (k === 0) du = 0;
        u = clamp(u + du, 0, 100);
        e2 = e1; e1 = e; y2 = y1; y1 = y;
      }
      // process input (deviation) through dead time buffer
      buf[bi] = u - u0 + dist;
      const uin = buf[(bi + 1) % (nd + 1)];
      bi = (bi + 1) % (nd + 1);
      if (model.type === 'fopdt') x = a * x + (1 - a) * gain * uin;
      else x += h * gain * uin;
      if (!isNum(x) || Math.abs(x) > 1e4) { diverged = true; break; }
      if (k % every === 0) { tt.push(t); spA.push(sp); pvA.push(y); opA.push(u); }
    }
    const res = { t: tt, sp: spA, pv: pvA, op: opA, diverged };
    res.metrics = simMetrics(res, opts);
    return res;
  }

  function simMetrics(r, opts) {
    const m = { diverged: r.diverged };
    if (r.diverged || r.t.length < 3) return m;
    const idx = (t) => { let i = 0; while (i < r.t.length - 1 && r.t[i] < t) i++; return i; };
    const iSp = idx(opts.spTime), iD = idx(opts.distTime), iEnd = r.t.length - 1;
    // SP response
    if (opts.spStep) {
      const step = opts.spStep, target = r.sp[iD - 1];
      let over = 0, iae = 0, lastOut = iSp;
      for (let i = iSp; i < iD; i++) {
        const dev = (r.pv[i] - target) * Math.sign(step);
        over = Math.max(over, dev);
        if (Math.abs(r.pv[i] - target) > 0.02 * Math.abs(step)) lastOut = i;
        if (i > iSp) iae += Math.abs(r.sp[i] - r.pv[i]) * (r.t[i] - r.t[i - 1]);
      }
      m.overshoot = (over / Math.abs(step)) * 100;
      m.settle = lastOut >= iD - 1 ? Infinity : r.t[lastOut] - opts.spTime;
      m.iaeSp = iae;
      let opMax = 0;
      for (let i = iSp; i < iD; i++) opMax = Math.max(opMax, Math.abs(r.op[i] - r.op[Math.max(iSp - 1, 0)]));
      m.opPeakSp = opMax;
    }
    // load response
    if (opts.distStep) {
      let peak = 0, iae = 0, lastOut = iD;
      for (let i = iD; i <= iEnd; i++) {
        const dev = Math.abs(r.pv[i] - r.sp[i]);
        peak = Math.max(peak, dev);
        if (i > iD) iae += dev * (r.t[i] - r.t[i - 1]);
      }
      for (let i = iD; i <= iEnd; i++) if (Math.abs(r.pv[i] - r.sp[i]) > Math.max(0.1 * peak, 1e-6)) lastOut = i;
      m.peakDist = peak;
      m.recover = lastOut >= iEnd ? Infinity : r.t[lastOut] - opts.distTime;
      m.iaeDist = iae;
      // not settling: deviation in last 15% still large
      let tail = 0;
      for (let i = Math.floor(iEnd - 0.15 * (iEnd - iD)); i <= iEnd; i++) tail = Math.max(tail, Math.abs(r.pv[i] - r.sp[i]));
      m.notSettled = tail > 0.3 * peak && peak > 1e-6;
    }
    return m;
  }

  /** Reasonable sim duration covering both SP and load tests. */
  function suggestSimTime(model, ctrls) {
    const Ti = Math.max(...ctrls.map((c) => (isFinite(c.Ti) ? c.Ti : 0)));
    const base = model.type === 'fopdt'
      ? Math.max(8 * (model.tau + model.theta), 4 * Ti)
      : Math.max(20 * Math.max(model.theta, 1), 5 * Ti);
    return 2 * base;
  }

  return {
    // helpers
    mean, std, median, minmax, diffNoise, fmtDuration,
    // parsing
    detectDelimiter, splitLine, parseNumber, parseTimestamp, detectDateOrder, parseTable, guessColumns,
    loopTagFromHeader, guessLoopType,
    buildDataset, resample, compressionCheck, modeClass,
    // correlation
    fft, acf, ccf,
    // health
    detectOscillation, stictionHorch, loopHealth,
    // model
    findSteps, fitFOPDT, fitIntegrating, modelResponse, sliceWindow, simFOPDTUnit,
    // tuning
    METHODS, tune, defaultTuning, toCentum, fromCentum, compareTuning, effDelay,
    // analysis
    loopAt, margins, ultimate, simulateClosedLoop, suggestSimTime,
  };
});
