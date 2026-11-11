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
console.log(`nets ${P.nets.length}, wires ${segs}, length ${(lenOpt / 1000).toFixed(1)} m (drawing order ${(lenDraw / 1000).toFixed(1)} m)`);
console.log(fail ? `FAILED: ${fail} problem(s)` : 'PASS');
process.exit(fail ? 1 : 0);
