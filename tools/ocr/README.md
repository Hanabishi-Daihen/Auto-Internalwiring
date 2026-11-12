# Glyph template tools (offline reader for vector CAD text)

Python prototypes used to build `data/glyph_templates.js` from PP1047A:

1. `build_db.py <pdf> <pages> glyphdb.pkl` - cut small stroke paths into character clusters and group look-alike shapes
2. `sheet.py` - contact sheets of the shape groups; labels were assigned by eye in `ocr.py` (`LABELS`)
3. `harvest.py` + `dedupe.py` - add templates for look-alike characters (8/B, 0/O, U) from words whose
   true text is known (the PP1047A netlist), keeping only unambiguous shapes
4. `run_ocr.py` + `eval.py` - read pages and score device / wire names against the netlist

The browser uses the JavaScript port: `js/pdfvec.js` (paths from pdf.js) and `js/glyphocr.js` (reader).

Adding templates for another drawing's font (no hand labelling):

```
node tools/ocr/harvest_dict.js harvest.json [--known=QDL,QF1] drawing.pdf:1-30 other.pdf:1-40
node tools/ocr/merge_templates.js harvest.json            # preview: what each new template fixes / breaks
node tools/ocr/merge_templates.js harvest.json --write    # add them to data/glyph_templates.js
```

`harvest_dict.js` reads every page, matches read words against a dictionary of drawing vocabulary (title block,
notes, view names; `--known` adds e.g. device names printed as real text on the outline) and keeps the letters that
were read wrong, rotated upright. `merge_templates.js` adds a template only if it fixes clearly more letters than it
breaks (letters read right are the controls). Check `node tools/eval_reading.js` on PP1047A afterwards.
Round 2 (6 drawings): added I, J, Z, Q and second shapes of N, D, P, S, E, Y, G, F — letters right on the harvest
set 77% → 99%, PP1047A unchanged.

