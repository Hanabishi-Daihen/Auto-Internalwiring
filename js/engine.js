/*
 * Internal Wiring Planner - engine
 * Pure functions (no DOM): device/pin geometry, wireway routing and chain optimisation.
 * Works in the browser (window.WiringEngine) and in Node (module.exports) for testing.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  function splitPin(ref) {
    if (ref === 'GND') return { dev: 'GND', pin: '' };
    const i = ref.indexOf(':');
    return i < 0 ? { dev: ref, pin: '' } : { dev: ref.slice(0, i), pin: ref.slice(i + 1) };
  }
  // 'E#FM1' -> display 'E', note 'FM1'
  function pinLabel(pin) {
    const i = pin.indexOf('#');
    return i < 0 ? pin : pin.slice(0, i);
  }
  function pinNote(pin) {
    const i = pin.indexOf('#');
    return i < 0 ? '' : pin.slice(i + 1);
  }
  function manhattan(a, b) {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y) + Math.abs(a.Z - b.Z);
  }

  // PDF point (x,y) in a view -> cabinet mm {X,Y,Z}
  function toWorld(view, x, y) {
    const m = view.map;
    const X = Array.isArray(m.x) ? (x - m.x[0]) * m.x[1] : m.x;
    const Y = Array.isArray(m.y) ? (y - m.y[0]) * m.y[1] : m.y;
    let Z = 0;
    if (m.zFromX) Z = (x - m.zFromX[0]) * m.zFromX[1];
    else if (typeof m.z === 'number') Z = m.z;
    return { X, Y, Z };
  }

  // ------------------------------------------------------------------ model
  function buildModel(project) {
    const views = project.views;
    const devices = project.devices;
    const terms = project.terminals || {};
    const barIndex = {};               // 'TB:pin' -> group id
    const barEntry = {};               // 'TB:pin' -> true when the arrangement shows an internal wire
    Object.keys(project.barEntry || {}).forEach(function (tb) {
      project.barEntry[tb].forEach(function (p) { barEntry[tb + ':' + p] = true; });
    });
    Object.keys(project.bars || {}).forEach(function (tb) {
      project.bars[tb].forEach(function (g, gi) {
        g.forEach(function (p) { barIndex[tb + ':' + p] = tb + '#bar' + gi; });
      });
    });

    function pinPos(ref) {
      const sp = splitPin(ref);
      const d = devices[sp.dev];
      if (!d || !d.view || !views[d.view]) return null;
      const view = views[d.view];
      let x = d.x, y = d.y;
      const t = terms[sp.dev];
      if (t) {
        let idx = t.pins.indexOf(sp.pin);
        const n = t.pins.length;
        if (idx < 0) idx = n - 1;      // extra pins -> end of strip
        y = t.y1 + (idx + 0.5) * (t.y2 - t.y1) / n;
      }
      const w = toWorld(view, x, y);
      return { view: d.view, x: x, y: y, X: w.X, Y: w.Y, Z: w.Z };
    }

    // ---- wireway graph (one per 'graph' view, e.g. mounting plates of LCC / RCC) ----
    const firstGraph = Object.keys(views).find(function (k) { return views[k].kind === 'graph'; }) || 'PLATE';
    const segs = (project.wireways || []).map(function (w) {
      return { id: w[0], x1: w[1], y1: w[2], x2: w[3], y2: w[4], view: w[5] || firstGraph, pts: [] };
    }).filter(function (s) { return !!views[s.view]; });
    const nodes = [];                  // {id, view, x, y, X, Y, Z, label}
    const nodeKey = {};
    function addNode(view, x, y, label) {
      const k = view + ':' + x.toFixed(2) + ':' + y.toFixed(2);
      if (nodeKey[k] !== undefined) return nodeKey[k];
      const w = toWorld(views[view], x, y);
      nodes.push({ id: nodes.length, view: view, x: x, y: y, X: w.X, Y: w.Y, Z: w.Z, label: label || '' });
      nodeKey[k] = nodes.length - 1;
      return nodes.length - 1;
    }
    function onSeg(s, x, y, view) {
      const tol = 0.6;
      if (view && s.view !== view) return false;
      if (Math.abs(s.y1 - s.y2) < 1e-6) {           // horizontal
        return Math.abs(y - s.y1) < tol && x >= Math.min(s.x1, s.x2) - tol && x <= Math.max(s.x1, s.x2) + tol;
      }
      return Math.abs(x - s.x1) < tol && y >= Math.min(s.y1, s.y2) - tol && y <= Math.max(s.y1, s.y2) + tol;
    }
    segs.forEach(function (s) {
      s.pts.push(addNode(s.view, s.x1, s.y1));
      s.pts.push(addNode(s.view, s.x2, s.y2));
    });
    // intersections
    for (let i = 0; i < segs.length; i++) {
      for (let j = 0; j < segs.length; j++) {
        if (i === j) continue;
        const a = segs[i], b = segs[j];
        if (a.view !== b.view) continue;
        const aH = Math.abs(a.y1 - a.y2) < 1e-6, bH = Math.abs(b.y1 - b.y2) < 1e-6;
        if (aH === bH) continue;
        const x = aH ? b.x1 : a.x1, y = aH ? a.y1 : b.y1;
        if (onSeg(a, x, y) && onSeg(b, x, y)) {
          const xx = aH ? x : a.x1, yy = aH ? a.y1 : y;
          const n = addNode(a.view, xx, yy);
          if (a.pts.indexOf(n) < 0) a.pts.push(n);
        }
      }
    }
    // portals (links between views): [id, viewA, xA, yA, xB, yB, extra_mm, viewB, fixedCost]
    // e.g. door hinge bundle -> plate wireway, side-wall wireway -> inner-panel wireway.
    // An end that lies in a 'graph' view is inserted on its wireway segment.
    function attachPoint(view, x, y, label) {
      let node = null;
      if (views[view].kind === 'graph') {
        let best = null, bd = Infinity;
        segs.forEach(function (s) {
          if (s.view !== view) return;
          const H = Math.abs(s.y1 - s.y2) < 1e-6;
          const px = H ? Math.min(Math.max(x, Math.min(s.x1, s.x2)), Math.max(s.x1, s.x2)) : s.x1;
          const py = H ? s.y1 : Math.min(Math.max(y, Math.min(s.y1, s.y2)), Math.max(s.y1, s.y2));
          const d = Math.abs(px - x) + Math.abs(py - y);
          if (d < bd) { bd = d; best = { s: s, x: px, y: py }; }
        });
        if (best && bd < 12) {
          node = addNode(view, best.x, best.y, label);
          if (best.s.pts.indexOf(node) < 0) best.s.pts.push(node);
        }
      }
      return node === null ? addNode(view, x, y, label) : node;
    }
    const portals = (project.portals || []).filter(function (p) {
      return views[p[1]] && views[p[7] || firstGraph];
    }).map(function (p) {
      const vb = p[7] || firstGraph;
      const anchor = attachPoint(p[1], p[2], p[3], p[0]);
      const plateNode = attachPoint(vb, p[4], p[5], p[0]);
      return { id: p[0], view: p[1], viewB: vb, anchor: anchor, plate: plateNode, extra: p[6] || 0, fixed: !!p[8] };
    });
    // edges
    const N = nodes.length;
    const edges = [];
    segs.forEach(function (s) {
      const H = Math.abs(s.y1 - s.y2) < 1e-6;
      s.pts.sort(function (a, b) { return H ? nodes[a].x - nodes[b].x : nodes[a].y - nodes[b].y; });
      // de-dup
      s.pts = s.pts.filter(function (v, i, arr) { return i === 0 || v !== arr[i - 1]; });
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        edges.push({ a: a, b: b, w: manhattan(nodes[a], nodes[b]), seg: s.id });
      }
    });
    portals.forEach(function (p) {
      // fixed-cost portals (drawn in the app on views with independent scales): extra + height difference
      const w = p.fixed ? p.extra + Math.abs(nodes[p.anchor].Y - nodes[p.plate].Y)
        : manhattan(nodes[p.anchor], nodes[p.plate]) + p.extra;
      edges.push({ a: p.anchor, b: p.plate, w: w, seg: p.id, portal: true });
    });
    // Floyd-Warshall
    const D = [], NX = [], ES = [];
    for (let i = 0; i < N; i++) {
      D.push(new Float64Array(N).fill(Infinity));
      NX.push(new Int32Array(N).fill(-1));
      ES.push(new Array(N).fill(null));
      D[i][i] = 0; NX[i][i] = i;
    }
    edges.forEach(function (e) {
      if (e.w < D[e.a][e.b]) {
        D[e.a][e.b] = D[e.b][e.a] = e.w;
        NX[e.a][e.b] = e.b; NX[e.b][e.a] = e.a;
        ES[e.a][e.b] = ES[e.b][e.a] = e.seg;
      }
    });
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
      const dik = D[i][k];
      if (dik === Infinity) continue;
      for (let j = 0; j < N; j++) {
        const v = dik + D[k][j];
        if (v < D[i][j]) { D[i][j] = v; NX[i][j] = NX[i][k]; }
      }
    }
    const segById = {};
    segs.forEach(function (s) { segById[s.id] = s; });

    return {
      project: project, views: views, nodes: nodes, segs: segs, segById: segById, portals: portals,
      D: D, NX: NX, ES: ES, barIndex: barIndex, barEntry: barEntry, pinPos: pinPos, _attach: {}
    };
  }

  // attachment options of a pin to the routing graph: [{n, c, proj:{x,y}, seg, sub:[a,b], t}]
  function attachOptions(model, ref) {
    if (model._attach[ref]) return model._attach[ref];
    const p = model.pinPos(ref);
    let opts = [];
    if (!p) { model._attach[ref] = opts; return opts; }
    if (model.views[p.view].kind === 'graph') {
      const cand = [];
      model.segs.forEach(function (s) {
        if (s.view !== p.view) return;
        const H = Math.abs(s.y1 - s.y2) < 1e-6;
        let px, py;
        if (H) { px = Math.min(Math.max(p.x, Math.min(s.x1, s.x2)), Math.max(s.x1, s.x2)); py = s.y1; }
        else { px = s.x1; py = Math.min(Math.max(p.y, Math.min(s.y1, s.y2)), Math.max(s.y1, s.y2)); }
        const w = toWorld(model.views[p.view], px, py);
        const stub = Math.abs(w.X - p.X) + Math.abs(w.Y - p.Y);
        cand.push({ s: s, px: px, py: py, w: w, stub: stub, H: H });
      });
      cand.sort(function (a, b) { return a.stub - b.stub; });
      cand.slice(0, 3).forEach(function (c) {
        const pts = c.s.pts;
        // find sub-edge containing the projection
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = model.nodes[pts[i]], b = model.nodes[pts[i + 1]];
          const lo = c.H ? a.x : a.y, hi = c.H ? b.x : b.y, v = c.H ? c.px : c.py;
          if (v >= lo - 1e-6 && v <= hi + 1e-6) {
            const da = Math.abs(c.w.X - a.X) + Math.abs(c.w.Y - a.Y);
            const db = Math.abs(c.w.X - b.X) + Math.abs(c.w.Y - b.Y);
            const sub = [pts[i], pts[i + 1]];
            opts.push({ n: pts[i], c: c.stub + da, proj: { x: c.px, y: c.py }, seg: c.s.id, sub: sub, t: da, stub: c.stub });
            opts.push({ n: pts[i + 1], c: c.stub + db, proj: { x: c.px, y: c.py }, seg: c.s.id, sub: sub, t: da, stub: c.stub });
            break;
          }
        }
      });
    } else {
      model.portals.forEach(function (pt) {
        const n = pt.view === p.view ? pt.anchor : pt.viewB === p.view ? pt.plate : -1;
        if (n < 0) return;
        const a = model.nodes[n];
        opts.push({ n: n, c: manhattan(p, a), proj: null, seg: null, sub: null });
      });
    }
    model._attach[ref] = opts;
    return opts;
  }

  // shortest wire route between two pins -> {len, nodes:[...], via:[seg ids], a:optA, b:optB, direct}
  function route(model, refA, refB) {
    const pa = model.pinPos(refA), pb = model.pinPos(refB);
    if (!pa || !pb) return { len: Infinity, nodes: [], via: [], direct: false };
    // two terminals of the same device: short jumper on the device itself
    if (splitPin(refA).dev === splitPin(refB).dev && refA !== 'GND') {
      const j = (model.project.settings && model.project.settings.jumper) || 50;
      return { len: j, nodes: [], via: ['JUMPER'], direct: true, from: pa, to: pb };
    }
    let best = { len: Infinity, nodes: [], via: [], direct: false };
    if (pa.view === pb.view && (model.views[pa.view].kind !== 'graph' || !attachOptions(model, refA).length)) {
      best = { len: manhattan(pa, pb), nodes: [], via: [pa.view], direct: true };
    }
    const oa = attachOptions(model, refA), ob = attachOptions(model, refB);
    // same sub-edge on the plate: run inside the duct directly
    oa.forEach(function (x) {
      ob.forEach(function (y) {
        if (x.sub && y.sub && x.sub[0] === y.sub[0] && x.sub[1] === y.sub[1]) {
          const L = x.stub + y.stub + Math.abs(x.t - y.t);
          if (L < best.len) best = { len: L, nodes: [], via: [x.seg], direct: true, pa: x, pb: y };
        }
      });
    });
    oa.forEach(function (x) {
      ob.forEach(function (y) {
        const L = x.c + model.D[x.n][y.n] + y.c;
        if (L < best.len) best = { len: L, pa: x, pb: y, direct: false };
      });
    });
    if (!best.direct && best.pa) {
      const path = [best.pa.n];
      let u = best.pa.n;
      const v = best.pb.n;
      let guard = 0;
      while (u !== v && guard++ < 500) { u = model.NX[u][v]; if (u < 0) break; path.push(u); }
      const via = [];
      if (best.pa.seg) via.push(best.pa.seg);
      for (let i = 0; i + 1 < path.length; i++) {
        const s = model.ES[path[i]][path[i + 1]];
        if (s && via[via.length - 1] !== s) via.push(s);
      }
      if (best.pb.seg && via[via.length - 1] !== best.pb.seg) via.push(best.pb.seg);
      best.nodes = path;
      best.via = via;
    }
    best.from = pa; best.to = pb;
    return best;
  }

  // pins without a position or without a route get a large finite cost so a chain is still produced
  const NO_ROUTE = 1e7;
  function distance(model, a, b) {
    const k = a < b ? a + '|' + b : b + '|' + a;
    const c = model._dist || (model._dist = {});
    if (c[k] === undefined) { const L = route(model, a, b).len; c[k] = isFinite(L) ? L : NO_ROUTE; }
    return c[k];
  }

  // cabinet (LOC) of a pin: device.loc, else its view's loc, else the project LOC
  function locOf(model, ref) {
    const sp = splitPin(ref);
    const d = model.project.devices[sp.dev];
    if (d && d.loc) return d.loc;
    const pre = sp.dev.match(/^\+([A-Za-z0-9]+)-/);      // +RCC-X3 -> RCC.
    if (pre) return pre[1].toUpperCase() + '.';
    if (!d) return model.project.meta.loc || '';
    const v = model.views[d.view];
    return (v && v.loc) || model.project.meta.loc || '';
  }

  // ------------------------------------------------------------------ path optimisation
  // open Hamiltonian path over n items with cost matrix C (array of arrays)
  function pathCost(C, order) {
    let s = 0;
    for (let i = 0; i + 1 < order.length; i++) s += C[order[i]][order[i + 1]];
    return s;
  }
  function exactPath(C, n) {
    const FULL = 1 << n;
    const dp = new Float64Array(FULL * n).fill(Infinity);
    const par = new Int16Array(FULL * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = 0;
    for (let m = 1; m < FULL; m++) {
      for (let j = 0; j < n; j++) {
        const cur = dp[m * n + j];
        if (!(m & (1 << j)) || cur === Infinity) continue;
        for (let k = 0; k < n; k++) {
          if (m & (1 << k)) continue;
          const nm = m | (1 << k), v = cur + C[j][k];
          if (v < dp[nm * n + k]) { dp[nm * n + k] = v; par[nm * n + k] = j; }
        }
      }
    }
    let bj = 0, bv = Infinity;
    for (let j = 0; j < n; j++) if (dp[(FULL - 1) * n + j] < bv) { bv = dp[(FULL - 1) * n + j]; bj = j; }
    const order = [];
    let m = FULL - 1, j = bj;
    while (j >= 0) { order.push(j); const pj = par[m * n + j]; m &= ~(1 << j); j = pj; }
    return order.reverse();
  }
  function heuristicPath(C, n) {
    // greedy edge (degree <= 2, no cycles)
    const E = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) E.push([C[i][j], i, j]);
    E.sort(function (a, b) { return a[0] - b[0]; });
    const deg = new Int32Array(n), uf = [], adj = [];
    for (let i = 0; i < n; i++) { uf.push(i); adj.push([]); }
    function find(x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }
    let added = 0;
    for (let e = 0; e < E.length && added < n - 1; e++) {
      const i = E[e][1], j = E[e][2];
      if (deg[i] >= 2 || deg[j] >= 2) continue;
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      uf[ri] = rj; deg[i]++; deg[j]++; adj[i].push(j); adj[j].push(i); added++;
    }
    let start = 0;
    for (let i = 0; i < n; i++) if (deg[i] <= 1) { start = i; break; }
    const order = [start], seen = new Uint8Array(n); seen[start] = 1;
    let cur = start;
    while (order.length < n) {
      const nx = adj[cur].find(function (v) { return !seen[v]; });
      if (nx === undefined) break;
      order.push(nx); seen[nx] = 1; cur = nx;
    }
    // 2-opt + or-opt improvement on open path
    let improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          // reverse order[i..j]
          const a = i > 0 ? order[i - 1] : -1, b = order[i], c = order[j], d = j + 1 < n ? order[j + 1] : -1;
          const before = (a >= 0 ? C[a][b] : 0) + (d >= 0 ? C[c][d] : 0);
          const after = (a >= 0 ? C[a][c] : 0) + (d >= 0 ? C[b][d] : 0);
          if (after + 1e-9 < before) {
            const seg = order.slice(i, j + 1).reverse();
            for (let k = 0; k < seg.length; k++) order[i + k] = seg[k];
            improved = true;
          }
        }
      }
      // or-opt: move one node elsewhere
      for (let i = 0; i < n; i++) {
        const base = pathCost(C, order);
        const node = order[i];
        const rest = order.slice(0, i).concat(order.slice(i + 1));
        let bestPos = -1, bestVal = base;
        for (let p = 0; p <= rest.length; p++) {
          const cand = rest.slice(0, p).concat([node], rest.slice(p));
          const v = pathCost(C, cand);
          if (v + 1e-9 < bestVal) { bestVal = v; bestPos = p; }
        }
        if (bestPos >= 0) {
          const cand = rest.slice(0, bestPos).concat([node], rest.slice(bestPos));
          for (let k = 0; k < n; k++) order[k] = cand[k];
          improved = true;
        }
      }
    }
    return order;
  }

  /*
   * Plan one net.
   *   net: {wire, sheet, cls, pins:[[ref, sheet],...], fixed:[[a,b]], keepOrder}
   *   returns {segments:[{a,b,sheet,len,route,fixed}], lenDrawing, lenOpt, warnings:[]}
   */
  function planNet(model, net, opts) {
    // a node drawn across two cabinets (e.g. LCC-X3.201 ... RCC-X3.201) is joined by an external cable:
    // plan the internal wiring of each cabinet separately
    const groups = {};
    net.pins.forEach(function (p) {
      const r = Array.isArray(p) ? p[0] : p;
      const L = locOf(model, r);
      (groups[L] = groups[L] || []).push(p);
    });
    const locs = Object.keys(groups);
    if (locs.length <= 1) return planCabinet(model, net, opts);
    const res = { segments: [], lenDrawing: 0, lenOpt: 0, warnings: [], unrouted: 0, cabinets: locs };
    locs.forEach(function (L) {
      const refs = groups[L].map(function (p) { return Array.isArray(p) ? p[0] : p; });
      const sub = Object.assign({}, net, {
        pins: groups[L],
        fixed: (net.fixed || []).filter(function (f) { return refs.indexOf(f[0]) >= 0 && refs.indexOf(f[1]) >= 0; })
      });
      const r = planCabinet(model, sub, opts);
      res.segments = res.segments.concat(r.segments);
      res.lenDrawing += r.lenDrawing; res.lenOpt += r.lenOpt; res.unrouted += r.unrouted;
      res.warnings = res.warnings.concat(r.warnings);
    });
    res.warnings.push('node นี้อยู่หลายตู้ (' + locs.join(', ') + ') — ส่วนที่ข้ามตู้เป็นสายภายนอก');
    return res;
  }

  function planCabinet(model, net, opts) {
    opts = opts || {};
    const warnings = [];
    const sheetOf = {};
    const refs = [];
    net.pins.forEach(function (p) {
      const r = Array.isArray(p) ? p[0] : p;
      sheetOf[r] = Array.isArray(p) ? (p[1] || net.sheet) : net.sheet;
      if (refs.indexOf(r) < 0) refs.push(r);
    });
    refs.forEach(function (r) { if (!model.pinPos(r)) warnings.push('ไม่พบตำแหน่ง ' + r); });

    // drawing-order length (reference): chain as listed, bars merged
    function chainLen(list) {
      let s = 0;
      for (let i = 0; i + 1 < list.length; i++) s += distance(model, list[i], list[i + 1]);
      return s;
    }

    // ---- fixed (locked) edges: leaf side leaves optimisation
    const fixedSegs = [];
    const leaf = {};
    (net.fixed || []).forEach(function (f) {
      const a = f[0], b = f[1];
      const aT = !!(model.project.terminals || {})[splitPin(a).dev];
      const lf = aT ? b : a, anchor = aT ? a : b;
      leaf[lf] = anchor;
      fixedSegs.push({ a: anchor, b: lf, fixed: true });
    });

    // ---- items: single pins or bar groups
    const items = [];      // {members:[ref], used:{}}
    const itemOf = {};
    refs.forEach(function (r) {
      if (leaf[r]) return;
      const g = model.barIndex[r];
      if (g) {
        let it = items.find(function (x) { return x.group === g; });
        if (!it) { it = { group: g, members: [] }; items.push(it); }
        it.members.push(r);
        itemOf[r] = it;
      } else {
        const it = { group: null, members: [r] };
        items.push(it); itemOf[r] = it;
      }
    });
    // fixed anchors inside a bar consume that bar pin
    const usedByFixed = {};
    fixedSegs.forEach(function (f) { usedByFixed[f.a] = true; });
    // candidate pins of an item: bar pins marked for internal wiring first, then pins not used by locked edges
    function freeMembers(it) {
      if (it.members.length === 1) return it.members;
      const entry = it.members.filter(function (m) { return model.barEntry[m]; });
      if (entry.length) return entry;
      const fm = it.members.filter(function (m) { return !usedByFixed[m]; });
      return fm.length ? fm : it.members;
    }
    function itemDist(i, j) {
      let best = Infinity, ba = null, bb = null;
      freeMembers(items[i]).forEach(function (a) {
        freeMembers(items[j]).forEach(function (b) {
          const d = distance(model, a, b);
          if (d < best) { best = d; ba = a; bb = b; }
        });
      });
      return { d: best, a: ba, b: bb };
    }

    const n = items.length;
    let order = [];
    const C = [];
    for (let i = 0; i < n; i++) { C.push([]); for (let j = 0; j < n; j++) C[i].push(i === j ? 0 : itemDist(i, j).d); }

    if (n <= 1) order = n ? [0] : [];
    else if (net.keepOrder || opts.drawingOrder) order = items.map(function (_, i) { return i; });
    else if (n <= 11) order = exactPath(C, n);
    else order = heuristicPath(C, n);

    // start the chain at the end nearest to the source pin (first pin in the drawing)
    if (order.length > 1) {
      const src = itemOf[refs[0]] ? items.indexOf(itemOf[refs[0]]) : -1;
      if (src >= 0) {
        const pos = order.indexOf(src);
        if (pos > order.length - 1 - pos) order.reverse();
      }
    }

    // ---- concrete segments, assigning distinct bar pins
    const usedPin = {};
    Object.keys(usedByFixed).forEach(function (k) { usedPin[k] = (usedPin[k] || 0) + 1; });
    const segsOut = [];
    function pickMember(it, other) {
      const cands = freeMembers(it).slice().sort(function (a, b) {
        const ua = usedPin[a] || 0, ub = usedPin[b] || 0;
        if (ua !== ub) return ua - ub;
        return distance(model, a, other) - distance(model, b, other);
      });
      return cands[0];
    }
    for (let k = 0; k + 1 < order.length; k++) {
      const I = items[order[k]], J = items[order[k + 1]];
      const pre = itemDist(order[k], order[k + 1]);
      let a = I.members.length > 1 ? pickMember(I, pre.b) : I.members[0];
      let b = J.members.length > 1 ? pickMember(J, a) : J.members[0];
      usedPin[a] = (usedPin[a] || 0) + 1;
      usedPin[b] = (usedPin[b] || 0) + 1;
      segsOut.push({ a: a, b: b, fixed: false });
    }
    const all = fixedSegs.concat(segsOut).map(function (s) {
      const r = route(model, s.a, s.b);
      return {
        a: s.a, b: s.b, fixed: s.fixed, len: r.len, via: r.via || [], route: r,
        sheet: sheetOf[s.b] || net.sheet
      };
    });
    // order output: optimized chain first, then fixed branches next to their anchors
    const out = [];
    segsOut.forEach(function (s) {
      out.push(all.find(function (x) { return x.a === s.a && x.b === s.b && !x.fixed; }));
    });
    all.filter(function (x) { return x.fixed; }).forEach(function (f) {
      let pos = -1;
      out.forEach(function (s, i) { if (s.a === f.a || s.b === f.a) pos = i; });
      if (pos < 0) out.push(f); else out.splice(pos + 1, 0, f);
    });
    // reference length in drawing order (fixed edges included as drawn)
    const drawList = refs.filter(function (r) { return !leaf[r]; });
    const merged = [];
    drawList.forEach(function (r) {
      const g = model.barIndex[r];
      if (g && merged.some(function (m) { return model.barIndex[m] === g; })) return;
      merged.push(r);
    });
    const fixedLen = all.filter(function (x) { return x.fixed; }).reduce(function (s, x) { return s + x.len; }, 0);
    const lenDrawing = chainLen(merged) + fixedLen;
    const lenOpt = out.reduce(function (s, x) { return s + (isFinite(x.len) ? x.len : 0); }, 0);
    const unrouted = out.filter(function (x) { return !isFinite(x.len); }).length;
    return { segments: out, lenDrawing: Math.min(lenDrawing, NO_ROUTE) >= NO_ROUTE ? lenOpt : lenDrawing, lenOpt: lenOpt, warnings: warnings, unrouted: unrouted };
  }

  // zone of a pin for bundling / work order
  function zoneOf(model, ref) {
    const p = model.pinPos(ref);
    if (!p) return '?';
    const multi = Object.keys(model.views).some(function (k) { return model.views[k].loc; });
    const pre = multi ? locOf(model, ref).replace(/\.$/, '') + ' ' : '';
    const v = model.views[p.view];
    if (v.kind !== 'graph') return pre + p.view;
    const dev = splitPin(ref).dev;
    if ((model.project.terminals || {})[dev] || /(^|-)(TB|X)\d|TB-?X/i.test(dev)) return pre + p.view + '-TB';
    if (dev === 'GND') return pre + p.view + '-GND';
    const rows = (model.project.zoneRows || {})[p.view];
    if (rows) {
      for (let i = 0; i < rows.length; i++) if (p.y < rows[i][0]) return pre + p.view + '-' + rows[i][1];
    }
    return pre + p.view;
  }

  const api = {
    splitPin: splitPin, pinLabel: pinLabel, pinNote: pinNote, toWorld: toWorld,
    buildModel: buildModel, route: route, distance: distance, planNet: planNet,
    attachOptions: attachOptions, zoneOf: zoneOf, locOf: locOf, exactPath: exactPath, heuristicPath: heuristicPath
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WiringEngine = api;
})(typeof window !== 'undefined' ? window : this);
