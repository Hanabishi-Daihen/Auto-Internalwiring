/*
 * Vector extraction from a pdf.js page: every painted path as polylines in page points
 * (origin top-left, y down - the same frame as the rendered page).
 * Browser: window.PdfVec   Node: module.exports
 */
(function (root) {
  'use strict';

  function mul(m, n) {            // m x n  (pdf.js transform order)
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function ap(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function bez(p0, p1, p2, p3, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, a = (1 - t) * (1 - t) * (1 - t), b = 3 * (1 - t) * (1 - t) * t, c = 3 * (1 - t) * t * t, d = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
    return out;
  }

  /**
   * @param page   pdf.js PDFPageProxy
   * @param OPS    pdfjsLib.OPS
   * @returns {width, height, paths:[{polys, bbox:[x0,y0,x1,y1], fill, stroke, lw}]}
   */
  async function extractPaths(page, OPS) {
    const vp = page.getViewport({ scale: 1 });
    const ol = await page.getOperatorList();
    const paths = [];
    let ctm = vp.transform.slice();
    const stack = [];
    let polys = [], cur = null, lw = 1;
    const flush = () => { if (cur && cur.length) polys.push(cur); cur = null; };
    function emit(fill, stroke) {
      flush();
      if (!polys.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      polys.forEach((pl) => pl.forEach((p) => { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }));
      const s = Math.hypot(ctm[0], ctm[1]);
      paths.push({ polys: polys, bbox: [x0, y0, x1, y1], fill: fill, stroke: stroke, lw: lw * s });
      polys = [];
    }
    const fn = ol.fnArray, args = ol.argsArray;
    for (let i = 0; i < fn.length; i++) {
      const op = fn[i], a = args[i];
      switch (op) {
        case OPS.save: stack.push([ctm, lw]); break;
        case OPS.restore: { const s = stack.pop(); if (s) { ctm = s[0]; lw = s[1]; } break; }
        case OPS.transform: ctm = mul(ctm, a); break;
        case OPS.paintFormXObjectBegin: stack.push([ctm, lw]); if (a && a[0]) ctm = mul(ctm, a[0]); break;
        case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) { ctm = s[0]; lw = s[1]; } break; }
        case OPS.setLineWidth: lw = a[0]; break;
        case OPS.constructPath: {
          const ops = a[0], c = a[1];
          let k = 0;
          for (let j = 0; j < ops.length; j++) {
            const o = ops[j];
            if (o === OPS.moveTo) { flush(); cur = [ap(ctm, c[k], c[k + 1])]; k += 2; }
            else if (o === OPS.lineTo) { if (!cur) cur = []; cur.push(ap(ctm, c[k], c[k + 1])); k += 2; }
            else if (o === OPS.curveTo) {
              const p0 = cur && cur.length ? cur[cur.length - 1] : ap(ctm, c[k], c[k + 1]);
              cur = cur || [p0];
              cur.push.apply(cur, bez(p0, ap(ctm, c[k], c[k + 1]), ap(ctm, c[k + 2], c[k + 3]), ap(ctm, c[k + 4], c[k + 5]), 6));
              k += 6;
            } else if (o === OPS.curveTo2) {        // first control point = current point
              const p0 = cur[cur.length - 1];
              cur.push.apply(cur, bez(p0, p0, ap(ctm, c[k], c[k + 1]), ap(ctm, c[k + 2], c[k + 3]), 6)); k += 4;
            } else if (o === OPS.curveTo3) {        // last control point = end point
              const p0 = cur[cur.length - 1], p3 = ap(ctm, c[k + 2], c[k + 3]);
              cur.push.apply(cur, bez(p0, ap(ctm, c[k], c[k + 1]), p3, p3, 6)); k += 4;
            } else if (o === OPS.closePath) { if (cur && cur.length) cur.push(cur[0].slice()); }
            else if (o === OPS.rectangle) {
              flush();
              const x = c[k], y = c[k + 1], w = c[k + 2], h = c[k + 3]; k += 4;
              polys.push([ap(ctm, x, y), ap(ctm, x + w, y), ap(ctm, x + w, y + h), ap(ctm, x, y + h), ap(ctm, x, y)]);
            }
          }
          break;
        }
        case OPS.stroke: emit(false, true); break;
        case OPS.closeStroke: if (cur && cur.length) cur.push(cur[0].slice()); emit(false, true); break;
        case OPS.fill: case OPS.eoFill: emit(true, false); break;
        case OPS.fillStroke: case OPS.eoFillStroke: emit(true, true); break;
        case OPS.closeFillStroke: case OPS.closeEOFillStroke: if (cur && cur.length) cur.push(cur[0].slice()); emit(true, true); break;
        case OPS.endPath: flush(); polys = []; break;
        default: break;
      }
    }
    return { width: vp.width, height: vp.height, paths: paths };
  }

  const api = { extractPaths: extractPaths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfVec = api;
})(typeof window !== 'undefined' ? window : this);
