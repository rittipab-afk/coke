/* PID Loop Tuner — lightweight canvas charts (no dependencies).
 * LineChart: stacked panes sharing one x axis (one y scale per pane — never dual-axis),
 *            crosshair tooltip, drag-to-zoom or drag-to-select, double-click to reset.
 * XYChart:   trajectory plot (e.g. OP vs PV) with nearest-point tooltip.
 */
(function (root) {
  'use strict';

  const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim() || '#888';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function niceTicks(lo, hi, target) {
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const s = niceStep(hi - lo, target);
    const out = [];
    for (let v = Math.ceil(lo / s) * s; v <= hi + s * 1e-9; v += s) out.push(+v.toPrecision(12));
    return { ticks: out, step: s };
  }
  const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  function timeTicks(lo, hi, target) {
    const raw = (hi - lo) / Math.max(1, target);
    const s = TIME_STEPS.find((v) => v >= raw) || Math.ceil(raw / 86400) * 86400;
    const out = [];
    for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) out.push(v);
    return { ticks: out, step: s };
  }
  function fmtNum(v, step) {
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  function setupCanvas(container, heightPx) {
    container.classList.add('chart');
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    container.append(canvas, tip);
    const ctx = canvas.getContext('2d');
    const size = { w: 0, h: heightPx, dpr: 1 };
    const resize = () => {
      size.w = Math.max(200, container.clientWidth);
      size.dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.w * size.dpr);
      canvas.height = Math.round(size.h * size.dpr);
      canvas.style.width = size.w + 'px';
      canvas.style.height = size.h + 'px';
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    };
    return { canvas, tip, ctx, size, resize };
  }

  function placeTip(tip, container, x, y) {
    tip.hidden = false;
    const cw = container.clientWidth;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > cw) left = x - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, y - th / 2) + 'px';
  }

  // ─────────────────────────── LineChart ───────────────────────────
  function LineChart(container, config) {
    const PAD_L = 56, PAD_R = 14, PAD_T = 22, GAP = 30, AXIS_H = 26;
    let cfg = config;
    let view = null;          // [x0, x1] visible range
    let selection = cfg.selection || null;
    let hoverX = null;
    let drag = null;
    const totalH = () => cfg.panes.reduce((s, p) => s + (p.height || 160), 0) + GAP * (cfg.panes.length - 1) + PAD_T + AXIS_H;
    const cv = setupCanvas(container, totalH());
    container.setAttribute('aria-label', cfg.ariaLabel || cfg.panes.map((p) => p.label).join(', '));

    const xs = () => cfg.x;
    const fullRange = () => {
      const x = xs();
      return [x[0], x[x.length - 1]];
    };
    const plotW = () => cv.size.w - PAD_L - PAD_R;
    const xToPx = (v) => PAD_L + ((v - view[0]) / (view[1] - view[0] || 1)) * plotW();
    const pxToX = (px) => view[0] + ((px - PAD_L) / plotW()) * (view[1] - view[0]);

    function paneLayout() {
      let y = PAD_T;
      return cfg.panes.map((p) => {
        const h = p.height || 160;
        const box = { top: y, bottom: y + h, pane: p };
        y += h + GAP;
        return box;
      });
    }

    function yRange(p, i0, i1) {
      if (isNum(p.yMin) && isNum(p.yMax)) return [p.yMin, p.yMax];
      let lo = Infinity, hi = -Infinity;
      for (const s of p.series) {
        const y = s.y;
        for (let i = i0; i <= i1; i++) { const v = y[i]; if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (isNum(p.yMin)) lo = Math.min(lo, p.yMin);
      if (isNum(p.yMax)) hi = Math.max(hi, p.yMax);
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
      return [lo - pad, hi + pad];
    }

    function draw() {
      const { ctx, size } = cv;
      const x = xs();
      if (!view) view = fullRange();
      ctx.clearRect(0, 0, size.w, size.h);
      const ink2 = css(container, '--text-secondary'), muted = css(container, '--text-muted');
      const grid = css(container, '--grid'), axis = css(container, '--axis');
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      const i0 = Math.max(0, lowerBound(x, view[0]) - 1), i1 = Math.min(x.length - 1, lowerBound(x, view[1]) + 1);
      const layout = paneLayout();
      const timeAxis = cfg.xType !== 'number';
      const xt = timeAxis ? timeTicks(view[0], view[1], plotW() / 110) : niceTicks(view[0], view[1], plotW() / 80);

      for (const box of layout) {
        const p = box.pane;
        const [lo, hi] = yRange(p, i0, i1);
        box.lo = lo; box.hi = hi;
        const yToPx = (v) => box.bottom - ((v - lo) / (hi - lo)) * (box.bottom - box.top);
        box.yToPx = yToPx;
        // grid + y ticks
        const yt = niceTicks(lo, hi, (box.bottom - box.top) / 40);
        ctx.lineWidth = 1;
        ctx.strokeStyle = grid;
        ctx.fillStyle = muted;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const v of yt.ticks) {
          const py = Math.round(yToPx(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(PAD_L, py); ctx.lineTo(size.w - PAD_R, py); ctx.stroke();
          ctx.fillText(fmtNum(v, yt.step), PAD_L - 6, py);
        }
        for (const v of xt.ticks) {
          const px = Math.round(xToPx(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(px, box.top); ctx.lineTo(px, box.bottom); ctx.stroke();
        }
        // zero / reference line
        if (p.zeroLine && lo < 0 && hi > 0) {
          ctx.strokeStyle = axis;
          const py = Math.round(yToPx(0)) + 0.5;
          ctx.beginPath(); ctx.moveTo(PAD_L, py); ctx.lineTo(size.w - PAD_R, py); ctx.stroke();
        }
        // baseline
        ctx.strokeStyle = axis;
        ctx.beginPath(); ctx.moveTo(PAD_L, box.bottom + 0.5); ctx.lineTo(size.w - PAD_R, box.bottom + 0.5); ctx.stroke();
        // pane label
        ctx.fillStyle = ink2;
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(p.label, PAD_L, box.top - 6);
        ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

        // selection band
        if (selection) {
          const a = Math.max(PAD_L, xToPx(selection[0])), b = Math.min(size.w - PAD_R, xToPx(selection[1]));
          if (b > a) {
            ctx.fillStyle = css(container, '--sel');
            ctx.fillRect(a, box.top, b - a, box.bottom - box.top);
          }
        }
        // series
        ctx.save();
        ctx.beginPath(); ctx.rect(PAD_L, box.top, plotW(), box.bottom - box.top); ctx.clip();
        for (const s of p.series) drawSeries(ctx, x, s, i0, i1, yToPx, container, xToPx, plotW());
        ctx.restore();
      }
      // x axis labels
      const last = layout[layout.length - 1];
      ctx.fillStyle = muted;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      let limit = size.w - PAD_R + 1;
      if (cfg.xLabel) {
        ctx.textAlign = 'right';
        ctx.fillText(cfg.xLabel, size.w - PAD_R, last.bottom + 6);
        limit = size.w - PAD_R - ctx.measureText(cfg.xLabel).width - 8;
        ctx.textAlign = 'center';
      }
      let prevRight = -Infinity;
      for (const v of xt.ticks) {
        const px = xToPx(v);
        if (px < PAD_L - 1) continue;
        const label = cfg.xTickFormat ? cfg.xTickFormat(v, xt.step) : fmtNum(v, xt.step);
        const half = ctx.measureText(label).width / 2;
        if (px + half > limit || px - half < prevRight + 8) continue;
        ctx.fillText(label, px, last.bottom + 6);
        prevRight = px + half;
      }
      // drag rectangle
      if (drag && Math.abs(drag.x1 - drag.x0) > 3) {
        ctx.fillStyle = css(container, '--sel');
        ctx.strokeStyle = css(container, '--accent');
        const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
        ctx.fillRect(a, PAD_T, b - a, last.bottom - PAD_T);
        ctx.strokeRect(a + 0.5, PAD_T + 0.5, b - a, last.bottom - PAD_T);
      }
      // crosshair
      if (hoverX !== null && !drag) {
        const idx = nearestIndex(hoverX);
        if (idx >= 0) {
          const px = Math.round(xToPx(x[idx])) + 0.5;
          ctx.strokeStyle = css(container, '--axis');
          ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, last.bottom); ctx.stroke();
          const surface = css(container, '--surface-1');
          for (const box of layout) for (const s of box.pane.series) {
            const v = s.y[idx];
            if (!isNum(v) || s.noDot) continue;
            const py = box.yToPx(v);
            ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fillStyle = css(container, s.color); ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = surface; ctx.stroke(); ctx.lineWidth = 1;
          }
          showTip(idx, px, layout);
        }
      } else cv.tip.hidden = true;
      container._layout = layout;
    }

    function nearestIndex(xv) {
      const x = xs();
      let i = lowerBound(x, xv);
      if (i > 0 && Math.abs(x[i - 1] - xv) < Math.abs(x[i] - xv)) i--;
      return i;
    }

    function showTip(idx, px, layout) {
      const x = xs();
      const rows = [];
      for (const box of layout) for (const s of box.pane.series) {
        const v = s.y[idx];
        if (s.noTip) continue;
        rows.push(`<div class="tip-row"><span class="key" style="background:${css(container, s.color)}${s.dash ? ';height:2px;border-top:2px dashed ' + css(container, s.color) + ';background:none' : ''}"></span><span>${s.name}</span><b>${isNum(v) ? (s.fmt ? s.fmt(v) : v.toFixed(s.digits ?? 2)) : '—'}</b></div>`);
      }
      cv.tip.innerHTML = `<div class="tip-head">${cfg.xFormat ? cfg.xFormat(x[idx]) : x[idx]}</div>${rows.join('')}`;
      placeTip(cv.tip, container, px, (layout[0].top + layout[layout.length - 1].bottom) / 2);
    }

    // pointer interaction
    const localX = (ev) => ev.clientX - cv.canvas.getBoundingClientRect().left;
    cv.canvas.addEventListener('pointerdown', (ev) => {
      const px = localX(ev);
      if (px < PAD_L || px > cv.size.w - PAD_R) return;
      drag = { x0: px, x1: px };
      cv.canvas.setPointerCapture(ev.pointerId);
    });
    cv.canvas.addEventListener('pointermove', (ev) => {
      const px = localX(ev);
      if (drag) { drag.x1 = Math.max(PAD_L, Math.min(cv.size.w - PAD_R, px)); }
      hoverX = px >= PAD_L && px <= cv.size.w - PAD_R ? pxToX(px) : null;
      draw();
    });
    cv.canvas.addEventListener('pointerleave', () => { if (!drag) { hoverX = null; draw(); } });
    cv.canvas.addEventListener('pointerup', () => {
      if (!drag) return;
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
      drag = null;
      if (b - a > 5) {
        const r = [pxToX(a), pxToX(b)];
        if ((cfg.mode || 'zoom') === 'select') {
          selection = r;
          if (cfg.onSelect) cfg.onSelect(r[0], r[1]);
        } else view = r;
      }
      draw();
    });
    cv.canvas.addEventListener('dblclick', () => { view = fullRange(); draw(); });

    const ro = new ResizeObserver(() => { cv.resize(); draw(); });
    ro.observe(container);
    cv.resize(); draw();

    return {
      update(next) {
        const keepView = next.keepView;
        cfg = Object.assign({}, cfg, next);
        if (!keepView) view = null;
        if ('selection' in next) selection = next.selection;
        cv.size.h = totalH();
        cv.resize(); draw();
      },
      setMode(m) { cfg.mode = m; },
      setSelection(r) { selection = r; draw(); },
      setView(r) { view = r; draw(); },
      resetZoom() { view = fullRange(); draw(); },
      redraw: draw,
      canvas: cv.canvas,
      destroy() { ro.disconnect(); container.innerHTML = ''; },
    };
  }

  function drawSeries(ctx, x, s, i0, i1, yToPx, container, xToPx, plotW) {
    const y = s.y;
    ctx.strokeStyle = css(container, s.color);
    ctx.lineWidth = s.width || 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.setLineDash(s.dash ? [6, 4] : []);
    ctx.beginPath();
    let pen = false;
    const perPx = (i1 - i0 + 1) / Math.max(1, plotW);
    if (perPx > 3 && !s.dash) {
      // min/max decimation per pixel column keeps spikes visible without drawing every point
      let col = null, mn = 0, mx = 0, first = 0, lastV = 0;
      const flush = () => {
        if (col === null) return;
        if (!pen) { ctx.moveTo(col, yToPx(first)); pen = true; } else ctx.lineTo(col, yToPx(first));
        ctx.lineTo(col, yToPx(mn)); ctx.lineTo(col, yToPx(mx)); ctx.lineTo(col, yToPx(lastV));
      };
      for (let i = i0; i <= i1; i++) {
        const v = y[i];
        if (!isNum(v)) { flush(); col = null; pen = false; continue; }
        const px = Math.round(xToPx(x[i]));
        if (px !== col) { flush(); col = px; mn = mx = first = v; }
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        lastV = v;
      }
      flush();
    } else {
      for (let i = i0; i <= i1; i++) {
        const v = y[i];
        if (!isNum(v)) { pen = false; continue; }
        const px = xToPx(x[i]), py = yToPx(v);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ─────────────────────────── XYChart ───────────────────────────
  function XYChart(container, config) {
    const PAD_L = 56, PAD_R = 14, PAD_T = 12, PAD_B = 40;
    let cfg = config;
    const cv = setupCanvas(container, cfg.height || 300);
    container.setAttribute('aria-label', cfg.ariaLabel || `${cfg.yLabel} vs ${cfg.xLabel}`);
    let hover = null;
    let rng = null;
    function ranges() {
      const r = (a) => {
        let lo = Infinity, hi = -Infinity;
        for (const v of a) if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        const pad = (hi - lo) * 0.06 || 1;
        return [lo - pad, hi + pad];
      };
      return { x: r(cfg.x), y: r(cfg.y) };
    }
    function draw() {
      const { ctx, size } = cv;
      rng = ranges();
      ctx.clearRect(0, 0, size.w, size.h);
      const W = size.w - PAD_L - PAD_R, H = size.h - PAD_T - PAD_B;
      const X = (v) => PAD_L + ((v - rng.x[0]) / (rng.x[1] - rng.x[0])) * W;
      const Y = (v) => PAD_T + H - ((v - rng.y[0]) / (rng.y[1] - rng.y[0])) * H;
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.lineWidth = 1;
      ctx.strokeStyle = css(container, '--grid'); ctx.fillStyle = css(container, '--text-muted');
      const xt = niceTicks(rng.x[0], rng.x[1], W / 80), yt = niceTicks(rng.y[0], rng.y[1], H / 40);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const v of yt.ticks) { const py = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(PAD_L, py); ctx.lineTo(PAD_L + W, py); ctx.stroke(); ctx.fillText(fmtNum(v, yt.step), PAD_L - 6, py); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const v of xt.ticks) { const px = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, PAD_T + H); ctx.stroke(); ctx.fillText(fmtNum(v, xt.step), px, PAD_T + H + 6); }
      ctx.fillStyle = css(container, '--text-secondary');
      ctx.fillText(cfg.xLabel, PAD_L + W / 2, PAD_T + H + 22);
      ctx.save(); ctx.translate(12, PAD_T + H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(cfg.yLabel, 0, 0); ctx.restore();
      // trajectory
      ctx.save();
      ctx.beginPath(); ctx.rect(PAD_L, PAD_T, W, H); ctx.clip();
      ctx.strokeStyle = css(container, cfg.color || '--series-1');
      ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < cfg.x.length; i++) {
        const a = cfg.x[i], b = cfg.y[i];
        if (!isNum(a) || !isNum(b)) { pen = false; continue; }
        if (!pen) { ctx.moveTo(X(a), Y(b)); pen = true; } else ctx.lineTo(X(a), Y(b));
      }
      ctx.stroke();
      ctx.restore();
      if (hover !== null) {
        const px = X(cfg.x[hover]), py = Y(cfg.y[hover]);
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = css(container, cfg.color || '--series-1'); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = css(container, '--surface-1'); ctx.stroke();
        cv.tip.innerHTML = `${cfg.tipHead ? `<div class="tip-head">${cfg.tipHead(hover)}</div>` : ''}<div class="tip-row"><span>${cfg.xLabel}</span><b>${cfg.x[hover].toFixed(2)}</b></div><div class="tip-row"><span>${cfg.yLabel}</span><b>${cfg.y[hover].toFixed(2)}</b></div>`;
        placeTip(cv.tip, container, px, py);
      } else cv.tip.hidden = true;
      cv.X = X; cv.Y = Y;
    }
    cv.canvas.addEventListener('pointermove', (ev) => {
      const rect = cv.canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      let best = -1, bd = 20 * 20;
      const step = Math.max(1, Math.floor(cfg.x.length / 4000));
      for (let i = 0; i < cfg.x.length; i += step) {
        if (!isNum(cfg.x[i]) || !isNum(cfg.y[i])) continue;
        const d = (cv.X(cfg.x[i]) - mx) ** 2 + (cv.Y(cfg.y[i]) - my) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      hover = best >= 0 ? best : null;
      draw();
    });
    cv.canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
    const ro = new ResizeObserver(() => { cv.resize(); draw(); });
    ro.observe(container);
    cv.resize(); draw();
    return {
      update(next) { cfg = Object.assign({}, cfg, next); hover = null; draw(); },
      redraw: draw,
      destroy() { ro.disconnect(); container.innerHTML = ''; },
    };
  }

  root.PIDCharts = { LineChart, XYChart, niceTicks, timeTicks };
})(typeof self !== 'undefined' ? self : this);
