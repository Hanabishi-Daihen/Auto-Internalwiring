/* Internal Wiring Planner - UI */
(function () {
  'use strict';
  const E = window.WiringEngine;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmtM = (mm) => (mm / 1000).toFixed(1) + ' m';

  const BASE = clone(window.PROJECT_DATA);
  const STORE_KEY = 'iwp.project.' + (BASE.meta.processNo || 'default');
  const DEFAULT_SETTINGS = { mode: 'opt', allow: 100, round: 50 };

  let project, model, plan, wires;
  let selWire = null, selNet = '', selDev = null;
  let bgImage = null;
  let pdfDoc = null, pdfPage = 1, pdfZoom = 1.4;

  // ---------------------------------------------------------------- storage
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
    project = saved && saved.version === BASE.version ? saved : clone(BASE);
    project.settings = Object.assign({}, DEFAULT_SETTINGS, project.settings || {});
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); } catch (e) { /* storage unavailable */ }
    }, 300);
  }
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  // ---------------------------------------------------------------- compute
  function recompute() {
    model = E.buildModel(project);
    const st = project.settings;
    wires = [];
    plan = project.nets.map((net, ni) => {
      const r = E.planNet(model, net, { drawingOrder: st.mode === 'drawing' });
      r.segments.forEach((s) => {
        const pa = E.splitPin(s.a), pb = E.splitPin(s.b);
        const notes = [];
        [pa, pb].forEach((p) => { const n = E.pinNote(p.pin); if (n) notes.push(E.pinLabel(p.pin) + ' = ' + n); });
        if (s.fixed) notes.push('ช่วงล็อกตามแบบ');
        if (net.remark) notes.push(net.remark);
        const cut = Math.ceil((s.len + 2 * st.allow) / st.round) * st.round;
        wires.push({
          net: ni, wire: net.wire, cls: net.cls || '', sheet: s.sheet, a: s.a, b: s.b,
          cmp1: pa.dev, pin1: E.pinLabel(pa.pin), cmp2: pb.dev, pin2: E.pinLabel(pb.pin),
          len: s.len, cut: isFinite(cut) ? cut : 0, via: s.via, route: s.route, fixed: s.fixed,
          z1: E.zoneOf(model, s.a), z2: E.zoneOf(model, s.b), remark: notes.join(' / ')
        });
      });
      return r;
    });
    wires.forEach((w, i) => { w.id = i; w.bundle = [w.z1, w.z2].sort().join(' ↔ '); });
  }
  function cableText(cls) {
    const c = project.cable[cls || ''];
    return c && c.color ? `${c.color} ${c.size} sq.mm.` : '';
  }

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const m = project.meta;
    $('#projTitle').textContent = `${m.processNo} · ${m.panelName} · Schematic ${m.schematicDwg} Sheet ${m.sheets}`;
    const totOpt = plan.reduce((s, r) => s + r.lenOpt, 0);
    const totDraw = plan.reduce((s, r) => s + r.lenDrawing, 0);
    const blank = wires.filter((w) => !cableText(w.cls)).length;
    const doorW = wires.filter((w) => /DOOR/.test(w.z1 + w.z2) && !(/DOOR/.test(w.z1) && /DOOR/.test(w.z2) && w.z1 === w.z2)).length;
    const assumed = Object.values(project.devices).filter((d) => d.assumed).length;
    const over = pinOverload();
    const saving = totDraw > 0 ? (1 - totOpt / totDraw) * 100 : 0;
    const cards = [
      ['จำนวนสายภายใน', wires.length, `${project.nets.length} node จาก Sheet ${m.sheets}`, ''],
      ['ความยาวรวม (โดยประมาณ)', fmtM(totOpt), project.settings.mode === 'opt' ? `ตามแบบ ${fmtM(totDraw)} · ลดลง ${saving.toFixed(0)}%` : 'ใช้ลำดับตามแบบ', 'good'],
      ['ใส่สี/ขนาดสายแล้ว', wires.length - blank, `ยังว่าง ${blank} เส้น (ระบายเหลือง)`, blank ? 'warn' : 'good'],
      ['สายข้ามประตู (hinge)', doorW, 'มัดรวมผ่านบานพับ', ''],
      ['อุปกรณ์ตำแหน่งสมมติ', assumed, 'ไม่พบใน Outline — ควรตรวจ', assumed ? 'warn' : 'good'],
      ['ขั้วที่มีสาย > 2 เส้น', over.length, over.length ? over.slice(0, 3).map((o) => o[0]).join(', ') : 'ผ่าน', over.length ? 'warn' : 'good']
    ];
    $('#statCards').innerHTML = cards.map((c) => `<div class="card ${c[3]}"><div class="k">${esc(c[0])}</div><div class="v">${esc(c[1])}</div><div class="s">${esc(c[2])}</div></div>`).join('');
    const an = (project.anomalies || []).concat(Object.values(project.noInternal || {}));
    $('#anomalyList').innerHTML = an.map((a) => `<li>${esc(a)}</li>`).join('');
    // bundle table
    const b = {};
    wires.forEach((w) => { const k = w.bundle; (b[k] = b[k] || { n: 0, len: 0, cut: 0 }); b[k].n++; b[k].len += w.len; b[k].cut += w.cut; });
    const rows = Object.entries(b).sort((x, y) => y[1].n - x[1].n);
    $('#bundleTable').innerHTML = `<table class="grid"><tr><th>กลุ่มเส้นทาง (ต้นทาง ↔ ปลายทาง)</th><th>จำนวนสาย</th><th>ความยาวเดินสาย</th><th>ความยาวตัดรวม</th></tr>` +
      rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${fmtM(v.len)}</td><td class="num">${fmtM(v.cut)}</td></tr>`).join('') + '</table>';
  }
  function pinOverload() {
    const deg = {};
    wires.forEach((w) => { [w.a, w.b].forEach((p) => { deg[p] = (deg[p] || 0) + 1; }); });
    return Object.entries(deg).filter(([k, v]) => {
      if (k === 'GND') return false;
      const isT = !!project.terminals[E.splitPin(k).dev];
      return isT ? v > 4 : v > 2;
    });
  }

  // ---------------------------------------------------------------- wire list
  function sheetOptions(sel) {
    const sheets = Array.from(new Set(project.nets.map((n) => n.sheet))).sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">ทุก Sheet</option>' + sheets.map((s) => `<option value="${esc(s)}">Sheet ${esc(s)}</option>`).join('');
    sel.value = cur;
  }
  function sortedWires(mode) {
    const list = wires.slice();
    const pos = (ref) => { const p = model.pinPos(ref); return p ? [p.view, p.x, p.y] : ['', 0, 0]; };
    if (mode === 'work') {
      list.sort((a, b) => a.bundle.localeCompare(b.bundle) || a.cmp1.localeCompare(b.cmp1, undefined, { numeric: true }) || a.id - b.id);
    } else if (mode === 'device') {
      list.sort((a, b) => {
        const pa = pos(a.a), pb = pos(b.a);
        return pa[0].localeCompare(pb[0]) || (pa[2] - pb[2]) || (pa[1] - pb[1]) || a.id - b.id;
      });
    } else {
      list.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.net - b.net || a.id - b.id);
    }
    return list;
  }
  function filteredWires() {
    const q = $('#wSearch').value.trim().toLowerCase();
    const sh = $('#wSheet').value;
    const onlyBlank = $('#wBlank').checked, onlyRem = $('#wRemark').checked;
    return sortedWires($('#wSort').value).filter((w) => {
      if (sh && w.sheet !== sh) return false;
      if (onlyBlank && cableText(w.cls)) return false;
      if (onlyRem && !w.remark) return false;
      if (!q) return true;
      return (w.wire + ' ' + w.a + ' ' + w.b + ' ' + w.remark).toLowerCase().includes(q);
    });
  }
  function renderWires() {
    const list = filteredWires();
    const mode = $('#wSort').value;
    $('#wCount').textContent = `${list.length} / ${wires.length} เส้น`;
    const head = '<tr><th>#</th><th>LINENO.</th><th>CABLE</th><th>CMP.1</th><th>PIN.1</th><th>CMP.2</th><th>PIN.2</th><th>SH.</th><th>ยาว (mm)</th><th>ตัด (mm)</th><th>เส้นทาง</th><th>หมายเหตุ</th></tr>';
    let last = null, n = 0;
    const rows = list.map((w) => {
      let sep = '';
      const key = mode === 'work' ? w.bundle : mode === 'sheet' ? 'Sheet ' + w.sheet : null;
      if (key && key !== last) { sep = `<tr class="sep"><td colspan="12">${esc(key)}</td></tr>`; last = key; }
      n++;
      const cab = cableText(w.cls);
      const via = (w.via || []).join(' › ');
      return sep + `<tr data-id="${w.id}" class="${selWire === w.id ? 'sel' : ''}"><td class="num">${n}</td><td class="mono"><b>${esc(w.wire)}</b></td>` +
        `<td class="nw ${cab ? '' : 'blank'}">${esc(cab)}</td><td class="mono">${esc(w.cmp1)}</td><td class="mono">${esc(w.pin1)}</td>` +
        `<td class="mono">${esc(w.cmp2)}</td><td class="mono">${esc(w.pin2)}</td><td>${esc(w.sheet)}</td>` +
        `<td class="num">${Math.round(w.len)}</td><td class="num">${w.cut}</td>` +
        `<td>${/HINGE/.test(via) ? '<span class="tag door">ผ่านบานพับ</span> ' : ''}${w.fixed ? '<span class="tag fixed">ล็อก</span> ' : ''}<span class="mono">${esc(via)}</span></td>` +
        `<td class="${w.remark ? 'rem' : ''}">${esc(w.remark)}</td></tr>`;
    });
    $('#wireTable').innerHTML = head + rows.join('');
  }

  // ---------------------------------------------------------------- map view (canvas)
  function MapView(canvas, opts) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.scale = 2; this.ox = 0; this.oy = 0;
    this.highlight = []; this.showAll = false; this.showWW = true; this.edit = false;
    this.bindEvents();
  }
  MapView.prototype.resize = function () {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width < 2 || r.height < 2) return false;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    return true;
  };
  MapView.prototype.fit = function (box) {
    if (!this.resize()) return;
    box = box || [60, 155, 790, 372];
    const sx = this.w / (box[2] - box[0]), sy = this.h / (box[3] - box[1]);
    this.scale = Math.min(sx, sy) * 0.98;
    this.ox = (box[0] + box[2]) / 2 - this.w / 2 / this.scale;
    this.oy = (box[1] + box[3]) / 2 - this.h / 2 / this.scale;
    this.draw();
  };
  MapView.prototype.toScreen = function (x, y) { return [(x - this.ox) * this.scale, (y - this.oy) * this.scale]; };
  MapView.prototype.toPdf = function (sx, sy) { return [sx / this.scale + this.ox, sy / this.scale + this.oy]; };
  MapView.prototype.bindEvents = function () {
    const self = this;
    let drag = null;
    this.c.addEventListener('wheel', function (e) {
      e.preventDefault();
      const r = self.c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const p = self.toPdf(mx, my);
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      self.scale = Math.min(60, Math.max(0.5, self.scale * f));
      self.ox = p[0] - mx / self.scale; self.oy = p[1] - my / self.scale;
      self.draw();
    }, { passive: false });
    this.c.addEventListener('mousedown', function (e) {
      const r = self.c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const p = self.toPdf(mx, my);
      const hit = self.hitDevice(p[0], p[1]);
      if (self.edit && hit) { drag = { dev: hit, dx: project.devices[hit].x - p[0], dy: project.devices[hit].y - p[1] }; }
      else drag = { pan: true, sx: mx, sy: my, ox: self.ox, oy: self.oy, moved: false, hit: hit };
      self.c.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      const r = self.c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (drag.pan) {
        if (Math.abs(mx - drag.sx) + Math.abs(my - drag.sy) > 3) drag.moved = true;
        self.ox = drag.ox - (mx - drag.sx) / self.scale; self.oy = drag.oy - (my - drag.sy) / self.scale;
      } else {
        const p = self.toPdf(mx, my);
        const d = project.devices[drag.dev];
        d.x = +(p[0] + drag.dx).toFixed(2); d.y = +(p[1] + drag.dy).toFixed(2);
        drag.moved = true;
      }
      self.draw();
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return;
      self.c.style.cursor = 'grab';
      if (drag.dev && drag.moved) {
        const d = project.devices[drag.dev];
        const v = viewAt(d.x, d.y);
        if (v) d.view = v;
        d.assumed = false;
        save(); recompute(); refreshAll();
        toast(`ย้าย ${drag.dev} → ${project.views[d.view].name} แล้วคำนวณเส้นทางใหม่`);
      } else if (drag.pan && !drag.moved && self.opts.onClick) {
        self.opts.onClick(drag.hit);
      }
      drag = null;
    });
  };
  function viewAt(x, y) {
    let best = null;
    Object.entries(project.views).forEach(([k, v]) => {
      const r = v.rect;
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) best = k;
    });
    return best;
  }
  MapView.prototype.hitDevice = function (x, y) {
    let best = null, bd = Infinity;
    Object.entries(project.devices).forEach(([k, d]) => {
      const hw = Math.max(d.w || 4, 2.5) / 2, hh = Math.max(d.h || 4, 2.5) / 2;
      if (x >= d.x - hw && x <= d.x + hw && y >= d.y - hh && y <= d.y + hh) {
        const dd = Math.abs(x - d.x) + Math.abs(y - d.y);
        if (dd < bd) { bd = dd; best = k; }
      }
    });
    return best;
  };
  function routeSegments(w) {
    // polyline pieces in PDF coords: [{x1,y1,x2,y2,dash}]
    const r = w.route, out = [];
    if (!r || !r.from || !r.to) return out;
    const A = r.from, B = r.to;
    const L = (p, q, dash) => {
      if (Math.abs(p.x - q.x) > 0.01 && Math.abs(p.y - q.y) > 0.01) {
        out.push({ x1: p.x, y1: p.y, x2: q.x, y2: p.y, dash: dash });
        out.push({ x1: q.x, y1: p.y, x2: q.x, y2: q.y, dash: dash });
      } else out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, dash: dash });
    };
    if (r.direct && !r.pa) { L(A, B); return out; }
    if (r.direct && r.pa) { L(A, r.pa.proj); L(r.pa.proj, r.pb.proj); L(r.pb.proj, B); return out; }
    const nodes = r.nodes.map((i) => model.nodes[i]);
    if (r.pa.proj) { L(A, r.pa.proj); L(r.pa.proj, nodes[0]); } else L(A, nodes[0]);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const p = nodes[i], q = nodes[i + 1];
      out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, dash: p.view !== q.view, jump: p.view !== q.view });
    }
    const last = nodes[nodes.length - 1];
    if (r.pb.proj) { L(last, r.pb.proj); L(r.pb.proj, B); } else L(last, B);
    return out;
  }
  MapView.prototype.draw = function () {
    if (!this.w && !this.resize()) return;
    const ctx = this.ctx, s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(-this.ox * s, -this.oy * s); ctx.scale(s, s);
    const bg = project.background;
    if (bgImage && bgImage.complete && bgImage.naturalWidth) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(bgImage, 0, 0, bg.ptWidth, bg.ptHeight);
      ctx.globalAlpha = 1;
    }
    // wireways
    if (this.showWW) {
      ctx.lineCap = 'butt';
      model.segs.forEach((sg) => {
        ctx.strokeStyle = 'rgba(56, 132, 255, .18)'; ctx.lineWidth = 7.5;
        ctx.beginPath(); ctx.moveTo(sg.x1, sg.y1); ctx.lineTo(sg.x2, sg.y2); ctx.stroke();
      });
      model.portals.forEach((p) => {
        const a = model.nodes[p.anchor];
        ctx.fillStyle = 'rgba(56,132,255,.6)';
        ctx.beginPath(); ctx.arc(a.x, a.y, 1.6, 0, Math.PI * 2); ctx.fill();
      });
    }
    // all wires
    const drawWire = (w, color, width, alpha) => {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width / s * 1.2;
      routeSegments(w).forEach((g) => {
        ctx.setLineDash(g.dash ? [4 / s, 4 / s] : []);
        ctx.globalAlpha = g.jump ? alpha * 0.35 : alpha;
        ctx.lineWidth = (g.jump ? 1 : width) / s * 1.2;
        ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
      });
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    };
    if (this.showAll) wires.forEach((w) => drawWire(w, '#94a3b8', 1, 0.35));
    // devices
    const lbl = s > 3.2;
    Object.entries(project.devices).forEach(([k, d]) => {
      const w = d.w || 4, h = d.h || 4;
      ctx.lineWidth = 1 / s * 1.2;
      ctx.strokeStyle = d.assumed ? '#ea580c' : '#334155';
      ctx.fillStyle = selDev === k ? 'rgba(250, 204, 21, .55)' : d.assumed ? 'rgba(251, 146, 60, .25)' : 'rgba(255,255,255,.35)';
      ctx.fillRect(d.x - w / 2, d.y - h / 2, w, h);
      ctx.strokeRect(d.x - w / 2, d.y - h / 2, w, h);
      if (lbl) {
        ctx.fillStyle = '#0f172a';
        ctx.font = `${Math.max(1.4, 11 / s)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(k.replace(/^-/, ''), d.x, d.y - h / 2 - 7 / s);
      }
    });
    // highlight
    const hl = this.highlight;
    const colors = ['#e11d48', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
    hl.forEach((w, i) => drawWire(w, hl.length === 1 ? '#e11d48' : colors[i % colors.length], 3, 0.95));
    hl.forEach((w) => {
      [w.route && w.route.from, w.route && w.route.to].forEach((p) => {
        if (!p) return;
        ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.arc(p.x, p.y, 4 / s, 0, Math.PI * 2); ctx.fill();
      });
    });
    ctx.restore();
  };
  MapView.prototype.centerOn = function (x, y, zoom) {
    if (zoom) this.scale = zoom;
    this.ox = x - this.w / 2 / this.scale; this.oy = y - this.h / 2 / this.scale;
    this.draw();
  };
  MapView.prototype.focusWires = function (list) {
    const pts = [];
    list.forEach((w) => routeSegments(w).forEach((g) => { pts.push([g.x1, g.y1], [g.x2, g.y2]); }));
    if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const pad = 12;
    this.fit([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
  };

  let mini, big;
  function setupMaps() {
    mini = new MapView($('#miniMap'), {
      onClick: (dev) => { if (dev) { $('#wSearch').value = dev; renderWires(); } }
    });
    big = new MapView($('#layoutMap'), {
      onClick: (dev) => { selectDevice(dev); }
    });
    window.addEventListener('resize', () => { if (mini.resize()) mini.draw(); if (big.resize()) big.draw(); });
  }
  function selectWire(id) {
    selWire = id;
    const w = wires[id];
    $$('#wireTable tr.sel').forEach((tr) => tr.classList.remove('sel'));
    const tr = document.querySelector(`#wireTable tr[data-id="${id}"]`);
    if (tr) tr.classList.add('sel');
    const netWires = wires.filter((x) => x.net === w.net);
    mini.highlight = [w];
    mini.resize(); mini.focusWires(netWires);
    mini.highlight = [w];
    mini.draw();
    const net = project.nets[w.net];
    const list = netWires.map((x) => `${x.cmp1}.${x.pin1} → ${x.cmp2}.${x.pin2}`).join('<br>');
    $('#miniInfo').innerHTML = `<b>${esc(w.wire)}</b> (Sheet ${esc(net.sheet)}) · ${esc(w.cmp1)}.${esc(w.pin1)} → ${esc(w.cmp2)}.${esc(w.pin2)} · ${Math.round(w.len)} mm · ${esc((w.via || []).join(' › '))}` +
      `<details><summary>ลำดับพ่วงทั้ง node (${netWires.length} เส้น)</summary><div class="mono">${list}</div></details>`;
  }
  function selectDevice(dev) {
    selDev = dev || null;
    big.highlight = dev ? wires.filter((w) => E.splitPin(w.a).dev === dev || E.splitPin(w.b).dev === dev) : [];
    big.draw();
    if (dev) {
      const d = project.devices[dev];
      toast(`${dev} · ${d.desc || ''} · ${project.views[d.view].name}${d.assumed ? ' · ตำแหน่งสมมติ' : ''} · ${big.highlight.length} เส้น`);
    }
  }

  // ---------------------------------------------------------------- layout tab
  function renderDevList() {
    const q = $('#dSearch').value.trim().toLowerCase();
    const items = Object.entries(project.devices)
      .filter(([k, d]) => !q || (k + ' ' + d.desc).toLowerCase().includes(q))
      .sort((a, b) => (b[1].assumed - a[1].assumed) || a[0].localeCompare(b[0], undefined, { numeric: true }));
    $('#devList').innerHTML = items.map(([k, d]) =>
      `<div class="devitem ${d.assumed ? 'assumed' : ''}" data-dev="${esc(k)}"><span><b>${esc(k)}</b><br><span class="vw">${esc(d.desc || '')}</span></span><span class="vw">${esc(d.view)}</span></div>`).join('');
  }
  function renderNetSelect() {
    const sel = $('#lNet');
    const cur = sel.value;
    const names = project.nets.map((n, i) => [i, `${n.wire}  (Sh.${n.sheet})`]);
    sel.innerHTML = '<option value="">— เลือกเบอร์สายเพื่อไฮไลต์ —</option>' + names.map(([i, t]) => `<option value="${i}">${esc(t)}</option>`).join('');
    sel.value = cur;
  }

  // ---------------------------------------------------------------- netlist tab
  function pinsToText(net) {
    return net.pins.map((p) => (p[1] && p[1] !== net.sheet ? `${p[0]}@${p[1]}` : p[0])).join(' ');
  }
  function textToPins(txt, sheet) {
    return txt.split(/[\s,;]+/).filter(Boolean).map((t) => {
      const i = t.lastIndexOf('@');
      return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : [t, sheet];
    });
  }
  function fixedToText(net) { return (net.fixed || []).map((f) => f[0] + '>' + f[1]).join(' '); }
  function textToFixed(txt) {
    return txt.split(/[\s,;]+/).filter(Boolean).map((t) => t.split('>')).filter((p) => p.length === 2);
  }
  function renderNets() {
    const q = $('#nSearch').value.trim().toLowerCase();
    const sh = $('#nSheet').value;
    const clsOpts = Object.keys(project.cable);
    let shown = 0;
    const rows = project.nets.map((n, i) => {
      if (sh && n.sheet !== sh) return '';
      if (q && !(n.wire + ' ' + pinsToText(n) + ' ' + (n.remark || '')).toLowerCase().includes(q)) return '';
      shown++;
      const r = plan[i];
      const cls = `<select data-f="cls">${clsOpts.map((c) => `<option value="${esc(c)}" ${c === (n.cls || '') ? 'selected' : ''}>${esc(c ? c + ' — ' + cableText(c) : '(ว่าง)')}</option>`).join('')}</select>`;
      return `<tr data-i="${i}">
        <td><input data-f="wire" value="${esc(n.wire)}" style="width:70px"></td>
        <td><input data-f="sheet" value="${esc(n.sheet)}" style="width:44px"></td>
        <td style="min-width:150px">${cls}</td>
        <td style="min-width:320px"><textarea data-f="pins" rows="${Math.min(6, 1 + Math.floor(pinsToText(n).length / 70))}">${esc(pinsToText(n))}</textarea></td>
        <td style="min-width:150px"><textarea data-f="fixed" rows="1">${esc(fixedToText(n))}</textarea></td>
        <td><label class="chk"><input type="checkbox" data-f="keepOrder" ${n.keepOrder ? 'checked' : ''}> ตามแบบ</label></td>
        <td class="num">${r ? r.segments.length : 0}<br><span class="hint">${r ? Math.round(r.lenOpt) : 0} mm</span></td>
        <td style="min-width:160px"><input data-f="remark" value="${esc(n.remark || '')}"></td>
        <td><button class="iconbtn" data-act="show" title="ดูบนผัง">👁</button><button class="iconbtn" data-act="pdf" title="เปิด Sheet นี้ใน PDF">📄</button><button class="iconbtn" data-act="del" title="ลบ node">✕</button></td>
      </tr>`;
    }).join('');
    $('#nCount').textContent = `${shown} / ${project.nets.length} node`;
    $('#netTable').innerHTML = `<tr><th>เบอร์สาย</th><th>Sheet</th><th>ประเภทวงจร (สี/ขนาด)</th><th>ขาที่อยู่ใน node เดียวกัน</th><th>ล็อกช่วง</th><th>ลำดับ</th><th>สาย</th><th>หมายเหตุ</th><th></th></tr>` + rows;
  }
  function onNetEdit(e) {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i, n = project.nets[i], f = e.target.dataset.f;
    if (!f) return;
    if (f === 'pins') n.pins = textToPins(e.target.value, n.sheet);
    else if (f === 'fixed') n.fixed = textToFixed(e.target.value);
    else if (f === 'keepOrder') n.keepOrder = e.target.checked;
    else n[f] = e.target.value;
    const bad = n.pins.filter((p) => p[0] !== 'GND' && !project.devices[E.splitPin(p[0]).dev]);
    if (bad.length) toast('ไม่พบอุปกรณ์: ' + bad.map((b) => b[0]).join(', ') + ' — เพิ่มอุปกรณ์ในผังก่อน หรือแก้ชื่อ');
    save(); recompute(); refreshAll(['nets']);
  }

  // ---------------------------------------------------------------- PDF
  let workerLoaded = false;
  function ensurePdfWorker() {
    return new Promise((res) => {
      if (workerLoaded || location.protocol !== 'file:') {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        res(); return;
      }
      // file:// pages cannot start a Web Worker -> load the worker on the main thread
      const s = document.createElement('script');
      s.src = 'vendor/pdf.worker.min.js';
      s.onload = () => { workerLoaded = true; window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; res(); };
      s.onerror = () => res();
      document.head.appendChild(s);
    });
  }
  async function openPdf(file) {
    if (!window.pdfjsLib) { toast('โหลด pdf.js ไม่ได้'); return; }
    await ensurePdfWorker();
    const buf = await file.arrayBuffer();
    pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const sel = $('#pPage');
    sel.innerHTML = Array.from({ length: pdfDoc.numPages }, (_, i) => `<option value="${i + 1}">หน้า ${i + 1}</option>`).join('');
    $('#pInfo').textContent = `${file.name} · ${pdfDoc.numPages} หน้า (หน้า PDF = เลข Sheet)`;
    pdfPage = 7; sel.value = '7';
    renderPdfPage();
    toast('เปิด PDF แล้ว — ดูได้ในแท็บ “ดูแบบ PDF”');
  }
  async function renderPdfPage() {
    if (!pdfDoc) return;
    pdfPage = Math.min(Math.max(1, pdfPage), pdfDoc.numPages);
    $('#pPage').value = String(pdfPage);
    const page = await pdfDoc.getPage(pdfPage);
    const vp = page.getViewport({ scale: pdfZoom * (window.devicePixelRatio || 1) });
    const cv = $('#pdfCanvas');
    cv.width = vp.width; cv.height = vp.height;
    cv.style.width = (vp.width / (window.devicePixelRatio || 1)) + 'px';
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    $('#pZoom').textContent = Math.round(pdfZoom * 100) + '%';
  }
  async function extractOutline() {
    if (!pdfDoc) { toast('เปิดไฟล์ PDF ก่อน (ปุ่ม 📄 เปิด PDF)'); return; }
    const pg = +(prompt('หน้า Outline drawing ที่มีอุปกรณ์ภายในตู้ (หน้า PDF):', String(project.meta.outlineSheet || 30)) || 0);
    if (!pg) return;
    const page = await pdfDoc.getPage(pg);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const found = {};
    tc.items.forEach((it) => {
      const s = (it.str || '').trim();
      if (!s) return;
      const tx = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      const rot = Math.abs(it.transform[1]) > Math.abs(it.transform[0]);
      const w = it.width, x = tx[4], yb = tx[5];
      const cx = rot ? x - fh / 2 : x + w / 2, cy = rot ? yb - w / 2 : yb - fh / 2;
      [s, '-' + s.replace(/^-/, '')].forEach((name) => {
        if (project.devices[name] && !project.terminals[name] && name !== 'GND') {
          (found[name] = found[name] || []).push([cx, cy]);
        }
      });
    });
    const names = Object.keys(found).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) { toast('ไม่พบชื่ออุปกรณ์เป็นข้อความในหน้านี้ (ข้อความอาจเป็นเส้น vector)'); return; }
    const rows = names.map((n) => {
      const d = project.devices[n], p = found[n][0];
      const dist = Math.hypot(d.x - p[0], d.y - p[1]);
      return `<tr><td><input type="checkbox" data-n="${esc(n)}" ${d.assumed || dist > 15 ? 'checked' : ''}></td><td class="mono">${esc(n)}</td><td class="num">${d.x.toFixed(1)}, ${d.y.toFixed(1)}</td><td class="num">${p[0].toFixed(1)}, ${p[1].toFixed(1)}</td><td class="num">${dist.toFixed(1)}</td><td>${found[n].length > 1 ? 'พบ ' + found[n].length + ' จุด (ใช้จุดแรก)' : ''}</td></tr>`;
    }).join('');
    modal(`พบอุปกรณ์ ${names.length} รายการบนหน้า ${pg}`,
      `<p class="note">ตำแหน่งจาก PDF คือจุดกึ่งกลาง<b>ป้ายชื่อ</b>ของอุปกรณ์ (อาจอยู่เหนืออุปกรณ์เล็กน้อย) — ค่าเริ่มต้นเลือกเฉพาะอุปกรณ์ตำแหน่งสมมติ หรือที่ต่างจากเดิมมากกว่า 15 pt · หน้านี้จะถูกใช้เป็นภาพพื้นหลังผัง</p>
       <div class="tablewrap" style="max-height:50vh"><table class="grid"><tr><th><input type="checkbox" onclick="document.querySelectorAll('#modalBody input[data-n]').forEach(function(c){c.checked=this.checked}, this)" title="เลือกทั้งหมด"></th><th>อุปกรณ์</th><th>เดิม (pt)</th><th>จาก PDF (pt)</th><th>ต่าง</th><th></th></tr>${rows}</table></div>`,
      [['ยกเลิก', null], ['อัปเดตตำแหน่ง', async () => {
        let n = 0;
        $$('#modalBody input[data-n]').forEach((cb) => {
          if (!cb.checked) return;
          const d = project.devices[cb.dataset.n], p = found[cb.dataset.n][0];
          d.x = +p[0].toFixed(2); d.y = +p[1].toFixed(2);
          const v = viewAt(d.x, d.y); if (v) d.view = v;
          d.assumed = false; n++;
        });
        await setBackgroundFromPdf(page, vp);
        save(); recompute(); refreshAll();
        toast(`อัปเดต ${n} อุปกรณ์ และพื้นหลังจากหน้า ${pg} แล้ว`);
      }]]);
  }
  async function setBackgroundFromPdf(page, vp1) {
    const vp = page.getViewport({ scale: 2.5 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const url = cv.toDataURL('image/jpeg', 0.82);
    project.background = { src: url, ptWidth: vp1.width, ptHeight: vp1.height };
    loadBg();
  }
  function loadBg() {
    bgImage = new Image();
    bgImage.onload = () => { mini.draw(); big.draw(); };
    bgImage.src = project.background.src;
  }

  // ---------------------------------------------------------------- modal
  function modal(title, body, actions) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const box = $('#modalActions');
    box.innerHTML = '';
    actions.forEach(([label, fn], i) => {
      const b = document.createElement('button');
      b.className = 'btn' + (i === actions.length - 1 ? ' primary' : '');
      b.textContent = label;
      b.onclick = async () => { $('#modal').hidden = true; if (fn) await fn(); };
      box.appendChild(b);
    });
    $('#modal').hidden = false;
  }

  // ---------------------------------------------------------------- settings
  const META_FIELDS = [
    ['title', 'หัวเรื่อง (แถวที่ 1)'], ['panelName', 'ชื่อตู้'], ['loc', 'LOC. (เช่น TCC.)'],
    ['processNo', 'Process No.'], ['drawingNo', 'Drawing No. (Wiring list)'], ['schematicDwg', 'Schematic drawing no.'],
    ['project', 'Project'], ['contract', 'Contract no.'], ['rev', 'Rev.']
  ];
  function renderSettings() {
    const m = project.meta;
    $('#metaForm').innerHTML = META_FIELDS.map(([k, l]) => `<label>${esc(l)}<input data-meta="${k}" value="${esc(m[k] || '')}"></label>`).join('');
    $('#sMode').value = project.settings.mode;
    $('#sAllow').value = project.settings.allow;
    $('#sRound').value = project.settings.round;
    $('#cableTable').innerHTML = '<table class="grid"><tr><th>รหัส</th><th>วงจร</th><th>สี</th><th>ขนาด</th></tr>' +
      Object.entries(project.cable).filter(([k]) => k).map(([k, c]) =>
        `<tr data-c="${esc(k)}"><td class="mono">${esc(k)}</td><td>${esc(c.label)}</td><td><input data-cf="color" value="${esc(c.color)}" style="width:60px"></td><td><input data-cf="size" value="${esc(c.size)}" style="width:60px"></td></tr>`).join('') + '</table>';
  }

  // ---------------------------------------------------------------- CSV netlist
  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- wiring
  function refreshAll(skip) {
    skip = skip || [];
    renderOverview();
    sheetOptions($('#wSheet')); sheetOptions($('#nSheet'));
    renderWires();
    if (skip.indexOf('nets') < 0) renderNets();
    renderDevList(); renderNetSelect();
    if (mini) { mini.highlight = selWire != null && wires[selWire] ? [wires[selWire]] : []; mini.draw(); }
    if (big) big.draw();
  }
  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
      if (t.dataset.tab === 'layout') { requestAnimationFrame(() => { if (!big._fitted) { big.fit(); big._fitted = true; } else { big.resize(); big.draw(); } }); }
      if (t.dataset.tab === 'wires') { requestAnimationFrame(() => { if (!mini._fitted) { mini.fit(); mini._fitted = true; } else { mini.resize(); mini.draw(); } }); }
    }));
    ['#wSearch', '#wSheet', '#wSort', '#wBlank', '#wRemark'].forEach((s) => $(s).addEventListener('input', renderWires));
    $('#wireTable').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) selectWire(+tr.dataset.id);
    });
    // layout
    $('#lEdit').addEventListener('change', (e) => { big.edit = e.target.checked; toast(big.edit ? 'ลากกล่องอุปกรณ์เพื่อย้ายตำแหน่ง (วางในมุมมองใดก็ได้)' : 'ปิดโหมดแก้ไข'); });
    $('#lWire').addEventListener('change', (e) => { big.showWW = e.target.checked; big.draw(); });
    $('#lAll').addEventListener('change', (e) => { big.showAll = e.target.checked; big.draw(); });
    $('#lFit').addEventListener('click', () => big.fit());
    $('#lNet').addEventListener('change', (e) => {
      const i = e.target.value;
      big.highlight = i === '' ? [] : wires.filter((w) => w.net === +i);
      if (big.highlight.length) big.focusWires(big.highlight); else big.draw();
    });
    $('#lExtract').addEventListener('click', extractOutline);
    $('#dSearch').addEventListener('input', renderDevList);
    $('#devList').addEventListener('click', (e) => {
      const it = e.target.closest('[data-dev]');
      if (!it) return;
      const d = project.devices[it.dataset.dev];
      selectDevice(it.dataset.dev);
      big.centerOn(d.x, d.y, Math.max(big.scale, 6));
    });
    // nets
    ['#nSearch', '#nSheet'].forEach((s) => $(s).addEventListener('input', renderNets));
    $('#netTable').addEventListener('change', onNetEdit);
    $('#netTable').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = +b.closest('tr').dataset.i;
      if (b.dataset.act === 'del') {
        if (!confirm(`ลบ node ${project.nets[i].wire} ?`)) return;
        project.nets.splice(i, 1); save(); recompute(); refreshAll();
      } else if (b.dataset.act === 'show') {
        $('.tab[data-tab="layout"]').click();
        setTimeout(() => { $('#lNet').value = String(i); $('#lNet').dispatchEvent(new Event('change')); }, 50);
      } else if (b.dataset.act === 'pdf') {
        if (!pdfDoc) { toast('เปิดไฟล์ PDF ก่อน (ปุ่ม 📄 เปิด PDF)'); return; }
        pdfPage = parseInt(project.nets[i].sheet, 10) || 1;
        $('.tab[data-tab="pdf"]').click(); renderPdfPage();
      }
    });
    $('#nAdd').addEventListener('click', () => {
      project.nets.unshift({ wire: 'NEW', sheet: $('#nSheet').value || '', cls: '', pins: [], remark: '', fixed: [] });
      save(); recompute(); refreshAll();
    });
    $('#nCsvOut').addEventListener('click', () => {
      const lines = [['wire', 'sheet', 'class', 'pins', 'fixed', 'keepOrder', 'remark'].join(',')];
      project.nets.forEach((n) => lines.push([n.wire, n.sheet, n.cls || '', pinsToText(n), fixedToText(n), n.keepOrder ? 1 : '', n.remark || ''].map(csvCell).join(',')));
      download(`netlist_${project.meta.processNo}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    });
    $('#nCsvIn').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCsv((await f.text()).replace(/^﻿/, ''));
      const h = rows.shift().map((x) => x.trim().toLowerCase());
      const ix = (k) => h.indexOf(k);
      if (ix('wire') < 0 || ix('pins') < 0) { toast('CSV ต้องมีคอลัมน์ wire และ pins'); return; }
      const nets = rows.map((r) => {
        const sheet = (r[ix('sheet')] || '').trim();
        return {
          wire: r[ix('wire')].trim(), sheet: sheet, cls: ix('class') >= 0 ? (r[ix('class')] || '').trim() : '',
          pins: textToPins(r[ix('pins')] || '', sheet), fixed: ix('fixed') >= 0 ? textToFixed(r[ix('fixed')] || '') : [],
          keepOrder: ix('keeporder') >= 0 && !!(r[ix('keeporder')] || '').trim(), remark: ix('remark') >= 0 ? r[ix('remark')] || '' : ''
        };
      });
      modal('นำเข้า Netlist', `<p>พบ ${nets.length} node ในไฟล์ <b>${esc(f.name)}</b></p>`,
        [['ยกเลิก', null], ['เพิ่มต่อท้าย', () => { project.nets = project.nets.concat(nets); save(); recompute(); refreshAll(); }],
         ['แทนที่ทั้งหมด', () => { project.nets = nets; save(); recompute(); refreshAll(); }]]);
      e.target.value = '';
    });
    // pdf
    $('#pdfFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openPdf(f).catch((err) => toast('เปิด PDF ไม่ได้: ' + err.message)); e.target.value = ''; });
    $('#pPage').addEventListener('change', (e) => { pdfPage = +e.target.value; renderPdfPage(); });
    $('#pPrev').addEventListener('click', () => { pdfPage--; renderPdfPage(); });
    $('#pNext').addEventListener('click', () => { pdfPage++; renderPdfPage(); });
    $('#pZoomIn').addEventListener('click', () => { pdfZoom = Math.min(6, pdfZoom * 1.25); renderPdfPage(); });
    $('#pZoomOut').addEventListener('click', () => { pdfZoom = Math.max(0.5, pdfZoom / 1.25); renderPdfPage(); });
    // project
    $('#btnSaveProj').addEventListener('click', () => {
      download(`wiring_project_${project.meta.processNo}.json`, new Blob([JSON.stringify(project, null, 1)], { type: 'application/json' }));
    });
    $('#projFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const p = JSON.parse(await f.text());
        if (!p.nets || !p.devices || !p.views) throw new Error('ไม่ใช่ไฟล์โปรเจกต์');
        project = p; project.settings = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
        save(); recompute(); loadBg(); renderSettings(); refreshAll(); toast('โหลดโปรเจกต์แล้ว');
      } catch (err) { toast('โหลดไม่ได้: ' + err.message); }
      e.target.value = '';
    });
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('ล้างการแก้ไขทั้งหมดและกลับไปใช้ข้อมูลตั้งต้น?')) return;
      project = clone(BASE); project.settings = Object.assign({}, DEFAULT_SETTINGS);
      save(); recompute(); loadBg(); renderSettings(); refreshAll(); toast('รีเซ็ตแล้ว');
    });
    // settings
    $('#metaForm').addEventListener('input', (e) => { const k = e.target.dataset.meta; if (k) { project.meta[k] = e.target.value; save(); renderOverview(); } });
    $('#sMode').addEventListener('change', (e) => { project.settings.mode = e.target.value; save(); recompute(); refreshAll(); });
    $('#sAllow').addEventListener('change', (e) => { project.settings.allow = Math.max(0, +e.target.value || 0); save(); recompute(); refreshAll(); });
    $('#sRound').addEventListener('change', (e) => { project.settings.round = Math.max(1, +e.target.value || 1); save(); recompute(); refreshAll(); });
    $('#cableTable').addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-c]'); if (!tr) return;
      project.cable[tr.dataset.c][e.target.dataset.cf] = e.target.value.trim();
      save(); refreshAll();
    });
    // excel
    $('#btnExcel').addEventListener('click', async () => {
      try {
        const btn = $('#btnExcel'); btn.disabled = true;
        const blob = await window.WiringExport.toExcel(project, wires, plan, { sort: $('#wSort').value, sortedWires: sortedWires, cableText: cableText, model: model });
        download(`Internal_Wiring_${(project.meta.loc || '').replace(/\W/g, '')}_${project.meta.processNo}.xlsx`, blob);
        btn.disabled = false;
        toast('ส่งออก Excel แล้ว');
      } catch (err) { $('#btnExcel').disabled = false; toast('ส่งออกไม่ได้: ' + err.message, 6000); console.error(err); }
    });
  }

  // ---------------------------------------------------------------- start
  load();
  recompute();
  setupMaps();
  loadBg();
  bind();
  renderSettings();
  refreshAll();
  window.IWP = { get project() { return project; }, get wires() { return wires; }, get plan() { return plan; }, recompute: recompute };
})();
