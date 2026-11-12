#!/usr/bin/env node
/*
 * Score a saved reading (💾 บันทึกผลการอ่าน .json, method A or B) against a reference netlist.
 *
 *   node tools/eval_reading.js <reading.json> [reference.js|reference.json] [--cabinet LCC.]
 *
 * A reference made from a finished Excel list (tools/xls_reference.py) works too. With --cabinet, only
 * that cabinet's pins of a multi-cabinet reading are scored. Names are normalised on both sides
 * (-TB.X3 + 201 and -X3.201 -> -X3:201, pin 1.0 -> 1, 17(+) -> 17).
 *
 * Reference defaults to data/pp1047a_tcc.js (PP1047A sheets 07-22, traced by hand). Any project file saved
 * by the app (💾 บันทึกโปรเจกต์) also works as a reference once its netlist has been checked.
 * Reports: internal pins found / correct, connections between found pins, nodes reproduced exactly,
 * wire numbers correct / wrong / missing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const AB = require('../js/autobuild.js');

function loadRef(file) {
  const src = fs.readFileSync(file, 'utf8');
  const json = /\.js$/.test(file) ? src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, '') : src;
  return JSON.parse(json);
}
function norm(r) {
  r = r.split('#')[0].replace('(AUX)', '').toUpperCase().replace(/\s+/g, '');
  if (r === 'GND' || /^-?GND:?$/.test(r)) return 'GND';
  const i = r.lastIndexOf(':');
  let d = i < 0 ? r : r.slice(0, i), p = i < 0 ? '' : r.slice(i + 1);
  d = d.replace(/^\+[A-Z0-9]+-/, '-').replace(/^-TB\.(X\d+[A-Z]?)$/, '-$1');
  const m = d.match(/^-(X\d+[A-Z]?)\.(.+)$/);                // terminal written -X3.201: strip X3, terminal 201
  if (m) { d = '-' + m[1]; p = m[2]; }
  p = p.replace(/\(.*?\)/g, '').replace(/^(\d+)\.0$/, '$1');
  return d + ':' + p;
}

function score(pred, ref) {
  const truth = ref.nets.map((n) => ({ wire: n.wire, pins: new Set(n.pins.map((p) => norm(p[0])).filter((r) => r !== 'GND')) }))
    .filter((t) => t.pins.size >= 2);
  const tp = new Set(); truth.forEach((t) => t.pins.forEach((p) => tp.add(p)));
  pred = pred.map((n) => Object.assign({}, n, { pins: n.pins.map((p) => [norm(p[0]), p[1]]) }));
  const pp = new Set(); pred.forEach((n) => n.pins.forEach((p) => pp.add(p[0])));
  const hit = [...pp].filter((p) => tp.has(p)).length;
  const tid = new Map(), pid = new Map();
  truth.forEach((t, i) => t.pins.forEach((p) => { if (!tid.has(p)) tid.set(p, new Set()); tid.get(p).add(i); }));
  pred.forEach((n, i) => n.pins.forEach((p) => { if (!pid.has(p[0])) pid.set(p[0], new Set()); pid.get(p[0]).add(i); }));
  const common = [...tid.keys()].filter((p) => pid.has(p));
  const meet = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
  let TP = 0, FP = 0, FN = 0;
  for (let i = 0; i < common.length; i++) for (let j = i + 1; j < common.length; j++) {
    const st = meet(tid.get(common[i]), tid.get(common[j])), sp = meet(pid.get(common[i]), pid.get(common[j]));
    if (st && sp) TP++; else if (sp) FP++; else if (st) FN++;
  }
  const exact = truth.filter((t) => pred.some((n) => n.pins.length === t.pins.size && n.pins.every((p) => t.pins.has(p[0])))).length;
  const wireOf = new Map(); truth.forEach((t) => t.pins.forEach((p) => wireOf.set(p, t.wire)));
  let wOk = 0, wBad = 0, wMiss = 0;
  for (const n of pred) {
    const votes = new Map();
    n.pins.forEach((p) => { const w = wireOf.get(p[0]); if (w) votes.set(w, (votes.get(w) || 0) + 1); });
    if (!votes.size) continue;
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (/^N\d+$/.test(n.wire)) wMiss++; else if (n.wire === best) wOk++; else wBad++;
  }
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + '%';
  return {
    pins: `internal pins: reference ${tp.size} · read ${pp.size} · correct ${hit} → found ${pct(hit, tp.size)}, correct ${pct(hit, pp.size)}`,
    conn: `connections between found pins: precision ${pct(TP, TP + FP)} · recall ${pct(TP, TP + FN)}`,
    exact: `nodes reproduced exactly: ${exact}/${truth.length}`,
    wires: `wire numbers: correct ${wOk} · wrong ${wBad} · missing ${wMiss}`
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--cabinet'), cab = ci >= 0 ? argv.splice(ci, 2)[1] : null;
  const [readingFile, refFile] = argv;
  if (!readingFile) { console.error('usage: node tools/eval_reading.js <reading.json> [reference]'); process.exit(2); }
  const rd = JSON.parse(fs.readFileSync(readingFile, 'utf8'));
  const ref = loadRef(refFile || path.join(__dirname, '..', 'data', 'pp1047a_tcc.js'));
  const cabinets = (rd.cabs || []).map((c) => c.loc).filter(Boolean);
  const merged = AB.mergeSheets(rd.sheets, { cabinets: cabinets.length ? cabinets : [ref.meta.loc || 'TCC.'] });
  let nets = merged.nets;
  if (cab && cabinets.length > 1) {
    // keep this cabinet's pins (keys are +LCC-...), drop nodes left with fewer than two
    const pre = '+' + cab.replace(/^\+/, '').replace(/\.$/, '') + '-';
    nets = nets.map((n) => Object.assign({}, n, { pins: n.pins.filter((p) => p[0].startsWith(pre)) })).filter((n) => n.pins.length >= 2);
  }
  const s = score(nets, ref);
  if (cab) console.log('cabinet ' + cab);
  console.log(`${rd.pdfName || readingFile} · method ${rd.method}${rd.info && rd.info.model ? ' · ' + rd.info.model : ''} · ${rd.sheets.length} sheets`);
  if (rd.info && rd.info.cost) console.log(`AI cost ≈ $${(+rd.info.cost).toFixed(2)}`);
  Object.values(s).forEach((l) => console.log('  ' + l));
}
module.exports = { score: score, norm: norm, loadRef: loadRef };
