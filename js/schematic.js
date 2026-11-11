/*
 * Schematic interpreter: vector paths + words (GlyphOCR) of one sheet -> electrical nodes.
 *   - wires: stroke paths that are not text, joined end-to-end; a T or crossing joins only at a junction dot
 *   - each node collects: wire label, device pins (pin text next to a lead + nearest device label),
 *     terminal points (wire ending on a terminal circle), cross-sheet references (/08.B1)
 * Browser: window.SchematicReader   Node: module.exports
 */
(function (root) {
  'use strict';

  const RX = {
    device: /^-[A-Z0-9][A-Z0-9.\-]*$/,
    xref: /^\/\d{1,2}\.[A-I]\d{1,2}$/,
    loc: /^\+[A-Z][A-Z0-9]*\.?$/,
    pin: /^(\d{1,3}|[A-Z]\d|\d\.\d{1,2}|NC|NO|COM\d?|C|L|N|E|PE|L\+|L-|\+|-|[A-Z]{1,3}\d?)$/,
    wire: /^([A-Z]{1,3}\d{1,3}|\d{3}|[A-Z]{1,2}[+-]?\.?\d?|[A-Z]\d?[A-Z]?\d{1,2})$/
  };

  function dist2seg(px, py, s) {
    const abx = s[2] - s[0], aby = s[3] - s[1];
    const t = Math.max(0, Math.min(1, ((px - s[0]) * abx + (py - s[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-12)));
    return Math.hypot(px - s[0] - t * abx, py - s[1] - t * aby);
  }
  function center(b) { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  function boxSeg(b, s) {
    // distance between an axis-aligned box and a segment
    const inside = (x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    if (inside(s[0], s[1]) || inside(s[2], s[3])) return 0;
    let d = Math.min(dist2seg(b[0], b[1], s), dist2seg(b[2], b[1], s), dist2seg(b[0], b[3], s), dist2seg(b[2], b[3], s));
    const bx = (x) => Math.max(b[0], Math.min(b[2], x)), by = (y) => Math.max(b[1], Math.min(b[3], y));
    d = Math.min(d, Math.hypot(s[0] - bx(s[0]), s[1] - by(s[1])), Math.hypot(s[2] - bx(s[2]), s[3] - by(s[3])));
    // a segment passing straight through the box
    if (Math.abs(s[0] - s[2]) < 0.05 && s[0] >= b[0] && s[0] <= b[2] && Math.min(s[1], s[3]) <= b[3] && Math.max(s[1], s[3]) >= b[1]) d = 0;
    if (Math.abs(s[1] - s[3]) < 0.05 && s[1] >= b[1] && s[1] <= b[3] && Math.min(s[0], s[2]) <= b[2] && Math.max(s[0], s[2]) >= b[0]) d = 0;
    return d;
  }
  function boxDist(a, b) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return Math.hypot(dx, dy);
  }

  /**
   * @param vec   {paths} from PdfVec.extractPaths
   * @param ocr   {words, items} from GlyphOCR.readPage
   * @param sheet sheet label (e.g. '10')
   */
  function readSheet(vec, ocr, sheet) {
    const paths = vec.paths;
    // ---- paths used by text / terminal circles / junction outlines
    const textPath = new Set(), termCircles = [], dots = [];
    for (const it of ocr.items) {
      if (it.kind === 'char' || it.used) it.c.src.forEach((i) => textPath.add(i));
      if (it.kind === 'terminal') { it.c.src.forEach((i) => textPath.add(i)); const c = center(it.bbox); termCircles.push({ x: c[0], y: c[1], r: (it.w + it.h) / 4, bbox: it.bbox }); }
      if (it.kind === 'junction') { it.c.src.forEach((i) => textPath.add(i)); const c = center(it.bbox); dots.push(c); }
    }
    paths.forEach((p, i) => {
      if (p.fill && Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]) < 1.6) { dots.push(center(p.bbox)); textPath.add(i); }
    });
    // ---- dashed lines (mechanical links of switches / relays, cabinet boundaries): chains of short collinear strokes
    const shortIdx = [];
    paths.forEach((p, i) => {
      if (!p.stroke || textPath.has(i) || p.polys.length !== 1 || p.polys[0].length !== 2) return;
      const [a, c] = p.polys[0], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L > 0.3 && L < 3.4 && (Math.abs(c[1] - a[1]) < 0.05 || Math.abs(c[0] - a[0]) < 0.05)) shortIdx.push(i);
    });
    const dashLinks = [];
    for (const horiz of [true, false]) {
      const ds = shortIdx.filter((i) => { const [a, c] = paths[i].polys[0]; return horiz ? Math.abs(c[1] - a[1]) < 0.05 : Math.abs(c[0] - a[0]) < 0.05; })
        .map((i) => { const [a, c] = paths[i].polys[0]; return horiz ? { i: i, k: a[1], s: Math.min(a[0], c[0]), e: Math.max(a[0], c[0]) } : { i: i, k: a[0], s: Math.min(a[1], c[1]), e: Math.max(a[1], c[1]) }; })
        .sort((x, y) => (x.k - y.k) || (x.s - y.s));
      const done = new Set();
      for (let i = 0; i < ds.length; i++) {
        if (done.has(i)) continue;
        const chain = [ds[i]]; done.add(i);
        for (let j = i + 1; j < ds.length && ds[j].k - ds[i].k < 0.3; j++) {
          if (done.has(j)) continue;
          const last = chain[chain.length - 1];
          if (Math.abs(ds[j].k - last.k) < 0.3 && ds[j].s - last.e > 0.2 && ds[j].s - last.e < 3.5) { chain.push(ds[j]); done.add(j); }
        }
        if (chain.length >= 3) {
          chain.forEach((d) => textPath.add(d.i));
          dashLinks.push({ horiz: horiz, k: chain[0].k, s: chain[0].s, e: chain[chain.length - 1].e });
        }
      }
    }
    // ---- long-dash boundary lines (some drawings draw the +LCC / +RCC boxes with ~25pt dashes):
    // a run of >= 4 collinear, equally long strokes separated by equal, empty gaps
    const boundLines = [];
    {
      const edges = [];
      paths.forEach((p, i) => {
        if (!p.stroke || textPath.has(i) || p.polys.length !== 1 || p.polys[0].length > 3) return;
        const pl = p.polys[0];
        for (let k = 0; k + 1 < pl.length; k++) {
          const a = pl[k], c = pl[k + 1], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
          const h = Math.abs(c[1] - a[1]) < 0.05, v = Math.abs(c[0] - a[0]) < 0.05;
          if (!(h || v) || L < 8 || L > 45) continue;
          edges.push(h ? { i: i, horiz: true, k: a[1], s: Math.min(a[0], c[0]), e: Math.max(a[0], c[0]), L: L }
            : { i: i, horiz: false, k: a[0], s: Math.min(a[1], c[1]), e: Math.max(a[1], c[1]), L: L });
        }
      });
      const nearTerm = (x, y) => termCircles.some((t) => Math.hypot(t.x - x, t.y - y) < t.r + 2.5) || dots.some((d) => Math.hypot(d[0] - x, d[1] - y) < 2.5);
      for (const horiz of [true, false]) {
        const ds = edges.filter((d) => d.horiz === horiz).sort((x, y) => (x.k - y.k) || (x.s - y.s));
        const done = new Set();
        for (let i = 0; i < ds.length; i++) {
          if (done.has(i)) continue;
          const chain = [ds[i]];
          for (let j = i + 1; j < ds.length && ds[j].k - ds[i].k < 0.3; j++) {
            if (done.has(j)) continue;
            const last = chain[chain.length - 1], gap = ds[j].s - last.e;
            if (gap < 3 || gap > 10) continue;
            const mid = (ds[j].s + last.e) / 2;
            if (horiz ? nearTerm(mid, last.k) : nearTerm(last.k, mid)) continue;
            chain.push(ds[j]);
          }
          if (chain.length < 4) continue;
          const gaps = chain.slice(1).map((d, k) => d.s - chain[k].e);
          const inner = chain.slice(1, -1).map((d) => d.L);   // end pieces may be cut by a corner
          if (Math.max(...gaps) - Math.min(...gaps) > 1.5) continue;
          if (inner.length && Math.max(...inner) - Math.min(...inner) > 2) continue;
          chain.forEach((d) => { textPath.add(d.i); done.add(ds.indexOf(d)); });
          boundLines.push({ horiz: horiz, k: chain[0].k, s: chain[0].s, e: chain[chain.length - 1].e });
        }
      }
    }
    // ---- wire segments
    // component bodies: small closed rectangles (overload relay, MCB, coil boxes). Strokes inside a body
    // are the symbol's internals (e.g. the heater loop that runs straight from pin 1 to pin 2), not wiring.
    const bodies = [];
    paths.forEach((p, i) => {
      if (!p.stroke || textPath.has(i) || p.polys.length !== 1) return;
      const pl = p.polys[0];
      if (pl.length !== 5 || Math.hypot(pl[0][0] - pl[4][0], pl[0][1] - pl[4][1]) > 0.05) return;
      for (let k = 0; k < 4; k++) if (Math.abs(pl[k][0] - pl[k + 1][0]) > 0.05 && Math.abs(pl[k][1] - pl[k + 1][1]) > 0.05) return;
      const w = p.bbox[2] - p.bbox[0], h = p.bbox[3] - p.bbox[1];
      if (w < 3 || h < 3 || w > 40 || h > 40) return;
      bodies.push(p.bbox); textPath.add(i);
    });
    const clipOut = (s) => {   // pieces of s outside every body
      let pieces = [s];
      for (const b of bodies) {
        const next = [];
        for (const q of pieces) {
          if (Math.max(q[0], q[2]) <= b[0] || Math.min(q[0], q[2]) >= b[2] || Math.max(q[1], q[3]) <= b[1] || Math.min(q[1], q[3]) >= b[3]) { next.push(q); continue; }
          // Liang-Barsky: part of q inside b (shrunk a hair so wires ending on the outline survive)
          const e = 0.05, dx = q[2] - q[0], dy = q[3] - q[1];
          let t0 = 0, t1 = 1, ok = true;
          [[-dx, q[0] - (b[0] + e)], [dx, (b[2] - e) - q[0]], [-dy, q[1] - (b[1] + e)], [dy, (b[3] - e) - q[1]]].forEach(([pp, qq]) => {
            if (!ok) return;
            if (Math.abs(pp) < 1e-9) { if (qq < 0) ok = false; return; }
            const r = qq / pp;
            if (pp < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
          });
          if (!ok || t0 >= t1) { next.push(q); continue; }
          if (t0 > 0) next.push([q[0], q[1], q[0] + dx * t0, q[1] + dy * t0]);
          if (t1 < 1) next.push([q[0] + dx * t1, q[1] + dy * t1, q[2], q[3]]);
        }
        pieces = next;
      }
      return pieces;
    };
    const segs = [];
    paths.forEach((p, i) => {
      if (!p.stroke || textPath.has(i)) return;
      for (const pl of p.polys) for (let k = 0; k + 1 < pl.length; k++) {
        for (const s of clipOut([pl[k][0], pl[k][1], pl[k + 1][0], pl[k + 1][1]])) {
          if (Math.hypot(s[2] - s[0], s[3] - s[1]) < 0.05) continue;
          s.path = i; segs.push(s);
        }
      }
    });
    const n = segs.length, par = new Int32Array(n).map((_, i) => i);
    const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const u = (a, b) => { par[f(a)] = f(b); };
    // consecutive segments of one polyline belong together
    for (let i = 1; i < n; i++) if (segs[i].path === segs[i - 1].path && Math.hypot(segs[i][0] - segs[i - 1][2], segs[i][1] - segs[i - 1][3]) < 1e-6) u(i, i - 1);
    // spatial grid
    const G = 10, grid = new Map();
    const cellsOf = (s) => {
      const out = [];
      for (let gx = Math.floor(Math.min(s[0], s[2]) / G); gx <= Math.floor(Math.max(s[0], s[2]) / G); gx++)
        for (let gy = Math.floor(Math.min(s[1], s[3]) / G); gy <= Math.floor(Math.max(s[1], s[3]) / G); gy++) out.push(gx + ',' + gy);
      return out;
    };
    segs.forEach((s, i) => cellsOf(s).forEach((k) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }));
    const near = (x, y) => (grid.get(Math.floor(x / G) + ',' + Math.floor(y / G)) || []);
    const dotAt = (x, y) => dots.some((d) => Math.hypot(d[0] - x, d[1] - y) < 0.7);
    const EP = 0.2;
    const degree = new Map();                 // endpoint key -> count of segment ends there
    const key = (x, y) => Math.round(x / EP) + ',' + Math.round(y / EP);
    segs.forEach((s) => { [[s[0], s[1]], [s[2], s[3]]].forEach(([x, y]) => degree.set(key(x, y), (degree.get(key(x, y)) || 0) + 1)); });
    segs.forEach((s, i) => {
      for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) {
        for (const j of near(x, y)) {
          if (j === i) continue;
          const t = segs[j];
          const eEnd = Math.hypot(t[0] - x, t[1] - y) < EP || Math.hypot(t[2] - x, t[3] - y) < EP;
          if (eEnd) {
            // plain corner / continuation; a dot or exactly two ends make it a real joint
            u(i, j);
          } else if (dist2seg(x, y, t) < EP) {
            // T-joint only with a junction dot; a collinear overlap (wire drawn over a symbol lead) is one line
            const ax = s[2] - s[0], ay = s[3] - s[1], bx = t[2] - t[0], by = t[3] - t[1];
            const collinear = Math.abs(ax * by - ay * bx) < 1e-3 * Math.hypot(ax, ay) * Math.hypot(bx, by);
            if (collinear || dotAt(x, y)) u(i, j);
          }
        }
      }
    });
    // ---- components
    const comp = new Map();
    segs.forEach((s, i) => { const r = f(i); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(i); });
    const nets = [];
    for (const ids of comp.values()) {
      let len = 0, b = [Infinity, Infinity, -Infinity, -Infinity];
      ids.forEach((i) => { const s = segs[i]; len += Math.hypot(s[2] - s[0], s[3] - s[1]); b = [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])]; });
      nets.push({ segs: ids, len: len, bbox: b, pins: [], labels: [], xrefs: [], terms: [] });
    }
    const netOf = new Int32Array(n);
    nets.forEach((nt, k) => nt.segs.forEach((i) => { netOf[i] = k; }));
    const nearestNet = (x, y, lim, box) => {
      let best = -1, bd = lim;
      for (let gx = Math.floor((x - lim - 4) / G); gx <= Math.floor((x + lim + 4) / G); gx++)
        for (let gy = Math.floor((y - lim - 4) / G); gy <= Math.floor((y + lim + 4) / G); gy++)
          for (const j of grid.get(gx + ',' + gy) || []) {
            const sg = segs[j];
            if (Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) < 0.6) continue;
            const d = box ? boxSeg(box, sg) : dist2seg(x, y, sg);
            if (d < bd) { bd = d; best = j; }
          }
      return best < 0 ? null : { net: netOf[best], d: bd, seg: segs[best] };
    };

    // ---- words by role
    const W = ocr.words.map((w) => Object.assign({}, w, { c: center(w.bbox) }));
    const devLabels = W.filter((w) => RX.device.test(w.text));
    const xrefs = W.filter((w) => RX.xref.test(w.text));

    const links = dashLinks.filter((l) => l.horiz && l.e - l.s < 260).map((l) => ({ y: l.k, x0: l.s, x1: l.e }));
    const labelLeftOf = (x, y, maxDx, maxDy) => devLabels.map((d) => {
      const dx = x - d.bbox[2], dy = Math.abs(y - d.c[1]);
      if (dx < -2 || dx > maxDx || dy > maxDy) return null;
      return [d, dx + 1.6 * dy];
    }).filter(Boolean).sort((a, b) => a[1] - b[1])[0];

    // terminals: wire ends on a circle; pin name = nearest short word, block = '-TB..' / '-X..' label on the same row
    // terminal rows: circles on one line share the '-TB..' / '-X..' label written left of (or above) the row
    const tbLabels = devLabels.filter((w) => /^-(TB|X\d|TBL|X-|TB-)/.test(w.text));
    const rows = [];
    // bands of equal y (circles of one row may differ by a fraction of a point), split where x jumps
    const byY = termCircles.slice().sort((a, b) => a.y - b.y), bands = [];
    byY.forEach((tc) => { const bd = bands[bands.length - 1]; if (bd && tc.y - bd[0].y < 1.2) bd.push(tc); else bands.push([tc]); });
    for (const bd of bands) {
      bd.sort((a, b) => a.x - b.x);
      let cur = null;
      for (const tc of bd) {
        if (!cur || tc.x - cur.xs[cur.xs.length - 1] >= 60) { cur = { y: tc.y, xs: [], items: [] }; rows.push(cur); }
        cur.items.push(tc); cur.xs.push(tc.x);
      }
    }
    for (const r of rows) {
      for (const tc of r.items) {
        tc.block = tbLabels.filter((w) => w.bbox[2] <= tc.x + 2 && tc.x - w.bbox[2] < 45 && Math.abs(w.c[1] - tc.y) < 14)
          .sort((a, b) => (tc.x - a.bbox[2] + 2 * Math.abs(a.c[1] - tc.y)) - (tc.x - b.bbox[2] + 2 * Math.abs(b.c[1] - tc.y)))[0];
      }
      // carry the nearest block label along the row
      let cur = null;
      for (const tc of r.items.sort((a, b) => a.x - b.x)) { if (tc.block) cur = tc.block; else if (cur) tc.block = cur; }
    }
    const termWords = new Set();
    for (const tc of termCircles) {
      const touching = new Set();
      for (const j of near(tc.x, tc.y).concat(near(tc.x + tc.r, tc.y), near(tc.x - tc.r, tc.y), near(tc.x, tc.y + tc.r), near(tc.x, tc.y - tc.r))) {
        const sg = segs[j];
        for (const [x, y] of [[sg[0], sg[1]], [sg[2], sg[3]]]) {
          const d = Math.hypot(x - tc.x, y - tc.y);
          if (d > tc.r - 0.4 && d < tc.r + 0.4) touching.add(netOf[j]);
        }
      }
      const cand = W.filter((w) => !RX.device.test(w.text) && !RX.xref.test(w.text) && w.text.length <= 6 && boxDist(w.bbox, tc.bbox) < 3.5)
        .sort((a, b) => boxDist(a.bbox, tc.bbox) - boxDist(b.bbox, tc.bbox));
      const blk = tc.block;
      if (cand[0]) termWords.add(cand[0]);
      const pin = cand[0] ? cand[0].text : '?';
      touching.forEach((k) => nets[k].terms.push({ dev: blk ? blk.text : '-TB?', pin: pin, x: tc.x, y: tc.y, sure: !!(blk && cand[0]) }));
    }
    // device pins: pin text beside a symbol lead; device = label left of the symbol, or the label at the
    // left end of a dashed mechanical link running through the symbol
    const used = new Set(termWords);
    const pinCands = [];
    for (const w of W) {
      if (used.has(w) || RX.device.test(w.text) || RX.xref.test(w.text) || RX.loc.test(w.text)) continue;
      if (!RX.pin.test(w.text) || w.text.length > 4) continue;
      // text just under a device label is its cross reference (/10.G3), not a pin
      if (devLabels.some((d) => w.bbox[1] - d.bbox[3] > -0.5 && w.bbox[1] - d.bbox[3] < 4 && w.c[0] > d.bbox[0] - 2 && w.c[0] < d.bbox[2] + 6)) continue;
      const nn = nearestNet(w.c[0], w.c[1], 3.0, w.bbox);
      if (!nn) continue;
      let dev = labelLeftOf(w.c[0], w.c[1], 44, 24);
      const lk = links.filter((l) => Math.abs(l.y - w.c[1]) < 11 && w.c[0] > l.x0 - 4 && w.c[0] < l.x1 + 8);
      for (const l of lk) {
        const ld = labelLeftOf(l.x0, l.y, 34, 15);
        if (ld && (!dev || dev[1] > 18)) dev = [ld[0], 18];
      }
      pinCands.push({ w: w, nn: nn, dev: dev, linked: lk.length > 0 });
      used.add(w);
    }
    // multi-pole symbols: pins 1-3-5 (or 2-4-6) in one row belong to one device; the label of the
    // NEXT device often sits just right of pin 5, so give the whole row the label left of its first pin
    const rowsP = [];
    pinCands.slice().sort((a, b) => (a.w.c[1] - b.w.c[1]) || (a.w.c[0] - b.w.c[0])).forEach((pc) => {
      const r = rowsP.find((q) => {
        const last = q[q.length - 1];
        if (Math.abs(last.w.c[1] - pc.w.c[1]) > 1.0) return false;
        const dx = pc.w.c[0] - last.w.c[0];
        if (dx <= 0 || dx > 16) return false;
        // a device label between the two pins starts a new device
        return !devLabels.some((d) => d.bbox[0] > last.w.c[0] && d.bbox[2] < pc.w.c[0] + 1 && Math.abs(d.c[1] - pc.w.c[1]) < 14);
      });
      if (r) r.push(pc); else rowsP.push([pc]);
    });
    for (const r of rowsP) {
      if (r.length >= 2 && !r.some((pc) => pc.linked)) {
        const first = r[0];
        const lab = labelLeftOf(first.w.c[0], first.w.c[1], 44, 24);
        if (lab) r.forEach((pc) => { pc.dev = lab; });
      }
    }
    // pins written above and below the same component box (1 over 2, 3 over 4 ...) are one device:
    // the pin far from the label inherits the device found for its partner
    const byBody = new Map();
    for (const pc of pinCands) {
      const w = pc.w;
      const bi = bodies.findIndex((b) => w.c[0] >= b[0] && w.c[0] <= b[2] + 1 && Math.max(b[1] - w.bbox[3], w.bbox[1] - b[3]) < 8 && Math.max(b[1] - w.bbox[3], w.bbox[1] - b[3]) > -1);
      if (bi < 0) continue;
      if (!byBody.has(bi)) byBody.set(bi, []);
      byBody.get(bi).push(pc);
    }
    for (const g of byBody.values()) {
      const best = g.filter((pc) => pc.dev).sort((a, b) => a.dev[1] - b.dev[1])[0];
      if (best) g.forEach((pc) => { if (!pc.dev || pc.dev[1] > best.dev[1] + 6) pc.dev = best.dev; });
    }
    for (const r of rowsP) {
      for (const pc of r) {
        if (!pc.dev) { used.delete(pc.w); continue; }
        nets[pc.nn.net].pins.push({ dev: pc.dev[0].text, pin: pc.w.text, x: pc.w.c[0], y: pc.w.c[1], word: pc.w, d: pc.dev[1] });
      }
    }
    // wire labels: label-like words close to a wire that are not pins
    for (const w of W) {
      if (used.has(w) || !RX.wire.test(w.text) || RX.device.test(w.text)) continue;
      const nn = nearestNet(w.c[0], w.c[1], 4.5, w.bbox);
      if (nn) nets[nn.net].labels.push({ text: w.text, d: nn.d });
    }
    // cross-sheet references: '/08.B1' next to an arrow at a wire end
    for (const x of xrefs) {
      const nn = nearestNet(x.c[0], x.c[1], 8);
      if (nn) nets[nn.net].xrefs.push(x.text);
    }
    // location boxes (+TR, +MCC, +LCC, +RCC ...): the dashed rectangle around a '+XXX' word
    const longL = dashLinks.filter((l) => l.e - l.s > 25).concat(boundLines);
    const longH = longL.filter((l) => l.horiz), longV = longL.filter((l) => !l.horiz);
    const boxes = [];
    for (const w of W.filter((x) => RX.loc.test(x.text))) {
      const [x, y] = w.c;
      const top = longH.filter((l) => l.k < y && l.s - 3 < x && l.e + 3 > x).sort((a, b) => b.k - a.k)[0];
      const bot = longH.filter((l) => l.k > y && l.s - 3 < x && l.e + 3 > x).sort((a, b) => a.k - b.k)[0];
      const lef = longV.filter((l) => l.k < x && l.s - 3 < y && l.e + 3 > y).sort((a, b) => b.k - a.k)[0];
      const rig = longV.filter((l) => l.k > x && l.s - 3 < y && l.e + 3 > y).sort((a, b) => a.k - b.k)[0];
      const rect = [lef ? lef.k : (top ? top.s : -Infinity), top ? top.k : -Infinity, rig ? rig.k : (top ? top.e : Infinity), bot ? bot.k : Infinity];
      if (!isFinite(rect[1]) && !isFinite(rect[3])) continue;
      boxes.push({ text: w.text.replace(/\.$/, ''), rect: rect, area: (rect[2] - rect[0]) * (rect[3] - rect[1]) });
    }
    const locAt = (x, y) => {
      const b = boxes.filter((q) => x >= q.rect[0] && x <= q.rect[2] && y >= q.rect[1] && y <= q.rect[3]).sort((p, q) => p.area - q.area)[0];
      return b ? b.text : '';
    };

    const nodes = nets.filter((nt) => nt.pins.length + nt.terms.length >= 1 && nt.len > 2).map((nt) => {
      const lab = nt.labels.sort((a, b) => a.d - b.d)[0];
      // no label on the wire: terminals are usually numbered after the wire they carry
      // (TB01:R0 on wire R0, TB03:121 on wire 121), so one plausible terminal name stands in
      let wire = lab ? lab.text : '', wireFrom = lab ? 'label' : '';
      if (!wire) {
        const tn = Array.from(new Set(nt.terms.map((t) => t.pin))).filter((p) => RX.wire.test(p) && !/^\d{1,2}$/.test(p));
        if (tn.length === 1) { wire = tn[0]; wireFrom = 'terminal'; }
      }
      return {
        sheet: sheet, wire: wire, wireFrom: wireFrom, labels: nt.labels.map((l) => l.text),
        pins: nt.pins.map((p) => ({ dev: p.dev, pin: p.pin, x: p.x, y: p.y, loc: locAt(p.x, p.y) })),
        terms: nt.terms.map((t) => Object.assign({}, t, { loc: locAt(t.x, t.y) })),
        xrefs: Array.from(new Set(nt.xrefs)), bbox: nt.bbox, len: nt.len
      };
    });
    return { sheet: sheet, nodes: nodes, boxes: boxes, nets: nets, segs: segs, dots: dots, terms: termCircles, links: links };
  }

  const api = { readSheet: readSheet, RX: RX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchematicReader = api;
})(typeof window !== 'undefined' ? window : this);
