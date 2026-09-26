/* PID Loop Tuner — UI wiring. Depends on window.PIDCore and window.PIDCharts. */
(function () {
  'use strict';
  const C = window.PIDCore, Ch = window.PIDCharts;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const S = {
    table: null, map: null, ds: null, rs: null, fileName: '',
    cfg: {}, slGuessed: false,
    healthRange: null, health: null,
    fitRange: null, fit: null, model: null, modelSource: null,
    tune: null, result: null,
    charts: {},
  };

  // ───────────────────────── formatting ─────────────────────────
  const p2 = (v) => String(v).padStart(2, '0');
  function dateOf(t) { return new Date(S.rs.t0 + t * 1000); }
  function fmtTime(t) {
    const d = dateOf(t);
    return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  }
  function tickTime(t, step) {
    const d = dateOf(t);
    if (step >= 86400) return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}`;
    if (step >= 60) return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  }
  const fmtDur = C.fmtDuration;
  function fmtSig(v, sig = 3) {
    if (!isNum(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString('en-US');
    return Number(v.toPrecision(sig)).toString();
  }
  function fmtSec(v) {
    if (!isNum(v)) return v === Infinity ? '∞' : '—';
    return `${fmtSig(v)} s`;
  }

  // ───────────────────────── theme ─────────────────────────
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: 'ธีม: อัตโนมัติ', light: 'ธีม: สว่าง', dark: 'ธีม: มืด' };
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('#themeBtn').textContent = THEME_LABEL[t];
    Object.values(S.charts).forEach((c) => c && c.redraw && c.redraw());
  }
  let theme = store.get('pidtuner:theme') || 'auto';
  $('#themeBtn').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set('pidtuner:theme', theme);
    applyTheme(theme);
  });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(theme));

  // ───────────────────────── tabs ─────────────────────────
  let currentTab = 'data';
  function showTab(name) {
    currentTab = name;
    $$('nav.tabs button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
      if (b.dataset.tab === name && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    $$('section.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'health') renderHealth();
    if (name === 'model') enterModel();
    if (name === 'tune') enterTune();
    if (name === 'report') renderReport();
    window.scrollTo({ top: 0 });
  }
  function enableTabs() {
    const has = !!S.rs;
    $('nav.tabs [data-tab="health"]').disabled = !has;
    $('nav.tabs [data-tab="model"]').disabled = !has;
    $('nav.tabs [data-tab="tune"]').disabled = !S.model;
    $('nav.tabs [data-tab="report"]').disabled = !S.rs;
    // "next: Tuning" buttons stay disabled (with the reason on hover) until there is a model
    $$('[data-goto="tune"]').forEach((b) => {
      b.disabled = !S.model;
      b.title = S.model ? '' : 'ต้องมี model ก่อน: ข้อมูลต้องมีช่วง step MV ใน MAN หรือกรอก model เอง';
    });
  }
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => !b.disabled && showTab(b.dataset.tab)));
  document.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-goto]');
    if (!g) return;
    const tab = $(`nav.tabs [data-tab="${g.dataset.goto}"]`);
    if (g.disabled || (tab && tab.disabled)) return;
    showTab(g.dataset.goto);
  });

  function legend(el, items) {
    el.innerHTML = items.map((i) => {
      const color = getComputedStyle(document.documentElement).getPropertyValue(i.color).trim();
      const cls = i.dash ? 'key dash' : i.thin ? 'key thin' : 'key';
      const style = i.dash ? `border-color:${color}` : `background:${color};${i.alpha ? 'opacity:' + i.alpha : ''}`;
      return `<span><span class="${cls}" style="${style}"></span>${esc(i.name)}</span>`;
    }).join('');
  }
  function chart(key, el, config, kind = 'line') {
    if (S.charts[key]) { S.charts[key].update(config); return S.charts[key]; }
    S.charts[key] = kind === 'xy' ? Ch.XYChart(el, config) : Ch.LineChart(el, config);
    return S.charts[key];
  }
  function dropChart(key) { if (S.charts[key]) { S.charts[key].destroy(); delete S.charts[key]; } }

  // ───────────────────────── data loading ─────────────────────────
  const drop = $('#drop'), fileIn = $('#file');
  drop.addEventListener('click', () => fileIn.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });
  fileIn.addEventListener('change', () => fileIn.files[0] && readFile(fileIn.files[0]));
  function readFile(f) {
    const r = new FileReader();
    r.onload = () => loadText(String(r.result), f.name, { auto: true });
    r.onerror = () => msg('อ่านไฟล์ไม่ได้', true);
    r.readAsText(f);
  }
  $('#pasteBtn').addEventListener('click', () => {
    const t = $('#paste').value;
    if (!t.trim()) return msg('ยังไม่ได้ paste ข้อมูล', true);
    loadText(t, 'ข้อมูลที่ paste', { auto: true });
  });
  // Ctrl+V anywhere on the page (outside form fields) loads the table straight away.
  document.addEventListener('paste', (e) => {
    const el = e.target;
    const inField = el && el.closest && el.closest('input, select, textarea, [contenteditable]');
    if (inField && el.id !== 'paste') return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text || text.split(/\r?\n/).filter((l) => l.trim()).length < 10) {
      if (!inField) msg('ข้อมูลที่ paste มีน้อยเกินไป ให้ copy ทั้งตาราง (อย่างน้อย 10 แถว) จาก Excel', true);
      return;
    }
    e.preventDefault();
    $('#paste').value = '';
    if (currentTab !== 'data') showTab('data');
    loadText(text, 'ข้อมูลที่ paste', { auto: true });
  });
  const samples = window.PID_SAMPLES || [];
  const sampleSel = $('#sampleSel');
  sampleSel.innerHTML = samples.length
    ? samples.map((s, i) => `<option value="${i}">${esc(s.meta.tag)} · ${esc(s.meta.note)}</option>`).join('')
    : '<option>ไม่มีข้อมูลตัวอย่างในไฟล์นี้</option>';
  $('#sampleBtn').disabled = !samples.length;
  $('#sampleBtn').addEventListener('click', () => {
    const s = samples[+sampleSel.value];
    if (!s) return;
    const m = s.meta;
    store.set('pidtuner:cfg:' + m.tag, {
      tag: m.tag, loopType: m.loopType, sl: m.sl, sh: m.sh, unit: m.unit, Ts: m.Ts, alg: 'pid', act: 'rev',
      PB: m.current ? m.current.PB : '', TI: m.current ? m.current.TI : '', TD: m.current ? m.current.TD : '',
    });
    loadText(s.text, s.file + ' (ตัวอย่างจำลอง)');
  });
  function msg(t, bad) { const el = $('#loadMsg'); el.textContent = t; el.style.color = bad ? 'var(--critical)' : ''; }

  function loadText(text, name, opts = {}) {
    let table;
    try { table = C.parseTable(text); } catch (e) { return msg('อ่านข้อมูลไม่ได้: ' + e.message, true); }
    if (table.rows.length < 10) return msg('ข้อมูลน้อยเกินไป (ต้องมีอย่างน้อย 10 แถว)', true);
    S.table = table; S.fileName = name;
    S.map = C.guessColumns(table);
    const label = (i) => (S.map.headerNames && S.map.headerNames[i]) || table.headers[i];
    const options = ['<option value="-1">(ไม่มี)</option>'].concat(table.headers.map((h, i) => `<option value="${i}">${esc(label(i))}</option>`)).join('');
    for (const [id, key] of [['colTime', 'time'], ['colPV', 'pv'], ['colSP', 'sp'], ['colOP', 'op'], ['colMode', 'mode']]) {
      $('#' + id).innerHTML = options;
      $('#' + id).value = String(S.map[key]);
    }
    $('#dateOrder').value = C.detectDateOrder(table.rows.slice(0, 500).map((r) => r[S.map.time]));
    $('#mapCard').hidden = false;
    msg(`โหลด "${name}" แล้ว: ${table.rows.length.toLocaleString()} แถว, ${table.headers.length} คอลัมน์ (ตัวคั่น ${table.delimiter === '\t' ? 'tab' : `"${table.delimiter}"`}${table.decimalComma ? ', ทศนิยมแบบ comma' : ''})`);
    const pvHead = label(S.map.pv) || '';
    const tag = C.loopTagFromHeader(pvHead);
    loadCfgFor(tag);
    rebuild();
    if (!opts.auto || !S.rs) return;
    if (!S.slGuessed && S.cfg.sh > S.cfg.sl) {
      // known tag: settings remembered → go straight to the analysis
      msg(`โหลด ${tag || 'ข้อมูล'} แล้ว ใช้ค่าตั้ง loop ที่จำไว้ (แก้ได้ใน Tab 1)`);
      showTab('health');
    } else {
      $('#cfgCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#cfgHint').textContent = `ครั้งแรกของ ${tag || 'tag นี้'}: กรอก SL/SH และ PB/TI/TD จากหน้า tuning บน DCS ครั้งเดียว แอปจะจำไว้ ครั้งหน้า paste แล้วไปหน้าวิเคราะห์ได้ทันที`;
    }
  }
  ['colTime', 'colPV', 'colSP', 'colOP', 'colMode', 'dateOrder'].forEach((id) => $('#' + id).addEventListener('change', () => {
    S.map = { time: +$('#colTime').value, pv: +$('#colPV').value, sp: +$('#colSP').value, op: +$('#colOP').value, mode: +$('#colMode').value };
    rebuild();
  }));

  function rebuild() {
    const warn = $('#dataWarn');
    warn.innerHTML = '';
    if (S.map.time < 0 || S.map.pv < 0) { warn.innerHTML = '<p class="pill warn">ต้องเลือก column Timestamp และ PV</p>'; return; }
    S.ds = C.buildDataset(S.table, S.map, { dateOrder: $('#dateOrder').value });
    if (S.ds.t.length < 10) { warn.innerHTML = '<p class="pill warn">อ่าน timestamp ไม่ได้ ลองเปลี่ยน "รูปแบบวันที่" หรือเลือก column เวลาใหม่</p>'; return; }
    S.rs = C.resample(S.ds, 0);
    const n = S.rs.t.length, span = S.rs.t[n - 1];
    const st = S.ds.stats;
    const comp = C.compressionCheck(S.ds.pv);
    $('#dataInfo').innerHTML = [
      ['ช่วงเวลา', `${fmtTime(0)} → ${fmtTime(span)} (${fmtDur(span)})`],
      ['Sample interval', `${fmtSig(S.rs.dtData)} s${Math.abs(S.rs.dt - S.rs.dtData) > 1e-6 ? ` → resample ${fmtSig(S.rs.dt)} s` : ''}`],
      ['จำนวนจุด', `${n.toLocaleString()} จุด`],
      ['ค่าเสีย (Bad, I/O Timeout ฯลฯ)', `${st.badValues.toLocaleString()} แถว`],
      ['timestamp อ่านไม่ได้ / ซ้ำ', `${st.badTime} / ${st.duplicates}`],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const w = [];
    if (comp.suspicious) w.push(`PV มีค่าซ้ำ ${(comp.flatFrac * 100).toFixed(0)}% / เป็นเส้นตรง ${(comp.linFrac * 100).toFixed(0)}% ของข้อมูล ซึ่งเป็นลักษณะของ PI compression หรือ interpolation ควร export แบบ Sampled Data ที่ interval สั้นลง (≤ 1/5 ของ time constant) เพราะ compression บัง noise และ stiction ได้`);
    if (S.map.sp < 0) w.push('ไม่มี column SP จะวิเคราะห์ error ไม่ได้');
    if (S.map.op < 0) w.push('ไม่มี column OP/MV จะหา model และวิเคราะห์ stiction ไม่ได้');
    if (S.map.mode < 0) w.push('ไม่มี column MODE จะถือว่าข้อมูลทั้งหมดเป็น closed-loop');
    if (S.ds.modeIgnored) w.push('column MODE ไม่มีค่า AUT/MAN/CAS (เช่น "Tag not found" จาก PI DataLink) จึงไม่ใช้ และถือว่าข้อมูลทั้งหมดเป็น closed-loop');
    if (S.ds.spConstant !== null) {
      const [lo, hi] = C.minmax(S.ds.pv);
      if (S.ds.spConstant < lo || S.ds.spConstant > hi) w.push(`SP/SV คงที่ที่ ${S.ds.spConstant} ตลอดช่วง และไม่อยู่ในช่วงของ PV เลย อาจไม่ใช่ SV ของ loop นี้ (ตรวจชื่อ tag) ผล Error/Offset ใน Loop Health จะไม่ถูกต้อง`);
    }
    warn.innerHTML = w.map((t) => `<p class="pill warn" style="display:block;border-radius:8px;margin:8px 0 0;padding:6px 10px">${esc(t)}</p>`).join('');

    if (S.slGuessed || !isNum(S.cfg.sl) || !isNum(S.cfg.sh)) guessRange();
    $('#cfgCard').hidden = false;
    $('#overviewCard').hidden = false;
    S.healthRange = null; S.health = null; S.fitRange = null; S.fit = null;
    if (S.modelSource === 'fit') { S.model = null; S.modelSource = null; }
    S.tune = null;
    enableTabs();
    renderOverview();
    updateCfgHint();
    const noStep = S.rs.hasOP && detectSteps().length === 0;
    $('#noStepHint').textContent = noStep ? 'ข้อมูลนี้ไม่มี step test (MV ไม่ได้ถูกขยับใน MAN) จึงหาค่า tuning ไม่ได้ ใช้ Loop Health ได้' : '';
  }

  // ───────────────────────── loop config ─────────────────────────
  const cfgIds = { tag: 'cfgTag', loopType: 'cfgType', sl: 'cfgSL', sh: 'cfgSH', unit: 'cfgUnit', PB: 'cfgPB', TI: 'cfgTI', TD: 'cfgTD', Ts: 'cfgTs', alg: 'cfgAlg', act: 'cfgAct' };
  const numKeys = ['sl', 'sh', 'PB', 'TI', 'TD', 'Ts'];
  function loadCfgFor(tag) {
    const saved = (tag && store.get('pidtuner:cfg:' + tag)) || null;
    const type = C.guessLoopType(tag);
    const c = saved || { tag, loopType: type, sl: '', sh: '', unit: '', PB: '', TI: '', TD: '', Ts: 1, alg: 'pid', act: '' };
    for (const [k, id] of Object.entries(cfgIds)) $('#' + id).value = c[k] ?? '';
    S.slGuessed = !saved || c.sl === '' || c.sh === '';
    readCfg();
  }
  function readCfg() {
    const c = {};
    for (const [k, id] of Object.entries(cfgIds)) {
      const v = $('#' + id).value;
      c[k] = numKeys.includes(k) ? (v === '' ? NaN : Number(v)) : v;
    }
    if (!(c.Ts > 0)) c.Ts = 1;
    S.cfg = c;
    return c;
  }
  function guessRange() {
    const [lo, hi] = C.minmax(S.rs.pv);
    const t = Ch.niceTicks(lo, hi, 4);
    const sl = Math.floor(lo / t.step) * t.step, sh = Math.ceil(hi / t.step) * t.step;
    $('#cfgSL').value = +sl.toPrecision(10);
    $('#cfgSH').value = +(sh > sl ? sh : sl + 1).toPrecision(10);
    S.slGuessed = true;
    readCfg();
  }
  function updateCfgHint() {
    const c = S.cfg;
    const h = [];
    if (S.slGuessed) h.push('⚠ SL/SH เดาจากข้อมูล ให้ใส่ค่า range จริงของ tag จาก DCS เพราะใช้แปลง gain เป็น PB');
    if (!(c.sh > c.sl)) h.push('⚠ SH ต้องมากกว่า SL');
    if (!isNum(c.PB)) h.push('ใส่ค่า PB/TI/TD ปัจจุบันเพื่อเทียบกับค่าที่แนะนำ');
    $('#cfgHint').textContent = h.join(' · ');
  }
  let cfgTimer = null;
  Object.values(cfgIds).forEach((id) => $('#' + id).addEventListener('input', () => {
    if (id === 'cfgSL' || id === 'cfgSH') S.slGuessed = false;
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(onCfgChange, 250);
  }));
  function onCfgChange() {
    const prevType = S.cfg.loopType;
    const c = readCfg();
    if (c.tag) store.set('pidtuner:cfg:' + c.tag, Object.fromEntries(Object.keys(cfgIds).map((k) => [k, isNum(c[k]) || !numKeys.includes(k) ? c[k] : ''])));
    updateCfgHint();
    if (!S.rs) return;
    renderOverview();
    S.health = null;
    if (prevType !== c.loopType && S.modelSource === 'fit') S.tune = null;
    if (S.fitRange) runFit(false);
    if (currentTab === 'health') renderHealth();
    if (currentTab === 'model') enterModel();
    if (currentTab === 'tune') enterTune();
  }
  const pct = (v) => ((v - S.cfg.sl) / (S.cfg.sh - S.cfg.sl)) * 100;
  const eng = (p) => S.cfg.sl + (p / 100) * (S.cfg.sh - S.cfg.sl);
  const unit = () => S.cfg.unit || 'eng. unit';

  // ───────────────────────── overview ─────────────────────────
  function trendPanes(extraPv = []) {
    const rs = S.rs;
    return [
      { label: `PV / SP (${unit()})`, height: 190, series: [
        { name: 'PV', y: rs.pv, color: '--series-1' },
        ...(rs.hasSP ? [{ name: 'SP', y: rs.sp, color: '--ref', dash: true, width: 1.5 }] : []),
        ...extraPv,
      ] },
      ...(rs.hasOP ? [{ label: 'OP / MV (%)', height: 130, series: [{ name: 'OP', y: rs.op, color: '--series-2' }] }] : []),
    ];
  }
  function trendLegend(el, extra = []) {
    legend(el, [{ name: 'PV', color: '--series-1' }, ...(S.rs.hasSP ? [{ name: 'SP', color: '--ref', dash: true }] : []), ...extra, ...(S.rs.hasOP ? [{ name: 'OP (กราฟล่าง)', color: '--series-2' }] : [])]);
  }
  function renderOverview() {
    trendLegend($('#ovLegend'));
    chart('ov', $('#ovChart'), { x: S.rs.t, panes: trendPanes(), xFormat: fmtTime, xTickFormat: tickTime, mode: 'zoom', ariaLabel: 'แนวโน้ม PV, SP และ OP' });
  }

  // ───────────────────────── health ─────────────────────────
  function idxRange(range) {
    const t = S.rs.t;
    if (!range) return [0, t.length];
    const lb = (x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
    return [lb(range[0]), Math.min(t.length, lb(range[1]) + 1)];
  }
  function subDataset(i0, i1) {
    const rs = S.rs;
    return {
      t0: rs.t0, dt: rs.dt, hasSP: rs.hasSP, hasOP: rs.hasOP,
      t: rs.t.subarray(i0, i1), pv: rs.pv.subarray(i0, i1), sp: rs.sp.subarray(i0, i1), op: rs.op.subarray(i0, i1),
      mode: rs.mode ? rs.mode.slice(i0, i1) : null,
    };
  }
  function computeHealth() {
    if (!(S.cfg.sh > S.cfg.sl)) return null;
    const [i0, i1] = idxRange(S.healthRange);
    const sub = subDataset(i0, i1);
    const h = C.loopHealth(sub, { sl: S.cfg.sl, sh: S.cfg.sh, loopType: S.cfg.loopType });
    h.range = [i0, i1];
    return h;
  }
  const ICON = { good: '✓', warn: '!', bad: '✕', na: '–' };
  const STATUS_TXT = { good: 'ปกติ', warn: 'ควรตรวจ', bad: 'มีปัญหา', na: 'ไม่มีข้อมูล' };
  function statusHTML(f) {
    return `<div class="status ${f.status}"><span class="ico" aria-hidden="true">${ICON[f.status]}</span><div>
      <div class="head"><b>${esc(f.label)}</b><span class="val">${esc(f.value)}</span><span class="tag">${STATUS_TXT[f.status]}</span></div>
      <p>${esc(f.msg)}</p></div></div>`;
  }
  function renderHealth() {
    if (!S.rs) return;
    S.health = computeHealth();
    const [i0, i1] = S.health ? S.health.range : [0, S.rs.t.length];
    $('#hRangeLabel').textContent = S.healthRange ? `${fmtTime(S.rs.t[i0])} → ${fmtTime(S.rs.t[i1 - 1])}` : 'ทั้งหมด';
    trendLegend($('#hLegend'));
    chart('health', $('#hChart'), {
      x: S.rs.t, panes: trendPanes(), xFormat: fmtTime, xTickFormat: tickTime, mode: 'select',
      selection: S.healthRange, keepView: true,
      onSelect: (a, b) => { S.healthRange = [a, b]; renderHealth(); },
    });
    if (!S.health) { $('#hList').innerHTML = '<div class="empty">ต้องตั้งค่า SL/SH ให้ถูกต้องก่อน</div>'; return; }
    $('#hList').innerHTML = S.health.findings.map(statusHTML).join('');
    // XY
    if (S.rs.hasOP) {
      const step = Math.max(1, Math.floor((i1 - i0) / 20000));
      const xs = [], ys = [], idx = [];
      for (let i = i0; i < i1; i += step) { xs.push(S.rs.op[i]); ys.push(S.rs.pv[i]); idx.push(i); }
      chart('xy', $('#xyChart'), { x: xs, y: ys, xLabel: 'OP (%)', yLabel: `PV (${unit()})`, color: '--series-1', height: 300, tipHead: (k) => fmtTime(S.rs.t[idx[k]]), ariaLabel: 'กราฟ OP เทียบ PV' }, 'xy');
    }
    const st = S.health.metrics.stiction;
    $('#ccfCard').hidden = !st;
    if (st) {
      const lagsS = st.lags.map((k) => k * S.rs.dt);
      chart('ccf', $('#ccfChart'), {
        x: lagsS, xType: 'number', xLabel: 'lag (s)', xFormat: (v) => `lag ${fmtSig(v)} s`,
        panes: [{ label: 'r(OP, PV)', height: 170, zeroLine: true, yMin: -1, yMax: 1, series: [{ name: 'CCF', y: st.r, color: '--series-1', digits: 3 }] }],
        mode: 'zoom', ariaLabel: 'Cross-correlation ระหว่าง OP และ PV',
      });
    }
  }
  $('#hAll').addEventListener('click', () => { S.healthRange = null; S.charts.health && S.charts.health.setSelection(null); renderHealth(); });

  // ───────────────────────── model ─────────────────────────
  function modelType() {
    const v = $('#mType').value;
    return v === 'auto' ? (S.cfg.loopType === 'level' ? 'integrating' : 'fopdt') : v;
  }
  let steps = [];
  function enterModel() {
    if (!S.rs) return;
    if (!S.rs.hasOP) {
      $('#fitOut').innerHTML = '<div class="empty">ต้องมี column OP/MV จึงจะหา model ได้</div>';
    }
    steps = detectSteps();
    const list = $('#stepList');
    list.innerHTML = steps.length
      ? `<span class="hint">พบ OP step ${steps.length} ครั้ง:</span> <button class="btn small" type="button" data-step="all">ทุก step</button>` +
        steps.slice(0, 12).map((s, k) => `<button class="btn small" type="button" data-step="${k}">#${k + 1} ${tickTime(S.rs.t[s.i], 1)} (${s.size > 0 ? '+' : ''}${s.size.toFixed(1)}%)</button>`).join('')
      : '<span class="hint">ไม่พบ OP step อัตโนมัติ ให้ลากเลือกช่วงบนกราฟเอง</span>';
    if (!S.fitRange && steps.length) S.fitRange = stepWindow('all');
    renderModelChart();
    if (S.fitRange && !S.fit) runFit(false);
    if (!S.fit && S.rs.hasOP) $('#fitOut').innerHTML = steps.length ? '<div class="empty">ยังไม่ได้เลือกช่วงข้อมูล</div>' : NO_STEP_HTML;
    renderManual();
    enableTabs();
  }
  const NO_STEP_HTML = `<div class="status warn" id="noStepBox"><span class="ico" aria-hidden="true">!</span><div>
    <div class="head"><b>ข้อมูลช่วงนี้ไม่มี step test</b></div>
    <p>ไม่พบช่วงที่ขยับ MV ใน MAN (loop อยู่ใน AUTO/CAS และ controller ขยับ MV เอง) จึงหา model และคำนวณค่า tuning ไม่ได้ ไม่ใช่แอปเสีย</p>
    <p>ใช้ <b>Loop Health</b> ดูสุขภาพ loop ได้เลย · ถ้าต้องการค่า PB/TI ที่แนะนำ ต้องมีข้อมูลช่วง step test หรือกรอก model จาก engineer ในกล่องด้านขวา</p>
    <p style="margin-top:8px"><button class="btn primary small" type="button" data-goto="health">ไป Loop Health</button></p></div></div>`;
  function detectSteps() {
    if (!S.rs || !S.rs.hasOP) return [];
    const opNoise = C.diffNoise(S.rs.op);
    return C.findSteps(S.rs.op, Math.max(0.5, 4 * (opNoise || 0)));
  }
  function stepWindow(k) {
    const t = S.rs.t, n = t.length;
    const modeAt = (i) => (S.rs.mode ? S.rs.mode[i] : null);
    if (k === 'all') {
      const a = steps[0].i, b = steps[steps.length - 1].i;
      const next = n - 1;
      let end = next;
      // stop at the end of the manual segment that contains the last step
      if (S.rs.mode && modeAt(b) === 'MAN') { end = b; while (end < n - 1 && modeAt(end + 1) === 'MAN') end++; }
      let start = a;
      if (S.rs.mode && modeAt(a) === 'MAN') { while (start > 0 && modeAt(start - 1) === 'MAN') start--; }
      const pre = Math.min(a - start, Math.round((steps.length > 1 ? steps[1].i - a : end - a) * 0.25));
      return [t[Math.max(0, a - Math.max(pre, 1))], t[end]];
    }
    const s = steps[k];
    const nextI = k + 1 < steps.length ? steps[k + 1].i : n - 1;
    const pre = Math.max(1, Math.round((nextI - s.i) * 0.2));
    return [t[Math.max(0, s.i - pre)], t[nextI]];
  }
  $('#stepList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    S.fitRange = stepWindow(b.dataset.step === 'all' ? 'all' : +b.dataset.step);
    runFit(true);
  });
  $('#mType').addEventListener('change', () => { if (S.fitRange) runFit(true); renderManual(); });

  function renderModelChart() {
    const overlay = new Float64Array(S.rs.t.length).fill(NaN);
    if (S.fit && S.fit.yfit) for (let k = 0; k < S.fit.yfit.length; k++) overlay[S.fit.i0 + k] = eng(S.fit.yfit[k]);
    trendLegend($('#mLegend'), S.fit ? [{ name: 'Model', color: '--series-3' }] : []);
    chart('model', $('#mChart'), {
      x: S.rs.t, panes: trendPanes(S.fit ? [{ name: 'Model', y: overlay, color: '--series-3' }] : []),
      xFormat: fmtTime, xTickFormat: tickTime, mode: 'select', selection: S.fitRange, keepView: true,
      onSelect: (a, b) => { S.fitRange = [a, b]; runFit(true); },
      ariaLabel: 'เลือกช่วง step test',
    });
  }

  function runFit(userAction) {
    if (!S.rs || !S.rs.hasOP || !S.fitRange || !(S.cfg.sh > S.cfg.sl)) return;
    const [i0, i1] = idxRange(S.fitRange);
    if (i1 - i0 < 20) { $('#fitOut').innerHTML = '<div class="empty">ช่วงที่เลือกสั้นเกินไป (ต้อง ≥ 20 จุด)</div>'; return; }
    const u = [], y = [];
    let firstBad = -1;
    for (let i = i0; i < i1; i++) {
      if (!isNum(S.rs.op[i]) || !isNum(S.rs.pv[i])) { if (firstBad < 0) firstBad = i; continue; }
      u.push(S.rs.op[i]); y.push(pct(S.rs.pv[i]));
    }
    const type = modelType();
    const U = Float64Array.from(u), Y = Float64Array.from(y);
    const fit = type === 'integrating' ? C.fitIntegrating(U, Y, S.rs.dt) : C.fitFOPDT(U, Y, S.rs.dt);
    fit.i0 = i0; fit.i1 = i0 + Y.length; fit.u = U; fit.y = Y;
    if (firstBad >= 0) fit.warnings.push('ช่วงที่เลือกมีค่าเสีย (Bad/gap) ถูกตัดออก ทำให้เวลาไม่ต่อเนื่อง ควรเลือกช่วงที่ข้อมูลครบ');
    if (S.rs.mode) {
      const closed = S.rs.mode.slice(i0, i1).filter((m) => m === 'AUT' || m === 'CAS').length;
      if (closed > 0.05 * (i1 - i0)) fit.warnings.push(`ช่วงนี้มี ${(closed / (i1 - i0) * 100).toFixed(0)}% ที่อยู่ใน AUTO/CAS ซึ่ง controller ขยับ OP เอง ทำให้ model อาจ bias ควรใช้ช่วง MAN`);
    }
    S.fit = fit;
    S.model = { type: fit.type, Kp: fit.Kp, tau: fit.tau, theta: fit.theta, Ki: fit.Ki, y0: fit.y0, ub: fit.ub };
    S.modelSource = 'fit';
    S.tune = null;
    enableTabs();
    renderFit();
    renderModelChart();
    renderManual();
    if (userAction && currentTab !== 'model') showTab('model');
  }

  function renderFit() {
    const f = S.fit;
    if (!f) return;
    const span = S.cfg.sh - S.cfg.sl;
    const rows = f.type === 'fopdt' ? [
      ['Process gain Kp', `${fmtSig(f.Kp)} %span/%OP`, `= ${fmtSig((f.Kp * span) / 100)} ${esc(unit())} ต่อ OP 1%`],
      ['Time constant τ', fmtSec(f.tau), ''],
      ['Dead time θ', fmtSec(f.theta), `θ/τ = ${fmtSig(f.theta / f.tau, 2)}`],
    ] : [
      ['Integrating gain Ki', `${fmtSig(f.Ki)} %span/s/%OP`, `ถ้า OP ห่างจุดสมดุล 1% level จะเปลี่ยน ${fmtSig(f.Ki * 60)} %span/นาที`],
      ['Dead time θ', fmtSec(f.theta), ''],
      ['OP จุดสมดุล (in = out)', `${fmtSig(f.ub)} %`, ''],
    ];
    rows.push(['R² (ความเข้ากัน)', fmtSig(f.r2, 3), f.r2 >= 0.9 ? 'ดี' : f.r2 >= 0.8 ? 'พอใช้' : 'ต่ำ'],
      ['SNR', isFinite(f.snr) ? fmtSig(f.snr, 2) : '∞', f.snr >= 10 ? 'ดี' : f.snr >= 5 ? 'พอใช้' : 'ต่ำ'],
      ['ช่วงข้อมูล', `${fmtTime(S.rs.t[f.i0])} → ${tickTime(S.rs.t[f.i1 - 1], 1)}`, fmtDur(S.rs.t[f.i1 - 1] - S.rs.t[f.i0])]);
    const gainSign = f.type === 'fopdt' ? f.Kp : f.Ki;
    const dir = gainSign > 0 ? 'Reverse' : 'Direct';
    $('#fitOut').innerHTML = `
      <table class="data"><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="hl">${r[1]}</td><td class="muted">${r[2]}</td></tr>`).join('')}</tbody></table>
      <p class="hint">Gain ${gainSign > 0 ? 'เป็นบวก (OP ขึ้น → PV ขึ้น)' : 'เป็นลบ (OP ขึ้น → PV ลง)'} จึงต้องใช้ <b>${dir} action</b>
      ${S.cfg.act && ((S.cfg.act === 'rev') !== (dir === 'Reverse')) ? '<span class="pill warn">ไม่ตรงกับที่ตั้งไว้ ตรวจ MV ว่าเป็นค่าที่ส่งไป valve จริงหรือไม่ (fail-open/close)</span>' : ''}</p>
      ${f.warnings.length ? `<ul class="notes">${f.warnings.map((w) => `<li><span class="pill warn">ระวัง</span> ${esc(w)}</li>`).join('')}</ul>` : '<p class="hint" style="color:var(--good-ink)">✓ ไม่พบข้อควรระวัง</p>'}`;
    // detail chart
    const tt = S.rs.t.subarray(f.i0, f.i1);
    const n = Math.min(tt.length, f.y.length);
    const meas = Float64Array.from({ length: n }, (_, k) => eng(f.y[k]));
    let mod = Float64Array.from({ length: n }, (_, k) => eng(f.yfit[k]));
    const items = [{ name: 'PV จริง', color: '--series-1' }, { name: 'Model (fit)', color: '--series-3' }];
    const series = [{ name: 'PV จริง', y: meas, color: '--series-1' }, { name: 'Model (fit)', y: mod, color: '--series-3' }];
    if (S.modelSource === 'manual') {
      const man = C.modelResponse(Object.assign({}, S.model, { y0: f.y0, ub: f.ub }), f.u, S.rs.dt);
      series.push({ name: 'Model (กรอกเอง)', y: Float64Array.from(man, eng), color: '--series-2', dash: true });
      items.push({ name: 'Model (กรอกเอง)', color: '--series-2', dash: true });
    }
    legend($('#fitLegend'), items);
    chart('fit', $('#fitChart'), {
      x: tt.subarray(0, n), xFormat: fmtTime, xTickFormat: tickTime, mode: 'zoom',
      panes: [
        { label: `PV (${unit()})`, height: 200, series },
        { label: 'OP / MV (%)', height: 110, series: [{ name: 'OP', y: f.u.subarray(0, n), color: '--series-2' }] },
      ],
      ariaLabel: 'เปรียบเทียบ model กับ PV จริง',
    });
  }

  function renderManual() {
    const type = S.model ? S.model.type : modelType();
    const m = S.model || {};
    const fields = type === 'fopdt'
      ? [['Kp', 'Kp (%span/%OP)', m.Kp], ['tau', 'τ (s)', m.tau], ['theta', 'θ (s)', m.theta]]
      : [['Ki', 'Ki (%span/s/%OP)', m.Ki], ['theta', 'θ (s)', m.theta]];
    $('#manualForm').innerHTML = `<label>Model<select id="manType"><option value="fopdt"${type === 'fopdt' ? ' selected' : ''}>FOPDT</option><option value="integrating"${type === 'integrating' ? ' selected' : ''}>Integrating</option></select></label>` +
      fields.map(([k, l, v]) => `<label>${l}<input data-mk="${k}" type="number" step="any" value="${isNum(v) ? +v.toPrecision(4) : ''}"></label>`).join('');
    $('#manType').addEventListener('change', () => { S.model = { type: $('#manType').value }; renderManual(); });
  }
  $('#manualBtn').addEventListener('click', () => {
    const type = $('#manType').value;
    const m = { type };
    for (const el of $$('#manualForm [data-mk]')) m[el.dataset.mk] = Number(el.value);
    const ok = type === 'fopdt' ? m.Kp && m.tau > 0 && m.theta >= 0 : m.Ki && m.theta >= 0;
    if (!ok) { alert('กรอกค่าให้ครบ (Kp/Ki ≠ 0, τ > 0, θ ≥ 0)'); return; }
    S.model = m; S.modelSource = 'manual'; S.tune = null;
    enableTabs();
    if (S.fit) renderFit();
    showTab('tune');
  });

  // ───────────────────────── tuning ─────────────────────────
  const lamToPos = (lam) => Math.round((1000 * Math.log(lam / S.tune.min)) / Math.log(S.tune.max / S.tune.min));
  const posToLam = (p) => S.tune.min * Math.pow(S.tune.max / S.tune.min, p / 1000);
  function enterTune() {
    if (!S.model) return;
    const m = S.model;
    if (!S.tune) {
      const d = C.defaultTuning(m, S.cfg.loopType, S.cfg.Ts);
      S.tune = { method: d.method, lam: d.lam, base: d.lam, min: d.min, max: d.max };
      const opMean = S.health && S.health.metrics.opMean;
      $('#sU0').value = +(Math.min(95, Math.max(5, isNum(opMean) ? opMean : S.rs && S.rs.hasOP ? C.mean(S.rs.op) : 50))).toFixed(1);
    }
    $('#tMethod').innerHTML = C.METHODS[m.type].map((x) => `<option value="${x.id}"${x.id === S.tune.method ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    computeTune();
  }
  $('#tMethod').addEventListener('change', () => { S.tune.method = $('#tMethod').value; computeTune(); });
  $('#tLam').addEventListener('input', () => { S.tune.lam = posToLam(+$('#tLam').value); computeTune(true); });
  $('#tLamNum').addEventListener('change', () => {
    const v = Number($('#tLamNum').value);
    if (v > 0) { S.tune.lam = v; S.tune.min = Math.min(S.tune.min, v); S.tune.max = Math.max(S.tune.max, v); computeTune(); }
  });
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    S.tune.lam = Math.min(S.tune.max, Math.max(S.tune.min, S.tune.base * Number(b.dataset.preset)));
    computeTune();
  }));
  ['sSp', 'sDist', 'sU0'].forEach((id) => $('#' + id).addEventListener('change', () => computeTune()));

  function interpOnto(tSrc, ySrc, tDst) {
    const out = new Float64Array(tDst.length).fill(NaN);
    let j = 0;
    for (let k = 0; k < tDst.length; k++) {
      const t = tDst[k];
      if (t > tSrc[tSrc.length - 1] + 1e-9) break;
      while (j < tSrc.length - 2 && tSrc[j + 1] < t) j++;
      const f = tSrc[j + 1] > tSrc[j] ? Math.min(1, Math.max(0, (t - tSrc[j]) / (tSrc[j + 1] - tSrc[j]))) : 0;
      out[k] = ySrc[j] + (ySrc[j + 1] - ySrc[j]) * f;
    }
    return out;
  }

  function computeTune(fromSlider) {
    const m = S.model, c = S.cfg, T = S.tune;
    const meta = C.METHODS[m.type].find((x) => x.id === T.method) || C.METHODS[m.type][0];
    T.method = meta.id;
    $('#tMethodNote').textContent = meta.note;
    $('#tLamLabel').textContent = `${meta.param} (วินาที) · ค่ายิ่งมาก loop ยิ่งนุ่มนวลและทนต่อ model ผิดพลาดมากขึ้น`;
    if (!fromSlider) $('#tLam').value = lamToPos(T.lam);
    $('#tLamNum').value = +T.lam.toPrecision(3);
    const ratio = [];
    if (m.theta > 0) ratio.push(`${fmtSig(T.lam / C.effDelay(m.theta, c.Ts), 2)}×θ`);
    if (m.type === 'fopdt') ratio.push(`${fmtSig(T.lam / m.tau, 2)}×τ`);
    $('#tLamRatio').textContent = ratio.length ? `= ${ratio.join(' = ')}` : '';

    const prop = C.tune(m, T.method, T.lam, c.Ts);
    const cur = isNum(c.PB) && c.PB > 0 ? C.fromCentum(c.PB, c.TI, c.TD) : null;
    const worstModel = Object.assign({}, m, m.type === 'fopdt' ? { Kp: m.Kp * 1.3 } : { Ki: m.Ki * 1.3 }, { theta: m.theta * 1.3 });
    const mg = { prop: C.margins(m, prop, c.Ts), worst: C.margins(worstModel, prop, c.Ts), cur: cur ? C.margins(m, cur, c.Ts) : null };
    const u0 = Number($('#sU0').value) || 50;
    const y0 = 50;
    const simT = C.suggestSimTime(m, cur ? [prop, cur] : [prop]);
    const simOpts = { Ts: c.Ts, T: simT, u0, y0, spStep: Number($('#sSp').value) || 0, spTime: simT * 0.03, distStep: Number($('#sDist').value) || 0, distTime: simT * 0.5, algorithm: c.alg };
    const sim = {
      prop: C.simulateClosedLoop(m, prop, simOpts),
      worst: C.simulateClosedLoop(m, prop, Object.assign({}, simOpts, { gainMult: 1.3, delayMult: 1.3 })),
      cur: cur ? C.simulateClosedLoop(m, cur, simOpts) : null,
    };
    S.result = { prop, cur, mg, sim, simOpts, method: meta, lam: T.lam };
    renderTuneOut();
    renderSim();
    enableTabs();
  }

  function renderTuneOut() {
    const { prop, cur, mg, sim, method } = S.result;
    const pc = C.toCentum(prop), cc = cur ? C.toCentum(cur) : null;
    const box = (label, v, unitTxt, curV) => `<div><small>${label}</small><span class="big">${v}</span> ${unitTxt}${cc ? `<small>ปัจจุบัน ${curV}</small>` : ''}</div>`;
    $('#tOut').innerHTML =
      box('PB', fmtSig(pc.PB), '%', cc && fmtSig(cc.PB)) +
      box('TI', fmtSig(pc.TI), 's', cc && (cc.TI ? fmtSig(cc.TI) : 'ไม่มี')) +
      box('TD', pc.TD ? fmtSig(pc.TD) : '0', 's', cc && fmtSig(cc.TD));
    const m = S.model;
    const g = m.type === 'fopdt' ? m.Kp : m.Ki;
    const dir = g > 0 ? 'Reverse' : 'Direct';
    $('#tDirection').innerHTML = `Control action: <b>${dir}</b> (gain ของ process ${g > 0 ? 'เป็นบวก' : 'เป็นลบ'}) · วิธี ${esc(method.name)} · ${esc(S.result.method.param)} = ${fmtSec(S.result.lam)}`;

    // guard rails and notes
    const notes = [];
    const push = (status, text) => notes.push({ status, text });
    for (const n of C.compareTuning(cur, prop)) push(n.status, n.msg);
    if (mg.prop.gm < 2 || mg.prop.ms > 2) push('bad', `ค่าแนะนำมี margin ต่ำ (GM ${fmtSig(mg.prop.gm, 2)}, Ms ${fmtSig(mg.prop.ms, 2)}) ควรเพิ่ม ${method.param}`);
    if (!mg.worst.stable || sim.worst.metrics.diverged || sim.worst.metrics.notSettled) push('bad', `ถ้า gain/dead time จริงมากกว่า model 30% loop จะแกว่งหรือไม่เสถียร ควรเพิ่ม ${method.param}`);
    else if (mg.worst.ms > 2) push('warn', `ถ้า gain/dead time จริงมากกว่า model 30% จะเริ่มแกว่ง (Ms ${fmtSig(mg.worst.ms, 2)}) ถ้าไม่มั่นใจใน model ให้เลือกแบบนุ่มนวลขึ้น`);
    if (cur && mg.cur && (mg.cur.gm < 1.7 || mg.cur.ms > 2)) push('warn', `ค่าปัจจุบันมี margin ต่ำ (GM ${fmtSig(mg.cur.gm, 2)}, Ms ${fmtSig(mg.cur.ms, 2)}) สอดคล้องกับ loop ที่แกว่งง่าย`);
    const st = S.health && S.health.metrics.stiction;
    if (st && st.verdict === 'likely') push('bad', 'Tab 2 พบข้อบ่งชี้ valve stiction ต้องแก้ valve ก่อน เพราะเปลี่ยน tuning ไม่ได้แก้ต้นเหตุ (ลด gain ได้แค่ช่วยให้แกว่งช้าลง)');
    if (prop.Td > 0) {
      const noise = S.health ? S.health.metrics.noise : C.diffNoise(Float64Array.from(S.rs.pv, pct));
      if (noise > 0.2) push('warn', `PV noise ${fmtSig(noise, 2)} %span ค่อนข้างสูงสำหรับการใช้ TD ควรมี PV filter หรือใช้ PI แทน`);
      push('info', 'CENTUM มีหลายรูปแบบ derivative ให้ตรวจการตั้งค่า derivative gain/filter ของ block ก่อนใช้ TD');
    }
    if (m.theta > 0 && S.cfg.Ts > m.theta) push('warn', `Control period (${S.cfg.Ts} s) ยาวกว่า dead time (${fmtSig(m.theta)} s) จึงจำกัดความเร็วที่ loop ทำได้`);
    if (m.type === 'integrating') {
      const pk = sim.prop.metrics.peakDist;
      push('info', `Averaging level: ถ้า flow เปลี่ยนเทียบเท่า OP ${S.result.simOpts.distStep}% level จะเบี่ยงสูงสุด ≈ ${fmtSig(pk, 2)} %span (${fmtSig((pk * (S.cfg.sh - S.cfg.sl)) / 100, 2)} ${esc(unit())}) ตรวจว่าไม่ชน alarm high/low`);
    }
    if (S.cfg.alg === 'pid' && prop.Kc > 1) push('info', 'ถ้า operator เปลี่ยน SV บ่อย อัลกอริทึม I-PD จะไม่มี OP กระชากตอนเปลี่ยน SV (ค่า PB/TI เหมือนเดิม)');
    if (S.modelSource === 'fit' && S.fit && S.fit.r2 < 0.8) push('bad', `model fit ต่ำ (R² ${fmtSig(S.fit.r2, 2)}) ค่าที่แนะนำจึงเชื่อถือได้น้อย`);
    if (S.slGuessed) push('warn', 'SL/SH ยังเป็นค่าที่เดาจากข้อมูล ค่า PB จะผิดถ้า range ไม่ตรงกับ DCS');
    push('info', 'แนะนำให้เปลี่ยนทีละขั้นและเฝ้าดู trend อย่างน้อย 3–5 เท่าของ TI หลังเปลี่ยน');
    const icon = { bad: '✕', warn: '!', info: 'i' };
    const cls = { bad: 'bad', warn: 'warn', info: 'na' };
    $('#tNotes').innerHTML = notes.map((n) => `<li class="status ${cls[n.status]}" style="list-style:none;margin:6px 0 0 -18px"><span class="ico" aria-hidden="true">${icon[n.status]}</span><div><p style="margin:0">${esc(n.text)}</p></div></li>`).join('');
    S.result.notes = notes;

    const banner = $('#tuneBanner');
    banner.innerHTML = st && st.verdict === 'likely'
      ? '<div class="banner bad"><b>สงสัย valve stiction:</b> ผลจาก Tab 2 ชี้ว่า valve ติด ควรแจ้ง maintenance/instrument ตรวจ valve (positioner, packing) ก่อนเปลี่ยน tuning</div>' : '';

    // comparison table
    const col = (x) => (x ? x : null);
    const mt = (s) => s && s.metrics;
    const rows = [
      ['PB (%)', cc && fmtSig(cc.PB), fmtSig(pc.PB), fmtSig(pc.PB)],
      ['TI (s)', cc && (cc.TI ? fmtSig(cc.TI) : 'ไม่มี'), fmtSig(pc.TI), fmtSig(pc.TI)],
      ['TD (s)', cc && fmtSig(cc.TD), fmtSig(pc.TD), fmtSig(pc.TD)],
      ['Gain margin', col(mg.cur) && fmtSig(mg.cur.gm, 2), fmtSig(mg.prop.gm, 2), fmtSig(mg.worst.gm, 2)],
      ['Phase margin (°)', col(mg.cur) && fmtSig(mg.cur.pm, 2), fmtSig(mg.prop.pm, 2), fmtSig(mg.worst.pm, 2)],
      ['Ms', col(mg.cur) && fmtSig(mg.cur.ms, 2), fmtSig(mg.prop.ms, 2), fmtSig(mg.worst.ms, 2)],
      ['Overshoot SP step (%)', mt(sim.cur) && fmtOrDiv(sim.cur, (x) => fmtSig(x.overshoot, 2)), fmtOrDiv(sim.prop, (x) => fmtSig(x.overshoot, 2)), fmtOrDiv(sim.worst, (x) => fmtSig(x.overshoot, 2))],
      ['Settling time ±2%', mt(sim.cur) && fmtOrDiv(sim.cur, (x) => fmtDurInf(x.settle)), fmtOrDiv(sim.prop, (x) => fmtDurInf(x.settle)), fmtOrDiv(sim.worst, (x) => fmtDurInf(x.settle))],
      ['OP กระโดดตอน SP step (%)', mt(sim.cur) && fmtOrDiv(sim.cur, (x) => fmtSig(x.opPeakSp, 2)), fmtOrDiv(sim.prop, (x) => fmtSig(x.opPeakSp, 2)), fmtOrDiv(sim.worst, (x) => fmtSig(x.opPeakSp, 2))],
      ['PV เบี่ยงสูงสุดจาก load (%span)', mt(sim.cur) && fmtOrDiv(sim.cur, (x) => fmtSig(x.peakDist, 2)), fmtOrDiv(sim.prop, (x) => fmtSig(x.peakDist, 2)), fmtOrDiv(sim.worst, (x) => fmtSig(x.peakDist, 2))],
      ['เวลากลับเข้า SP หลัง load', mt(sim.cur) && fmtOrDiv(sim.cur, (x) => fmtDurInf(x.recover)), fmtOrDiv(sim.prop, (x) => fmtDurInf(x.recover)), fmtOrDiv(sim.worst, (x) => fmtDurInf(x.recover))],
    ];
    S.result.table = rows;
    $('#tTable').innerHTML = `<thead><tr><th></th><th>ปัจจุบัน</th><th>แนะนำ</th><th>แนะนำ ถ้า gain และ θ +30%</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1] ?? '—'}</td><td class="hl">${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody>`;
  }
  function fmtOrDiv(sim, f) {
    if (!sim) return null;
    if (sim.metrics.diverged) return 'ไม่เสถียร';
    const s = f(sim.metrics);
    return sim.metrics.notSettled ? `${s} (ไม่ settle)` : s;
  }
  function tickDur(v, step) {
    if (step >= 3600) return `${+(v / 3600).toFixed(2)} h`;
    if (step >= 60) return `${+(v / 60).toFixed(1)} min`;
    return `${+v.toFixed(1)} s`;
  }
  function fmtDurInf(v) { return v === Infinity ? 'ไม่ settle' : fmtDur(v); }

  function simPanes(target) {
    const { sim } = S.result;
    const t = Float64Array.from(sim.prop.t);
    const E = (arr) => Float64Array.from(arr, eng);
    const pv = [{ name: 'SP', y: E(sim.prop.sp), color: '--ref', dash: true, width: 1.5 }];
    const op = [];
    const items = [{ name: 'SP', color: '--ref', dash: true }];
    if (sim.cur) {
      pv.push({ name: 'ปัจจุบัน', y: E(interpOnto(sim.cur.t, sim.cur.pv, t)), color: '--series-2' });
      op.push({ name: 'OP ปัจจุบัน', y: interpOnto(sim.cur.t, sim.cur.op, t), color: '--series-2' });
      items.push({ name: 'ค่าปัจจุบัน', color: '--series-2' });
    }
    pv.push({ name: 'แนะนำ', y: E(sim.prop.pv), color: '--series-1' });
    pv.push({ name: 'แนะนำ (gain/θ +30%)', y: E(interpOnto(sim.worst.t, sim.worst.pv, t)), color: '--series-1', alpha: 0.4, width: 1.5 });
    op.push({ name: 'OP แนะนำ', y: Float64Array.from(sim.prop.op), color: '--series-1' });
    items.push({ name: 'ค่าแนะนำ', color: '--series-1' }, { name: 'ค่าแนะนำ ถ้า gain/θ +30%', color: '--series-1', alpha: 0.4, thin: true });
    if (target) legend(target, items);
    const tRel = Float64Array.from(t);
    return { x: tRel, panes: [{ label: `PV (${unit()})`, height: 200, series: pv }, { label: 'OP / MV (%)', height: 130, series: op }] };
  }
  function renderSim() {
    const p = simPanes($('#simLegend'));
    chart('sim', $('#simChart'), Object.assign(p, { xType: 'number', xFormat: (v) => `t = ${fmtDur(v)}`, xTickFormat: tickDur, mode: 'zoom', ariaLabel: 'ผลจำลอง closed-loop' }));
  }

  // ───────────────────────── report ─────────────────────────
  function tagName() { return $('#hideTag').checked ? 'LOOP-A' : (S.cfg.tag || '(ไม่ระบุ tag)'); }
  function renderReport() {
    const body = $('#reportBody');
    if (!S.rs) { body.innerHTML = '<div class="empty">ยังไม่มีข้อมูล</div>'; return; }
    if (!S.health) S.health = computeHealth();
    if (S.model && !S.result) { enterTune(); }
    const c = S.cfg, rs = S.rs;
    const now = new Date();
    const typeTH = { flow: 'Flow', pressure: 'Pressure', temperature: 'Temperature', level: 'Level' }[c.loopType];
    let h = `<h1>รายงาน Loop Tuning: ${esc(tagName())}</h1>
      <p class="hint">สร้างเมื่อ ${now.toLocaleString('th-TH')} · ข้อมูล ${fmtTime(0)} → ${fmtTime(rs.t[rs.t.length - 1])} · ${esc($('#hideTag').checked ? 'source hidden' : S.fileName)}</p>
      <div class="banner"><b>เอกสารประกอบการพิจารณาเท่านั้น</b> ค่าที่แนะนำต้องผ่านการทบทวนของ control engineer และ MOC ก่อนนำไปใช้</div>
      <h2>1. ข้อมูล loop</h2>
      <dl class="kv"><dt>ชนิด</dt><dd>${typeTH}</dd><dt>PV range</dt><dd>${fmtSig(c.sl)} – ${fmtSig(c.sh)} ${esc(unit())}${S.slGuessed ? ' (เดาจากข้อมูล)' : ''}</dd>
      <dt>ค่าปัจจุบัน</dt><dd>${isNum(c.PB) ? `PB ${fmtSig(c.PB)}%, TI ${c.TI ? fmtSig(c.TI) + ' s' : 'ไม่มี'}, TD ${fmtSig(c.TD || 0)} s` : 'ไม่ระบุ'}</dd>
      <dt>Control period / algorithm</dt><dd>${c.Ts} s / ${esc($('#cfgAlg').selectedOptions[0].textContent)}</dd></dl>`;
    if (S.health) {
      const hr = S.health.range;
      h += `<h2>2. Loop health</h2><p class="hint">ช่วง ${fmtTime(rs.t[hr[0]])} → ${fmtTime(rs.t[hr[1] - 1])}</p><div class="status-list">${S.health.findings.map(statusHTML).join('')}</div>`;
    }
    if (S.model) {
      const m = S.model;
      h += `<h2>3. Process model (${S.modelSource === 'manual' ? 'กรอกเอง' : 'fit จาก step test'})</h2>`;
      h += m.type === 'fopdt'
        ? `<dl class="kv"><dt>Kp</dt><dd>${fmtSig(m.Kp)} %span/%OP</dd><dt>τ</dt><dd>${fmtSec(m.tau)}</dd><dt>θ</dt><dd>${fmtSec(m.theta)}</dd>`
        : `<dl class="kv"><dt>Ki</dt><dd>${fmtSig(m.Ki)} %span/s/%OP</dd><dt>θ</dt><dd>${fmtSec(m.theta)}</dd>`;
      if (S.modelSource === 'fit' && S.fit) h += `<dt>R² / SNR</dt><dd>${fmtSig(S.fit.r2, 3)} / ${isFinite(S.fit.snr) ? fmtSig(S.fit.snr, 2) : '∞'}</dd>`;
      h += '</dl>';
      if (S.modelSource === 'fit' && S.fit && S.fit.warnings.length) h += `<ul class="notes">${S.fit.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
    }
    if (S.result) {
      const r = S.result;
      h += `<h2>4. ค่าที่แนะนำ (${esc(r.method.name)}, ${esc(r.method.param)} = ${fmtSec(r.lam)})</h2>
        <div class="scroll-x"><table class="data"><thead><tr><th></th><th>ปัจจุบัน</th><th>แนะนำ</th><th>แนะนำ ถ้า gain/θ +30%</th></tr></thead><tbody>
        ${r.table.map((row) => `<tr><td>${row[0]}</td><td>${row[1] ?? '—'}</td><td class="hl">${row[2]}</td><td>${row[3]}</td></tr>`).join('')}</tbody></table></div>
        <ul class="notes">${r.notes.map((n) => `<li>${n.status === 'bad' ? '✕ ' : n.status === 'warn' ? '! ' : ''}${esc(n.text)}</li>`).join('')}</ul>
        <h2>5. ผลจำลอง</h2><div class="legend" id="repLegend"></div><div id="repSim"></div>`;
    } else {
      h += '<p class="hint">ยังไม่มี model/tuning ทำ Tab 3 และ 4 เพื่อให้ report สมบูรณ์</p>';
    }
    h += `<h2>ลงนาม</h2><dl class="kv"><dt>จัดทำโดย</dt><dd>..............................................</dd><dt>ตรวจโดย (Control Eng.)</dt><dd>..............................................</dd><dt>MOC No.</dt><dd>..............................................</dd></dl>`;
    dropChart('rep');
    body.innerHTML = h;
    if (S.result) {
      const p = simPanes($('#repLegend'));
      chart('rep', $('#repSim'), Object.assign(p, { xType: 'number', xFormat: (v) => `t = ${fmtDur(v)}`, xTickFormat: tickDur, mode: 'zoom', ariaLabel: 'ผลจำลอง closed-loop' }));
    }
  }
  $('#hideTag').addEventListener('change', renderReport);
  $('#printBtn').addEventListener('click', () => window.print());
  $('#copyBtn').addEventListener('click', async () => {
    const text = reportText();
    try { await navigator.clipboard.writeText(text); $('#copyMsg').textContent = 'คัดลอกแล้ว'; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); $('#copyMsg').textContent = 'คัดลอกแล้ว'; } catch (e2) { $('#copyMsg').textContent = 'คัดลอกไม่ได้'; }
      ta.remove();
    }
    setTimeout(() => { $('#copyMsg').textContent = ''; }, 2500);
  });
  function reportText() {
    const c = S.cfg, L = [];
    L.push(`Loop tuning summary: ${tagName()} (${c.loopType})`);
    if (S.rs) L.push(`Data: ${fmtTime(0)} → ${fmtTime(S.rs.t[S.rs.t.length - 1])}, dt ${fmtSig(S.rs.dt)} s, PV range ${c.sl}–${c.sh} ${unit()}`);
    L.push(`Current: ${isNum(c.PB) ? `PB ${c.PB}%, TI ${c.TI || 0} s, TD ${c.TD || 0} s` : 'n/a'}; control period ${c.Ts} s; algorithm ${c.alg}`);
    if (S.health) { L.push('', 'Loop health:'); for (const f of S.health.findings) L.push(`- [${f.status}] ${f.label}: ${f.value} — ${f.msg}`); }
    if (S.model) {
      const m = S.model;
      L.push('', `Model (${S.modelSource}): ` + (m.type === 'fopdt' ? `FOPDT Kp=${fmtSig(m.Kp)} %span/%OP, tau=${fmtSig(m.tau)} s, theta=${fmtSig(m.theta)} s` : `Integrating Ki=${fmtSig(m.Ki)} %span/s/%OP, theta=${fmtSig(m.theta)} s`) + (S.fit && S.modelSource === 'fit' ? `, R2=${fmtSig(S.fit.r2, 3)}` : ''));
    }
    if (S.result) {
      const r = S.result;
      L.push('', `Proposed (${r.method.name}, ${r.method.param}=${fmtSig(r.lam)} s):`);
      for (const row of r.table) L.push(`- ${row[0]}: current ${row[1] ?? '—'} | proposed ${row[2]} | +30% gain/θ ${row[3]}`);
      L.push('', 'Notes:'); for (const n of r.notes) L.push(`- ${n.text}`);
    }
    L.push('', 'Advisory only — review with control engineer and MOC before changing DCS.');
    return L.join('\n');
  }

  applyTheme(theme);
  enableTabs();
})();
