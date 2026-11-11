/*
 * Automatic project builder: PDF + page ranges -> netlist + device positions -> planner project.
 *   Reading method A: offline (PdfVec + GlyphOCR + SchematicReader)
 *   Reading method B: Claude API (vision) - one request per schematic sheet, JSON output
 * Browser: window.AutoBuild   Node: module.exports (A pipeline + merge are testable without a browser)
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  function parsePages(txt, max) {
    const out = [];
    String(txt || '').split(/[,\s]+/).filter(Boolean).forEach((part) => {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); } else if (/^\d+$/.test(part)) out.push(+part);
    });
    return Array.from(new Set(out)).filter((p) => p >= 1 && (!max || p <= max)).sort((a, b) => a - b);
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const normLoc = (s) => String(s || '').replace(/^\+/, '').replace(/\.$/, '').toUpperCase();

  // ---------------------------------------------------------------- method A (offline)
  /** whitespace-separated tokens of the page's real text, with approximate boxes in viewport points */
  async function textTokens(page) {
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const out = [];
    for (const it of tc.items) {
      const s = it.str || ''; if (!s.trim()) continue;
      const tx = root.pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]) || 1, rot = Math.abs(it.transform[1]) > Math.abs(it.transform[0]);
      const per = (it.width || fh * 0.6 * s.length) / s.length;
      const re = /\S+/g; let m;
      while ((m = re.exec(s))) {
        const a = m.index * per, b = (m.index + m[0].length) * per;
        const bbox = rot ? [tx[4] - fh, tx[5] - b, tx[4], tx[5] - a] : [tx[4] + a, tx[5] - fh, tx[4] + b, tx[5]];
        out.push({ text: m[0], rot: rot ? 1 : 0, bbox: bbox });
      }
    }
    return out;
  }

  async function readSheetsA(pdfDoc, pages, OPS, templates, onProgress) {
    const reader = new root.GlyphOCR.Reader(templates);
    const sheets = [];
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      onProgress && onProgress(`อ่าน Sheet ${pg} (${i + 1}/${pages.length})`, i / pages.length);
      const page = await pdfDoc.getPage(pg);
      const vec = await root.PdfVec.extractPaths(page, OPS);
      const ocr = root.GlyphOCR.readPage(vec.paths, reader);
      // some drawings write the cabinet labels (+LCC. / +RCC.) as real PDF text, not strokes
      (await textTokens(page)).filter((t) => /^\+[A-Z][A-Z0-9]*\.?$/.test(t.text))
        .forEach((t) => ocr.words.push({ text: t.text, rot: t.rot, bbox: t.bbox, H: t.bbox[3] - t.bbox[1], chars: [], prefix: '+', src: 'text' }));
      const sh = root.SchematicReader.readSheet(vec, ocr, pad2(pg));
      sheets.push({ sheet: pad2(pg), nodes: sh.nodes, boxes: sh.boxes, words: ocr.words.length, method: 'A' });
    }
    return sheets;
  }

  // ---------------------------------------------------------------- method B (Claude API)
  const AI_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['nodes', 'notes'],
    properties: {
      nodes: {
        type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['wire', 'points', 'continues'],
          properties: {
            wire: { type: 'string', description: 'wire number written on the node, "" if none' },
            points: {
              type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['device', 'pin', 'cabinet'],
                properties: {
                  device: { type: 'string', description: 'designation as written, e.g. -K1, -TB03, -X3, -8FM1' },
                  pin: { type: 'string', description: 'pin / terminal number, e.g. 13, A1, 1.11, W1, 201' },
                  cabinet: { type: 'string', description: 'the +XXX location box the point is drawn in (e.g. +TR, +RCC), "" if none' }
                }
              }
            },
            continues: { type: 'array', items: { type: 'string' }, description: 'cross-sheet references at this node, e.g. /08.B1' }
          }
        }
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'drawing issues: duplicated wire numbers, unlabelled nodes, unreadable text' }
    }
  };
  const AI_SYSTEM = [
    'You read IEC electrical control schematics of transformer control cabinets and list every electrical node on the sheet.',
    'A node is a set of device pins and terminal points joined by wires. Wires are joined only where a junction dot is drawn; crossing lines without a dot are not joined.',
    'For every node give: the wire number written next to it (or ""), every point on it as device designation + pin number, and any cross-sheet reference arrow on it.',
    'Device designations start with "-" (e.g. -K12, -43CA, -8FM1, -TB03). Terminals: a small circle with the block name (e.g. -TB03) and the terminal number (e.g. 101, W1, P2.21); notation -X3.201 means device -X3, pin 201.',
    'Contacts linked by a dashed mechanical line belong to the device whose label is at the end of the line. Auxiliary contacts of breakers are written like 1.11 / 1.12.',
    'Record the cabinet/location box (+TR, +TCC, +LCC, +RCC, +MDC, +MCC, ...) that encloses each point, or "" when it is not inside a dashed box.',
    'List every node, including nodes that only reach terminals. Do not invent pins that are not drawn. Report unreadable or contradictory items in notes.'
  ].join('\n');

  async function pageImages(page, maxSide) {
    // two overlapping halves keep small text readable (about 1500 px each)
    const vp1 = page.getViewport({ scale: 1 });
    const scale = (maxSide * 2) / vp1.width;
    const vp = page.getViewport({ scale: scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const out = [];
    const w = cv.width, ov = Math.round(w * 0.04);
    for (const [x0, x1] of [[0, w / 2 + ov], [w / 2 - ov, w]]) {
      const c = document.createElement('canvas');
      c.width = Math.round(x1 - x0); c.height = cv.height;
      c.getContext('2d').drawImage(cv, -x0, 0);
      out.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    }
    return out;
  }

  async function readSheetsB(pdfDoc, pages, opts, onProgress) {
    if (!root.Anthropic) throw new Error('ไม่พบไลบรารี Anthropic SDK');
    const client = new root.Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
    const sheets = [];
    const usage = { input: 0, output: 0 };
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      onProgress && onProgress(`AI อ่าน Sheet ${pg} (${i + 1}/${pages.length})`, i / pages.length);
      const page = await pdfDoc.getPage(pg);
      const imgs = await pageImages(page, 1500);
      const stream = client.beta.messages.stream({
        model: opts.model || 'claude-opus-5-5',
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: opts.effort || 'high', format: { type: 'json_schema', schema: AI_SCHEMA } },
        system: AI_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Sheet ${pg} of the schematic, left half:` },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgs[0] } },
            { type: 'text', text: 'Right half (the halves overlap slightly):' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgs[1] } },
            { type: 'text', text: `Cabinet(s) being wired: ${opts.cabinets.join(', ')}. List all electrical nodes on this sheet.` }
          ]
        }]
      });
      const msg = await stream.finalMessage();
      usage.input += (msg.usage && msg.usage.input_tokens) || 0;
      usage.output += (msg.usage && msg.usage.output_tokens) || 0;
      if (msg.stop_reason === 'refusal') throw new Error(`Sheet ${pg}: AI ปฏิเสธการอ่าน (${(msg.stop_details && msg.stop_details.category) || ''})`);
      if (msg.stop_reason === 'max_tokens') throw new Error(`Sheet ${pg}: คำตอบยาวเกินกำหนด`);
      // after a server-side fallback, partial text of the declined attempt precedes a 'fallback' block
      const lastFb = msg.content.map((b) => b.type).lastIndexOf('fallback');
      const txt = msg.content.slice(lastFb + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
      let data;
      try { data = JSON.parse(txt); } catch (e) { throw new Error(`Sheet ${pg}: อ่านผล JSON ไม่ได้`); }
      sheets.push({
        sheet: pad2(pg), method: 'B', notes: data.notes || [],
        nodes: (data.nodes || []).map((n) => ({
          sheet: pad2(pg), wire: n.wire || '', xrefs: n.continues || [], terms: [],
          pins: (n.points || []).map((p) => ({ dev: p.device.trim(), pin: String(p.pin).trim(), loc: (p.cabinet || '').trim() }))
        }))
      });
    }
    return { sheets: sheets, usage: usage };
  }

  // ---------------------------------------------------------------- merge sheets -> internal nets
  /**
   * @param sheets   [{sheet, nodes:[{wire, pins:[{dev,pin,loc}], terms:[{dev,pin,loc}], xrefs}]}]
   * @param opts     {cabinets:['TCC.'], defaultLoc:'TCC.'}
   */
  function mergeSheets(sheets, opts) {
    const cabs = opts.cabinets.map(normLoc);
    const def = normLoc(opts.defaultLoc || opts.cabinets[0]);
    const multi = cabs.length > 1;
    const items = [];
    sheets.forEach((sh) => sh.nodes.forEach((nd, k) => items.push({ sh: sh.sheet, nd: nd, id: sh.sheet + '#' + k })));
    // union nodes that continue on another sheet under the same wire number
    const par = items.map((_, i) => i);
    const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const byWire = new Map();
    items.forEach((it, i) => {
      const w = (it.nd.wire || '').trim();
      // the same wire number on another sheet is the same node (sheets continue through arrows)
      if (!w || /^(E|PE|GND|0|\?)$/.test(w)) return;
      if (!byWire.has(w)) byWire.set(w, []);
      byWire.get(w).push(i);
    });
    for (const ids of byWire.values()) {
      // only across sheets: a number repeated on one sheet is a drawing duplicate, not one node
      const firstOn = new Map();
      ids.forEach((i) => { if (!firstOn.has(items[i].sh)) firstOn.set(items[i].sh, i); });
      const reps = Array.from(firstOn.values());
      if (reps.length < 2) continue;
      const one = (i) => ((items[i].nd.xrefs || []).length > 0);
      if (items[reps[0]].nd.wire.length === 1 && !reps.some(one)) continue;
      for (let k = 1; k < reps.length; k++) par[f(reps[k])] = f(reps[0]);
    }
    const groups = new Map();
    items.forEach((it, i) => { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });

    const nets = [], devices = new Map(), warnings = [];
    let unnamed = 0;
    for (const g of groups.values()) {
      const pins = [], seen = new Set();
      let ext = 0;
      for (const it of g) {
        for (const p of (it.nd.pins || []).concat(it.nd.terms || [])) {
          if (!p.dev || !p.pin || /\?/.test(p.dev + p.pin)) continue;
          const L = normLoc(p.loc) || def;
          if (cabs.indexOf(L) < 0) { ext++; continue; }              // drawn inside +TR / +MCC ... -> external
          const key = (multi ? '+' + L : '') + p.dev;
          const ref = key + ':' + p.pin;
          if (seen.has(ref)) continue;
          seen.add(ref);
          pins.push([ref, it.sh]);
          if (!devices.has(key)) devices.set(key, { loc: L + '.', name: p.dev });
        }
      }
      if (pins.length < 2) continue;
      const wires = Array.from(new Set(g.map((it) => (it.nd.wire || '').trim()).filter(Boolean)));
      let wire = wires[0];
      const remark = [];
      if (!wire) { wire = 'N' + (++unnamed); remark.push('ไม่พบเบอร์สายในแบบ - ตั้งชื่อชั่วคราว'); }
      if (wires.length > 1) remark.push('พบหลายเบอร์ใน node เดียวกัน: ' + wires.join(', '));
      if (ext) remark.push(`มีจุดต่อภายนอก ${ext} จุด (ตัดออก)`);
      nets.push({ wire: wire, sheet: g[0].sh, cls: '', pins: pins, fixed: [], remark: remark.join(' / '), auto: true });
    }
    // same wire number on separate nodes of one sheet -> warn (drawing duplicate or reading error)
    const cnt = new Map();
    nets.forEach((n) => { if (!/^N\d+$/.test(n.wire)) cnt.set(n.wire + '@' + n.sheet, (cnt.get(n.wire + '@' + n.sheet) || 0) + 1); });
    cnt.forEach((v, k) => { if (v > 1) warnings.push(`เบอร์สาย ${k.replace('@', ' (Sheet ')}) ใช้กับ ${v} node`); });
    nets.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.wire.localeCompare(b.wire, undefined, { numeric: true }));
    return { nets: nets, devices: devices, warnings: warnings };
  }

  // ---------------------------------------------------------------- outline pages -> device positions + wireways
  async function readOutline(pdfDoc, pg, OPS, templates, wanted) {
    const page = await pdfDoc.getPage(pg);
    const vp = page.getViewport({ scale: 1 });
    const words = [];
    // 1) real text
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = (it.str || '').trim(); if (!s) continue;
      const tx = root.pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]), rot = Math.abs(it.transform[1]) > Math.abs(it.transform[0]);
      const cx = rot ? tx[4] - fh / 2 : tx[4] + it.width / 2, cy = rot ? tx[5] - it.width / 2 : tx[5] - fh / 2;
      s.split(/\s+/).forEach((t) => words.push({ text: t, x: cx, y: cy, rot: rot ? 1 : 0, src: 'text' }));
    }
    // 2) vector text
    const vec = await root.PdfVec.extractPaths(page, OPS);
    const reader = new root.GlyphOCR.Reader(templates);
    const ocr = root.GlyphOCR.readPage(vec.paths, reader);
    ocr.words.forEach((w) => words.push({ text: w.text, x: (w.bbox[0] + w.bbox[2]) / 2, y: (w.bbox[1] + w.bbox[3]) / 2, rot: w.rot, bbox: w.bbox, src: 'ocr' }));
    // device matches
    const pos = {};
    const canon = (s) => s.replace(/^\+[A-Z0-9]+-/, '-').replace(/^-/, '').replace(/^[A-Z]{2,4}-TB-/, '').toUpperCase();
    const want = new Map(); (wanted || []).forEach((k) => { const c = canon(k); if (!want.has(c)) want.set(c, []); want.get(c).push(k); });
    for (const w of words) {
      const c = canon(w.text);
      // short or all-digit names ("-1", "-27") must carry their dash on the outline too,
      // otherwise the frame's grid numbers 1..9 would be taken for devices
      if ((c.length <= 2 || /^\d+$/.test(c)) && !/^[-+]/.test(w.text)) continue;
      if (want.has(c)) for (const key of want.get(c)) if (!pos[key]) pos[key] = { x: w.x, y: w.y, src: w.src };
    }
    // wireways: 'WIRE WAY' text sits in the middle of the duct
    const wireways = [];
    const ww = ocr.words.filter((w) => /^WIRE$/.test(w.text));
    for (const w of ww) {
      const horiz = w.rot === 0;
      const cx = (w.bbox[0] + w.bbox[2]) / 2, cy = (w.bbox[1] + w.bbox[3]) / 2;
      // duct walls: long lines parallel to the text, a few points either side
      let best = null;
      for (const p of vec.paths) {
        if (!p.stroke) continue;
        for (const pl of p.polys) for (let k = 0; k + 1 < pl.length; k++) {
          const a = pl[k], b = pl[k + 1];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < 25) continue;
          if (horiz && Math.abs(a[1] - b[1]) < 0.1 && Math.abs(a[1] - cy) < 9 && Math.min(a[0], b[0]) < cx && Math.max(a[0], b[0]) > cx) {
            if (!best || L > best.L) best = { L: L, s: Math.min(a[0], b[0]), e: Math.max(a[0], b[0]) };
          }
          if (!horiz && Math.abs(a[0] - b[0]) < 0.1 && Math.abs(a[0] - cx) < 9 && Math.min(a[1], b[1]) < cy && Math.max(a[1], b[1]) > cy) {
            if (!best || L > best.L) best = { L: L, s: Math.min(a[1], b[1]), e: Math.max(a[1], b[1]) };
          }
        }
      }
      if (best) wireways.push(horiz ? [best.s, cy, best.e, cy] : [cx, best.s, cx, best.e]);
    }
    return { page: pg, width: vp.width, height: vp.height, positions: pos, wireways: wireways, words: words.length };
  }

  // ---------------------------------------------------------------- project
  function buildProject(base, merged, outlines, opts) {
    const P = base;
    P.nets = merged.nets;
    P.devices = {};
    P.views = {}; P.wireways = []; P.portals = []; P.terminals = {}; P.bars = {};
    P.backgrounds = P.backgrounds || {};
    P.anomalies = merged.warnings.slice();
    let placed = 0;
    for (const o of outlines) {
      const loc = o.loc;
      const pts = Object.entries(o.positions);
      if (!pts.length) continue;
      const vid = 'V' + o.page + (loc ? '_' + normLoc(loc) : '');
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach(([, p]) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
      o.wireways.forEach((w) => { x0 = Math.min(x0, w[0], w[2]); y0 = Math.min(y0, w[1], w[3]); x1 = Math.max(x1, w[0], w[2]); y1 = Math.max(y1, w[1], w[3]); });
      const pad = 8, scale = opts.mmPerPt || 7.8;
      P.views[vid] = {
        name: `Outline หน้า ${o.page}${loc ? ' (' + loc + ')' : ''} - อัตโนมัติ`, kind: o.wireways.length >= 2 ? 'graph' : 'free',
        rect: [x0 - pad, y0 - pad, x1 + pad, y1 + pad], bg: o.bg, loc: loc,
        map: { x: [x0 - pad, scale], y: [y0 - pad, scale], z: 0 }
      };
      o.wireways.forEach((w, i) => P.wireways.push(['WW' + o.page + '_' + (i + 1), +w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2), +w[3].toFixed(2), vid]));
      pts.forEach(([k, p]) => {
        if (P.devices[k] && P.devices[k].view) return;
        P.devices[k] = { view: vid, bg: o.bg, x: +p.x.toFixed(2), y: +p.y.toFixed(2), w: 5, h: 5, desc: '', assumed: false, loc: loc };
        placed++;
      });
    }
    merged.devices.forEach((d, k) => {
      if (!P.devices[k]) P.devices[k] = { view: null, bg: null, x: 0, y: 0, w: 5, h: 5, desc: 'ไม่พบใน Outline - ยังไม่วาง', assumed: false, loc: d.loc };
      else P.devices[k].loc = d.loc;
    });
    return { project: P, placed: placed };
  }

  const api = { parsePages: parsePages, readSheetsA: readSheetsA, readSheetsB: readSheetsB, mergeSheets: mergeSheets, readOutline: readOutline, buildProject: buildProject, AI_SCHEMA: AI_SCHEMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoBuild = api;
})(typeof window !== 'undefined' ? window : this);
