#!/usr/bin/env node
/*
 * Self test: node tools/selftest.js
 * Plans every net of the bundled project and checks the wiring rules.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/engine.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'pp1047a_tcc.js'), 'utf8');
const sandbox = {};
new Function('window', src)(sandbox);
const P = sandbox.PROJECT_DATA;

const model = E.buildModel(P);
let fail = 0, segs = 0, lenOpt = 0, lenDraw = 0;
const deg = {};
P.nets.forEach((n) => {
  const r = E.planNet(model, n);
  r.warnings.forEach((w) => { console.log('WARN', n.wire, w); fail++; });
  // every pin must be reached (bar members count once per bar)
  const touched = new Set();
  r.segments.forEach((s) => {
    segs++;
    if (!isFinite(s.len)) { console.log('NO ROUTE', n.wire, s.a, s.b); fail++; }
    touched.add(s.a); touched.add(s.b);
    deg[s.a] = (deg[s.a] || 0) + 1; deg[s.b] = (deg[s.b] || 0) + 1;
  });
  const bars = new Set();
  n.pins.forEach(([p]) => {
    const g = model.barIndex[p];
    if (g) { bars.add(g); return; }
    if (n.pins.length > 1 && !touched.has(p)) { console.log('UNCONNECTED', n.wire, p); fail++; }
  });
  bars.forEach((g) => {
    const any = n.pins.some(([p]) => model.barIndex[p] === g && touched.has(p));
    if (!any && n.pins.length > 1) { console.log('BAR NOT CONNECTED', n.wire, g); fail++; }
  });
  lenOpt += r.lenOpt; lenDraw += r.lenDrawing;
});
Object.entries(deg).forEach(([p, d]) => {
  if (p === 'GND') return;
  const isT = !!P.terminals[E.splitPin(p).dev];
  if ((!isT && d > 2) || (isT && d > 4)) { console.log('TOO MANY WIRES', p, d); fail++; }
});
// ---- multi-cabinet project (LCC + RCC): a node drawn in both cabinets is split, terminals keyed +LOC-
const M = {
  meta: { loc: 'LCC.' }, settings: {}, terminals: {}, bars: {},
  views: {
    L: { kind: 'graph', loc: 'LCC.', rect: [0, 0, 100, 100], map: { x: [0, 10], y: [0, 10], z: 0 } },
    R: { kind: 'graph', loc: 'RCC.', rect: [200, 0, 300, 100], map: { x: [200, 10], y: [0, 10], z: 0 } },
    RD: { kind: 'free', loc: 'RCC.', rect: [400, 0, 500, 100], map: { x: [400, 10], y: [0, 10], z: 0 } }
  },
  wireways: [['WL', 10, 50, 90, 50, 'L'], ['WR', 210, 50, 290, 50, 'R']],
  portals: [['HINGE', 'RD', 405, 50, 210, 50, 500, 'R', true]],
  devices: {
    '+LCC-X3': { view: 'L', x: 20, y: 40 }, '-43FLR': { view: 'L', x: 80, y: 40 },
    '+RCC-X3': { view: 'R', x: 220, y: 40 }, '-KR1': { view: 'R', x: 280, y: 40 }, '-43RS': { view: 'RD', x: 450, y: 50 }
  },
  nets: [{ wire: 'F2', sheet: '17', pins: [['+LCC-X3:203', '17'], ['-43FLR:3', '17'], ['+RCC-X3:203', '17'], ['-43RS:4', '17'], ['-KR1:14', '17']] }]
};
const mm = E.buildModel(M);
const r2 = E.planNet(mm, M.nets[0]);
const locsOf = r2.segments.map((s) => E.locOf(mm, s.a) + '|' + E.locOf(mm, s.b));
if (r2.segments.length !== 3 || locsOf.some((l) => l.split('|')[0] !== l.split('|')[1])) { console.log('MULTI-CABINET SPLIT FAILED', locsOf); fail++; }
if (r2.segments.some((s) => !isFinite(s.len))) { console.log('MULTI-CABINET ROUTE FAILED', r2.segments.map((s) => s.a + '>' + s.b + ' ' + s.len)); fail++; }
const viaHinge = r2.segments.some((s) => (s.via || []).indexOf('HINGE') >= 0);
if (!viaHinge) { console.log('DOOR WIRE DID NOT USE HINGE'); fail++; }
console.log(`multi-cabinet test: ${r2.segments.map((s) => s.a + '>' + s.b + ' ' + Math.round(s.len) + 'mm').join(', ')}`);

console.log(`nets ${P.nets.length}, wires ${segs}, length ${(lenOpt / 1000).toFixed(1)} m (drawing order ${(lenDraw / 1000).toFixed(1)} m)`);
console.log(fail ? `FAILED: ${fail} problem(s)` : 'PASS');
process.exit(fail ? 1 : 0);
