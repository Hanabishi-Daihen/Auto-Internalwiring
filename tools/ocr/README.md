# Glyph template tools (offline reader for vector CAD text)

Python prototypes used to build `data/glyph_templates.js` from PP1047A:

1. `build_db.py <pdf> <pages> glyphdb.pkl` - cut small stroke paths into character clusters and group look-alike shapes
2. `sheet.py` - contact sheets of the shape groups; labels were assigned by eye in `ocr.py` (`LABELS`)
3. `harvest.py` + `dedupe.py` - add templates for look-alike characters (8/B, 0/O, U) from words whose
   true text is known (the PP1047A netlist), keeping only unambiguous shapes
4. `run_ocr.py` + `eval.py` - read pages and score device / wire names against the netlist

The browser uses the JavaScript port: `js/pdfvec.js` (paths from pdf.js) and `js/glyphocr.js` (reader).
