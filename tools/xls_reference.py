#!/usr/bin/env python3
"""
Turn a finished internal wiring list (.xls / .xlsx, form 'IN LCC') into a reference netlist for
tools/eval_reading.js.

    python3 tools/xls_reference.py wiring.xls "IN LCC" LCC. out.json

Every row is one wire CMP.1:PIN.1 - CMP.2:PIN.2; wires that share a pin form one node.
Columns are found by their header (CMP.1, PIN.1, CMP.2, PIN.2, SH., LINENO. / wire mark).
Needs xlrd for .xls (pip install xlrd) or openpyxl for .xlsx.
Finished lists are not always right (the user's note): use the score as a guide and check
disagreements against the drawing.
"""
import json
import re
import sys


def cell_text(v):
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else repr(v)
    return str(v).strip()


def read_rows(path, sheet):
    if path.lower().endswith('.xls'):
        import xlrd
        sh = xlrd.open_workbook(path).sheet_by_name(sheet)
        return [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True)[sheet]
    return [[c if c is not None else '' for c in row] for row in ws.iter_rows(values_only=True)]


def norm_dev(d):
    d = d.strip().upper().replace(' ', '')
    d = re.sub(r'^\+[A-Z0-9]+-', '-', d)
    d = re.sub(r'^-TB\.(X\d+[A-Z]?)$', r'-\1', d)          # -TB.X3 -> -X3 (terminal strip X3)
    if d and not d.startswith('-') and d != 'GND':
        d = '-' + d
    return d


def norm_pin(p):
    p = cell_text(p).upper().replace(' ', '')
    return re.sub(r'^(\d+)\.0$', r'\1', p)


def main():
    path, sheet, loc, out = sys.argv[1:5]
    rows = read_rows(path, sheet)
    hdr_i = next(i for i, r in enumerate(rows) if any(str(c).strip().upper().startswith('CMP.1') for c in r))
    hdr = [str(c).strip().upper() for c in rows[hdr_i]]
    col = lambda name: next(i for i, h in enumerate(hdr) if h.startswith(name))
    c1, p1, c2, p2 = col('CMP.1'), col('PIN.1'), col('CMP.2'), col('PIN.2')
    csh = next((i for i, h in enumerate(hdr) if h.startswith('SH')), None)
    cw = next((i for i, h in enumerate(hdr) if h.startswith('LINENO')), 0)
    par = {}

    def f(x):
        par.setdefault(x, x)
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    wire_of, sheet_of, n_rows = {}, {}, 0
    for r in rows[hdr_i + 1:]:
        if len(r) <= max(c1, p1, c2, p2):
            continue
        a_dev, b_dev = norm_dev(cell_text(r[c1])), norm_dev(cell_text(r[c2]))
        if not a_dev or not b_dev:
            continue
        a = a_dev + ':' + norm_pin(r[p1]) if a_dev != 'GND' else 'GND'
        b = b_dev + ':' + norm_pin(r[p2]) if b_dev != 'GND' else 'GND'
        n_rows += 1
        par[f(a)] = f(b)
        w = cell_text(r[cw]).split('\n')[0].strip()
        sh = cell_text(r[csh]) if csh is not None else ''
        for k in (a, b):
            wire_of.setdefault(k, w)
            sheet_of.setdefault(k, sh.zfill(2) if sh.isdigit() else sh)
    groups = {}
    for k in list(par):
        groups.setdefault(f(k), []).append(k)
    nets = []
    for pins in groups.values():
        ws = [wire_of.get(p, '') for p in pins if wire_of.get(p)]
        nets.append({'wire': max(set(ws), key=ws.count) if ws else '', 'sheet': '',
                     'pins': [[p, sheet_of.get(p, '')] for p in sorted(pins)]})
    json.dump({'meta': {'loc': loc, 'source': path.split('/')[-1], 'sheet': sheet, 'rows': n_rows}, 'nets': nets},
              open(out, 'w'), ensure_ascii=False, indent=0)
    print(f'{n_rows} wires -> {len(nets)} nodes, {sum(len(n["pins"]) for n in nets)} pins')


if __name__ == '__main__':
    main()
