#!/usr/bin/env node
/*
 * Add harvested templates (tools/ocr/harvest_dict.js) to data/glyph_templates.js, greedily:
 * a candidate is added only when it fixes clearly more harvested letters than it breaks
 * (correctly read control letters included). 0 and O count as the same letter (same shape in the CAD font).
 *
 *   node tools/ocr/merge_templates.js harvest.json [--write] [--max 80]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../../js/glyphocr.js');

const args = process.argv.slice(2);
const file = args[0];
const write = args.includes('--write');
const maxAdd = +(args[args.indexOf('--max') + 1] || 80) || 80;
const TPL = path.join(__dirname, '..', '..', 'data', 'glyph_templates.js');
const src = fs.readFileSync(TPL, 'utf8');
const head = src.slice(0, src.indexOf('window.GLYPH_TEMPLATES'));
const templates = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
const H = JSON.parse(fs.readFileSync(file, 'utf8'));

const cls = (l) => (l === '0' ? 'O' : l);
const prep = (polys) => { const b = G.bitmap(polys); return { bm: b.bm, dl: G.dilate(b.bm), la: b.la, ink: b.ink }; };
const N2 = 24 * 24;
function sim(a, t) {     // same score as Reader.classify
  if (Math.abs(a.la - t.la) > 0.45) return 0;
  let a1 = 0, a2 = 0;
  for (let i = 0; i < N2; i++) { if (a.bm[i] && t.dl[i]) a1++; if (t.bm[i] && a.dl[i]) a2++; }
  return 0.5 * (a1 / Math.max(a.ink, 1) + a2 / Math.max(t.ink, 1));
}

const items = H.cands.concat(H.controls).map((c) => Object.assign(prep(c.polys), { lab: cls(c.lab), polys: c.polys, cand: !c.read || c.read !== c.lab }));
const T = templates.map(([lab, polys]) => Object.assign(prep(polys), { lab: cls(lab) }));
// current best score for the right letter (cs) and for any wrong letter (ws)
for (const it of items) {
  it.cs = 0; it.ws = 0;
  for (const t of T) { const s = sim(it, t); if (t.lab === it.lab) it.cs = Math.max(it.cs, s); else it.ws = Math.max(it.ws, s); }
}
const ok = () => items.filter((i) => i.cs > i.ws).length;
console.log(`items ${items.length} (candidates ${H.cands.length}, controls ${H.controls.length}) · correct before: ${ok()}`);

const added = [];
for (let round = 0; round < maxAdd; round++) {
  const wrong = items.filter((i) => i.cs <= i.ws && i.cand);
  if (!wrong.length) break;
  // try a sample of wrong items as new templates
  const pool = wrong.length > 160 ? wrong.filter((_, k) => k % Math.ceil(wrong.length / 160) === 0) : wrong;
  let best = null;
  for (const c of pool) {
    let gain = 0, loss = 0;
    for (const it of items) {
      const s = sim(it, c);
      const before = it.cs > it.ws;
      const after = it.lab === c.lab ? Math.max(it.cs, s) > it.ws : it.cs > Math.max(it.ws, s);
      if (after && !before) gain++; else if (before && !after) loss++;
    }
    const net = gain - 2 * loss;
    if (!best || net > best.net) best = { c: c, gain: gain, loss: loss, net: net };
  }
  if (!best || best.net < 3) break;
  for (const it of items) {
    const s = sim(it, best.c);
    if (it.lab === best.c.lab) it.cs = Math.max(it.cs, s); else it.ws = Math.max(it.ws, s);
  }
  added.push([best.c.lab, best.c.polys]);
  console.log(`+ '${best.c.lab}' fixes ${best.gain}, breaks ${best.loss} → correct ${ok()}`);
}
const byLab = {}; added.forEach(([l]) => { byLab[l] = (byLab[l] || 0) + 1; });
console.log(`added ${added.length}: ${JSON.stringify(byLab)} · correct after: ${ok()} / ${items.length}`);
if (write) {
  const all = templates.concat(added.map(([l, p]) => [l === 'O' ? 'O' : l, p]));
  fs.writeFileSync(TPL, head + 'window.GLYPH_TEMPLATES = ' + JSON.stringify(all) + ';\n');
  console.log('wrote', TPL, all.length, 'templates');
}
