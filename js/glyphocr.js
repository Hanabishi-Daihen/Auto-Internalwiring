/*
 * Offline reader for CAD single-stroke text drawn as vector paths (labels that are not real PDF text).
 * 1) group small stroke paths into characters  2) match each against glyph templates (0 / +90 / -90 deg)
 * 3) assemble words (reading direction, '-' prefixes, '.' separators, O/0 by context).
 * Browser: window.GlyphOCR   Node: module.exports
 */
(function (root) {
  'use strict';
  const N = 24, SMALL = 6.5, TOL = 0.25, TOUCH = 0.18;

  // ---------------------------------------------------------------- rasterising
  function bboxOf(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pl of polys) for (const p of pl) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }
  function rot(polys, r) {
    if (r === 0) return polys;
    if (r === 1) return polys.map((pl) => pl.map((p) => [p[1], -p[0]]));     // 90 deg CCW: text reads bottom -> top
    return polys.map((pl) => pl.map((p) => [-p[1], p[0]]));                   // 90 deg CW
  }
  function bitmap(polys) {
    const b = bboxOf(polys), w = b[2] - b[0], h = b[3] - b[1];
    const s = (N - 4) / Math.max(w, h, 1e-6), ox = (N - w * s) / 2, oy = (N - h * s) / 2;
    const bm = new Uint8Array(N * N);
    const plot = (x, y) => {           // ~2 px pen like PIL width=2
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) {
        const X = xi + dx, Y = yi + dy;
        if (X >= 0 && Y >= 0 && X < N && Y < N) bm[Y * N + X] = 1;
      }
    };
    for (const pl of polys) {
      const q = pl.map((p) => [(p[0] - b[0]) * s + ox, (p[1] - b[1]) * s + oy]);
      if (q.length === 1) q.push(q[0]);
      for (let i = 0; i + 1 < q.length; i++) {
        const [x0, y0] = q[i], [x1, y1] = q[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
        for (let k = 0; k <= n; k++) plot(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
      }
    }
    const m = Math.max(w, h, 1e-3);
    return { bm: bm, la: Math.log((w + 0.05 * m) / (h + 0.05 * m)), ink: bm.reduce((a, v) => a + v, 0) };
  }
  function dilate(bm) {
    const o = bm.slice();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!bm[y * N + x]) continue;
      if (x > 0) o[y * N + x - 1] = 1; if (x < N - 1) o[y * N + x + 1] = 1;
      if (y > 0) o[(y - 1) * N + x] = 1; if (y < N - 1) o[(y + 1) * N + x] = 1;
    }
    return o;
  }

  // ---------------------------------------------------------------- templates
  function Reader(templates) {
    this.T = [];
    for (const [lab, polys] of templates) {
      for (const r of [0, 1, 2]) {
        const b = bitmap(rot(polys, r));
        this.T.push({ lab: lab, r: r, bm: b.bm, dl: dilate(b.bm), la: b.la, ink: b.ink });
      }
    }
  }
  Reader.prototype.classify = function (polys) {
    const b = bitmap(polys), bd = dilate(b.bm), best = {};
    for (const t of this.T) {
      if (Math.abs(b.la - t.la) > 0.45) continue;
      let a1 = 0, a2 = 0;
      for (let i = 0; i < N * N; i++) { if (b.bm[i] && t.dl[i]) a1++; if (t.bm[i] && bd[i]) a2++; }
      const s = 0.5 * (a1 / Math.max(b.ink, 1) + a2 / Math.max(t.ink, 1));
      if (!best[t.r] || s > best[t.r][1]) best[t.r] = [t.lab, s];
    }
    return best;
  };
  const top = (best) => Math.max(0, ...Object.values(best).map((v) => v[1]));

  // ---------------------------------------------------------------- geometry helpers
  function segsOf(polys) { const S = []; for (const pl of polys) for (let k = 0; k + 1 < pl.length; k++) S.push([pl[k], pl[k + 1]]); return S; }
  function ptSeg(p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-12)));
    return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby);
  }
  function minPtSegs(P, S, lim) {
    for (const p of P) for (const s of S) if (ptSeg(p, s[0], s[1]) < lim) return true;
    return false;
  }
  function crosses(S1, S2) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    for (const [a, b] of S1) for (const [c, d] of S2) {
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 1) characters
  function clusters(paths) {
    const small = paths.filter((p) => p.stroke && !p.fill && Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]) < SMALL);
    const n = small.length, par = new Int32Array(n).map((_, i) => i);
    const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const ends = small.map((q) => q.polys.flatMap((pl) => [pl[0], pl[pl.length - 1]]));
    const pts = small.map((q) => q.polys.flat());
    const segs = small.map((q) => segsOf(q.polys));
    const grid = new Map();
    small.forEach((q, i) => {
      for (let gx = Math.floor(q.bbox[0] / 4); gx <= Math.floor(q.bbox[2] / 4); gx++)
        for (let gy = Math.floor(q.bbox[1] / 4); gy <= Math.floor(q.bbox[3] / 4); gy++) {
          const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
        }
    });
    const seen = new Set();
    for (const cell of grid.values()) {
      for (let x = 0; x < cell.length; x++) for (let y = x + 1; y < cell.length; y++) {
        const i = cell[x], j = cell[y];
        const key = i < j ? i * n + j : j * n + i;
        if (seen.has(key)) continue; seen.add(key);
        if (f(i) === f(j)) continue;
        const A = small[i].bbox, B = small[j].bbox;
        if (A[0] > B[2] + TOL || B[0] > A[2] + TOL || A[1] > B[3] + TOL || B[1] > A[3] + TOL) continue;
        if (minPtSegs(ends[i], segs[j], TOL) || minPtSegs(ends[j], segs[i], TOL) || crosses(segs[i], segs[j]) || minPtSegs(pts[i], segs[j], TOUCH))
          par[f(i)] = f(j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    const idx = []; paths.forEach((p, i) => { if (p.stroke && !p.fill && Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]) < SMALL) idx.push(i); });
    return Array.from(groups.values()).map((g) => mk(g.map((i) => small[i].polys), g.map((i) => idx[i])));
  }
  function mk(pathPolys, src) {
    const polys = pathPolys.flat();
    return { polys: polys, bbox: bboxOf(polys), paths: pathPolys, src: src || [] };
  }
  function isLine(c) {
    const w = c.bbox[2] - c.bbox[0], h = c.bbox[3] - c.bbox[1];
    return (h < 0.12 * w || w < 0.12 * h) && c.polys.length === 1;
  }

  // ---------------------------------------------------------------- 2) page reading
  function readPage(paths, reader) {
    // endpoints of every stroke, used to recognise terminal circles (a wire ends on the circle)
    const E = [];
    paths.forEach((p, i) => { if (p.stroke) for (const pl of p.polys) { E.push([pl[0][0], pl[0][1], i]); E.push([pl[pl.length - 1][0], pl[pl.length - 1][1], i]); } });
    const terminalCircle = (c) => {
      const w = c.bbox[2] - c.bbox[0], h = c.bbox[3] - c.bbox[1];
      if (!(w > 1.0 && w < 6.2 && w / Math.max(h, 1e-6) > 0.85 && w / Math.max(h, 1e-6) < 1.18) || c.paths.length > 2) return false;
      const own = new Set(c.src), cx = (c.bbox[0] + c.bbox[2]) / 2, cy = (c.bbox[1] + c.bbox[3]) / 2, r = (w + h) / 4;
      for (const p of E) {
        if (own.has(p[2])) continue;
        const d = Math.hypot(p[0] - cx, p[1] - cy); if (d > r - 0.3 && d < r + 0.3) return true;
      }
      return false;
    };
    const splitTouching = (c) => {
      const P = c.paths;
      if (P.length < 2 || P.length > 8) return null;
      let best = null;
      for (const axis of [0, 1]) {
        const order = P.map((_, i) => i).sort((a, b) => Math.min(...P[a].flat().map((q) => q[axis])) - Math.min(...P[b].flat().map((q) => q[axis])));
        for (let k = 1; k < P.length; k++) {
          const a = mk(order.slice(0, k).map((i) => P[i]), order.slice(0, k).map((i) => c.src[i])), b = mk(order.slice(k).map((i) => P[i]), order.slice(k).map((i) => c.src[i]));
          const ba = reader.classify(a.polys), bb = reader.classify(b.polys);
          const sz = (x) => Math.max(x.bbox[2] - x.bbox[0], x.bbox[3] - x.bbox[1]);
          const sa = Math.max(sz(a) >= 1.2 ? top(ba) : 0, isLine(a) ? 0.85 : 0), sb = Math.max(sz(b) >= 1.2 ? top(bb) : 0, isLine(b) ? 0.85 : 0);
          if (Math.min(sa, sb) >= 0.8 && (!best || sa + sb > best[0])) best = [sa + sb, [[a, ba], [b, bb]]];
        }
      }
      return best ? best[1] : null;
    };
    const res = [];
    for (const c of clusters(paths)) {
      if (terminalCircle(c)) { c.terminal = true; res.push([c, {}]); continue; }
      const b = reader.classify(c.polys);
      const w = c.bbox[2] - c.bbox[0], h = c.bbox[3] - c.bbox[1];
      if (top(b) < 0.8 && Math.max(w, h) >= 1.2) { const sp = splitTouching(c); if (sp) { res.push(...sp); continue; } }
      res.push([c, b]);
    }
    const items = res.map(([c, best]) => {
      const w = c.bbox[2] - c.bbox[0], h = c.bbox[3] - c.bbox[1];
      const it = { c: c, bbox: c.bbox, w: w, h: h, best: best, kind: 'other' };
      if (c.terminal) it.kind = 'terminal';
      else if (Math.max(w, h) < 1.2 && Math.min(w, h) > 0.5) it.kind = 'junction';
      else if (Object.keys(best).length && top(best) >= 0.8 && Math.max(w, h) >= 1.2) it.kind = 'char';
      else if (Math.max(w, h) < 0.45) it.kind = 'dot';
      else if (h < 0.12 * w && w < 6.5) it.kind = 'hline';
      else if (w < 0.12 * h && h < 6.5) it.kind = 'vline';
      return it;
    });
    return { words: assemble(items), items: items };
  }

  // ---------------------------------------------------------------- 3) words
  function assemble(items) {
    const chars = items.filter((i) => i.kind === 'char');
    const H = (it, r) => (r === 0 ? it.h : it.w);
    const n = chars.length, par = new Int32Array(n).map((_, i) => i);
    const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const linkRot = [];
    // neighbours via a coarse grid
    const grid = new Map(), G = 8;
    chars.forEach((c, i) => { const k = Math.floor(c.bbox[0] / G) + ',' + Math.floor(c.bbox[1] / G); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    chars.forEach((a, i) => {
      const gx = Math.floor(a.bbox[0] / G), gy = Math.floor(a.bbox[1] / G);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get((gx + dx) + ',' + (gy + dy)) || []) {
          if (i === j) continue;
          const b = chars[j];
          for (const r of [0, 1, 2]) {
            if (!a.best[r] || !b.best[r]) continue;
            const ma = top(a.best), mb = top(b.best);
            if (a.best[r][1] < Math.max(0.8, ma - 0.06) || b.best[r][1] < Math.max(0.8, mb - 0.06)) continue;
            const ha = H(a, r), hb = H(b, r);
            if (Math.abs(ha - hb) > 0.35 * Math.max(ha, hb)) continue;
            const Hm = Math.max(ha, hb), A = a.bbox, B = b.bbox;
            let ok;
            if (r === 0) ok = Math.abs(A[3] - B[3]) < 0.25 * Hm && B[0] - A[2] >= -0.05 * Hm && B[0] - A[2] < 0.62 * Hm;
            else if (r === 1) ok = Math.abs(A[2] - B[2]) < 0.25 * Hm && A[1] - B[3] >= -0.05 * Hm && A[1] - B[3] < 0.62 * Hm;
            else ok = Math.abs(A[0] - B[0]) < 0.25 * Hm && B[1] - A[3] >= -0.05 * Hm && B[1] - A[3] < 0.62 * Hm;
            if (ok) { par[f(i)] = f(j); linkRot.push([i, j, r]); }
          }
        }
      }
    });
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    const words = [];
    for (const g of groups.values()) {
      const tot = {};
      for (const i of g) for (const r of Object.keys(chars[i].best)) tot[r] = (tot[r] || 0) + chars[i].best[r][1] + (r === '0' ? 0.02 : r === '1' ? 0.01 : 0);
      if (g.length > 1) { const set = new Set(g); for (const [i, , r] of linkRot) if (set.has(i)) tot[r] = (tot[r] || 0) + 0.5; }
      const r = +Object.keys(tot).reduce((a, b) => (tot[a] >= tot[b] ? a : b));
      const key = r === 0 ? (i) => chars[i].bbox[0] : r === 1 ? (i) => -chars[i].bbox[3] : (i) => chars[i].bbox[1];
      g.sort((x, y) => key(x) - key(y));
      const text = g.map((i) => (chars[i].best[r] || ['?'])[0]).join('');
      const bb = [Math.min(...g.map((i) => chars[i].bbox[0])), Math.min(...g.map((i) => chars[i].bbox[1])), Math.max(...g.map((i) => chars[i].bbox[2])), Math.max(...g.map((i) => chars[i].bbox[3]))];
      words.push({ text: text, rot: r, bbox: bb, members: g, H: g.reduce((s, i) => s + H(chars[i], r), 0) / g.length, prefix: '' });
    }
    // '-' prefixes and '.' separators
    for (const it of items) {
      if (it.kind !== 'hline' && it.kind !== 'vline' && it.kind !== 'dot') continue;
      const [X0, Y0, X1, Y1] = it.bbox;
      for (const w of words) {
        const b = w.bbox, Hm = w.H, r = w.rot;
        if (it.kind === 'hline' && r === 0 && !w.prefix && Math.abs((Y0 + Y1) / 2 - (b[1] + b[3]) / 2) < 0.25 * Hm && b[0] - X1 >= 0 && b[0] - X1 < 0.8 * Hm && it.w > 0.25 * Hm && it.w < Hm) { w.prefix = '-'; w.bbox = [X0, b[1], b[2], b[3]]; it.used = true; break; }
        if (it.kind === 'vline' && r === 1 && !w.prefix && Math.abs((X0 + X1) / 2 - (b[0] + b[2]) / 2) < 0.25 * Hm && Y0 - b[3] >= 0 && Y0 - b[3] < 0.8 * Hm && it.h > 0.25 * Hm && it.h < Hm) { w.prefix = '-'; w.bbox = [b[0], b[1], b[2], Y1]; it.used = true; break; }
        if (it.kind === 'dot') {
          const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
          if (r === 0 && Math.abs(cy - b[3]) < 0.25 * Hm && b[0] < cx && cx < b[2]) { (w.dots = w.dots || []).push(cx); it.used = true; break; }
          if (r === 1 && Math.abs(cx - b[2]) < 0.25 * Hm && b[1] < cy && cy < b[3]) { (w.dots = w.dots || []).push(-cy); it.used = true; break; }
          if (r === 2 && Math.abs(cx - b[0]) < 0.25 * Hm && b[1] < cy && cy < b[3]) { (w.dots = w.dots || []).push(cy); it.used = true; break; }
        }
      }
    }
    // cross references are written '/08.B1': join '/08' and 'B1' split by the dot gap
    for (const a of words) {
      if (a.rot !== 0 || !/^\/\d{1,2}$/.test(a.text)) continue;
      const b = words.find((x) => x !== a && x.rot === 0 && /^[A-I]\d{1,2}$/.test(x.text) && Math.abs(x.bbox[3] - a.bbox[3]) < 0.3 * a.H && x.bbox[0] - a.bbox[2] > 0 && x.bbox[0] - a.bbox[2] < 1.6 * a.H);
      if (b) { a.text = a.text + '.' + b.text; a.bbox = [a.bbox[0], Math.min(a.bbox[1], b.bbox[1]), b.bbox[2], Math.max(a.bbox[3], b.bbox[3])]; a.members = a.members.concat(b.members); b.dead = true; a.joined = true; }
    }
    for (let k = words.length - 1; k >= 0; k--) if (words[k].dead) words.splice(k, 1);
    for (const w of words) {
      if (w.joined) { w.text = w.prefix + w.text; w.chars = w.members.map((i) => chars[i]); delete w.members; continue; }
      let t = fixO0(w.text);
      if (w.dots) {
        const pos = w.members.map((i) => { const bb = chars[i].bbox; return w.rot === 0 ? (bb[0] + bb[2]) / 2 : w.rot === 1 ? -(bb[1] + bb[3]) / 2 : (bb[1] + bb[3]) / 2; });
        let o = '';
        for (let k = 0; k < t.length; k++) { o += t[k]; if (k + 1 < pos.length && w.dots.some((d) => pos[k] < d && d < pos[k + 1])) o += '.'; }
        t = o;
      }
      w.text = w.prefix + t;
      w.chars = w.members.map((i) => chars[i]);
      delete w.members;
    }
    return words;
  }
  function fixO0(t) {
    const c = t.split('');
    for (let k = 0; k < c.length; k++) {
      if (c[k] !== 'O' && c[k] !== '0') continue;
      const L = c[k - 1] || '', R = c[k + 1] || '';
      const dig = [L, R].filter((x) => /\d/.test(x)).length, let_ = [L, R].filter((x) => /[A-NP-Z]/.test(x)).length;
      if (dig >= 1 && let_ === 0) c[k] = '0';
      else if (let_ === 2) c[k] = 'O';
    }
    return c.join('');
  }

  const api = { Reader: Reader, readPage: readPage, clusters: clusters, bitmap: bitmap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GlyphOCR = api;
})(typeof window !== 'undefined' ? window : this);
