#!/usr/bin/env node
/*
 * Harvest glyph templates from words whose spelling is known (title blocks, notes, view names).
 *
 *   node tools/ocr/harvest_dict.js out.json [--known=QDL,QF1,...] <pdf>:<pages> [<pdf>:<pages> ...]
 *
 * --known adds exact names (e.g. device names printed as real text on the outline) to the dictionary;
 * these may be as short as 3 letters.
 *
 * Runs the browser reader (index.html via Playwright) on each page. A read word that matches exactly one
 * dictionary word of the same length with few differing letters gives, for every differing letter, a
 * candidate template for the true letter (rotated back upright, normalised to unit height). Letters
 * read correctly are kept as controls so tools/ocr/merge_templates.js can reject templates that would
 * break them.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DICT = (`DESCRIPTION PROJECT DEVELOPMENT CONTENTS DIAGRAM SPECIFICATION CONTROL LOCAL COMPANY INTEGRATION COVER SHEET
DRAWING DRAWN TITLE CHECKED APPROVED DESIGNED DATE SCALE EQUIPMENT QUANTITY SIZE TERMINAL INSIDE PANEL FRONT VIEW SIDE
RIGHT LEFT WIRING WIRE JUNCTION CABINET TRANSFORMER ELECTRICITY GENERATING AUTHORITY THAILAND CONTRACT ITEM NAME
MODIFICATION REVISION CUSTOMER MOTOR DRIVE UNIT HEATER LAMP SWITCH RELAY FUSE BREAKER CIRCUIT SUPPLY POWER ALARM TRIP
SIGNAL REMOTE INDICATION TEMPERATURE WINDING PRESSURE RELIEF DEVICE LEVEL GAUGE COOLING SPARE AUXILIARY CONTACT NORMAL
OPEN CLOSE CLOSED ARRANGEMENT OUTLINE INSTALLATION INSTALLING MOUNTING PLATE INNER OUTER DOOR SWING HINGE BOTTOM TOP
SECTION DETAIL MATERIAL STEEL STAINLESS THICKNESS PAINT COLOR COLOUR WEIGHT APPROX DIMENSION DIMENSIONS GROUND EARTH
NEUTRAL VOLTAGE CURRENT FREQUENCY SEQUENCE QUALITY SQUARE JUMPER ADJUST ADJUSTABLE ZONE BUZZER ZERO HORIZONTAL
DISTRIBUTION BOARD MARSHALLING CUBICLE ROOM TANK GROUP FANS RATED EACH OPERATED SUBSTATION ENGINEERING PRODUCT
ELECTRIC LIMITED OPTION OPTIONAL INDICATOR METER AMMETER VOLTMETER SELECTOR PUSH BUTTON EMERGENCY STOP RESET TEST
COUNTER POSITION TAP CHANGER ONLOAD REGULATOR AUTOMATIC MANUAL RAISE LOWER HIGH LOW BLOCK INTERLOCK SUPERVISION
MONITORING THERMOMETER HYGROSTAT THERMOSTAT SOCKET OUTLET LIGHTING ILLUMINATION GLAND PLATE CABLE ENTRY TERMINALS
DUCT SHIELD ASSEMBLY QTY REQUIRED`).split(/\s+/).filter(Boolean);

(async () => {
  const argv = process.argv.slice(2);
  const known = ((argv.find((a) => a.startsWith('--known=')) || '').slice(8)).split(',').filter(Boolean);
  const [out, ...specs] = argv.filter((a) => !a.startsWith('--'));
  DICT.push(...known);
  if (!out || !specs.length) { console.error('usage: harvest_dict.js out.json pdf:pages ...'); process.exit(2); }
  const b = await chromium.launch();
  const p = await (await b.newContext()).newPage();
  p.on('pageerror', (e) => console.error('page error', e.message));
  await p.goto('file://' + path.resolve(__dirname, '..', '..', 'index.html'));
  await p.waitForTimeout(500);
  const all = { cands: [], controls: [], words: 0, matched: 0 };
  for (const spec of specs) {
    const i = spec.lastIndexOf(':');
    const pdf = spec.slice(0, i), pages = spec.slice(i + 1);
    await p.setInputFiles('#aPdfFile', pdf); await p.waitForTimeout(1200);
    const r = await p.evaluate(async ([pages, DICT, known]) => {
      const reader = new GlyphOCR.Reader(GLYPH_TEMPLATES);
      const byLen = new Map(); DICT.forEach((d) => { if (!byLen.has(d.length)) byLen.set(d.length, []); byLen.get(d.length).push(d); });
      const upright = (polys, r) => {
        const q = r === 0 ? polys : r === 1 ? polys.map((pl) => pl.map((p) => [-p[1], p[0]])) : polys.map((pl) => pl.map((p) => [p[1], -p[0]]));
        let x0 = Infinity, y0 = Infinity, y1 = -Infinity;
        q.forEach((pl) => pl.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }));
        const s = 1 / Math.max(y1 - y0, 1e-6);
        return q.map((pl) => pl.map((p) => [+((p[0] - x0) * s).toFixed(3), +((p[1] - y0) * s).toFixed(3)]));
      };
      const res = { cands: [], controls: [], words: 0, matched: 0 };
      for (const pg of AutoBuild.parsePages(pages, IWP.pdf.numPages)) {
        const page = await IWP.pdf.getPage(pg);
        const vec = await PdfVec.extractPaths(page, pdfjsLib.OPS);
        const ocr = GlyphOCR.readPage(vec.paths, reader);
        for (const w of ocr.words) {
          const cs = w.chars || [];
          if (cs.length < 3) continue;
          const raw = cs.map((c) => (c.best[w.rot] || ['?'])[0]).join('');
          res.words++;
          let best = null, second = Infinity;
          for (const d of byLen.get(raw.length) || []) {
            let m = 0; for (let k = 0; k < d.length; k++) if (d[k] !== raw[k]) m++;
            if (!best || m < best[1]) { if (best) second = Math.min(second, best[1]); best = [d, m]; } else second = Math.min(second, m);
          }
          if (!best || best[1] === 0 && false) continue;
          const lim = Math.max(1, Math.floor(raw.length * 0.35));
          if (best[1] > lim || second <= best[1]) continue;
          if (raw.length < 4 && known.indexOf(best[0]) < 0) continue;
          res.matched++;
          const d = best[0];
          cs.forEach((c, k) => {
            const item = { lab: d[k], read: raw[k], rot: w.rot, polys: upright(c.c.polys, w.rot), page: pg, word: d };
            if (d[k] !== raw[k]) res.cands.push(item); else if (Math.random() < 0.25) res.controls.push(item);
          });
        }
      }
      return res;
    }, [pages, DICT, known]);
    console.error(`${path.basename(pdf)} ${pages}: words ${r.words}, matched ${r.matched}, candidates ${r.cands.length}`);
    r.cands.forEach((c) => { c.src = path.basename(pdf); });
    all.cands.push(...r.cands); all.controls.push(...r.controls); all.words += r.words; all.matched += r.matched;
  }
  await b.close();
  fs.writeFileSync(out, JSON.stringify(all));
  const by = {}; all.cands.forEach((c) => { const k = c.read + '→' + c.lab; by[k] = (by[k] || 0) + 1; });
  console.log('confusions', Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => k + ':' + v).join('  '));
})();
