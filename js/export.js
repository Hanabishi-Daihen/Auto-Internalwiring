/* Internal Wiring Planner - Excel export (ExcelJS), layout follows the "IN LCC" template sheet */
(function () {
  'use strict';
  const E = window.WiringEngine;

  const FONT_HEAD = { name: 'Arial Narrow', size: 10, bold: true };
  const FONT_MARK = { name: 'Arial Narrow', size: 11, bold: true };
  const FONT_DATA = { name: 'Calibri', size: 11 };
  const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb } });
  const CYAN = 'FF00FFFF', YELLOW = 'FFFFFF00', ORANGE = 'FFFFC000', GREY = 'FFF2F2F2';
  const thin = { style: 'thin' }, medium = { style: 'medium' };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

  function hf(meta, sheetLabel) {
    const m = meta;
    const header = `&L&"Arial Narrow"&9Process No. : ${m.processNo}\nDrawing No.: ${m.drawingNo} SH.&P\nProjects : ${m.project}` +
      `&C&"Arial Narrow"&9SH.&P/&N&R&"Arial Narrow"&9Date : &D`;
    const footer = `&L&"Arial Narrow"&9${sheetLabel}&C&"Arial Narrow"&9SH.&P/&N&R&"Arial Narrow"&9Contract no : ${m.contract}`;
    return { oddHeader: header, oddFooter: footer };
  }
  function pageSetup(ws, landscape) {
    ws.pageSetup = {
      paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.39, right: 0.39, top: 1.06, bottom: 0.75, header: 0.28, footer: 0.3 },
      printTitlesRow: '1:2'
    };
  }
  function titleRow(ws, text, lastCol) {
    ws.mergeCells(1, 1, 1, lastCol);
    const c = ws.getCell(1, 1);
    c.value = text;
    c.font = { name: 'Arial Narrow', size: 14, bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: medium, left: medium, bottom: medium, right: medium };
    ws.getRow(1).height = 34.5;
  }
  function headerRow(ws, heads, row) {
    const r = ws.getRow(row || 2);
    heads.forEach((h, i) => {
      const c = r.getCell(i + 1);
      c.value = h; c.font = FONT_HEAD; c.fill = FILL(CYAN);
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = BORDER;
    });
    r.height = 34.5;
  }

  async function toExcel(project, wires, plan, opt) {
    const m = project.meta;
    const wb = new window.ExcelJS.Workbook();
    wb.creator = 'Internal Wiring Planner';
    wb.created = new Date();
    const date = new Date();
    const dstr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    const loc = m.loc || 'TCC.';
    const allLocs = Array.from(new Set(wires.map((w) => w.loc || loc))).sort();
    const multi = allLocs.length > 1;
    const heads = ['WIRE MARK 1', 'WIRE MARK 2', 'LINENO.', 'CABLE DETAILS', 'LOC.1', 'CMP.1', 'PIN.1', 'LOC.2', 'CMP.2', 'PIN.2', 'SH.', 'LENGTH (mm)', 'CUT (mm)', 'ROUTE', 'REMARK'];
    const widths = [12.28, 13, 6.99, 14.56, 9.14, 7.85, 6.56, 8.7, 6.7, 5.99, 7.42, 9, 8, 18, 40];
    const sorted = opt.sortedWires(opt.sort || 'sheet');

    // ------------------------------------------------ one wiring sheet per cabinet (IN LCC, IN RCC, ...)
    allLocs.forEach((L) => {
      const short = L.replace(/\.$/, '');
      const ws = wb.addWorksheet(('IN ' + short).slice(0, 31), { views: [{ state: 'frozen', ySplit: 2 }] });
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      const title = multi ? `${short} INTERNAL CABLE WIRING ${m.processNo}` : m.title;
      titleRow(ws, `${title} ${dstr} Rev.${m.rev}`, heads.length);
      headerRow(ws, heads);
      const H = hf(m, `Internal wiring diagram ${short} ${m.processNo}`);
      ws.headerFooter.oddHeader = H.oddHeader;
      ws.headerFooter.oddFooter = H.oddFooter;
      pageSetup(ws, false);

      let r = 3, lastKey = null;
      sorted.filter((w) => (w.loc || loc) === L).forEach((w) => {
        const key = opt.sort === 'work' ? w.bundle : opt.sort === 'sheet' || !opt.sort ? w.sheet : null;
        if (lastKey !== null && key !== lastKey) r++;          // blank row between sheets / bundles
        lastKey = key;
        const row = ws.getRow(r);
        const cab = opt.cableText(w.cls);
        const vals = [null, null, w.wire, cab, L, w.cmp1, w.pin1, L, w.cmp2, w.pin2, isNaN(+w.sheet) || w.sheet === '' ? w.sheet : +w.sheet,
          isFinite(w.len) ? Math.round(w.len) : '', w.cut || '', (w.via || []).join(' > '), w.remark];
        vals.forEach((v, i) => { if (v !== null) row.getCell(i + 1).value = v; });
        const m1 = `${w.cmp1}.${w.pin1}\n${w.cmp2}.${w.pin2}`, m2 = `${w.cmp2}.${w.pin2}\n${w.cmp1}.${w.pin1}`;
        row.getCell(1).value = { formula: `CONCATENATE(F${r}&"."&G${r},CHAR(10),I${r}&"."&J${r})`, result: m1 };
        row.getCell(2).value = { formula: `CONCATENATE(I${r}&"."&J${r},CHAR(10),F${r}&"."&G${r})`, result: m2 };
        for (let c = 1; c <= heads.length; c++) {
          const cell = row.getCell(c);
          cell.border = BORDER;
          if (c <= 2) { cell.font = FONT_MARK; cell.alignment = { horizontal: 'left', vertical: 'bottom', wrapText: true }; }
          else { cell.font = FONT_DATA; cell.alignment = { horizontal: c >= 14 ? 'left' : 'center', vertical: 'bottom', wrapText: c >= 14 }; }
          if ([3, 6, 7, 9, 10].indexOf(c) >= 0) cell.numFmt = '@';
        }
        if (!cab) row.getCell(4).fill = FILL(YELLOW);
        if (w.remark) row.getCell(15).fill = FILL(ORANGE);
        row.height = 30;
        r++;
      });
    });

    // ------------------------------------------------ short link sheet
    const sl = wb.addWorksheet('SHORT LINK (TB)');
    titleRow(sl, `${allLocs.join(' / ')} SHORT LINK TERMINAL (BAR) — ${m.processNo}`, 5);
    headerRow(sl, ['TERMINAL', 'FROM', 'TO', 'POINTS', 'PINS IN GROUP']);
    [12, 10, 10, 9, 60].forEach((w, i) => { sl.getColumn(i + 1).width = w; });
    let sr = 3;
    Object.entries(project.bars || {}).forEach(([tb, groups]) => {
      groups.forEach((g) => {
        const row = sl.getRow(sr++);
        [tb, g[0], g[g.length - 1], g.length, g.join(', ')].forEach((v, i) => {
          const c = row.getCell(i + 1); c.value = v; c.border = BORDER; c.font = FONT_DATA;
          c.alignment = { horizontal: i === 4 ? 'left' : 'center' };
        });
      });
    });
    pageSetup(sl, false);

    // ------------------------------------------------ bundle sheet
    const bs = wb.addWorksheet('BUNDLE');
    titleRow(bs, `${allLocs.join(' / ')} WIRE BUNDLES BY ROUTE — ${m.processNo}`, 5);
    headerRow(bs, ['BUNDLE (FROM ↔ TO)', 'WIRES', 'ROUTED LENGTH (m)', 'CUT LENGTH (m)', 'VIA']);
    [34, 9, 16, 15, 50].forEach((w, i) => { bs.getColumn(i + 1).width = w; });
    const b = {};
    wires.forEach((w) => {
      const k = w.bundle; b[k] = b[k] || { n: 0, len: 0, cut: 0, via: {} };
      b[k].n++; b[k].len += isFinite(w.len) ? w.len : 0; b[k].cut += w.cut;
      (w.via || []).forEach((v) => { b[k].via[v] = 1; });
    });
    let br = 3;
    Object.entries(b).sort((x, y) => y[1].n - x[1].n).forEach(([k, v]) => {
      const row = bs.getRow(br++);
      [k, v.n, +(v.len / 1000).toFixed(2), +(v.cut / 1000).toFixed(2), Object.keys(v.via).join(', ')].forEach((val, i) => {
        const c = row.getCell(i + 1); c.value = val; c.border = BORDER; c.font = FONT_DATA;
      });
    });
    pageSetup(bs, true);

    // ------------------------------------------------ cut list / material
    const cs = wb.addWorksheet('CUT LIST');
    titleRow(cs, `${allLocs.join(' / ')} CABLE MATERIAL SUMMARY — ${m.processNo}`, 5);
    headerRow(cs, ['CABLE DETAILS', 'CIRCUIT', 'WIRES', 'CUT LENGTH TOTAL (m)', 'NOTE']);
    [18, 30, 9, 20, 40].forEach((w, i) => { cs.getColumn(i + 1).width = w; });
    const mat = {};
    wires.forEach((w) => {
      const k = w.cls || '';
      mat[k] = mat[k] || { n: 0, cut: 0 };
      mat[k].n++; mat[k].cut += w.cut;
    });
    let cr = 3;
    Object.entries(mat).forEach(([k, v]) => {
      const row = cs.getRow(cr++);
      const cab = opt.cableText(k);
      [cab || '(ไม่ระบุ)', (project.cable[k] || {}).label || '', v.n, +(v.cut / 1000).toFixed(1), cab ? '' : 'ต้องกำหนดสี/ขนาดเอง'].forEach((val, i) => {
        const c = row.getCell(i + 1); c.value = val; c.border = BORDER; c.font = FONT_DATA;
        if (!cab && i === 0) c.fill = FILL(YELLOW);
      });
    });
    const tot = cs.getRow(cr + 1);
    tot.getCell(2).value = 'รวม'; tot.getCell(3).value = wires.length;
    tot.getCell(4).value = +(wires.reduce((s, w) => s + w.cut, 0) / 1000).toFixed(1);
    [2, 3, 4].forEach((i) => { tot.getCell(i).font = { name: 'Calibri', size: 11, bold: true }; });
    pageSetup(cs, false);

    // ------------------------------------------------ notes
    const ns = wb.addWorksheet('NOTES');
    ns.getColumn(1).width = 4; ns.getColumn(2).width = 120;
    const st = project.settings;
    const totOpt = plan.reduce((s, x) => s + x.lenOpt, 0), totDraw = plan.reduce((s, x) => s + x.lenDrawing, 0);
    const lines = [
      ['h', `${m.panelName} — INTERNAL WIRING NOTES (${m.processNo})`],
      ['h', 'ขอบเขต'],
      ['', `อ่านจาก Schematic ${m.schematicDwg} Sheet ${m.sheets}: สายอุปกรณ์→อุปกรณ์ และอุปกรณ์→Terminal ภายในตู้ (${allLocs.join(", ")}) รวม ${wires.length} เส้น จาก ${project.nets.length} node`],
      ['', 'ไม่รวมสายจาก Terminal ไปอุปกรณ์ภายนอก (หม้อแปลง, Sensor, ลูกค้า) ตาม Terminal arrangement Sheet 23-28'],
      ...Object.values(project.noInternal || {}).map((t) => ['', t]),
      ['h', 'วิธีจัดลำดับการพ่วงสาย'],
      ['', st.mode === 'opt'
        ? `แต่ละ node ถูกจัดเป็นสายพ่วงต่อเนื่อง (A→B, B→C) ที่สั้นที่สุดตามตำแหน่งอุปกรณ์ใน Outline Sheet ${m.outlineSheet}, รางวายเวย์ 75x100 บน mounting plate, ชุดสายผ่านบานพับ (HINGE) ของ swing panel และผนังข้าง; แต่ละขาอุปกรณ์มีสายไม่เกิน 2 เส้น`
        : 'ใช้ลำดับตามที่เขียนในแบบ (ไม่ปรับลำดับ)'],
      ['', `ความยาวเดินสายรวมโดยประมาณ ${(totOpt / 1000).toFixed(1)} m (ถ้าพ่วงตามลำดับในแบบ ${(totDraw / 1000).toFixed(1)} m)`],
      ['', `CUT (mm) = ความยาวตามเส้นทาง + เผื่อปลายละ ${st.allow} mm แล้วปัดขึ้นทีละ ${st.round} mm`],
      ['', 'กลุ่ม Short link bar ของ Terminal นับเป็นจุดเดียว (ดูชีท SHORT LINK (TB)); ช่วงที่แบบกำหนดผ่าน Terminal (เช่น P2.21→8FM1, 121→8FM1) ถูกล็อกตามแบบ'],
      ['h', 'สี/ขนาดสาย (Sheet 03 — Cable for wiring inside control cabinet)'],
      ...Object.entries(project.cable).filter(([k]) => k).map(([k, c]) => ['', `${c.label}: ${c.color} ${c.size} sq.mm.`]),
      ['', 'วงจรที่ไม่อยู่ในตารางข้างต้น (กำลัง 3 เฟส/มอเตอร์พัดลม, DC main, PT100, 4-20 mA, 24VDC, คอนแทคแห้งไปลูกค้า) เว้นว่างและระบายเหลือง'],
      ['h', 'จุดในแบบที่ควรตรวจสอบ'],
      ...(project.anomalies || []).map((a) => ['', a]),
      ['h', 'ข้อจำกัด'],
      ['', 'Netlist อ่านจากภาพแบบ (ตัวอักษรใน Schematic เป็นเส้น vector) อาจคลาดเคลื่อนในจุดที่เส้นหนาแน่น — ตรวจเทียบแบบโดยกรองคอลัมน์ SH.'],
      ['', 'ความยาวสายเป็นค่าประมาณจากมาตราส่วน Outline; อุปกรณ์ที่ไม่มีใน Outline ใช้ตำแหน่งสมมติ'],
    ];
    let nr = 1;
    lines.forEach(([t, txt]) => {
      if (t === 'h' && nr > 1) nr++;
      const c = ns.getCell(nr, 2);
      c.value = txt;
      c.alignment = { wrapText: true, vertical: 'top' };
      c.font = t === 'h' ? { name: 'Calibri', size: 12, bold: true } : FONT_DATA;
      nr++;
    });

    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  window.WiringExport = { toExcel: toExcel };
})();
