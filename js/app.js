/* Internal Wiring Planner - UI */
(function () {
  'use strict';
  const E = window.WiringEngine;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmtM = (mm) => (mm / 1000).toFixed(1) + ' m';
  const fin = (v) => (isFinite(v) ? v : 0);

  const BASE = clone(window.PROJECT_DATA);
  const STORE_KEY = 'iwp.project.current';
  const DEFAULT_SETTINGS = { mode: 'opt', allow: 100, round: 50, jumper: 50 };

  // generic circuit classes for a new project (edit to match the "Cable for wiring" table of the drawing)
  const NEW_CABLE = {
    AC_PH_A: { label: 'AC power phase A', color: 'R', size: '4.0' },
    AC_PH_B: { label: 'AC power phase B', color: 'Y', size: '4.0' },
    AC_PH_C: { label: 'AC power phase C', color: 'B', size: '4.0' },
    AC_PH_N: { label: 'AC power neutral', color: '', size: '4.0' },
    AC_CTRL: { label: 'AC control circuit', color: '', size: '2.5' },
    DC_CTRL: { label: 'DC control circuit', color: '', size: '2.5' },
    DC_PWR: { label: 'DC power source line', color: '', size: '4.0' },
    CT: { label: 'CT circuit', color: '', size: '4.0' },
    VT: { label: 'PT / VT circuit', color: '', size: '4.0' },
    EARTH: { label: 'Connection to earth', color: 'GY', size: '2.5' },
    '': { label: 'ไม่ระบุ (ตรวจสอบ)', color: '', size: '' }
  };

  let project, model, plan, wires;
  let selWire = null, selDev = null;
  const bgImages = {};
  let pdfDoc = null, pdfName = '', pdfPage = 1, pdfZoom = 1.4;

  // ---------------------------------------------------------------- storage / migration
  function migrate(p) {
    p.settings = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
    p.views = p.views || {}; p.devices = p.devices || {}; p.nets = p.nets || [];
    p.wireways = p.wireways || []; p.portals = p.portals || [];
    p.terminals = p.terminals || {}; p.bars = p.bars || {}; p.cable = p.cable || clone(NEW_CABLE);
    if (!p.backgrounds) {
      p.backgrounds = {};
      if (p.background) p.backgrounds.main = Object.assign({ name: 'Outline Sheet ' + (p.meta.outlineSheet || '') }, p.background);
      delete p.background;
    }
    Object.values(p.views).forEach((v) => { if (!v.bg) v.bg = Object.keys(p.backgrounds)[0] || 'main'; });
    return p;
  }
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
    project = migrate(saved && saved.version === BASE.version && saved.nets ? saved : clone(BASE));
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); }
      catch (e) { toast('บันทึกในเบราว์เซอร์ไม่ได้ (พื้นที่เต็ม) — ใช้ 💾 บันทึกโปรเจกต์ เป็นไฟล์แทน', 6000); }
    }, 300);
  }
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  const locs = () => Array.from(new Set((wires || []).map((w) => w.loc).filter(Boolean)
    .concat(Object.values(project.views).map((v) => v.loc).filter(Boolean)))).sort();
  // '+RCC-X3' -> '-X3' (the LOC column carries the cabinet)
  const cmpName = (dev) => dev.replace(/^\+[A-Za-z0-9]+(?=-)/, '');
  const bgOfDev = (d) => (d.view && project.views[d.view] ? project.views[d.view].bg : d.bg);

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
        if (!isFinite(s.len)) notes.push('ยังไม่มีตำแหน่ง/เส้นทาง — วางอุปกรณ์ในผังก่อน');
        if (net.remark) notes.push(net.remark);
        const cut = isFinite(s.len) ? Math.ceil((s.len + 2 * st.allow) / st.round) * st.round : 0;
        wires.push({
          net: ni, wire: net.wire, cls: net.cls || '', sheet: s.sheet, a: s.a, b: s.b,
          loc: E.locOf(model, s.a),
          cmp1: cmpName(pa.dev), pin1: E.pinLabel(pa.pin), cmp2: cmpName(pb.dev), pin2: E.pinLabel(pb.pin),
          len: s.len, cut: cut, via: s.via, route: s.route, fixed: s.fixed,
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
    $('#projTitle').textContent = `${m.processNo || ''} · ${m.panelName || ''} · Schematic ${m.schematicDwg || '-'} Sheet ${m.sheets || '-'}`;
    const totOpt = plan.reduce((s, r) => s + r.lenOpt, 0);
    const totDraw = plan.reduce((s, r) => s + r.lenDrawing, 0);
    const blank = wires.filter((w) => !cableText(w.cls)).length;
    const doorW = wires.filter((w) => /DOOR|HINGE/.test((w.via || []).join(' '))).length;
    const assumed = Object.values(project.devices).filter((d) => d.assumed).length;
    const unplaced = Object.values(project.devices).filter((d) => !d.view || !project.views[d.view]).length;
    const unrouted = wires.filter((w) => !isFinite(w.len)).length;
    const cross = plan.filter((r) => r.cabinets).length;
    const over = pinOverload();
    const saving = totDraw > 0 ? (1 - totOpt / totDraw) * 100 : 0;
    const L = locs();
    const cards = [
      ['จำนวนสายภายใน', wires.length, `${project.nets.length} node${L.length > 1 ? ' · ' + L.length + ' ตู้ (' + L.join(', ') + ')' : ''}`, ''],
      ['ความยาวรวม (โดยประมาณ)', fmtM(totOpt), project.settings.mode === 'opt' ? `ตามแบบ ${fmtM(totDraw)} · ลดลง ${saving.toFixed(0)}%` : 'ใช้ลำดับตามแบบ', 'good'],
      ['ใส่สี/ขนาดสายแล้ว', wires.length - blank, `ยังว่าง ${blank} เส้น (ระบายเหลือง)`, blank ? 'warn' : 'good'],
      ['สายผ่านบานพับ (hinge)', doorW, 'มัดรวมผ่านบานพับ', ''],
      ['อุปกรณ์ตำแหน่งสมมติ / ยังไม่วาง', assumed + ' / ' + unplaced, unrouted ? `${unrouted} เส้นยังไม่มีเส้นทาง` : 'ทุกเส้นมีเส้นทาง', assumed + unplaced ? 'warn' : 'good'],
      ['ขั้วที่มีสาย > 2 เส้น', over.length, over.length ? over.slice(0, 3).map((o) => o[0]).join(', ') : 'ผ่าน', over.length ? 'warn' : 'good']
    ];
    if (cross) cards.push(['node ที่ข้ามตู้', cross, 'แยกวางแผนเป็นสายภายในแต่ละตู้', '']);
    $('#statCards').innerHTML = cards.map((c) => `<div class="card ${c[3]}"><div class="k">${esc(c[0])}</div><div class="v">${esc(c[1])}</div><div class="s">${esc(c[2])}</div></div>`).join('');
    const an = (project.anomalies || []).concat(Object.values(project.noInternal || {}));
    $('#anomalyList').innerHTML = an.length ? an.map((a) => `<li>${esc(a)}</li>`).join('') : '<li style="color:var(--muted)">ยังไม่มีบันทึก</li>';
    const b = {};
    wires.forEach((w) => { const k = w.bundle; (b[k] = b[k] || { n: 0, len: 0, cut: 0 }); b[k].n++; b[k].len += fin(w.len); b[k].cut += w.cut; });
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
  function locOptions() {
    const sel = $('#wLoc'), cur = sel.value;
    const L = Array.from(new Set(wires.map((w) => w.loc))).sort();
    sel.innerHTML = '<option value="">ทุกตู้</option>' + L.map((l) => `<option>${esc(l)}</option>`).join('');
    sel.value = cur;
    sel.style.display = L.length > 1 ? '' : 'none';
  }
  function sortedWires(mode) {
    const list = wires.slice();
    const pos = (ref) => { const p = model.pinPos(ref); return p ? [p.view, p.x, p.y] : ['~', 0, 0]; };
    if (mode === 'work') {
      list.sort((a, b) => a.loc.localeCompare(b.loc) || a.bundle.localeCompare(b.bundle) || a.cmp1.localeCompare(b.cmp1, undefined, { numeric: true }) || a.id - b.id);
    } else if (mode === 'device') {
      list.sort((a, b) => {
        const pa = pos(a.a), pb = pos(b.a);
        return a.loc.localeCompare(b.loc) || pa[0].localeCompare(pb[0]) || (pa[2] - pb[2]) || (pa[1] - pb[1]) || a.id - b.id;
      });
    } else {
      list.sort((a, b) => a.loc.localeCompare(b.loc) || a.sheet.localeCompare(b.sheet, undefined, { numeric: true }) || a.net - b.net || a.id - b.id);
    }
    return list;
  }
  function filteredWires() {
    const q = $('#wSearch').value.trim().toLowerCase();
    const sh = $('#wSheet').value, lc = $('#wLoc').value;
    const onlyBlank = $('#wBlank').checked, onlyRem = $('#wRemark').checked;
    return sortedWires($('#wSort').value).filter((w) => {
      if (sh && w.sheet !== sh) return false;
      if (lc && w.loc !== lc) return false;
      if (onlyBlank && cableText(w.cls)) return false;
      if (onlyRem && !w.remark) return false;
      if (!q) return true;
      return (w.wire + ' ' + w.a + ' ' + w.b + ' ' + w.remark).toLowerCase().includes(q);
    });
  }
  function renderWires() {
    const list = filteredWires();
    const mode = $('#wSort').value;
    const multi = locs().length > 1;
    $('#wCount').textContent = `${list.length} / ${wires.length} เส้น`;
    const head = `<tr><th>#</th>${multi ? '<th>ตู้</th>' : ''}<th>LINENO.</th><th>CABLE</th><th>CMP.1</th><th>PIN.1</th><th>CMP.2</th><th>PIN.2</th><th>SH.</th><th>ยาว (mm)</th><th>ตัด (mm)</th><th>เส้นทาง</th><th>หมายเหตุ</th></tr>`;
    let last = null, n = 0;
    const rows = list.map((w) => {
      let sep = '';
      const key = (multi ? w.loc + ' · ' : '') + (mode === 'work' ? w.bundle : mode === 'sheet' ? 'Sheet ' + w.sheet : '');
      if (key && key !== last) { sep = `<tr class="sep"><td colspan="13">${esc(key)}</td></tr>`; last = key; }
      n++;
      const cab = cableText(w.cls);
      const via = (w.via || []).join(' › ');
      return sep + `<tr data-id="${w.id}" class="${selWire === w.id ? 'sel' : ''}"><td class="num">${n}</td>${multi ? `<td>${esc(w.loc)}</td>` : ''}<td class="mono"><b>${esc(w.wire)}</b></td>` +
        `<td class="nw ${cab ? '' : 'blank'}">${esc(cab)}</td><td class="mono">${esc(w.cmp1)}</td><td class="mono">${esc(w.pin1)}</td>` +
        `<td class="mono">${esc(w.cmp2)}</td><td class="mono">${esc(w.pin2)}</td><td>${esc(w.sheet)}</td>` +
        `<td class="num">${isFinite(w.len) ? Math.round(w.len) : '—'}</td><td class="num">${w.cut || '—'}</td>` +
        `<td>${/HINGE/.test(via) ? '<span class="tag door">ผ่านบานพับ</span> ' : ''}${w.fixed ? '<span class="tag fixed">ล็อก</span> ' : ''}<span class="mono">${esc(via)}</span></td>` +
        `<td class="${w.remark ? 'rem' : ''}">${esc(w.remark)}</td></tr>`;
    });
    $('#wireTable').innerHTML = head + rows.join('');
  }

  // ---------------------------------------------------------------- map view (canvas)
  function MapView(canvas, opts) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.scale = 2; this.ox = 0; this.oy = 0; this.bg = null;
    this.highlight = []; this.showAll = false; this.showWW = true; this.mode = 'pan';
    this.temp = null;                  // drawing preview for setup tools
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
  MapView.prototype.contentBox = function () {
    const vs = Object.values(project.views).filter((v) => v.bg === this.bg);
    if (vs.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      vs.forEach((v) => { x0 = Math.min(x0, v.rect[0]); y0 = Math.min(y0, v.rect[1]); x1 = Math.max(x1, v.rect[2]); y1 = Math.max(y1, v.rect[3]); });
      const pad = Math.max(8, (x1 - x0) * 0.03);
      return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }
    const b = project.backgrounds[this.bg];
    return b ? [0, 0, b.ptWidth, b.ptHeight] : [0, 0, 842, 595];
  };
  MapView.prototype.fit = function (box) {
    if (!this.resize()) return;
    box = box || this.contentBox();
    const sx = this.w / (box[2] - box[0]), sy = this.h / (box[3] - box[1]);
    this.scale = Math.min(sx, sy) * 0.98;
    this.ox = (box[0] + box[2]) / 2 - this.w / 2 / this.scale;
    this.oy = (box[1] + box[3]) / 2 - this.h / 2 / this.scale;
    this.draw();
  };
  MapView.prototype.toPdf = function (sx, sy) { return [sx / this.scale + this.ox, sy / this.scale + this.oy]; };
  MapView.prototype.evPdf = function (e) {
    const r = this.c.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    return { mx: mx, my: my, p: this.toPdf(mx, my) };
  };
  MapView.prototype.bindEvents = function () {
    const self = this;
    let drag = null;
    this.c.addEventListener('wheel', function (e) {
      e.preventDefault();
      const ev = self.evPdf(e);
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      self.scale = Math.min(80, Math.max(0.3, self.scale * f));
      self.ox = ev.p[0] - ev.mx / self.scale; self.oy = ev.p[1] - ev.my / self.scale;
      self.draw();
    }, { passive: false });
    this.c.addEventListener('mousedown', function (e) {
      const ev = self.evPdf(e), p = ev.p;
      const hit = self.hitDevice(p[0], p[1]);
      const m = self.mode;
      if (m === 'move' && hit) drag = { dev: hit, dx: project.devices[hit].x - p[0], dy: project.devices[hit].y - p[1] };
      else if (m === 'view') drag = { rect: true, x0: p[0], y0: p[1] };
      else drag = { pan: true, sx: ev.mx, sy: ev.my, ox: self.ox, oy: self.oy, moved: false, hit: hit, p: p };
      self.c.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      const ev = self.evPdf(e), p = ev.p;
      if (self.temp && self.temp.kind !== 'rect' && !drag) { self.temp.cur = p; self.draw(); }
      if (!drag) return;
      if (drag.pan) {
        if (Math.abs(ev.mx - drag.sx) + Math.abs(ev.my - drag.sy) > 3) drag.moved = true;
        self.ox = drag.ox - (ev.mx - drag.sx) / self.scale; self.oy = drag.oy - (ev.my - drag.sy) / self.scale;
      } else if (drag.rect) {
        self.temp = { kind: 'rect', x0: drag.x0, y0: drag.y0, x1: p[0], y1: p[1] };
      } else {
        const d = project.devices[drag.dev];
        d.x = +(p[0] + drag.dx).toFixed(2); d.y = +(p[1] + drag.dy).toFixed(2);
        drag.moved = true;
      }
      self.draw();
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return;
      self.c.style.cursor = 'grab';
      const dr = drag; drag = null;
      if (dr.dev && dr.moved) {
        const d = project.devices[dr.dev];
        const v = viewAt(d.x, d.y, self.bg);
        d.view = v; d.bg = self.bg;
        d.assumed = false;
        save(); recompute(); refreshAll();
        toast(v ? `ย้าย ${dr.dev} → ${project.views[v].name}` : `${dr.dev} อยู่นอกมุมมอง — ยังไม่มีเส้นทาง`);
      } else if (dr.rect && self.temp) {
        const t = self.temp; self.temp = null; self.draw();
        if (Math.abs(t.x1 - t.x0) > 4 && Math.abs(t.y1 - t.y0) > 4) self.opts.onRect && self.opts.onRect([Math.min(t.x0, t.x1), Math.min(t.y0, t.y1), Math.max(t.x0, t.x1), Math.max(t.y0, t.y1)]);
      } else if (dr.pan && !dr.moved && self.opts.onClick) {
        self.opts.onClick(dr.hit, dr.p);
      }
    });
  };
  function viewAt(x, y, bg) {
    let best = null, area = Infinity;
    Object.entries(project.views).forEach(([k, v]) => {
      const r = v.rect;
      if (bg && v.bg !== bg) return;
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
        const a = (r[2] - r[0]) * (r[3] - r[1]);
        if (a < area) { area = a; best = k; }
      }
    });
    return best;
  }
  MapView.prototype.hitDevice = function (x, y) {
    let best = null, bd = Infinity;
    Object.entries(project.devices).forEach(([k, d]) => {
      if (bgOfDev(d) !== this.bg) return;
      const hw = Math.max(d.w || 4, 2.5) / 2, hh = Math.max(d.h || 4, 2.5) / 2;
      if (x >= d.x - hw && x <= d.x + hw && y >= d.y - hh && y <= d.y + hh) {
        const dd = Math.abs(x - d.x) + Math.abs(y - d.y);
        if (dd < bd) { bd = dd; best = k; }
      }
    });
    return best;
  };
  function routeSegments(w) {
    const r = w.route, out = [];
    if (!r || !r.from || !r.to || !isFinite(r.len)) return out;
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
  const wireBg = (w) => { const d = project.devices[E.splitPin(w.a).dev]; return d ? bgOfDev(d) : null; };
  MapView.prototype.draw = function () {
    if (!this.w && !this.resize()) return;
    const ctx = this.ctx, s = this.scale, bgId = this.bg;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(-this.ox * s, -this.oy * s); ctx.scale(s, s);
    const bg = project.backgrounds[bgId], img = bgImages[bgId];
    if (bg && img && img.complete && img.naturalWidth) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(img, 0, 0, bg.ptWidth, bg.ptHeight);
      ctx.globalAlpha = 1;
    }
    // views
    const setup = ['view', 'ww', 'portal', 'del', 'device'].indexOf(this.mode) >= 0;
    Object.entries(project.views).forEach(([k, v]) => {
      if (v.bg !== bgId) return;
      ctx.lineWidth = 1 / s; ctx.setLineDash(setup ? [] : [5 / s, 4 / s]);
      ctx.strokeStyle = v.kind === 'graph' ? 'rgba(37, 99, 235, .55)' : 'rgba(22, 163, 74, .55)';
      ctx.strokeRect(v.rect[0], v.rect[1], v.rect[2] - v.rect[0], v.rect[3] - v.rect[1]);
      ctx.setLineDash([]);
      if (setup || s > 1.5) {
        ctx.fillStyle = v.kind === 'graph' ? '#1d4ed8' : '#15803d';
        ctx.font = `${11 / s}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`${k}${v.loc ? ' · ' + v.loc : ''}`, v.rect[0] + 2 / s, v.rect[1] + 2 / s);
      }
    });
    // wireways
    if (this.showWW) {
      ctx.lineCap = 'butt';
      model.segs.forEach((sg) => {
        if (project.views[sg.view].bg !== bgId) return;
        ctx.strokeStyle = 'rgba(56, 132, 255, .2)'; ctx.lineWidth = 7.5;
        ctx.beginPath(); ctx.moveTo(sg.x1, sg.y1); ctx.lineTo(sg.x2, sg.y2); ctx.stroke();
        if (setup) { ctx.strokeStyle = 'rgba(37,99,235,.9)'; ctx.lineWidth = 1 / s; ctx.stroke(); }
      });
      model.portals.forEach((p) => {
        const a = model.nodes[p.anchor], b = model.nodes[p.plate];
        const inA = project.views[a.view].bg === bgId, inB = project.views[b.view].bg === bgId;
        ctx.fillStyle = 'rgba(234,88,12,.85)';
        [[a, inA], [b, inB && setup]].forEach(([q, ok]) => {
          if (!ok) return;
          ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(1.6, 4 / s), 0, Math.PI * 2); ctx.fill();
        });
        if (inA && setup) {
          ctx.font = `${10 / s}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText(p.id, a.x + 3 / s, a.y - 2 / s);
        }
        if (setup && inA && inB) {
          ctx.strokeStyle = 'rgba(234,88,12,.6)'; ctx.lineWidth = 1 / s; ctx.setLineDash([4 / s, 3 / s]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        }
      });
    }
    const drawWire = (w, color, width, alpha) => {
      if (wireBg(w) !== bgId) return;
      ctx.strokeStyle = color;
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
      if (bgOfDev(d) !== bgId) return;
      const w = d.w || 4, h = d.h || 4, placed = d.view && project.views[d.view];
      ctx.lineWidth = 1 / s * 1.2;
      ctx.setLineDash(placed ? [] : [3 / s, 2 / s]);
      ctx.strokeStyle = d.assumed || !placed ? '#ea580c' : '#334155';
      ctx.fillStyle = selDev === k ? 'rgba(250, 204, 21, .55)' : d.assumed ? 'rgba(251, 146, 60, .25)' : 'rgba(255,255,255,.35)';
      ctx.fillRect(d.x - w / 2, d.y - h / 2, w, h);
      ctx.strokeRect(d.x - w / 2, d.y - h / 2, w, h);
      ctx.setLineDash([]);
      if (lbl) {
        ctx.fillStyle = '#0f172a';
        ctx.font = `${Math.max(1.4, 11 / s)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(k.replace(/^-/, ''), d.x, d.y - h / 2 - 7 / s);
      }
    });
    const hl = this.highlight;
    const colors = ['#e11d48', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
    hl.forEach((w, i) => drawWire(w, hl.length === 1 ? '#e11d48' : colors[i % colors.length], 3, 0.95));
    hl.forEach((w) => {
      if (wireBg(w) !== bgId) return;
      [w.route && w.route.from, w.route && w.route.to].forEach((p) => {
        if (!p) return;
        ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.arc(p.x, p.y, 4 / s, 0, Math.PI * 2); ctx.fill();
      });
    });
    // tool previews
    const t = this.temp;
    if (t) {
      ctx.strokeStyle = '#db2777'; ctx.lineWidth = 1.5 / s; ctx.setLineDash([4 / s, 3 / s]);
      if (t.kind === 'rect') ctx.strokeRect(t.x0, t.y0, t.x1 - t.x0, t.y1 - t.y0);
      else if (t.cur) {
        let x2 = t.cur[0], y2 = t.cur[1];
        if (t.kind === 'ww') { if (Math.abs(x2 - t.x) > Math.abs(y2 - t.y)) y2 = t.y; else x2 = t.x; }
        ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
  };
  MapView.prototype.centerOn = function (x, y, zoom) {
    if (zoom) this.scale = zoom;
    this.ox = x - this.w / 2 / this.scale; this.oy = y - this.h / 2 / this.scale;
    this.draw();
  };
  MapView.prototype.focusWires = function (list) {
    const pts = [];
    list.forEach((w) => { if (wireBg(w) === this.bg) routeSegments(w).forEach((g) => { pts.push([g.x1, g.y1], [g.x2, g.y2]); }); });
    if (!pts.length) { this.fit(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const pad = 12;
    this.fit([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
  };

  let mini, big;
  function setupMaps() {
    mini = new MapView($('#miniMap'), { onClick: (dev) => { if (dev) { $('#wSearch').value = dev; renderWires(); } } });
    big = new MapView($('#layoutMap'), { onClick: onLayoutClick, onRect: onLayoutRect });
    const first = Object.keys(project.backgrounds)[0] || null;
    mini.bg = big.bg = first;
    window.addEventListener('resize', () => { if (mini.resize()) mini.draw(); if (big.resize()) big.draw(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && big.temp) { big.temp = null; big.draw(); } });
  }
  function selectWire(id) {
    selWire = id;
    const w = wires[id];
    $$('#wireTable tr.sel').forEach((tr) => tr.classList.remove('sel'));
    const tr = document.querySelector(`#wireTable tr[data-id="${id}"]`);
    if (tr) tr.classList.add('sel');
    const netWires = wires.filter((x) => x.net === w.net && x.loc === w.loc);
    const b = wireBg(w); if (b) mini.bg = b;
    mini.highlight = [w];
    mini.resize(); mini.focusWires(netWires);
    const net = project.nets[w.net];
    const list = netWires.map((x) => `${x.cmp1}.${x.pin1} → ${x.cmp2}.${x.pin2}`).join('<br>');
    $('#miniInfo').innerHTML = `<b>${esc(w.wire)}</b> (Sheet ${esc(net.sheet)}${locs().length > 1 ? ', ' + esc(w.loc) : ''}) · ${esc(w.cmp1)}.${esc(w.pin1)} → ${esc(w.cmp2)}.${esc(w.pin2)} · ${isFinite(w.len) ? Math.round(w.len) + ' mm' : 'ยังไม่มีเส้นทาง'} · ${esc((w.via || []).join(' › '))}` +
      `<details><summary>ลำดับพ่วงทั้ง node (${netWires.length} เส้น)</summary><div class="mono">${list}</div></details>`;
  }
  function selectDevice(dev) {
    selDev = dev || null;
    big.highlight = dev ? wires.filter((w) => E.splitPin(w.a).dev === dev || E.splitPin(w.b).dev === dev) : [];
    big.draw();
    if (dev) {
      const d = project.devices[dev];
      const v = d.view && project.views[d.view];
      toast(`${dev} · ${d.desc || ''} · ${v ? v.name : 'ยังไม่อยู่ในมุมมอง'}${d.assumed ? ' · ตำแหน่งสมมติ' : ''} · ${big.highlight.length} เส้น`);
    }
  }

  // ---------------------------------------------------------------- layout setup tools
  const HINTS = {
    pan: 'ล้อเมาส์ = ซูม · ลากพื้นหลัง = เลื่อน · คลิกอุปกรณ์ = ดูสายที่ต่อ',
    move: 'ลากกล่องอุปกรณ์ไปตำแหน่งจริง (ปล่อยในกรอบมุมมองใดก็ได้)',
    device: 'คลิกตำแหน่งที่จะวางอุปกรณ์ แล้วใส่ชื่อ เช่น -K1 หรือ +RCC-X3',
    view: 'ลากกรอบครอบ mounting plate / บานประตู / ผนังข้าง แล้วกรอกขนาดจริง',
    ww: 'คลิกจุดเริ่มและจุดสิ้นสุดของรางวายเวย์ (บน mounting plate) — จับแนวตั้ง/แนวนอนให้อัตโนมัติ · Esc = ยกเลิก',
    portal: 'คลิกจุดที่ 1 (เช่น บานพับประตู หรือปลายรางบนผนังข้าง) แล้วคลิกจุดที่ 2 บนรางวายเวย์ของแผงที่สายวิ่งเข้า · Esc = ยกเลิก',
    del: 'คลิกรางวายเวย์ จุดเชื่อม อุปกรณ์ หรือในกรอบมุมมองเพื่อลบ'
  };
  function nearestSeg(p, maxD, viewFilter) {
    let best = null, bd = maxD;
    model.segs.forEach((sg) => {
      if (project.views[sg.view].bg !== big.bg) return;
      if (viewFilter && sg.view !== viewFilter) return;
      const H = Math.abs(sg.y1 - sg.y2) < 1e-6;
      const d = H ? (p[0] >= Math.min(sg.x1, sg.x2) - 1 && p[0] <= Math.max(sg.x1, sg.x2) + 1 ? Math.abs(p[1] - sg.y1) : Infinity)
        : (p[1] >= Math.min(sg.y1, sg.y2) - 1 && p[1] <= Math.max(sg.y1, sg.y2) + 1 ? Math.abs(p[0] - sg.x1) : Infinity);
      if (d < bd) { bd = d; best = sg; }
    });
    return best;
  }
  function snapWireway(view, x1, y1, x2, y2) {
    const H = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    const same = project.wireways.filter((w) => (w[5] || 'PLATE') === view);
    const tol = 6;
    const snap = (v, list) => { let b = v, bd = tol; list.forEach((c) => { if (Math.abs(c - v) < bd) { bd = Math.abs(c - v); b = c; } }); return b; };
    const vx = same.filter((w) => w[1] === w[3]).map((w) => w[1]);
    const hy = same.filter((w) => w[2] === w[4]).map((w) => w[2]);
    if (H) { const y = snap(y1, hy); return [snap(x1, vx), y, snap(x2, vx), y]; }
    const x = snap(x1, vx);
    return [x, snap(y1, hy), x, snap(y2, hy)];
  }
  function onLayoutClick(dev, p) {
    const m = big.mode;
    if (m === 'pan' || m === 'move') { selectDevice(dev); return; }
    if (m === 'device') {
      const name = (prompt('ชื่ออุปกรณ์ (เช่น -K1, -43CA, +RCC-X3):', '') || '').trim();
      if (!name) return;
      if (project.devices[name] && !confirm(name + ' มีอยู่แล้ว — ย้ายมาตำแหน่งนี้?')) return;
      const v = viewAt(p[0], p[1], big.bg);
      const isTB = /(^|-)(TB|X)\d|TB-?X/i.test(name);
      if (project.devices[name] && /^เพิ่มจาก Netlist/.test(project.devices[name].desc || '')) project.devices[name].desc = '';
      project.devices[name] = Object.assign(project.devices[name] || { desc: '' }, { view: v, bg: big.bg, x: +p[0].toFixed(2), y: +p[1].toFixed(2), w: isTB ? 5 : 5, h: isTB ? 30 : 5, assumed: false });
      save(); recompute(); refreshAll();
      return;
    }
    if (m === 'ww') {
      const v = viewAt(p[0], p[1], big.bg);
      if (!big.temp) {
        if (!v || project.views[v].kind !== 'graph') { toast('เริ่มรางวายเวย์ภายในกรอบมุมมองชนิด Mounting plate'); return; }
        big.temp = { kind: 'ww', x: p[0], y: p[1], view: v };
        return;
      }
      const t = big.temp; big.temp = null;
      const s = snapWireway(t.view, t.x, t.y, p[0], p[1]);
      if (Math.abs(s[0] - s[2]) + Math.abs(s[1] - s[3]) < 2) { big.draw(); return; }
      let n = project.wireways.length + 1; while (project.wireways.some((w) => w[0] === 'W' + n)) n++;
      project.wireways.push(['W' + n, +s[0].toFixed(2), +s[1].toFixed(2), +s[2].toFixed(2), +s[3].toFixed(2), t.view]);
      save(); recompute(); refreshAll();
      return;
    }
    if (m === 'portal') {
      const v = viewAt(p[0], p[1], big.bg);
      if (!big.temp) {
        if (!v) { toast('คลิกจุดเริ่มภายในกรอบมุมมอง (เช่น บานพับประตู หรือปลายรางบนผนังข้าง)'); return; }
        big.temp = { kind: 'portal', x: p[0], y: p[1], view: v };
        return;
      }
      const t = big.temp; big.temp = null;
      if (!v || v === t.view) { toast('จุดที่สองต้องอยู่ในมุมมองอื่น (เช่น รางวายเวย์บน mounting plate)'); big.draw(); return; }
      let px = p[0], py = p[1];
      if (project.views[v].kind === 'graph') {
        const sg = nearestSeg(p, 8, v);
        if (!sg) { toast('คลิกให้ใกล้รางวายเวย์ของมุมมอง ' + v); big.draw(); return; }
        const H = Math.abs(sg.y1 - sg.y2) < 1e-6;
        px = H ? p[0] : sg.x1; py = H ? sg.y1 : p[1];
      }
      const door = project.views[t.view].kind === 'free' || project.views[v].kind === 'free';
      const extra = +(prompt('ความยาวเผื่อของชุดสายผ่านจุดนี้ (mm)\n— บานพับประตู/swing panel มัก 400-600\n— ข้ามจากผนังข้างไปแผงหลัก 100-300', door ? '500' : '200') || 0);
      let n = project.portals.length + 1; while (project.portals.some((q) => q[0] === 'J' + n)) n++;
      const id = (prompt('ชื่อจุดเชื่อม (เช่น HINGE-L, SIDE-A):', door ? 'HINGE-' + n : 'J' + n) || 'J' + n).trim();
      project.portals.push([id, t.view, +t.x.toFixed(2), +t.y.toFixed(2), +px.toFixed(2), +py.toFixed(2), extra, v, true]);
      save(); recompute(); refreshAll();
      return;
    }
    if (m === 'del') {
      if (dev) { if (confirm('ลบอุปกรณ์ ' + dev + ' ? (node ที่อ้างถึงจะไม่มีตำแหน่ง)')) { delete project.devices[dev]; save(); recompute(); refreshAll(); } return; }
      const pt = project.portals.findIndex((q) => project.views[q[1]] && project.views[q[1]].bg === big.bg && Math.hypot(q[2] - p[0], q[3] - p[1]) < 5 / Math.min(big.scale, 2) + 2);
      if (pt >= 0) { if (confirm('ลบจุดเชื่อม ' + project.portals[pt][0] + ' ?')) { project.portals.splice(pt, 1); save(); recompute(); refreshAll(); } return; }
      const sg = nearestSeg(p, 4);
      if (sg) { if (confirm('ลบรางวายเวย์ ' + sg.id + ' ?')) { project.wireways = project.wireways.filter((w) => w[0] !== sg.id); save(); recompute(); refreshAll(); } return; }
      const v = viewAt(p[0], p[1], big.bg);
      if (v && confirm(`ลบมุมมอง ${v} (${project.views[v].name}) ? อุปกรณ์ในกรอบจะยังอยู่แต่ไม่มีเส้นทาง`)) {
        delete project.views[v];
        project.wireways = project.wireways.filter((w) => (w[5] || 'PLATE') !== v);
        project.portals = project.portals.filter((q) => q[1] !== v && (q[7] || 'PLATE') !== v);
        Object.values(project.devices).forEach((d) => { if (d.view === v) { d.bg = big.bg; d.view = null; } });
        save(); recompute(); refreshAll();
      }
    }
  }
  function onLayoutRect(rect) {
    const bgId = big.bg;
    const bg = project.backgrounds[bgId] || {};
    const defLoc = bg.loc || project.meta.loc || '';
    modal('มุมมองใหม่', `
      <div class="form">
        <label>รหัสมุมมอง (ไม่ซ้ำ เช่น RCC_PLATE, RCC_DOOR)<input id="fvId" value="${esc((defLoc.replace(/\W/g, '') || 'V') + '_' + (Object.keys(project.views).length + 1))}"></label>
        <label>ชื่อ<input id="fvName" value="Mounting plate"></label>
        <label>ชนิด<select id="fvKind"><option value="graph">Mounting plate — สายวิ่งตามรางวายเวย์</option><option value="free">ประตู / swing panel / ผนังข้าง — สายวิ่งตรงไปจุดเชื่อม (บานพับ)</option></select></label>
        <label>ตู้ (LOC.)<input id="fvLoc" value="${esc(defLoc)}" placeholder="เช่น LCC. หรือ RCC."></label>
        <label>ความกว้างจริงของกรอบที่ลาก (mm) — ใช้คำนวณมาตราส่วน<input id="fvW" type="number" value="1000"></label>
        <p class="note">กรอบกว้าง ${(rect[2] - rect[0]).toFixed(1)} pt × สูง ${(rect[3] - rect[1]).toFixed(1)} pt บนหน้า ${esc(bg.name || bgId)} · อ่านขนาดจากเส้นบอกขนาดใน Outline</p>
      </div>`,
    [['ยกเลิก', null], ['สร้างมุมมอง', () => {
      const id = $('#fvId').value.trim().replace(/\s+/g, '_');
      if (!id || project.views[id]) { toast('รหัสมุมมองว่างหรือซ้ำ'); return; }
      const wmm = +$('#fvW').value || 1000;
      const sc = wmm / (rect[2] - rect[0]);
      project.views[id] = {
        name: $('#fvName').value.trim() || id, kind: $('#fvKind').value, rect: rect.map((v) => +v.toFixed(2)),
        bg: bgId, loc: $('#fvLoc').value.trim(), map: { x: [rect[0], +sc.toFixed(4)], y: [rect[1], +sc.toFixed(4)], z: 0 }
      };
      let n = 0;
      Object.values(project.devices).forEach((d) => {
        if (bgOfDev(d) === bgId && d.x >= rect[0] && d.x <= rect[2] && d.y >= rect[1] && d.y <= rect[3]) { d.view = viewAt(d.x, d.y, bgId); n++; }
      });
      save(); recompute(); refreshAll();
      toast(`สร้างมุมมอง ${id} แล้ว (${n} อุปกรณ์อยู่ในกรอบ)${project.views[id].kind === 'graph' ? ' — ต่อไปวาดรางวายเวย์' : ' — ต่อไปกำหนดจุดเชื่อม/บานพับ'}`, 5000);
    }]]);
  }

  // ---------------------------------------------------------------- layout tab lists
  function renderBgSelect() {
    const sel = $('#lBg');
    const keys = Object.keys(project.backgrounds);
    sel.innerHTML = keys.length ? keys.map((k) => `<option value="${esc(k)}">${esc(project.backgrounds[k].name || k)}${project.backgrounds[k].loc ? ' (' + esc(project.backgrounds[k].loc) + ')' : ''}</option>`).join('')
      : '<option value="">— ยังไม่มีหน้า Outline —</option>';
    if (big.bg && keys.indexOf(big.bg) < 0) big.bg = keys[0] || null;
    if (!big.bg) big.bg = keys[0] || null;
    sel.value = big.bg || '';
  }
  function renderDevList() {
    const q = $('#dSearch').value.trim().toLowerCase();
    const items = Object.entries(project.devices)
      .filter(([k, d]) => !q || (k + ' ' + (d.desc || '')).toLowerCase().includes(q))
      .sort((a, b) => ((!b[1].view) - (!a[1].view)) || ((b[1].assumed ? 1 : 0) - (a[1].assumed ? 1 : 0)) || a[0].localeCompare(b[0], undefined, { numeric: true }));
    $('#devList').innerHTML = items.map(([k, d]) =>
      `<div class="devitem ${d.assumed || !d.view ? 'assumed' : ''}" data-dev="${esc(k)}"><span><b>${esc(k)}</b><br><span class="vw">${esc(d.desc || '')}</span></span><span class="vw">${esc(d.view || 'ยังไม่วาง')}</span></div>`).join('');
  }
  function renderNetSelect() {
    const sel = $('#lNet');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— เลือกเบอร์สายเพื่อไฮไลต์ —</option>' + project.nets.map((n, i) => `<option value="${i}">${esc(n.wire)}  (Sh.${esc(n.sheet)})</option>`).join('');
    sel.value = cur;
  }

  // ---------------------------------------------------------------- netlist tab
  function pinsToText(net) {
    return net.pins.map((p) => (p[1] && p[1] !== net.sheet ? `${p[0]}@${p[1]}` : p[0])).join(' ');
  }
  // accepts DEV:PIN, or the drawing notation DEV.PIN (e.g. -X3.201, +RCC-X3.201, -TBL-X2.101)
  function normPin(t) {
    if (t === 'GND' || t.indexOf(':') >= 0) return t;
    const i = t.lastIndexOf('.');
    return i > 0 ? t.slice(0, i) + ':' + t.slice(i + 1) : t;
  }
  function textToPins(txt, sheet) {
    return txt.split(/[\s,;]+/).filter(Boolean).map((t) => {
      const i = t.lastIndexOf('@');
      return i > 0 ? [normPin(t.slice(0, i)), t.slice(i + 1)] : [normPin(t), sheet];
    });
  }
  function fixedToText(net) { return (net.fixed || []).map((f) => f[0] + '>' + f[1]).join(' '); }
  function textToFixed(txt) {
    return txt.split(/[\s,;]+/).filter(Boolean).map((t) => t.split('>').map(normPin)).filter((p) => p.length === 2);
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
      const cls = `<select data-f="cls">${clsOpts.map((c) => `<option value="${esc(c)}" ${c === (n.cls || '') ? 'selected' : ''}>${esc(c ? c + ' — ' + (cableText(c) || 'ยังไม่กำหนดสี') : '(ว่าง)')}</option>`).join('')}</select>`;
      const warn = r && r.warnings.length ? `<br><span class="hint" style="color:var(--warn)">${esc(r.warnings.slice(0, 2).join(' · '))}</span>` : '';
      return `<tr data-i="${i}">
        <td><input data-f="wire" value="${esc(n.wire)}" style="width:70px"></td>
        <td><input data-f="sheet" value="${esc(n.sheet)}" style="width:44px"></td>
        <td style="min-width:150px">${cls}</td>
        <td style="min-width:320px"><textarea data-f="pins" rows="${Math.min(6, 1 + Math.floor(pinsToText(n).length / 70))}">${esc(pinsToText(n))}</textarea>${warn}</td>
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
    if (bad.length) {
      bad.forEach((b) => { project.devices[E.splitPin(b[0]).dev] = { view: null, bg: big.bg, x: 0, y: 0, w: 5, h: 5, desc: 'เพิ่มจาก Netlist — ยังไม่วาง', assumed: false }; });
      toast('เพิ่มอุปกรณ์ใหม่ (ยังไม่วางตำแหน่ง): ' + bad.map((b) => E.splitPin(b[0]).dev).join(', ') + ' — ไปวางในแท็บผังอุปกรณ์', 6000);
    }
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
    pdfName = file.name;
    const sel = $('#pPage');
    sel.innerHTML = Array.from({ length: pdfDoc.numPages }, (_, i) => `<option value="${i + 1}">หน้า ${i + 1}</option>`).join('');
    $('#pInfo').textContent = `${file.name} · ${pdfDoc.numPages} หน้า`;
    if ($('#aPdfName')) $('#aPdfName').textContent = `${file.name} · ${pdfDoc.numPages} หน้า`;
    pdfPage = Math.min(pdfDoc.numPages, parseInt((project.meta.sheets || '1'), 10) || 1);
    sel.value = String(pdfPage);
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
  // device designations written as text on an outline page
  const NOT_DEV = /^(IP\d+|M\d+|SS\d+|\d+(\.\d+)?[VAW]|\d+X\d+.*|[A-I]|\d+)$/i;
  function asDevName(s) {
    s = s.trim();
    let m = s.match(/^([A-Z]{2,4})-TB-(X\w+)$/);           // LCC-TB-X3 -> +LCC-X3
    if (m) return '+' + m[1] + '-' + m[2];
    if (NOT_DEV.test(s)) return null;
    if (s.indexOf('.') >= 0 && !/^-?\+?(TB-?)?X\d+\.\d$/i.test(s)) return null;   // 'AC.220V', 'GP.1' are nameplate text
    if (!/^-?\+?[A-Z0-9][A-Z0-9.\-]{0,10}$/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s)) return null;
    return s.startsWith('-') || s.startsWith('+') ? s : '-' + s;
  }
  async function extractOutline(addAsNew) {
    if (!pdfDoc) { toast('เปิดไฟล์ PDF ก่อน (ปุ่ม 📄 เปิด PDF)'); return; }
    const cur = project.backgrounds[big.bg];
    const pg = +(prompt('หน้า Outline drawing ใน PDF (หน้าที่มีอุปกรณ์ภายในตู้):', String(addAsNew ? '' : (cur && cur.page) || project.meta.outlineSheet || '')) || 0);
    if (!pg || pg > pdfDoc.numPages) return;
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
      s.split(/\s+/).forEach((tok) => {
        const cands = [tok, '-' + tok.replace(/^-/, '')];
        let name = cands.find((c) => project.devices[c] && !project.terminals[c] && c !== 'GND');
        let isNew = false;
        if (!name) { name = asDevName(tok); isNew = true; }
        if (!name) return;
        (found[name] = found[name] || { pts: [], isNew: isNew && !project.devices[name] }).pts.push([cx, cy]);
      });
    });
    const names = Object.keys(found).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const nNew = names.filter((n) => found[n].isNew).length;
    const bgName = `${pdfName.replace(/\.pdf$/i, '')} หน้า ${pg}`;
    const rows = names.map((n) => {
      const d = project.devices[n], p = found[n].pts[0];
      const dist = d && bgOfDev(d) === big.bg ? Math.hypot(d.x - p[0], d.y - p[1]) : Infinity;
      const chk = found[n].isNew || (d && (d.assumed || !d.view)) || (!addAsNew && dist > 15);
      return `<tr><td><input type="checkbox" data-n="${esc(n)}" ${chk ? 'checked' : ''}></td><td class="mono">${esc(n)}</td><td>${found[n].isNew ? '<span class="tag">ใหม่</span>' : ''}</td><td class="num">${d && isFinite(dist) ? d.x.toFixed(1) + ', ' + d.y.toFixed(1) : '—'}</td><td class="num">${p[0].toFixed(1)}, ${p[1].toFixed(1)}</td><td>${found[n].pts.length > 1 ? 'พบ ' + found[n].pts.length + ' จุด' : ''}</td></tr>`;
    }).join('');
    modal(`หน้า ${pg}: พบชื่ออุปกรณ์เป็นข้อความ ${names.length} รายการ (ใหม่ ${nNew})`,
      `<p class="note">ตำแหน่งจาก PDF คือกึ่งกลาง<b>ป้ายชื่อ</b> (อาจอยู่เหนืออุปกรณ์เล็กน้อย) · ถ้าพบน้อยแสดงว่าชื่อในหน้านี้เป็นเส้น vector — ใช้เครื่องมือ “＋ วางอุปกรณ์” แทน</p>
       <div class="form" style="grid-template-columns:1fr 1fr;margin-bottom:8px">
         <label>ภาพพื้นหลัง<select id="fxBg"><option value="new" ${addAsNew || !cur ? 'selected' : ''}>เพิ่มเป็นหน้า Outline ใหม่</option>${cur ? `<option value="cur" ${addAsNew ? '' : 'selected'}>แทนที่หน้าปัจจุบัน (${esc(cur.name || big.bg)})</option>` : ''}</select></label>
         <label>ตู้ (LOC.) ของหน้านี้<input id="fxLoc" value="${esc((cur && !addAsNew && cur.loc) || project.meta.loc || '')}" placeholder="เช่น LCC. / RCC."></label>
       </div>
       <div class="tablewrap" style="max-height:45vh"><table class="grid"><tr><th><input type="checkbox" onclick="document.querySelectorAll('#modalBody input[data-n]').forEach(function(c){c.checked=this.checked}, this)" title="เลือกทั้งหมด"></th><th>อุปกรณ์</th><th></th><th>เดิม (pt)</th><th>จาก PDF (pt)</th><th></th></tr>${rows}</table></div>`,
      [['ยกเลิก', null], ['นำเข้า', async () => {
        const mode = $('#fxBg').value, loc = $('#fxLoc').value.trim();
        let bgId = big.bg;
        if (mode === 'new' || !bgId) {
          bgId = 'bg' + (Object.keys(project.backgrounds).length + 1);
          while (project.backgrounds[bgId]) bgId += '_';
        }
        await setBackgroundFromPdf(page, vp, bgId, bgName, pg, loc);
        let n = 0;
        $$('#modalBody input[data-n]').forEach((cb) => {
          if (!cb.checked) return;
          let name = cb.dataset.n;
          const p = found[name].pts[0];
          // terminal blocks repeat in every cabinet (X1..X8): key them by cabinet, e.g. X3 -> +RCC-X3
          if (loc && found[name].isNew && /^-(TB-?)?X\d/i.test(name)) name = '+' + loc.replace(/\W/g, '') + '-' + name.slice(1).replace(/^TB-?/i, '');
          const d = project.devices[name] || (project.devices[name] = { desc: '', w: /(^|-)(TB|X)\d|-X\d/.test(name) ? 5 : 5, h: 5 });
          d.x = +p[0].toFixed(2); d.y = +p[1].toFixed(2); d.bg = bgId;
          d.view = viewAt(d.x, d.y, bgId);
          if (loc && !d.view) d.loc = loc;
          d.assumed = false; n++;
        });
        big.bg = bgId; big._fitted = false;
        save(); recompute(); refreshAll(); big.fit();
        toast(`นำเข้า ${n} อุปกรณ์บนหน้า ${pg} แล้ว — ต่อไปวาดมุมมองและรางวายเวย์`, 5000);
      }]]);
  }
  async function setBackgroundFromPdf(page, vp1, bgId, name, pg, loc) {
    const vp = page.getViewport({ scale: 2.5 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const url = cv.toDataURL('image/jpeg', 0.8);
    const old = project.backgrounds[bgId] || {};
    project.backgrounds[bgId] = { src: url, ptWidth: vp1.width, ptHeight: vp1.height, name: name || old.name || bgId, page: pg, loc: loc || old.loc || '' };
    loadBg(bgId);
  }
  function loadBg(id) {
    const ids = id ? [id] : Object.keys(project.backgrounds);
    ids.forEach((k) => {
      const img = new Image();
      img.onload = () => { mini.draw(); big.draw(); };
      img.src = project.backgrounds[k].src;
      bgImages[k] = img;
    });
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
    ['title', 'หัวเรื่อง (แถวที่ 1)'], ['panelName', 'ชื่อตู้ / ชุดตู้'], ['loc', 'LOC. ตั้งต้น (เช่น TCC., LCC.)'],
    ['processNo', 'Process No.'], ['drawingNo', 'Drawing No. (Wiring list)'], ['schematicDwg', 'Schematic drawing no.'],
    ['sheets', 'Sheet วงจรที่ใช้ (เช่น 07-22)'], ['project', 'Project'], ['contract', 'Contract no.'], ['rev', 'Rev.']
  ];
  function renderSettings() {
    const m = project.meta;
    $('#metaForm').innerHTML = META_FIELDS.map(([k, l]) => `<label>${esc(l)}<input data-meta="${k}" value="${esc(m[k] || '')}"></label>`).join('');
    $('#sMode').value = project.settings.mode;
    $('#sAllow').value = project.settings.allow;
    $('#sRound').value = project.settings.round;
    $('#sJump').value = project.settings.jumper;
    $('#cableTable').innerHTML = '<table class="grid"><tr><th>รหัส</th><th>วงจร</th><th>สี</th><th>ขนาด</th><th></th></tr>' +
      Object.entries(project.cable).filter(([k]) => k).map(([k, c]) =>
        `<tr data-c="${esc(k)}"><td class="mono">${esc(k)}</td><td><input data-cf="label" value="${esc(c.label)}"></td><td><input data-cf="color" value="${esc(c.color)}" style="width:60px"></td><td><input data-cf="size" value="${esc(c.size)}" style="width:60px"></td><td><button class="iconbtn" data-delcls="${esc(k)}" title="ลบ">✕</button></td></tr>`).join('') + '</table>';
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
  function ensureDevicesFor(nets) {
    const added = [];
    nets.forEach((n) => n.pins.forEach((p) => {
      const dev = E.splitPin(p[0]).dev;
      if (p[0] !== 'GND' && !project.devices[dev]) { project.devices[dev] = { view: null, bg: big.bg, x: 0, y: 0, w: 5, h: 5, desc: 'เพิ่มจาก Netlist — ยังไม่วาง', assumed: false }; added.push(dev); }
    }));
    if (!project.devices.GND && nets.some((n) => n.pins.some((p) => p[0] === 'GND'))) { project.devices.GND = { view: null, bg: big.bg, x: 0, y: 0, w: 20, h: 2, desc: 'Earth bar', assumed: false }; added.push('GND'); }
    return added;
  }

  // ---------------------------------------------------------------- new project
  function newProject() {
    modal('โปรเจกต์ใหม่', `
      <p class="note">เริ่มจากโปรเจกต์ว่างสำหรับตู้/แบบอื่น (โปรเจกต์ปัจจุบันจะถูกแทนที่ในเบราว์เซอร์ — กด 💾 บันทึกโปรเจกต์ เก็บไว้ก่อนถ้าต้องการ)</p>
      <div class="form">
        <label>Process No.<input id="npProc" placeholder="เช่น PP0993B"></label>
        <label>ตู้ (คั่นด้วย , ถ้ามีหลายตู้)<input id="npLocs" value="LCC., RCC."></label>
        <label>Schematic drawing no.<input id="npDwg" placeholder="เช่น CD-PP0993B-4S1"></label>
        <label>Sheet วงจร<input id="npSheets" placeholder="เช่น 16-38"></label>
        <label>Project<input id="npProj"></label>
      </div>
      <p class="note">ขั้นตอนต่อไป: 📄 เปิด PDF → แท็บผังอุปกรณ์ “+ หน้า Outline” (ทำทีละตู้) → วาดมุมมอง / รางวายเวย์ / บานพับ → วางอุปกรณ์ → แท็บ Netlist เพิ่ม node หรือนำเข้า CSV → ตั้งค่าสี/ขนาดสายตาม General spec</p>`,
    [['ยกเลิก', null], ['สร้าง', () => {
      const L = $('#npLocs').value.split(',').map((s) => s.trim()).filter(Boolean);
      const proc = $('#npProc').value.trim() || 'NEW';
      project = migrate({
        version: BASE.version,
        meta: {
          project: $('#npProj').value.trim() || '(TBD)', processNo: proc, schematicDwg: $('#npDwg').value.trim(), drawingNo: '(TBD)',
          contract: '(TBD)', loc: L[0] || 'LCC.', panelName: L.join(' / '), title: `${(L[0] || 'LCC.').replace(/\.$/, '')} INTERNAL CABLE WIRING ${proc}`,
          rev: '0', sheets: $('#npSheets').value.trim(), outlineSheet: ''
        },
        cable: clone(NEW_CABLE), views: {}, wireways: [], portals: [], devices: {}, terminals: {}, bars: {}, nets: [],
        backgrounds: {}, anomalies: [], noInternal: {}
      });
      big.bg = mini.bg = null; selWire = null; selDev = null;
      save(); recompute(); renderSettings(); refreshAll();
      toast('สร้างโปรเจกต์ใหม่แล้ว — เปิด PDF แล้วเพิ่มหน้า Outline', 5000);
    }]]);
  }

  // ---------------------------------------------------------------- wiring
  function refreshAll(skip) {
    skip = skip || [];
    renderOverview();
    sheetOptions($('#wSheet')); sheetOptions($('#nSheet')); locOptions();
    renderWires();
    if (skip.indexOf('nets') < 0) renderNets();
    renderBgSelect(); renderDevList(); renderNetSelect();
    if (!mini.bg || !project.backgrounds[mini.bg]) mini.bg = big.bg;
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
    ['#wSearch', '#wSheet', '#wSort', '#wBlank', '#wRemark', '#wLoc'].forEach((s) => $(s).addEventListener('input', renderWires));
    $('#wireTable').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) selectWire(+tr.dataset.id);
    });
    // layout
    $('#lMode').addEventListener('change', (e) => { big.mode = e.target.value; big.temp = null; $('#lHint').textContent = HINTS[big.mode]; big.draw(); });
    $('#lBg').addEventListener('change', (e) => { big.bg = e.target.value; big.fit(); });
    $('#lAddBg').addEventListener('click', () => extractOutline(true));
    $('#lWire').addEventListener('change', (e) => { big.showWW = e.target.checked; big.draw(); });
    $('#lAll').addEventListener('change', (e) => { big.showAll = e.target.checked; big.draw(); });
    $('#lFit').addEventListener('click', () => big.fit());
    $('#lNet').addEventListener('change', (e) => {
      const i = e.target.value;
      big.highlight = i === '' ? [] : wires.filter((w) => w.net === +i);
      if (big.highlight.length) { const b = wireBg(big.highlight[0]); if (b && b !== big.bg) { big.bg = b; $('#lBg').value = b; } big.focusWires(big.highlight); } else big.draw();
    });
    $('#lExtract').addEventListener('click', () => extractOutline(false));
    $('#dSearch').addEventListener('input', renderDevList);
    $('#devList').addEventListener('click', (e) => {
      const it = e.target.closest('[data-dev]');
      if (!it) return;
      const name = it.dataset.dev, d = project.devices[name];
      const b = bgOfDev(d);
      if (b && b !== big.bg) { big.bg = b; $('#lBg').value = b; }
      selectDevice(name);
      if (!d.view && !d.x) { toast(`${name} ยังไม่ได้วาง — เลือกเครื่องมือ “＋ วางอุปกรณ์” แล้วคลิกตำแหน่ง ใส่ชื่อ ${name}`, 5000); return; }
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
      const apply = (replace) => {
        project.nets = replace ? nets : project.nets.concat(nets);
        const added = ensureDevicesFor(nets);
        save(); recompute(); refreshAll();
        if (added.length) toast(`เพิ่มอุปกรณ์ใหม่ ${added.length} รายการ (ยังไม่วางตำแหน่ง)`, 5000);
      };
      modal('นำเข้า Netlist', `<p>พบ ${nets.length} node ในไฟล์ <b>${esc(f.name)}</b></p><p class="note">อุปกรณ์ที่ยังไม่มีในโปรเจกต์จะถูกเพิ่มเป็น “ยังไม่วาง”</p>`,
        [['ยกเลิก', null], ['เพิ่มต่อท้าย', () => apply(false)], ['แทนที่ทั้งหมด', () => apply(true)]]);
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
    $('#btnNewProj').addEventListener('click', newProject);
    $('#btnSaveProj').addEventListener('click', () => {
      download(`wiring_project_${project.meta.processNo}.json`, new Blob([JSON.stringify(project, null, 1)], { type: 'application/json' }));
    });
    $('#projFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const p = JSON.parse(await f.text());
        if (!p.nets || !p.devices || !p.views) throw new Error('ไม่ใช่ไฟล์โปรเจกต์');
        project = migrate(p);
        big.bg = mini.bg = Object.keys(project.backgrounds)[0] || null; big._fitted = mini._fitted = false;
        save(); recompute(); loadBg(); renderSettings(); refreshAll(); toast('โหลดโปรเจกต์แล้ว');
      } catch (err) { toast('โหลดไม่ได้: ' + err.message); }
      e.target.value = '';
    });
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('ล้างการแก้ไขทั้งหมดและกลับไปใช้ข้อมูลตั้งต้น (PP1047A TCC)?')) return;
      project = migrate(clone(BASE));
      big.bg = mini.bg = Object.keys(project.backgrounds)[0]; big._fitted = mini._fitted = false;
      save(); recompute(); loadBg(); renderSettings(); refreshAll(); toast('รีเซ็ตแล้ว');
    });
    // settings
    $('#metaForm').addEventListener('input', (e) => { const k = e.target.dataset.meta; if (k) { project.meta[k] = e.target.value; save(); renderOverview(); } });
    $('#sMode').addEventListener('change', (e) => { project.settings.mode = e.target.value; save(); recompute(); refreshAll(); });
    $('#sAllow').addEventListener('change', (e) => { project.settings.allow = Math.max(0, +e.target.value || 0); save(); recompute(); refreshAll(); });
    $('#sJump').addEventListener('change', (e) => { project.settings.jumper = Math.max(0, +e.target.value || 0); save(); recompute(); refreshAll(); });
    $('#sRound').addEventListener('change', (e) => { project.settings.round = Math.max(1, +e.target.value || 1); save(); recompute(); refreshAll(); });
    $('#cableTable').addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-c]'); if (!tr || !e.target.dataset.cf) return;
      project.cable[tr.dataset.c][e.target.dataset.cf] = e.target.value.trim();
      save(); refreshAll();
    });
    $('#cableTable').addEventListener('click', (e) => {
      const k = e.target.dataset && e.target.dataset.delcls;
      if (!k) return;
      const used = project.nets.filter((n) => n.cls === k).length;
      if (!confirm(`ลบประเภท ${k}?${used ? ` (${used} node ที่ใช้อยู่จะกลายเป็นว่าง)` : ''}`)) return;
      delete project.cable[k];
      project.nets.forEach((n) => { if (n.cls === k) n.cls = ''; });
      save(); renderSettings(); recompute(); refreshAll();
    });
    $('#btnAddCls').addEventListener('click', () => {
      const k = (prompt('รหัสประเภทวงจร (ภาษาอังกฤษ เช่น AC_PWR_FAN):', '') || '').trim().toUpperCase().replace(/\W/g, '_');
      if (!k || project.cable[k]) return;
      project.cable[k] = { label: prompt('ชื่อวงจร (ตาม General spec):', k) || k, color: '', size: '' };
      save(); renderSettings(); refreshAll();
    });
    // excel
    $('#btnExcel').addEventListener('click', async () => {
      const btn = $('#btnExcel');
      try {
        btn.disabled = true;
        const blob = await window.WiringExport.toExcel(project, wires, plan, { sort: $('#wSort').value, sortedWires: sortedWires, cableText: cableText, model: model });
        const L = locs();
        const tag = L.length > 1 ? L.map((l) => l.replace(/\W/g, '')).join('_') : (project.meta.loc || '').replace(/\W/g, '');
        download(`Internal_Wiring_${tag}_${project.meta.processNo}.xlsx`, blob);
        toast('ส่งออก Excel แล้ว');
      } catch (err) { toast('ส่งออกไม่ได้: ' + err.message, 6000); console.error(err); }
      btn.disabled = false;
    });
  }

  // ---------------------------------------------------------------- automatic build from PDF
  let autoResult = null;
  const KEY_STORE = 'iwp.anthropic.key';
  function autoCabRows() {
    return $$('#aCabs tr[data-r]').map((tr) => ({ loc: tr.querySelector('[data-k=loc]').value.trim(), outline: tr.querySelector('[data-k=out]').value.trim() }))
      .filter((r) => r.loc);
  }
  function renderAutoCabs(rows) {
    $('#aCabs').innerHTML = '<tr><th>ตู้ (LOC.)</th><th>หน้า Outline ของตู้นี้</th><th></th></tr>' + rows.map((r, i) =>
      `<tr data-r="${i}"><td><input data-k="loc" value="${esc(r.loc)}" placeholder="เช่น LCC."></td><td><input data-k="out" value="${esc(r.outline)}" placeholder="เช่น 30 หรือ 3-4"></td><td><button class="iconbtn" data-delcab="${i}">✕</button></td></tr>`).join('');
  }
  function autoLog(msg, frac) {
    const el = $('#aLog'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight;
    if (frac != null) { $('#aProg').hidden = false; $('#aBar').style.width = Math.round(frac * 100) + '%'; }
  }
  function updateCost() {
    const pages = window.AutoBuild.parsePages($('#aSch').value, pdfDoc ? pdfDoc.numPages : 0).length;
    const opus = $('#aModel').value === 'claude-opus-5-5';
    const lo = opus ? 0.12 : 0.06, hi = opus ? 0.3 : 0.15;
    $('#aCost').textContent = pages ? `ค่าใช้จ่ายโดยประมาณ ${pages} หน้า × $${lo}–${hi} ≈ $${(pages * lo).toFixed(1)}–${(pages * hi).toFixed(1)} (ขึ้นกับความซับซ้อนของแบบ)` : '';
  }
  // AI page cache in this browser: a re-run does not pay again for pages already read
  const BCACHE = 'iwp.bcache.';
  const bCache = {
    get(k) { try { const v = localStorage.getItem(BCACHE + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) {
      try { localStorage.setItem(BCACHE + k, JSON.stringify(v)); } catch (e) {
        // storage full: drop older cached pages and try once more
        try { Object.keys(localStorage).filter((x) => x.startsWith(BCACHE)).slice(0, 20).forEach((x) => localStorage.removeItem(x)); localStorage.setItem(BCACHE + k, JSON.stringify(v)); } catch (e2) { /* ignore */ }
      }
    }
  };
  let autoAbort = null;
  const pdfKey = () => (pdfDoc && pdfDoc.fingerprints && pdfDoc.fingerprints[0]) || (pdfName + ':' + (pdfDoc ? pdfDoc.numPages : 0));
  async function runAuto(preloaded) {
    if (!pdfDoc) { toast('เลือกไฟล์ Schematic PDF ก่อน'); return; }
    const A = window.AutoBuild;
    const pages = preloaded ? preloaded.pages : A.parsePages($('#aSch').value, pdfDoc.numPages);
    const cabs = autoCabRows();
    if (!pages.length) { toast('ใส่หน้า Schematic เช่น 7-22'); return; }
    if (!cabs.length) { toast('ใส่ชื่อตู้อย่างน้อย 1 ตู้'); return; }
    const method = preloaded ? preloaded.method : (($$('input[name=aMethod]').find((r) => r.checked) || {}).value || 'A');
    const key = $('#aKey').value.trim();
    if (!preloaded && method === 'B' && !key) { toast('ใส่ Anthropic API key สำหรับวิธี B'); return; }
    if (!preloaded && method === 'B') { try { if ($('#aKeyRemember').checked && key) localStorage.setItem(KEY_STORE, key); else localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ } }
    $('#aLog').textContent = ''; $('#aResult').hidden = true; $('#aRun').disabled = true;
    autoAbort = new AbortController(); $('#aCancel').hidden = method !== 'B' || !!preloaded;
    const t0 = Date.now();
    try {
      const cabinets = cabs.map((c) => c.loc);
      const prog = async (m, f) => { autoLog(m, f * 0.75); await new Promise((r) => setTimeout(r, 0)); };
      let sheets, info = { model: '', usage: null, cost: 0, failed: [] };
      if (preloaded) {
        sheets = preloaded.sheets; info = Object.assign(info, preloaded.info || {});
        autoLog(`ใช้ผลการอ่านจากไฟล์ (${method === 'A' ? 'วิธี A' : 'วิธี B · ' + (info.model || '')}) ${sheets.length} หน้า`);
      } else if (method === 'A') {
        sheets = await A.readSheetsA(pdfDoc, pages, window.pdfjsLib.OPS, window.GLYPH_TEMPLATES, prog);
      } else {
        const model = $('#aModel').value;
        const r = await A.readSheetsB(pdfDoc, pages, {
          apiKey: key, model: model, cabinets: cabinets, signal: autoAbort.signal, cache: bCache, fileKey: pdfKey(),
          hints: $('#aHints').checked, OPS: window.pdfjsLib.OPS, templates: window.GLYPH_TEMPLATES
        }, prog);
        sheets = r.sheets;
        info = { model: model, usage: r.usage, cost: r.cost, failed: r.failed, cached: r.cached };
        autoLog(`AI ใช้ token: input ${r.usage.input.toLocaleString()} · output ${r.usage.output.toLocaleString()} · ค่าใช้จ่ายรอบนี้ ≈ $${r.cost.toFixed(2)}` + (r.cached ? ` · ใช้ผลเดิม ${r.cached} หน้า (ไม่เสียค่าใช้จ่าย)` : ''));
        if (r.failed.length) autoLog(`⚠ อ่านไม่สำเร็จ ${r.failed.length} หน้า: ${r.failed.map((f) => f.page).join(', ')} — กดรันอีกครั้งเพื่ออ่านเฉพาะหน้าที่เหลือ`);
      }
      if (method === 'B') sheets.forEach((s) => (s.notes || []).forEach((n) => autoLog(`  Sheet ${s.sheet}: ${n}`)));
      if (!sheets.length) throw new Error('ไม่มีหน้าที่อ่านสำเร็จ');
      autoLog('รวม node ข้ามหน้าและคัดสายภายในตู้…', 0.8);
      const merged = A.mergeSheets(sheets, { cabinets: cabinets });
      // cross-check the AI against the free offline reading
      if (method === 'B' && $('#aCross').checked) {
        autoLog('ตรวจไขว้กับวิธี A…', 0.82);
        const sa = await A.readSheetsA(pdfDoc, sheets.map((s) => +s.sheet), window.pdfjsLib.OPS, window.GLYPH_TEMPLATES);
        const cross = A.crossCheck(merged.nets, A.mergeSheets(sa, { cabinets: cabinets }).nets);
        merged.nets.forEach((n, i) => { n.cross = cross[i]; });
        const bad = cross.filter((c) => c.split || c.joined).length;
        autoLog(`  node ที่วิธี A อ่านต่างจาก AI: ${bad} จาก ${merged.nets.length}`);
      }
      const outlines = [];
      const multi = cabinets.length > 1;
      for (const c of cabs) {
        const L = c.loc.replace(/^\+/, '').replace(/\.$/, '').toUpperCase();
        const wanted = Array.from(merged.devices.entries()).filter(([, d]) => d.loc.replace(/\.$/, '') === L).map(([k]) => k);
        for (const pg of A.parsePages(c.outline, pdfDoc.numPages)) {
          autoLog(`อ่าน Outline หน้า ${pg} (${c.loc})…`, 0.88);
          const o = await A.readOutline(pdfDoc, pg, window.pdfjsLib.OPS, window.GLYPH_TEMPLATES, wanted);
          o.loc = multi ? L + '.' : c.loc;
          outlines.push(o);
          autoLog(`  พบตำแหน่งอุปกรณ์ ${Object.keys(o.positions).length}/${wanted.length} · รางวายเวย์ ${o.wireways.length}`);
        }
      }
      autoResult = { method: method, pages: sheets.map((s) => +s.sheet), cabs: cabs, sheets: sheets, merged: merged, outlines: outlines, exclude: new Set(), info: info };
      autoLog(`เสร็จใน ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`, 1);
      renderAutoReview();
    } catch (err) {
      console.error(err);
      autoLog('ผิดพลาด: ' + (err && err.message ? err.message : err));
      toast('รันไม่สำเร็จ: ' + (err && err.message ? err.message : err), 7000);
    }
    $('#aRun').disabled = false; $('#aCancel').hidden = true; autoAbort = null;
  }
  function saveReading() {
    const r = autoResult; if (!r) return;
    const out = { app: 'internal-wiring-planner/reading', version: 1, pdfName: pdfName, pdfKey: pdfKey(), method: r.method, pages: r.pages, cabs: r.cabs, info: r.info, sheets: r.sheets, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${pdfName.replace(/\.pdf$/i, '') || 'reading'}_read_${r.method}${r.info && r.info.model ? '_' + r.info.model.replace(/^claude-/, '') : ''}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function loadReading(file) {
    let d;
    try { d = JSON.parse(await file.text()); } catch (e) { toast('อ่านไฟล์ไม่ได้'); return; }
    if (!d || d.app !== 'internal-wiring-planner/reading' || !Array.isArray(d.sheets)) { toast('ไม่ใช่ไฟล์ผลการอ่านของโปรแกรมนี้'); return; }
    if (!pdfDoc) { toast(`เปิด PDF ${d.pdfName || ''} ก่อน แล้วโหลดผลการอ่านอีกครั้ง`, 6000); return; }
    if (d.pdfKey && d.pdfKey !== pdfKey() && !confirm(`ไฟล์ผลการอ่านมาจาก ${d.pdfName} ซึ่งไม่ตรงกับ PDF ที่เปิดอยู่ — ใช้ต่อหรือไม่?`)) return;
    if (Array.isArray(d.cabs) && d.cabs.length) renderAutoCabs(d.cabs);
    $('#aSch').value = d.pages.length ? `${d.pages[0]}-${d.pages[d.pages.length - 1]}` : '';
    await runAuto({ method: d.method, pages: d.pages, sheets: d.sheets, info: d.info });
  }
  function netFlags(n) {
    const f = [];
    if (/^N\d+$/.test(n.wire)) f.push('ไม่มีเบอร์สาย');
    if (n.remark && /หลายเบอร์/.test(n.remark)) f.push('หลายเบอร์ใน node');
    if (n.remark && /ชื่อขั้ว/.test(n.remark)) f.push('เบอร์สายเดาจากชื่อขั้ว');
    if (n.pins.length === 2 && n.pins.every((p) => /^(\+[A-Z0-9]+)?-(TB|X)/i.test(p[0]))) f.push('มีแต่ขั้ว Terminal');
    if (n.pins.some((p) => !/^(\+[A-Z0-9]+)?-[A-Z0-9]/i.test(p[0]))) f.push('ชื่ออุปกรณ์ผิดรูปแบบ');
    if (n.cross && n.cross.split) f.push('วิธี A แยกเป็นหลาย node');
    if (n.cross && n.cross.joined) f.push('วิธี A ต่อกับ node อื่น');
    return f;
  }
  function renderAutoReview() {
    const r = autoResult; if (!r) return;
    const nets = r.merged.nets, placedKeys = new Set(r.outlines.flatMap((o) => Object.keys(o.positions)));
    const flagged = nets.filter((n) => netFlags(n).length).length;
    const devs = Array.from(r.merged.devices.keys());
    const unplaced = devs.filter((k) => !placedKeys.has(k));
    $('#aCards').innerHTML = [
      ['วิธีอ่าน', r.method === 'A' ? 'A · ออฟไลน์' : 'B · AI', `${r.pages.length} หน้า Schematic` +
        (r.method === 'B' && r.info ? ` · ≈ $${(r.info.cost || 0).toFixed(2)}` + ((r.info.failed || []).length ? ` · อ่านไม่สำเร็จ ${r.info.failed.length} หน้า` : '') : '')],
      ['node สายภายใน', nets.length, `${nets.reduce((s, n) => s + n.pins.length - 1, 0)} เส้นโดยประมาณ`],
      ['ควรตรวจ', flagged, 'ไม่มีเบอร์สาย / มีแต่ Terminal ฯลฯ'],
      ['อุปกรณ์', devs.length, `วางจาก Outline ได้ ${devs.length - unplaced.length} · ยังไม่วาง ${unplaced.length}`]
    ].map((c) => `<div class="card ${c[0] === 'ควรตรวจ' && c[1] ? 'warn' : ''}"><div class="k">${esc(c[0])}</div><div class="v">${esc(c[1])}</div><div class="s">${esc(c[2])}</div></div>`).join('');
    const warn = r.merged.warnings.slice(0, 30);
    if (unplaced.length) warn.unshift('อุปกรณ์ที่ยังไม่พบตำแหน่งใน Outline: ' + unplaced.slice(0, 40).join(', ') + (unplaced.length > 40 ? ' …' : ''));
    if (r.method === 'A') warn.unshift('วิธี A อ่านจากรูปทรงเส้นและตัวอักษร — ทดสอบกับ PP1047A หาขาภายในได้ราว 2 ใน 3 จุด ควรตรวจเทียบแบบทุก Sheet ในแท็บ Netlist (ปุ่ม 📄 เปิดหน้าแบบ)');
    $('#aWarn').innerHTML = warn.map((w) => `<li>${esc(w)}</li>`).join('');
    const only = $('#aOnlyFlag').checked;
    let shown = 0;
    $('#aNets').innerHTML = '<tr><th>ใช้</th><th>Sheet</th><th>เบอร์สาย</th><th>ขาใน node</th><th>ควรตรวจ</th></tr>' + nets.map((n, i) => {
      const fl = netFlags(n);
      if (only && !fl.length) return '';
      shown++;
      return `<tr><td><input type="checkbox" data-anet="${i}" ${r.exclude.has(i) ? '' : 'checked'}></td><td>${esc(n.sheet)}</td><td class="mono"><b>${esc(n.wire)}</b></td>` +
        `<td class="mono">${esc(n.pins.map((p) => p[0] + (p[1] !== n.sheet ? '@' + p[1] : '')).join('  '))}</td><td class="flag">${esc(fl.concat(n.remark && !/หลายเบอร์|ชั่วคราว|ชื่อขั้ว/.test(n.remark) ? [n.remark] : []).join(' · '))}</td></tr>`;
    }).join('');
    $('#aCount').textContent = `${shown} / ${nets.length} node`;
    $('#aResult').hidden = false;
  }
  async function applyAuto() {
    const r = autoResult; if (!r) return;
    if (!confirm('สร้างโปรเจกต์ใหม่จากผลนี้ (แทนที่โปรเจกต์ปัจจุบัน)?')) return;
    const cabinets = r.cabs.map((c) => c.loc);
    const proc = $('#aProc').value.trim() || 'NEW';
    const P = migrate({
      version: BASE.version,
      meta: {
        project: $('#aProj').value.trim() || '(TBD)', processNo: proc, schematicDwg: pdfName.replace(/\.pdf$/i, ''), drawingNo: '(TBD)',
        contract: '(TBD)', loc: cabinets[0], panelName: cabinets.join(' / '),
        title: `${cabinets[0].replace(/\.$/, '')} INTERNAL CABLE WIRING ${proc}`, rev: '0',
        sheets: `${r.pages[0]}-${r.pages[r.pages.length - 1]}`, outlineSheet: r.cabs.map((c) => c.outline).join(',')
      },
      cable: clone(NEW_CABLE), views: {}, wireways: [], portals: [], devices: {}, terminals: {}, bars: {}, nets: [],
      backgrounds: {}, anomalies: [], noInternal: {}
    });
    project = P;
    for (const o of r.outlines) {
      const page = await pdfDoc.getPage(o.page);
      const id = 'bg' + o.page;
      await setBackgroundFromPdf(page, page.getViewport({ scale: 1 }), id, `${pdfName.replace(/\.pdf$/i, '')} หน้า ${o.page}`, o.page, o.loc);
      o.bg = id;
    }
    const merged = Object.assign({}, r.merged, { nets: r.merged.nets.filter((_, i) => !r.exclude.has(i)) });
    window.AutoBuild.buildProject(P, merged, r.outlines, {});
    P.anomalies = (P.anomalies || []).concat([`สร้างอัตโนมัติด้วยวิธี ${r.method === 'A' ? 'A (ออฟไลน์)' : 'B (AI)'} จาก ${pdfName} หน้า ${P.meta.sheets} — ตรวจเทียบแบบก่อนใช้งาน`]);
    big.bg = mini.bg = Object.keys(P.backgrounds)[0] || null; big._fitted = mini._fitted = false; selWire = null; selDev = null;
    save(); recompute(); renderSettings(); refreshAll();
    $('.tab[data-tab="overview"]').click();
    toast('สร้างโปรเจกต์แล้ว — ตรวจ Netlist, วางอุปกรณ์ที่เหลือ และตั้งสี/ขนาดสายในแท็บตั้งค่า', 7000);
  }
  function bindAuto() {
    renderAutoCabs([{ loc: project.meta.loc || 'TCC.', outline: String(project.meta.outlineSheet || '') }]);
    $('#aSch').value = project.meta.sheets ? project.meta.sheets.replace(/^0/, '').replace(/-0/, '-') : '';
    $('#aProc').value = project.meta.processNo || '';
    try { const k = localStorage.getItem(KEY_STORE); if (k) { $('#aKey').value = k; $('#aKeyRemember').checked = true; } } catch (e) { /* ignore */ }
    $('#aPdfFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await openPdf(f); $('#aPdfName').textContent = `${f.name} · ${pdfDoc.numPages} หน้า`; updateCost(); } catch (err) { toast('เปิด PDF ไม่ได้: ' + err.message); }
      e.target.value = '';
    });
    $('#aAddCab').addEventListener('click', () => { const rows = autoCabRows(); rows.push({ loc: '', outline: '' }); renderAutoCabs(rows); });
    $('#aCabs').addEventListener('click', (e) => {
      const i = e.target.dataset && e.target.dataset.delcab; if (i === undefined) return;
      const rows = autoCabRows(); rows.splice(+i, 1); renderAutoCabs(rows.length ? rows : [{ loc: '', outline: '' }]);
    });
    $$('input[name=aMethod]').forEach((r) => r.addEventListener('change', () => { $('#aAiBox').hidden = !$$('input[name=aMethod]').find((x) => x.value === 'B').checked; updateCost(); }));
    ['#aSch', '#aModel'].forEach((s) => $(s).addEventListener('input', updateCost));
    $('#aRun').addEventListener('click', () => runAuto());
    $('#aCancel').addEventListener('click', () => { if (autoAbort) { autoAbort.abort(); autoLog('กำลังหยุด…'); } });
    $('#aSaveRead').addEventListener('click', saveReading);
    $('#aLoadRead').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadReading(f); });
    $('#aApply').addEventListener('click', applyAuto);
    $('#aOnlyFlag').addEventListener('change', renderAutoReview);
    $('#aNets').addEventListener('change', (e) => {
      const i = e.target.dataset && e.target.dataset.anet; if (i === undefined) return;
      if (e.target.checked) autoResult.exclude.delete(+i); else autoResult.exclude.add(+i);
    });
  }

  // ---------------------------------------------------------------- start
  load();
  recompute();
  setupMaps();
  loadBg();
  bind();
  bindAuto();
  renderSettings();
  refreshAll();
  window.IWP = { get project() { return project; }, get pdf() { return pdfDoc; }, get wires() { return wires; }, get plan() { return plan; }, recompute: recompute, get maps() { return { mini: mini, big: big }; } };
})();
