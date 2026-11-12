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
  /** geometry of a text item in viewport space: origin, reading direction (dx,dy), up vector (ux,uy), rot 0 / 1 (up) / 2 (down) */
  function textGeom(tx, width) {
    const fh = Math.hypot(tx[2], tx[3]) || 1, L = Math.hypot(tx[0], tx[1]) || 1;
    const dx = tx[0] / L, dy = tx[1] / L;
    // pdf.js item.width is in text space units scaled like the font: convert with the horizontal scale
    const w = (width || 0) * (L / fh > 0 ? L / fh : 1);
    return { x: tx[4], y: tx[5], dx: dx, dy: dy, ux: tx[2], uy: tx[3], width: w, rot: Math.abs(dx) >= Math.abs(dy) ? 0 : dy < 0 ? 1 : 2 };
  }

  /** whitespace-separated tokens of the page's real text, with approximate boxes in viewport points */
  async function textTokens(page) {
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const out = [];
    for (const it of tc.items) {
      const s = it.str || ''; if (!s.trim()) continue;
      const tx = root.pdfjsLib.Util.transform(vp.transform, it.transform);
      const g = textGeom(tx, it.width || Math.hypot(tx[2], tx[3]) * 0.6 * s.length);
      const per = g.width / s.length;
      const re = /\S+/g; let m;
      while ((m = re.exec(s))) {
        const a = m.index * per, b = (m.index + m[0].length) * per;
        const p0 = [g.x + g.dx * a, g.y + g.dy * a], p1 = [g.x + g.dx * b + g.ux, g.y + g.dy * b + g.uy];
        out.push({ text: m[0], rot: g.rot, bbox: [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])] });
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
      // (and some device names: -AN on PP1047A sheet 18)
      (await textTokens(page)).filter((t) => /^\+[A-Z][A-Z0-9]*\.?$/.test(t.text) || /^-[A-Z0-9][A-Z0-9.\-]*[A-Z0-9]$/.test(t.text))
        .forEach((t) => ocr.words.push({ text: t.text, rot: t.rot, bbox: t.bbox, H: t.rot ? t.bbox[2] - t.bbox[0] : t.bbox[3] - t.bbox[1], chars: [], prefix: t.text[0], src: 'text' }));
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

  const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10] };   // USD per million tokens (input, output)
  const B_VERSION = 2;                                                           // bump when the prompt changes (cache key)
  function costOf(usage, model) { const p = PRICE[model] || PRICE['claude-opus-5-5']; return (usage.input * p[0] + usage.output * p[1]) / 1e6; }

  /** words method A reads from the vector strokes, as hints for the AI: "text@x,y" with x,y in % of the page */
  async function textHints(page, OPS, templates) {
    if (!root.PdfVec || !root.GlyphOCR || !templates) return '';
    const vp = page.getViewport({ scale: 1 });
    const vec = await root.PdfVec.extractPaths(page, OPS);
    const ocr = root.GlyphOCR.readPage(vec.paths, new root.GlyphOCR.Reader(templates));
    const words = ocr.words.concat(await textTokens(page))
      .filter((w) => w.text.length >= 1 && !/^[?]+$/.test(w.text))
      .map((w) => `${w.text}@${Math.round(((w.bbox[0] + w.bbox[2]) / 2) / vp.width * 1000) / 10},${Math.round(((w.bbox[1] + w.bbox[3]) / 2) / vp.height * 1000) / 10}`);
    return words.slice(0, 2500).join(' ');
  }

  function parseAnswer(msg, pg) {
    if (msg.stop_reason === 'refusal') throw new Error(`Sheet ${pg}: AI ปฏิเสธการอ่าน (${(msg.stop_details && msg.stop_details.category) || ''})`);
    if (msg.stop_reason === 'max_tokens') throw new Error(`Sheet ${pg}: คำตอบยาวเกินกำหนด`);
    // after a server-side fallback, partial text of the declined attempt precedes a 'fallback' block
    const lastFb = msg.content.map((b) => b.type).lastIndexOf('fallback');
    const txt = msg.content.slice(lastFb + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { return JSON.parse(txt); } catch (e) { throw new Error(`Sheet ${pg}: อ่านผล JSON ไม่ได้`); }
  }
  function usageOf(msg) {
    // usage.iterations covers every attempt (a declined attempt plus the fallback); top-level usage only the last
    const it = (msg.usage && msg.usage.iterations) || null;
    const list = it && it.length ? it : [msg.usage || {}];
    return list.reduce((u, x) => ({ input: u.input + (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0), output: u.output + (x.output_tokens || 0) }), { input: 0, output: 0 });
  }
  function sheetFromAnswer(data, pg) {
    return {
      sheet: pad2(pg), method: 'B', notes: data.notes || [],
      nodes: (data.nodes || []).map((n) => ({
        sheet: pad2(pg), wire: (n.wire || '').trim(), xrefs: n.continues || [], terms: [],
        pins: (n.points || []).filter((p) => p && p.device).map((p) => ({ dev: p.device.trim(), pin: String(p.pin).trim(), loc: (p.cabinet || '').trim() }))
      }))
    };
  }

  /**
   * Method B: Claude reads each sheet image.
   * opts: {apiKey, model, effort, cabinets, signal, cache:{get(key), set(key, value)}, fileKey, hints, OPS, templates}
   * A page that fails is reported in `failed` and the run goes on; pages already read come from the cache
   * (a re-run does not pay for them again). Cancelling (signal) stops at once.
   */
  async function readSheetsB(pdfDoc, pages, opts, onProgress) {
    if (!root.Anthropic) throw new Error('ไม่พบไลบรารี Anthropic SDK');
    const client = new root.Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
    const model = opts.model || 'claude-opus-5-5';
    const sheets = [], failed = [];
    const usage = { input: 0, output: 0 };
    let cached = 0;
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      if (opts.signal && opts.signal.aborted) throw new Error('ยกเลิกแล้ว');
      const key = `${opts.fileKey || ''}|${pg}|${model}|${opts.hints ? 'h' : ''}|v${B_VERSION}`;
      const hit = opts.cache && opts.cache.get(key);
      if (hit) {
        sheets.push(sheetFromAnswer(hit, pg)); cached++;
        onProgress && onProgress(`Sheet ${pg} (${i + 1}/${pages.length}) ใช้ผลที่อ่านไว้แล้ว`, (i + 1) / pages.length);
        continue;
      }
      onProgress && onProgress(`AI อ่าน Sheet ${pg} (${i + 1}/${pages.length})…`, i / pages.length);
      try {
        const page = await pdfDoc.getPage(pg);
        const imgs = await pageImages(page, 1500);
        const content = [
          { type: 'text', text: `Sheet ${pg} of the schematic, left half:` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgs[0] } },
          { type: 'text', text: 'Right half (the halves overlap slightly):' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgs[1] } }
        ];
        if (opts.hints) {
          const h = await textHints(page, opts.OPS, opts.templates);
          if (h) content.push({ type: 'text', text: 'Text machine-read from the drawing\'s vector strokes, as text@x%,y% of the full page (x from the left, y from the top). It is often right but can confuse similar characters (8/B, 0/O, 5/S) and misses some items; trust the image when they disagree:\n' + h });
        }
        content.push({ type: 'text', text: `Cabinet(s) being wired: ${opts.cabinets.join(', ')}. List all electrical nodes on this sheet.` });
        const stream = client.beta.messages.stream({
          model: model,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: opts.effort || 'high', format: { type: 'json_schema', schema: AI_SCHEMA } },
          system: AI_SYSTEM,
          messages: [{ role: 'user', content: content }]
        }, { signal: opts.signal });
        const msg = await stream.finalMessage();
        const u = usageOf(msg);
        usage.input += u.input; usage.output += u.output;
        const data = parseAnswer(msg, pg);
        if (opts.cache) opts.cache.set(key, data);
        sheets.push(sheetFromAnswer(data, pg));
        onProgress && onProgress(`  Sheet ${pg}: ${(data.nodes || []).length} node · ~$${costOf(u, model).toFixed(2)}`, (i + 1) / pages.length);
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw new Error('ยกเลิกแล้ว');
        const m = (err && err.status ? `HTTP ${err.status} ` : '') + (err && err.message ? err.message : String(err));
        if (err && (err.status === 401 || err.status === 403)) throw new Error('API key ใช้ไม่ได้ (' + m + ')');
        failed.push({ page: pg, error: m });
        onProgress && onProgress(`  Sheet ${pg}: อ่านไม่สำเร็จ — ${m}`, (i + 1) / pages.length);
      }
    }
    return { sheets: sheets, usage: usage, cost: costOf(usage, model), failed: failed, cached: cached };
  }

  /**
   * Cross-check two readings of the same sheets (e.g. AI against offline). For each node of `main`:
   * 'split'  - the other reading puts two of its pins on different nodes
   * 'joined' - the other reading joins one of its pins to a pin of another node
   * Pins the other reading did not find are not judged.
   */
  function crossCheck(mainNets, otherNets) {
    const where = new Map();
    otherNets.forEach((n, i) => n.pins.forEach((p) => where.set(p[0] + '@' + p[1], i)));
    const mainOf = new Map();
    mainNets.forEach((n, i) => n.pins.forEach((p) => mainOf.set(p[0] + '@' + p[1], i)));
    return mainNets.map((n, i) => {
      const ids = n.pins.map((p) => where.get(p[0] + '@' + p[1])).filter((x) => x !== undefined);
      const res = { known: ids.length, split: new Set(ids).size > 1, joined: false };
      for (const k of new Set(ids)) for (const p of otherNets[k].pins) { const m = mainOf.get(p[0] + '@' + p[1]); if (m !== undefined && m !== i) res.joined = true; }
      return res;
    });
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
      if (!w || /^(E|PE|GND|0|\?)$/.test(w) || it.nd.wireFrom === 'terminal') return;
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
      // numbers written on the wire win over numbers taken from a terminal name
      const named = (from) => Array.from(new Set(g.filter((it) => (it.nd.wireFrom === 'terminal') === from).map((it) => (it.nd.wire || '').trim()).filter(Boolean)));
      const labelled = named(false), inferred = named(true);
      const wires = labelled.length ? labelled : inferred;
      let wire = wires[0];
      const remark = [];
      if (!wire) { wire = 'N' + (++unnamed); remark.push('ไม่พบเบอร์สายในแบบ - ตั้งชื่อชั่วคราว'); }
      else if (!labelled.length) remark.push('เบอร์สายจากชื่อขั้ว Terminal');
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
      const g = textGeom(tx, it.width), rot = g.rot !== 0;
      const cx = g.x + g.dx * g.width / 2 + g.ux / 2, cy = g.y + g.dy * g.width / 2 + g.uy / 2;
      s.split(/\s+/).forEach((t) => words.push({ text: t, x: cx, y: cy, rot: rot ? 1 : 0, src: 'text' }));
    }
    // 2) vector text
    const vec = await root.PdfVec.extractPaths(page, OPS);
    const reader = new root.GlyphOCR.Reader(templates);
    const ocr = root.GlyphOCR.readPage(vec.paths, reader);
    ocr.words.forEach((w) => words.push({ text: w.text, x: (w.bbox[0] + w.bbox[2]) / 2, y: (w.bbox[1] + w.bbox[3]) / 2, rot: w.rot, bbox: w.bbox, src: 'ocr' }));
    // installing drawings drawn at a larger scale have bigger letters: read once more for text up to 16 pt
    const big = root.GlyphOCR.readPage(vec.paths, reader, { maxChar: 16 });
    big.words.filter((w) => Math.max(w.bbox[2] - w.bbox[0], w.bbox[3] - w.bbox[1]) > 0 && w.H > 4.5)
      .forEach((w) => { words.push({ text: w.text, x: (w.bbox[0] + w.bbox[2]) / 2, y: (w.bbox[1] + w.bbox[3]) / 2, rot: w.rot, bbox: w.bbox, src: 'ocr' }); ocr.words.push(w); });
    // device matches
    const pos = {}, renames = {};
    const canon = (s) => s.replace(/^\+[A-Z0-9]+-/, '-').replace(/^-/, '').replace(/^[A-Z]{2,4}-TB-/, '').toUpperCase();
    // characters the stroke reader confuses (Q read as 0, B as 8 ...): equal for a second, looser match
    const loose = (s) => canon(s).replace(/[QOD]/g, '0').replace(/B/g, '8').replace(/S/g, '5').replace(/I/g, '1').replace(/Z/g, '2').replace(/G/g, '6');
    const want = new Map(); (wanted || []).forEach((k) => { const c = canon(k); if (!want.has(c)) want.set(c, []); want.get(c).push(k); });
    const usable = (w, c) => !((c.length <= 2 || /^\d+$/.test(c)) && !/^[-+]/.test(w.text));
    for (const w of words) {
      const c = canon(w.text);
      // short or all-digit names ("-1", "-27") must carry their dash on the outline too,
      // otherwise the frame's grid numbers 1..9 would be taken for devices
      if (!usable(w, c)) continue;
      if (want.has(c)) for (const key of want.get(c)) if (!pos[key]) pos[key] = { x: w.x, y: w.y, src: w.src };
    }
    // looser match for devices still missing; real PDF text on the outline also corrects the schematic name
    const wantLoose = new Map();
    (wanted || []).filter((k) => !pos[k]).forEach((k) => { const l = loose(k); if (!wantLoose.has(l)) wantLoose.set(l, []); wantLoose.get(l).push(k); });
    const wordLoose = new Map();
    for (const w of words) { const c = canon(w.text); if (!usable(w, c) || c.length < 2) continue; const l = loose(w.text); if (!wordLoose.has(l)) wordLoose.set(l, []); wordLoose.get(l).push(w); }
    for (const [l, keys] of wantLoose) {
      const ws = wordLoose.get(l);
      if (!ws || keys.length !== 1) continue;
      const texts = new Set(ws.map((w) => canon(w.text)));
      if (texts.size !== 1) continue;                 // two different labels look alike: leave it to the user
      const w = ws.find((x) => x.src === 'text') || ws[0], key = keys[0];
      pos[key] = { x: w.x, y: w.y, src: w.src + '~' };
      if (w.src === 'text' && canon(w.text) !== canon(key)) renames[key] = ((key.match(/^(\+[A-Z0-9]+)-/) || [])[1] || '') + '-' + canon(w.text);
    }
    // terminals written -X3.102 are single terminals of strip X3: the outline only names the strip,
    // so they go along the strip label (marked assumed - the user drags the strip into place if needed)
    const strips = {};
    for (const w of words) { const m = canon(w.text).match(/^(X\d{1,2}[A-Z]?)$/); if (m && !strips[m[1]]) strips[m[1]] = w; }
    const byStrip = {};
    for (const k of wanted || []) {
      if (pos[k]) continue;
      const m = k.match(/^(?:\+[A-Z0-9]+)?-(X\d{1,2}[A-Z]?)\.(.+)$/);
      if (m && strips[m[1]]) (byStrip[m[1]] = byStrip[m[1]] || []).push([k, m[2]]);
    }
    for (const [st, list] of Object.entries(byStrip)) {
      const w = strips[st];
      list.sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
      const vertical = w.rot !== 0 ? false : true;           // strips under a horizontal label run downwards
      list.forEach(([k], i) => { const d = 3 + Math.min(i, 80) * 0.7; pos[k] = { x: vertical ? w.x : w.x + d, y: vertical ? w.y + d : w.y, src: 'strip', assumed: true }; });
    }
    // wireways: 'WIRE WAY' / 'W/W' text sits in the middle of the duct
    const wireways = [];
    const ww = ocr.words.filter((w) => /^(WIRE|W\/W|WIREWAY)$/.test(w.text))
      .concat(words.filter((w) => w.src === 'text' && /^(WIRE|W\/W|WIREWAY)$/i.test(w.text)).map((w) => ({ text: w.text, rot: w.rot, bbox: [w.x - 3, w.y - 1.5, w.x + 3, w.y + 1.5] })));
    for (const w of ww) {
      const horiz = w.rot === 0;
      const cx = (w.bbox[0] + w.bbox[2]) / 2, cy = (w.bbox[1] + w.bbox[3]) / 2;
      const reach = Math.max(9, 4 * (w.H || 0));      // wider ducts on large-scale installing drawings
      // duct walls: long lines parallel to the text, a few points either side
      let best = null;
      for (const p of vec.paths) {
        if (!p.stroke) continue;
        for (const pl of p.polys) for (let k = 0; k + 1 < pl.length; k++) {
          const a = pl[k], b = pl[k + 1];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < 25) continue;
          if (horiz && Math.abs(a[1] - b[1]) < 0.1 && Math.abs(a[1] - cy) < reach && Math.min(a[0], b[0]) < cx && Math.max(a[0], b[0]) > cx) {
            if (!best || L > best.L) best = { L: L, s: Math.min(a[0], b[0]), e: Math.max(a[0], b[0]) };
          }
          if (!horiz && Math.abs(a[0] - b[0]) < 0.1 && Math.abs(a[0] - cx) < reach && Math.min(a[1], b[1]) < cy && Math.max(a[1], b[1]) > cy) {
            if (!best || L > best.L) best = { L: L, s: Math.min(a[1], b[1]), e: Math.max(a[1], b[1]) };
          }
        }
      }
      if (best) wireways.push(horiz ? [best.s, cy, best.e, cy] : [cx, best.s, cx, best.e]);
    }
    return { page: pg, width: vp.width, height: vp.height, positions: pos, renames: renames, wireways: wireways, words: words.length };
  }

  /** rename devices (schematic stroke reading → outline PDF text), in the nets, the device list and outline positions */
  function applyRenames(merged, outlines) {
    const ren = {};
    outlines.forEach((o) => Object.assign(ren, o.renames || {}));
    const keys = Object.keys(ren); if (!keys.length) return [];
    const fix = (ref) => { const i = ref.lastIndexOf(':'); const d = ref.slice(0, i); return ren[d] ? ren[d] + ref.slice(i) : ref; };
    merged.nets.forEach((n) => { n.pins.forEach((p) => { p[0] = fix(p[0]); }); });
    keys.forEach((k) => {
      if (merged.devices.has(k)) { const d = merged.devices.get(k); merged.devices.delete(k); merged.devices.set(ren[k], Object.assign({}, d, { name: ren[k] })); }
      outlines.forEach((o) => { if (o.positions[k]) { o.positions[ren[k]] = o.positions[k]; delete o.positions[k]; } });
    });
    return keys.map((k) => `${k} → ${ren[k]}`);
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
        P.devices[k] = { view: vid, bg: o.bg, x: +p.x.toFixed(2), y: +p.y.toFixed(2), w: 5, h: 5, desc: p.assumed ? 'วางตามป้ายราง Terminal - ตรวจตำแหน่ง' : '', assumed: !!p.assumed, loc: loc };
        placed++;
      });
    }
    merged.devices.forEach((d, k) => {
      if (!P.devices[k]) P.devices[k] = { view: null, bg: null, x: 0, y: 0, w: 5, h: 5, desc: 'ไม่พบใน Outline - ยังไม่วาง', assumed: false, loc: d.loc };
      else P.devices[k].loc = d.loc;
    });
    return { project: P, placed: placed };
  }

  const api = { parsePages: parsePages, readSheetsA: readSheetsA, readSheetsB: readSheetsB, crossCheck: crossCheck, costOf: costOf, PRICE: PRICE, mergeSheets: mergeSheets, readOutline: readOutline, applyRenames: applyRenames, buildProject: buildProject, AI_SCHEMA: AI_SCHEMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoBuild = api;
})(typeof window !== 'undefined' ? window : this);
