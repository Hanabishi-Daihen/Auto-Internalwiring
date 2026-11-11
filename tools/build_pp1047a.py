#!/usr/bin/env python3
"""
Build data/pp1047a_tcc.js (window.PROJECT_DATA) for the Internal Wiring Planner.

Source: Schematic diagram PP1047A Rev.0 (29-10-2026), TCC
  - Netlist        : Sheet 07-22 (read from drawing images, node by node)
  - Cable spec     : Sheet 03 (2.1 Cable for wiring inside control cabinet)
  - Terminals      : Sheet 23-28 (terminal order, short link bars, int./ext. side)
  - Device layout  : Sheet 30 (Outline drawing of TCC) - coordinates in PDF points

Run:  python3 tools/build_pp1047a.py
The script validates every pin reference before writing the file.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'data', 'pp1047a_tcc.js')

# ---------------------------------------------------------------- meta
META = {
    'project': 'ELECTRICITY GENERATING AUTHORITY OF THAILAND',
    'processNo': 'PP1047A',
    'schematicDwg': 'CD-PP1047A-4S',
    'drawingNo': 'CD-PP1047A-4X1',          # proposed number for the wiring list
    'contract': '(TBD)',
    'loc': 'TCC.',
    'panelName': 'TRANSFORMER CONTROL CABINET (TCC)',
    'title': 'TCC INTERNAL CABLE WIRING PP1047A',
    'rev': '0',
    'sheets': '07-22',
    'outlineSheet': 30,
}

# ---------------------------------------------------------------- cable classes (Sheet 03)
CABLE = {
    'VT':       {'label': 'VT secondary circuit',  'color': 'R',  'size': '2.5'},
    'CT':       {'label': 'CT secondary circuit',  'color': 'BK', 'size': '4.0'},
    'AC_CTRL':  {'label': 'AC control circuit',    'color': 'Y',  'size': '2.5'},
    'AC_N':     {'label': 'Neutral circuit',       'color': 'GR', 'size': '2.5'},
    'DC_CTRL':  {'label': 'DC control circuit',    'color': 'B',  'size': '1.5'},
    'EARTH':    {'label': 'Connection to earth',   'color': 'GN', 'size': '2.5'},
    'EARTH_CT': {'label': 'Connection to earth CT','color': 'GN', 'size': '4.0'},
    '':         {'label': 'ไม่ระบุในตาราง Cable for wiring (ตรวจสอบ)', 'color': '', 'size': ''},
}

# ---------------------------------------------------------------- layout views (Sheet 30, PDF pt)
# Each view maps PDF points -> cabinet millimetres.
#   X: across the width seen from the front (0 = left inner side)
#   Y: down from the top
#   Z: from the mounting plate (0) towards the door
S = 7.76   # mm per PDF point (1380 mm plate = 177.9 pt)
VIEWS = {
    'PLATE': {'name': 'Mounting plate (rear inner front view)', 'kind': 'graph',
              'rect': [576, 160, 762, 366],
              'map': {'x': [580.4, S], 'y': [160, S], 'z': 0}},
    'DOOR_L': {'name': 'Swing panel - left leaf', 'kind': 'free',
               'rect': [216, 160, 302.4, 368],
               'map': {'x': [210.0, 7.9], 'y': [160, S], 'z': 440}},
    'DOOR_R': {'name': 'Swing panel - right leaf', 'kind': 'free',
               'rect': [302.4, 160, 389, 368],
               'map': {'x': [210.0, 7.9], 'y': [160, S], 'z': 440}},
    'WALL_R': {'name': 'Right side wall (inner side view right)', 'kind': 'free',
               'rect': [462, 166, 512, 350],
               'map': {'x': 1380, 'y': [160, S], 'zFromX': [455.0, S]}},
    'WALL_L': {'name': 'Left side wall (inner side view left)', 'kind': 'free',
               'rect': [86, 166, 134, 350],
               'map': {'x': 0, 'y': [160, S], 'zFromX': [141.0, -S]}},
}

# Wireways on the mounting plate (PDF pt) - 75x100 mm ducts read from Sheet 30
WIREWAYS = [
    # id, x1, y1, x2, y2
    ['H1', 585.0, 167.6, 754.0, 167.6],
    ['H2', 585.0, 195.3, 754.0, 195.3],
    ['H3', 585.0, 221.9, 754.0, 221.9],
    ['H4', 585.0, 245.0, 754.0, 245.0],
    ['VL', 585.0, 167.6, 585.0, 360.8],
    ['VR', 754.0, 167.6, 754.0, 360.8],
    ['VC', 668.3, 195.3, 668.3, 360.8],
    ['V2', 613.0, 245.0, 613.0, 360.8],
    ['V3', 640.7, 245.0, 640.7, 360.8],
    ['V5', 696.2, 245.0, 696.2, 360.8],
    ['V6', 724.0, 245.0, 724.0, 360.8],
]

# Portals: how a free plane (door leaf / side wall) reaches the plate wireways.
#   [id, view, x, y, plateX, plateY, extra_mm]
PORTALS = [
    ['HINGE-L', 'DOOR_L', 219.0, 262.0, 585.0, 262.0, 350],   # hinge bundle, loop allowance
    ['HINGE-R', 'DOOR_R', 388.0, 262.0, 754.0, 262.0, 350],
]
for i, y in enumerate([173.5, 201.7, 238.1, 263.7, 289.7, 330.0]):
    PORTALS.append([f'WALL-R{i+1}', 'WALL_R', 468.0, y, 754.0, y, 50])
for i, y in enumerate([174.4, 198.1, 221.3, 243.3, 267.6, 291.0, 330.0]):
    PORTALS.append([f'WALL-L{i+1}', 'WALL_L', 128.0, y, 585.0, y, 50])

# ---------------------------------------------------------------- devices
DEV = {}
def dev(name, view, x, y, desc='', assumed=False, w=5, h=5):
    DEV[name] = {'view': view, 'x': round(x, 2), 'y': round(y, 2), 'w': w, 'h': h,
                 'desc': desc, 'assumed': assumed}

px = lambda p: 560 + p / 7.27          # helper for the 600-dpi crop of the plate
# Row 1 : contactors / thermal overload relays
row1 = [('-88F1', 237), ('-49F1', 278), ('-49F3', 318), ('-88F2', 361), ('-49F5', 402),
        ('-49F7', 443), ('-49F9', 485), ('-88F3', 525), ('-49F2', 566), ('-49F4', 606),
        ('-88F4', 648), ('-49F6', 688), ('-49F8', 729), ('-49F10', 770), ('-88F5', 810),
        ('-49F11', 851)]
for n, x in row1:
    dev(n, 'PLATE', px(x), 181.3, 'Magnetic contactor' if '88F' in n else 'Thermal overload relay', w=5.2, h=9)
# Row 2 : K1..K23
k_left = [240, 283, 326, 369, 412, 455, 498, 541, 584, 627, 670, 713]
k_right = [857, 900, 943, 986, 1029, 1072, 1115, 1158, 1201, 1244, 1287]
for i, x in enumerate(k_left + k_right):
    dev(f'-K{i+1}', 'PLATE', px(x), 208.4, 'Auxiliary relay', w=5.6, h=9)
# Row 3 : KS1..KS7, KL1, KL2  (KD1/KD2 are not shown on Sheet 30 -> assumed)
for i, x in enumerate([240, 283, 326, 369, 412, 455, 498]):
    dev(f'-KS{i+1}', 'PLATE', px(x), 235.2, 'Auxiliary relay (seal-in/reset)', w=5.6, h=9)
dev('-KL1', 'PLATE', px(541), 235.2, 'Auxiliary relay fan group 1', w=5.6, h=9)
dev('-KL2', 'PLATE', px(584), 235.2, 'Auxiliary relay fan group 2', w=5.6, h=9)
dev('-KD1', 'PLATE', px(627), 235.2, 'Aux. relay loss of DC supply (ตำแหน่งสมมติ)', True, w=5.6, h=9)
dev('-KD2', 'PLATE', px(670), 235.2, 'Aux. relay loss of DC control (ตำแหน่งสมมติ)', True, w=5.6, h=9)
dev('GND', 'PLATE', 668.3, 362.0, 'Earth bar (ตำแหน่งสมมติ - ใต้ mounting plate)', True, w=30, h=2)
dev('-FL1', 'PLATE', 668.3, 163.0, 'Cabinet lamp (ตำแหน่งสมมติ)', True, w=12, h=2)
dev('-92L', 'PLATE', 582.0, 172.0, 'Door switch (ตำแหน่งสมมติ)', True, w=3, h=4)

# Right side wall
for n, x, y, d in [('-X1', 473.5, 189.1, 'High speed trip relay'), ('-X2', 478.7, 189.1, 'High speed trip relay'),
                   ('-X3', 485.3, 189.1, 'High speed trip relay'), ('-X4', 491.8, 189.1, 'High speed trip relay'),
                   ('-23CL', 482.3, 212.5, 'Thermostat'), ('-23HL', 479.4, 226.3, 'Hygrostat'),
                   ('-27L', 470.2, 251.2, 'Under voltage relay'), ('-47L', 473.5, 251.2, 'Phase sequence relay'),
                   ('-KTB', 478.7, 250.6, 'Timer for auto acknowledge'),
                   ('-KBH', 484.6, 250.6, 'Horn alarm relay (Outline เขียน -KBZ)'),
                   ('-TM1', 470.2, 276.8, 'Transducer oil temp.'), ('-TM2', 473.0, 276.8, 'Transducer HV wdg temp.'),
                   ('-TM3', 475.9, 276.8, 'Transducer LV1 wdg temp.'), ('-TM4', 478.7, 276.8, 'Transducer LV2 wdg temp.'),
                   ('-PSU1', 482.3, 276.2, 'Power supply 24VDC'), ('-PSU2', 485.3, 276.2, 'Power supply 24VDC'),
                   ('-HL2', 484.6, 320.1, 'Space heater')]:
    dev(n, 'WALL_R', x, y, d, w=4, h=6)
dev('-BL', 'WALL_R', 490.0, 251.0, 'Buzzer (ไม่พบใน Outline - ตำแหน่งสมมติ)', True, w=3, h=4)
# Left side wall
dev('-CPU', 'WALL_L', 109.9, 255.8, 'MESSKO protocol converter', w=10, h=10)
dev('-CONL', 'WALL_L', 112.5, 278.1, 'Socket outlet', w=8, h=5)
dev('-HL1', 'WALL_L', 111.2, 321.4, 'Space heater', w=5, h=20)
# Swing panel (inner door) - left leaf
for n, x, y, d in [('-AN', 260.1, 251.9, 'Annunciator AN1-AN24'), ('-43BL', 249.6, 272.9, 'Horn ON/OFF switch (Outline: 43BR)'),
                   ('-3AK', 256.4, 272.9, 'PB accept'), ('-3AR', 263.4, 272.9, 'PB ann. reset'),
                   ('-3AT', 270.4, 272.9, 'PB ann. test'), ('-43CA', 255.3, 288.6, 'Fan control switch'),
                   ('-83C', 264.3, 288.6, 'Fan select switch'), ('-3C1', 248.3, 301.1, 'PB Gp.1 start'),
                   ('-3B1', 255.7, 301.1, 'PB Gp.1 stop'), ('-3C2', 263.0, 301.1, 'PB Gp.2 start'),
                   ('-3B2', 270.4, 301.1, 'PB Gp.2 stop'), ('-86ACO', 246.5, 318.1, '86A cut-off switch'),
                   ('-86A', 259.5, 316.8, 'Lock-out relay'), ('-43HL', 272.3, 318.1, 'Heater switch')]:
    dev(n, 'DOOR_L', x, y, d, w=5, h=5)
dev('-AN', 'DOOR_L', 260.1, 251.9, 'Annunciator AN1-AN24', w=44, h=26)
dev('-3R', 'DOOR_L', 259.5, 323.5, 'Reset PB (ไม่พบใน Outline - ตำแหน่งสมมติ)', True, w=4, h=4)
# Swing panel - right leaf
for n, x, y, d in [('-8AM', 343.6, 259.7, 'MCCB AC main 30A'), ('-8DM', 365.9, 259.7, 'MCCB DC main 20A'),
                   ('-8FM1', 342.5, 288.0, 'MCB fan group 1'), ('-8FM2', 352.2, 288.0, 'MCB fan group 2'),
                   ('-8FM3', 361.8, 288.0, 'MCB fan spare'), ('-8A1', 341.9, 303.0, 'MCB heater/lamp'),
                   ('-8A2', 348.7, 303.0, 'MCB AC supply'), ('-8A3', 355.5, 303.0, 'MCB transducer'),
                   ('-8A4', 362.2, 303.0, 'MCB DGA'), ('-8D1', 345.2, 318.1, 'MCB DC circuit'),
                   ('-8D2', 352.0, 318.1, 'MCB ann. & lamp'), ('-8D3', 358.8, 318.1, 'MCB fan control')]:
    dev(n, 'DOOR_R', x, y, d, w=8 if n in ('-8AM', '-8DM') else 6, h=8)

# ---------------------------------------------------------------- terminal blocks (Sheet 23-28)
def rng(a, b): return [str(i) for i in range(a, b + 1)]
TB01 = ['R0', 'S0', 'T0', 'K0', 'R1', 'K1', 'R2', 'K2', 'R3', 'K3', 'R4', 'K4',
        'RH1', 'RH2', 'RH3', 'RH4', 'RL1', 'RL2', 'RL3', 'RL4']
for m in range(1, 12):
    TB01 += [f'M{m}1', f'M{m}2', f'M{m}3', f'E#FM{m}']
TB01 += ['', '', '', '']                                   # 68P
TB02 = ['P0', 'N0'] + [f'W{i}' for i in range(1, 13)] + [f'P2.{i}' for i in range(1, 31)] + [''] * 9   # 53P
TB03 = rng(101, 175)                                       # 75P
TB04 = rng(201, 270)                                       # 70P
TB05 = rng(301, 385)                                       # 85P
TB06 = ['1x1H0', '1x2H0', '1x3H0', '1x4H0', '1x5H0', 'E#H0-1', '2x1H0', '2x2H0', '2x3H0', '2x4H0', '2x5H0', 'E#H0-2',
        'x1H2', 'x2H2', 'E#H2', 'x1X1', 'x2X1', 'E#X1', 'x1X2', 'x2X2', 'E#X2'] + [''] * 6   # 27P
TERMS = {
    '-TB01': {'pins': TB01, 'x': px(283), 'y1': 254.9, 'y2': 333.0},
    '-TB02': {'pins': TB02, 'x': px(484), 'y1': 254.9, 'y2': 318.6},
    '-TB03': {'pins': TB03, 'x': px(686), 'y1': 254.9, 'y2': 351.5},
    '-TB04': {'pins': TB04, 'x': px(888), 'y1': 254.9, 'y2': 336.1},
    '-TB05': {'pins': TB05, 'x': px(1090), 'y1': 254.9, 'y2': 353.5},
    '-TB06': {'pins': TB06, 'x': px(1298), 'y1': 254.9, 'y2': 295.5},
}
# The MS1 earth on Sheet 17 ("-TB01 E") is not in the TB01 arrangement -> keep as extra pin
TERMS['-TB01']['extra'] = ['E#MS1']
for t, d in TERMS.items():
    dev(t, 'PLATE', d['x'], (d['y1'] + d['y2']) / 2, 'Terminal block', w=6, h=d['y2'] - d['y1'])

# Short link bars (Sheet 23-25)
BARS = {
    '-TB01': [['RH1', 'RH2'], ['RH3', 'RH4']],
    '-TB02': [['W1', 'W2', 'W3'], ['W4', 'W5', 'W6'], ['W7', 'W8', 'W9'], ['W10', 'W11', 'W12'],
              ['P2.1', 'P2.2', 'P2.3', 'P2.4'], [f'P2.{i}' for i in range(7, 27)]],
    '-TB03': [['113', '114', '115'], ['116', '117', '118'], ['123', '124', '125', '126'],
              ['130', '131', '132'], ['133', '134', '135'], ['168', '169']],
}

# Bar pins that the terminal arrangement shows with an internal (TCC) wire -> preferred entry points
BAR_ENTRY = {
    '-TB02': ['W1', 'W4', 'W7', 'W10', 'P2.1'] + [f'P2.{i}' for i in range(21, 27)],
    '-TB03': ['113', '116', '123', '130', '133'],
}

# ---------------------------------------------------------------- nets (Sheet 07-22)
NETS = []
def net(wire, sheet, cls, pins, remark='', fixed=None):
    """pins: list of 'DEV:PIN' or ('DEV:PIN', sheet)."""
    pp = []
    for p in pins:
        if isinstance(p, tuple):
            pp.append([p[0], p[1]])
        else:
            pp.append([p, sheet])
    NETS.append({'wire': wire, 'sheet': sheet, 'cls': cls, 'pins': pp,
                 'remark': remark, 'fixed': fixed or []})

# ---- Sheet 07 : fan motor power
for w, p in [('R0', '1'), ('S0', '3'), ('T0', '5'), ('K0', '7')]:
    net(w, '07', '', [f'-TB01:{w}', f'-8AM:{p}'], 'วงจรกำลัง AC main - ไม่มีในตาราง Cable for wiring')
net('R', '07', '', ['-8AM:2', '-8FM1:1', '-8FM2:1', '-8FM3:1', ('-8A1:1', '08'), ('-8A2:1', '08'),
                    ('-8A3:1', '08'), ('-8A4:1', '08'), ('-47L:L1', '08')], 'บัส AC 3 เฟส - ระบุขนาดสายเอง')
net('S', '07', '', ['-8AM:4', '-8FM1:3', '-8FM2:3', '-8FM3:3', ('-47L:L2', '08')], 'บัส AC 3 เฟส - ระบุขนาดสายเอง')
net('T', '07', '', ['-8AM:6', '-8FM1:5', '-8FM2:5', '-8FM3:5', ('-47L:L3', '08')], 'บัส AC 3 เฟส - ระบุขนาดสายเอง')
net('K', '07', '', ['-8AM:8', ('-8A1:3', '08'), ('-8A2:3', '08'), ('-8A3:3', '08'), ('-8A4:3', '08'),
                    ('-47L:N', '08')], 'บัส Neutral วงจรกำลัง - ระบุขนาดสายเอง')
FAN = {'-8FM1': ['-88F1', '-88F2'], '-8FM2': ['-88F3', '-88F4'], '-8FM3': ['-88F5']}
fno = 1
for mcb, cons in FAN.items():
    for pin_m, pin_c in [('2', '1'), ('4', '3'), ('6', '5')]:
        net(f'F{fno}', '07', '', [f'{mcb}:{pin_m}'] + [f'{c}:{pin_c}' for c in cons], 'วงจรมอเตอร์พัดลม')
        fno += 1
OLR = {'-88F1': ['-49F1', '-49F3'], '-88F2': ['-49F5', '-49F7', '-49F9'], '-88F3': ['-49F2', '-49F4'],
       '-88F4': ['-49F6', '-49F8', '-49F10'], '-88F5': ['-49F11']}
fno = 10
for con, olrs in OLR.items():
    for pin_c, pin_o in [('2', '1'), ('4', '3'), ('6', '5')]:
        rem = 'วงจรมอเตอร์พัดลม'
        if fno == 21:
            rem += ' / เบอร์ F21 ซ้ำกับ node DC ใน Sheet 10'
        net(f'F{fno}', '07', '', [f'{con}:{pin_c}'] + [f'{o}:{pin_o}' for o in olrs], rem)
        fno += 1
for m in range(1, 12):
    for k, pin in enumerate(['2', '4', '6']):
        net(f'M{m}{k+1}', '07', '', [f'-49F{m}:{pin}', f'-TB01:M{m}{k+1}'], 'วงจรมอเตอร์พัดลม')
    net('E', '07', 'EARTH', [f'-TB01:E#FM{m}', 'GND'], f'ขั้ว E ของ FM{m}')

# ---- Sheet 08 : AC control
net('L01', '08', 'AC_CTRL', ['-8A1:2', '-CONL:L', '-43HL:2', '-43HL:6', '-92L:NC'])
net('L02', '08', 'AC_CTRL', ['-43HL:1', '-23HL:1', '-23CL:1'])
net('L03', '08', 'AC_CTRL', ['-43HL:5', '-23HL:2', '-23CL:2', '-TB01:RH1', '-TB01:RH2'])
net('L04', '08', 'AC_CTRL', ['-92L:C', '-TB01:RL1'])
net('L05', '08', 'AC_N', ['-8A1:4', '-CONL:N', '-TB01:RH3', '-TB01:RH4', '-TB01:RL3'])
net('RH1', '08', 'AC_CTRL', ['-TB01:RH1', '-HL1:L'])
net('RH2', '08', 'AC_CTRL', ['-TB01:RH2', '-HL2:L'])
net('RH3', '08', 'AC_N', ['-HL1:N', '-TB01:RH3'])
net('RH4', '08', 'AC_N', ['-HL2:N', '-TB01:RH4'])
net('RL1', '08', 'AC_CTRL', ['-TB01:RL1', '-FL1:L'])
net('RL3', '08', 'AC_N', ['-FL1:N', '-TB01:RL3'])
net('E', '08', 'EARTH', ['-HL1:E', 'GND'])
net('E', '08', 'EARTH', ['-HL2:E', 'GND'])
net('E', '08', 'EARTH', ['-CONL:GND', 'GND'])
net('R2', '08', 'AC_CTRL', ['-8A2:2', ('-27L:A1', '09'), ('-KS6:9', '13'), ('-27L:16', '13'), ('-8DM:4(AUX)', '13'),
                            ('-KS6:10', '13'), ('-TB03:130', '13'), ('-TB03:131', '13'), ('-TB03:132', '13')],
    fixed=[['-TB03:130', '-8D1:1.12'], ['-TB03:131', '-8D2:1.12'], ['-TB03:132', '-8D3:1.12']])
NETS[-1]['pins'] += [['-8D1:1.12', '13'], ['-8D2:1.12', '13'], ['-8D3:1.12', '13']]
net('K2', '08', 'AC_N', ['-8A2:4', ('-27L:A2', '09'), ('-KD1:13', '13'), ('-KD2:13', '13')])
net('R3', '08', 'AC_CTRL', ['-8A3:2', ('-TM1:5', '15'), ('-TM2:5', '15'), ('-TM3:5', '16'), ('-TM4:5', '16')])
net('K3', '08', 'AC_N', ['-8A3:4', ('-TM1:8', '15'), ('-TM2:8', '15'), ('-TM3:8', '16'), ('-TM4:8', '16')])
net('R4', '08', 'AC_CTRL', ['-8A4:2', ('-TB01:R4', '17'), ('-PSU1:L', '17'), ('-PSU2:L', '17')])
net('K4', '08', 'AC_N', ['-8A4:4', ('-TB01:K4', '17'), ('-PSU1:N', '17'), ('-PSU2:N', '17')])

# ---- Sheet 09 : DC supply
net('P01', '09', '', ['-TB02:P0', '-8DM:1'], 'DC main 125V - ไม่มีในตาราง Cable for wiring')
net('N03', '09', '', ['-TB02:N0', '-8DM:3'], 'DC main 125V - ไม่มีในตาราง Cable for wiring')
net('P', '09', '', ['-8DM:2', '-27L:F3', '-8D1:1', '-8D2:1', ('-8D3:1', '10'), ('-47L:A1', '08')],
    'DC main ด้านออก 8DM (20A) - ระบุขนาดสายเอง')
net('N', '09', '', ['-8DM:4', '-27L:E', '-8D1:3', '-8D2:3', ('-8D3:3', '10'), ('-47L:A2', '08')],
    'DC main ด้านออก 8DM (20A) - ระบุขนาดสายเอง')
P1 = ['-8D1:2',
      ('-TB02:P2.1', '11'), ('-TB02:P2.2', '11'), ('-TB02:P2.3', '11'), ('-TB02:P2.4', '11'),
      ('-X1:11', '11'), ('-X2:7', '11'), ('-X3:7', '11'), ('-X4:7', '11'),
      ('-X1:12', '11'), ('-KS1:9', '11'), ('-X2:8', '11'), ('-KS1:10', '11'),
      ('-X3:8', '11'), ('-KS1:11', '11'), ('-X4:8', '11'), ('-KS1:12', '11')]
P1 += [(f'-TB02:P2.{i}', '12') for i in range(7, 21)]
P1 += [('-KS2:9', '12'), ('-KS2:10', '12'), ('-KS2:11', '12'), ('-KS2:12', '12'),
       ('-KS3:9', '12'), ('-KS3:10', '12'), ('-KS3:11', '12'), ('-KS3:12', '12'),
       ('-KS4:9', '12'), ('-KS4:10', '12')]
P1 += [(f'-TB02:P2.{i}', '13') for i in range(21, 27)]
P1 += [('-8FM1:1.12', '13'), ('-8FM2:1.12', '13'), ('-8A1:1.12', '13'), ('-8A2:1.12', '13'),
       ('-8A3:1.12', '13'), ('-8A4:1.12', '13'),
       ('-47L:16', '13'), ('-8AM:12', '13'), ('-KS5:11', '13'), ('-KS5:12', '13'),
       ('-KS4:11', '13'), ('-KS4:12', '13'), ('-KS5:9', '13'), ('-KS5:10', '13')]
P1 += [(f'-49F{i}:98', '13') for i in (1, 3, 5, 7, 9, 2, 4, 6, 8, 10)]
P1 += [('-86ACO:16', '14'), ('-86A:106', '14'), ('-TB03:170', '14'), ('-3R:3', '14'),
       ('-KS6:11', '14'), ('-KS6:12', '14'), ('-KS7:9', '14')]
net('P1', '09', 'DC_CTRL', P1,
    fixed=[['-TB02:P2.21', '-8FM1:1.12'], ['-TB02:P2.22', '-8FM2:1.12'], ['-TB02:P2.23', '-8A1:1.12'],
           ['-TB02:P2.24', '-8A2:1.12'], ['-TB02:P2.25', '-8A3:1.12'], ['-TB02:P2.26', '-8A4:1.12']])
N1 = ['-8D1:4', ('-X1:1', '11'), ('-X2:1', '11'), ('-X3:1', '11'), ('-X4:1', '11'), ('-86A:B', '11'),
      ('-K1:B', '11'), ('-K2:B', '11'), ('-K3:B', '11'), ('-K4:B', '11')]
N1 += [(f'-K{i}:13', '12') for i in range(5, 15)]
N1 += [(f'-K{i}:13', '13') for i in range(15, 21)]
N1 += [(f'-K{i}:13', '14') for i in range(21, 24)] + [(f'-KS{i}:13', '14') for i in range(1, 8)]
net('N1', '09', 'DC_CTRL', N1)
P2 = ['-8D2:2', ('-AN:+125', '18'), ('-AN:COM1', '18'), ('-KBH:5', '18')]
P2 += [(f'-K{i}:5', '18') for i in range(1, 5)]
P2 += [(f'-K{i}:6', '18') for i in list(range(5, 17)) + [19, 20, 17, 18, 21, 22]]
P2 += [('-TB03:164', '18'), ('-TB03:166', '18')]
net('P2', '09', 'DC_CTRL', P2, 'Sheet 09 อ้างอิง /16.C1 แต่วงจรอยู่ Sheet 18')
net('N2', '09', 'DC_CTRL', ['-8D2:4', ('-AN:N-', '18'), ('-BL:COM', '18'), ('-KTB:2', '18'), ('-KBH:13', '18')],
    'Sheet 09 อ้างอิง /16.G1 แต่วงจรอยู่ Sheet 18')

# ---- Sheet 10 : fan control
net('F30', '10', 'DC_CTRL', ['-8D3:2', '-43CA:2', '-43CA:6', '-43CA:4', '-43CA:8', '-KL1:6', '-KL2:6', '-TB03:168'])
net('F31', '10', 'DC_CTRL', ['-43CA:1', '-TB02:W1', '-TB02:W2', '-TB02:W3'])
net('F32', '10', 'DC_CTRL', ['-43CA:5', '-TB02:W4', '-TB02:W5', '-TB02:W6'])
net('F35', '10', 'DC_CTRL', ['-TB02:W7', '-TB02:W8', '-TB02:W9', '-83C:2', '-83C:4'])
net('F36', '10', 'DC_CTRL', ['-TB02:W10', '-TB02:W11', '-TB02:W12', '-83C:6', '-83C:8'])
net('F39', '10', 'DC_CTRL', ['-83C:1', '-83C:7', '-3B1:2', '-KL1:14'])
net('F40', '10', 'DC_CTRL', ['-83C:3', '-83C:5', '-3B2:2', '-KL2:14'])
net('F33', '10', 'DC_CTRL', ['-43CA:3', '-3C1:3', '-KL1:5'])
net('F34', '10', 'DC_CTRL', ['-43CA:7', '-3C2:3', '-KL2:5'])
net('F37', '10', 'DC_CTRL', ['-3C1:4', '-KL1:9', '-3B1:1'])
net('F38', '10', 'DC_CTRL', ['-3C2:4', '-KL2:9', '-3B2:1'])
net('F21', '10', 'DC_CTRL', ['-8D3:4', '-KL1:13', '-KL2:13'] + [f'-88F{i}:A2' for i in range(1, 6)],
    'เบอร์ F21 ซ้ำกับวงจรมอเตอร์ใน Sheet 07 (88F4.2) - ควรแก้ในแบบ')
net('F41', '10', 'DC_CTRL', ['-KL1:10', '-49F1:95', '-49F5:95'])
net('F42', '10', 'DC_CTRL', ['-49F1:96', '-49F3:95'])
net('F43', '10', 'DC_CTRL', ['-49F3:96', '-88F1:A1'])
net('F44', '10', 'DC_CTRL', ['-49F5:96', '-49F7:95'])
net('F45', '10', 'DC_CTRL', ['-49F7:96', '-49F9:95'])
net('F46', '10', 'DC_CTRL', ['-49F9:96', '-88F2:A1'])
net('F47', '10', 'DC_CTRL', ['-KL2:10', '-49F2:95', '-49F6:95'])
net('F48', '10', 'DC_CTRL', ['-49F2:96', '-49F4:95'])
net('F49', '10', 'DC_CTRL', ['-49F4:96', '-88F3:A1'])
net('F50', '10', 'DC_CTRL', ['-49F6:96', '-49F8:95'])
net('F51', '10', 'DC_CTRL', ['-49F8:96', '-49F10:95'])
net('F52', '10', 'DC_CTRL', ['-49F10:96', '-88F4:A1'])
net('F53', '10', 'DC_CTRL', ['-TB03:169', '-49F11:95'])
net('F54', '10', 'DC_CTRL', ['-49F11:96', '-88F5:A1'])

# ---- Sheet 11 : protection
for i in range(1, 5):
    net(f'C{i}', '11', 'DC_CTRL', [f'-TB03:{100+i}', f'-X{i}:2'])
net('C5', '11', 'DC_CTRL', ['-X1:3', '-X2:3', '-X3:3', '-X4:3', '-86ACO:32'])
net('C6', '11', 'DC_CTRL', ['-86ACO:31', '-86A:G'])
for i in range(1, 5):
    net(f'C{5+2*i}', '11', 'DC_CTRL', [f'-X{i}:4', f'-K{i}:4', f'-K{i}:A'])
    net(f'C{6+2*i}', '11', 'DC_CTRL', [f'-KS1:{i}', f'-K{i}:7'])

# ---- Sheet 12
s12 = [('107', '-TB03:107', 5, 'C20', '-KS2:1'), ('108', '-TB03:108', 6, 'C21', '-KS2:2'),
       ('109', '-TB03:109', 7, 'C22', '-KS2:3'), ('110', '-TB03:110', 8, 'C23', '-KS2:4'),
       ('111', '-TB03:111', 9, 'C24', '-KS3:1'), ('112', '-TB03:112', 10, 'C25', '-KS3:2'),
       ('113', '-TB03:113', 11, 'C26', '-KS3:3'), ('116', '-TB03:116', 12, 'C27', '-KS3:4'),
       ('119', '-TB03:119', 13, 'C27', '-KS4:1'), ('120', '-TB03:120', 14, 'C27', '-KS4:2')]
for w, t, k, c, ks in s12:
    pins = [t, f'-K{k}:5', f'-K{k}:14']
    if w == '113':
        pins = ['-TB03:113', '-TB03:114', '-TB03:115'] + pins[1:]
    if w == '116':
        pins = ['-TB03:116', '-TB03:117', '-TB03:118'] + pins[1:]
    net(w, '12', 'DC_CTRL', pins)
    rem = ''
    if k in (13, 14):
        rem = f'เบอร์ C27 ซ้ำในแบบ (Sheet 12 ที่ K12/K13/K14) - เสนอ C{28 if k == 13 else 29}'
    net(c, '12', 'DC_CTRL', [ks, f'-K{k}:9'], rem)

# ---- Sheet 13
net('121', '13', 'DC_CTRL', ['-TB03:121', '-8FM1:1.11', '-K15:5', '-K15:14'], fixed=[['-TB03:121', '-8FM1:1.11']])
net('122', '13', 'DC_CTRL', ['-TB03:122', '-8FM2:1.11', '-K16:5', '-K16:14'], fixed=[['-TB03:122', '-8FM2:1.11']])
net('123', '13', 'DC_CTRL', ['-TB03:123', '-TB03:124', '-TB03:125', '-TB03:126', '-8A1:1.11', '-8A2:1.11',
                             '-8A3:1.11', '-8A4:1.11', '-K17:5', '-K17:14'],
    fixed=[['-TB03:123', '-8A1:1.11'], ['-TB03:124', '-8A2:1.11'], ['-TB03:125', '-8A3:1.11'], ['-TB03:126', '-8A4:1.11']])
net('C32', '13', 'DC_CTRL', ['-KS4:3', '-K15:9'])
net('C33', '13', 'DC_CTRL', ['-KS4:4', '-K16:9'])
net('C34', '13', 'DC_CTRL', ['-KS5:1', '-K17:9'])
net('C36', '13', 'DC_CTRL', ['-KS5:2', '-K18:9'])
net('C37', '13', 'DC_CTRL', ['-47L:15', '-8AM:11', '-K18:5', '-K18:14'])
net('C38', '13', 'DC_CTRL', ['-KS5:3', '-K19:9'])
net('C40', '13', 'DC_CTRL', ['-K19:5', '-K19:14'] + [f'-49F{i}:97' for i in (1, 3, 5, 7, 9)])
net('C39', '13', 'DC_CTRL', ['-KS5:4', '-K20:9'])
net('C41', '13', 'DC_CTRL', ['-K20:5', '-K20:14'] + [f'-49F{i}:97' for i in (2, 4, 6, 8, 10)])
net('C46', '13', 'AC_CTRL', ['-KS6:1', '-KD1:9'])
net('C47', '13', 'AC_CTRL', ['-27L:15', '-8DM:1(AUX)', '-KD1:5', '-KD1:14'],
    '8DM ขาคอนแทคช่วย 4-1 ซ้ำเบอร์กับขาหลัก -> ใช้ 1(AUX)/4(AUX)')
net('C48', '13', 'AC_CTRL', ['-KS6:2', '-KD2:10'])
net('133', '13', 'AC_CTRL', ['-TB03:133', '-TB03:134', '-TB03:135', '-8D1:1.11', '-8D2:1.11', '-8D3:1.11',
                             '-KD2:6', '-KD2:14'],
    fixed=[['-TB03:133', '-8D1:1.11'], ['-TB03:134', '-8D2:1.11'], ['-TB03:135', '-8D3:1.11']])

# ---- Sheet 14
net('C58', '14', 'DC_CTRL', ['-86ACO:15', '-K21:5', '-K21:14'])
net('C55', '14', 'DC_CTRL', ['-KS6:3', '-K21:9'])
net('C59', '14', 'DC_CTRL', ['-86A:104', '-K22:5', '-K22:14'])
net('C56', '14', 'DC_CTRL', ['-KS6:4', '-K22:9'])
net('C60', '14', 'DC_CTRL', ['-TB03:171', '-K23:5', '-K23:14'])
net('C57', '14', 'DC_CTRL', ['-KS7:1', '-K23:9'])
net('C61', '14', 'DC_CTRL', ['-3R:4'] + [f'-KS{i}:14' for i in range(1, 8)])

# ---- Sheet 15-16 : transducers (PT100 / 4-20 mA)
tm = {1: (136, 148, '15'), 2: (139, 150, '15'), 3: (142, 152, '16'), 4: (145, 154, '16')}
for t, (a, o, sh) in tm.items():
    for k in range(3):
        net(str(a + k), sh, '', [f'-TB03:{a+k}', f'-TM{t}:{k+1}'], 'สัญญาณ PT100 - ระบุชนิดสายเอง')
    net(str(o), sh, '', [f'-TM{t}:9', f'-TB03:{o}'], 'สัญญาณ 4-20 mA - ระบุชนิดสายเอง')
    net(str(o + 1), sh, '', [f'-TM{t}:10', f'-TB03:{o+1}'], 'สัญญาณ 4-20 mA - ระบุชนิดสายเอง')
net('E', '15', 'EARTH_CT', ['-TB06:E#H2', 'GND'], 'CT earth BCT HV-H2')
net('E', '16', 'EARTH_CT', ['-TB06:E#X1', 'GND'], 'CT earth BCT LV-X1')
net('E', '16', 'EARTH_CT', ['-TB06:E#X2', 'GND'], 'CT earth BCT LV-X2')

# ---- Sheet 17 : DGA
net('E', '17', 'EARTH', ['-TB01:E#MS1', 'GND'], 'ขั้ว TB01 E ของ MS1 ไม่มีใน Terminal arrangement (Sheet 23) - ตรวจสอบ')
net('C80', '17', '', ['-PSU1:L+', '-TB03:156', '-TB03:157'], '24VDC loop supply - ระบุชนิดสายเอง')
net('C81', '17', '', ['-PSU1:L-', '-TB03:161', '-TB03:163'], '24VDC loop supply - ระบุชนิดสายเอง')
net('C82', '17', '', ['-PSU2:L+', '-CPU:+'], '24VDC - ระบุชนิดสายเอง')
net('C83', '17', '', ['-PSU2:L-', '-CPU:-'], '24VDC - ระบุชนิดสายเอง')
net('E', '17', 'EARTH', ['-CPU:E', 'GND'])

# ---- Sheet 18 : annunciator
net('A36', '18', 'DC_CTRL', ['-KTB:6', '-3AK:3', '-3AR:3', '-3AT:3', '-AN:COM2'])
net('A37', '18', 'DC_CTRL', ['-3AK:4', '-KTB:8', '-AN:ACK'])
net('A38', '18', 'DC_CTRL', ['-3AR:4', '-AN:RES'])
net('A39', '18', 'DC_CTRL', ['-3AT:4', '-AN:TEST'])
net('A40', '18', 'DC_CTRL', ['-KBH:9', '-43BL:1', '-KTB:7'], 'ไม่มีเบอร์สายในแบบ - เสนอ A40 (ตรวจสอบ)')
net('A41', '18', 'DC_CTRL', ['-43BL:2', '-BL:X2'], '43BL ในแบบ / Outline เขียน 43BR')
net('A42', '18', 'DC_CTRL', ['-AN:BZ', '-KBH:14'], 'ไม่มีเบอร์สายในแบบ - เสนอ A42 (ตรวจสอบ)')
net('E', '18', 'EARTH', ['-AN:GND', 'GND'])
for i in range(1, 5):
    net(f'A{i}', '18', 'DC_CTRL', [f'-K{i}:8', f'-AN:FC{i}'])
for i in range(5, 17):
    net(f'A{i}', '18', 'DC_CTRL', [f'-K{i}:10', f'-AN:FC{i}'])
for a, k in [(17, 19), (18, 20), (19, 17), (20, 18), (21, 21), (22, 22)]:
    net(f'A{a}', '18', 'DC_CTRL', [f'-K{k}:10', f'-AN:FC{a}'])
net('165', '18', 'DC_CTRL', ['-TB03:165', '-AN:FC23'])
net('167', '18', 'DC_CTRL', ['-TB03:167', '-AN:FC24'])

# ---- Sheet 19 : BCT
net('E', '19', 'EARTH_CT', ['-TB06:E#H0-1', 'GND'], 'CT earth BCT HV-H0 (1)')
net('E', '19', 'EARTH_CT', ['-TB06:E#H0-2', 'GND'], 'CT earth BCT HV-H0 (2)')

# ---- Sheet 20 : dry contacts to TB04
DRY = 'คอนแทคแห้งไปลูกค้า - ระบุชนิดสายเอง'
t = 201
for k in range(1, 5):
    net(str(t), '20', '', [f'-K{k}:6', f'-TB04:{t}'], DRY); net(str(t + 1), '20', '', [f'-K{k}:9', f'-TB04:{t+1}'], DRY); t += 2
for kl, a in [('-KL1', 209), ('-KL2', 211)]:
    net(str(a), '20', '', [f'{kl}:8', f'-TB04:{a}'], DRY); net(str(a + 1), '20', '', [f'{kl}:12', f'-TB04:{a+1}'], DRY)
t = 213
for k in list(range(5, 21)) + ['D1', 'D2']:
    net(str(t), '20', '', [f'-K{k}:7', f'-TB04:{t}'], DRY); net(str(t + 1), '20', '', [f'-K{k}:11', f'-TB04:{t+1}'], DRY); t += 2
t = 249
for k in (21, 22, 23):
    net(str(t), '20', '', [f'-K{k}:7', f'-TB04:{t}'], DRY); net(str(t + 1), '20', '', [f'-K{k}:11', f'-TB04:{t+1}'], DRY); t += 2
net('255', '20', '', ['-8FM3:1.11', '-TB04:255'], DRY)
net('256', '20', '', ['-8FM3:1.12', '-TB04:256'], DRY)
net('257', '20', '', ['-49F11:98', '-TB04:257'], DRY)
net('258', '20', '', ['-49F11:97', '-TB04:258'], DRY)

# ---- Sheet 22 : 86ACO / 86A contacts to TB05
t = 301
for a, b in [(3, 4), (5, 6), (7, 8), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30)]:
    net(str(t), '22', '', [f'-86ACO:{a}', f'-TB05:{t}'], DRY); net(str(t + 1), '22', '', [f'-86ACO:{b}', f'-TB05:{t+1}'], DRY); t += 2
for a in (11, 21, 31, 41, 51, 61, 71, 81, 91, 101):
    net(str(t), '22', '', [f'-86A:{a}', f'-TB05:{t}'], DRY); net(str(t + 1), '22', '', [f'-86A:{a+2}', f'-TB05:{t+1}'], DRY); t += 2
for a in (12, 22, 32, 42, 52, 62, 72, 82, 92, 102):
    net(str(t), '22', '', [f'-86A:{a}', f'-TB05:{t}'], DRY); net(str(t + 1), '22', '', [f'-86A:{a+6}', f'-TB05:{t+1}'], DRY); t += 2
for a in (14, 24, 34, 44, 54, 64, 74, 84, 94):
    net(str(t), '22', '', [f'-86A:{a}', f'-TB05:{t}'], DRY); net(str(t + 1), '22', '', [f'-86A:{a+2}', f'-TB05:{t+1}'], DRY); t += 2
assert t == 379, t

# ---------------------------------------------------------------- sheets without internal wiring
NO_INTERNAL = {
    '21': 'Sheet 21: DGA2 MSENS FAIL / Potential meter -> TB04 259-264 เป็นสายภายนอกทั้งหมด ไม่มีสายภายใน',
}

ANOMALIES = [
    'Sheet 07/10: เบอร์สาย F21 ใช้ 2 node (88F4.2 วงจรมอเตอร์ และขั้วลบ DC ของ 8D3.4) - ควรแก้เบอร์ในแบบ',
    'Sheet 12: เบอร์ C27 ใช้ซ้ำ 3 node (KS3.4-K12.9, KS4.1-K13.9, KS4.2-K14.9) - เสนอ C28, C29',
    'Sheet 18: node KBH.9-43BL.1-KTB.7 และ AN.BZ-KBH.14 ไม่มีเบอร์สาย - เสนอ A40, A42',
    'Sheet 09: P2/N2 อ้างอิง /16.C1, /16.G1 แต่วงจร Annunciator อยู่ Sheet 18',
    'Sheet 18: ชื่อสวิตช์ 43BL ในวงจร แต่ Outline/ป้ายเขียน 43BR',
    'Sheet 18/30: KBH ในวงจร แต่ Outline เขียน KBZ; BL (buzzer) และ 3R (Sheet 14) ไม่พบใน Outline - วางตำแหน่งสมมติ',
    'Sheet 13/30: KD1, KD2 ไม่พบใน Outline - วางตำแหน่งสมมติบน DIN rail แถว KS',
    'Sheet 17: TB01 "E" ของ MS1 ไม่มีใน Terminal arrangement TB01 (Sheet 23)',
    'Sheet 08: FL1 (lamp), 92L (door switch) และ Earth bar ไม่ได้แสดงใน Sheet 30 - วางตำแหน่งสมมติ',
    'Sheet 13: คอนแทคช่วย 8DM (4-1) ใช้เบอร์ชนกับขั้วหลัก -> ระบุ 1(AUX)/4(AUX)',
]

# ---------------------------------------------------------------- validation
def all_pins():
    s = set()
    for d in DEV:
        s.add(d)
    return s

errors = []
term_pins = {t: set(p for p in d['pins'] if p) | set(d.get('extra', [])) for t, d in TERMS.items()}
for n in NETS:
    for p, sh in n['pins']:
        if p == 'GND':
            continue
        if ':' not in p:
            errors.append(f'bad pin {p} in {n["wire"]}')
            continue
        d, pin = p.split(':', 1)
        if d not in DEV:
            errors.append(f'unknown device {d} ({n["wire"]} sh{n["sheet"]})')
        if d in TERMS and pin not in term_pins[d]:
            errors.append(f'unknown terminal {p} ({n["wire"]})')
    names = [p for p, _ in n['pins']]
    if len(set(names)) != len(names):
        errors.append(f'duplicate pin in net {n["wire"]} sh{n["sheet"]}: {names}')
    for a, b in n['fixed']:
        if a not in names or b not in names:
            errors.append(f'fixed edge not in net {n["wire"]}: {a}-{b}')
# a pin must belong to exactly one net (except GND and terminal pins that pass through)
owner = {}
for i, n in enumerate(NETS):
    for p, _ in n['pins']:
        if p == 'GND':
            continue
        d = p.split(':')[0]
        if d in TERMS:
            continue
        if p in owner:
            errors.append(f'pin {p} in two nets: {NETS[owner[p]]["wire"]} and {n["wire"]}')
        owner[p] = i
if errors:
    print('\n'.join(errors))
    sys.exit(1)

data = {
    'version': 1,
    'meta': META, 'cable': CABLE, 'views': VIEWS, 'wireways': WIREWAYS, 'portals': PORTALS,
    'devices': DEV, 'terminals': TERMS, 'bars': BARS, 'barEntry': BAR_ENTRY, 'nets': NETS,
    'noInternal': NO_INTERNAL, 'anomalies': ANOMALIES,
    'background': {'src': 'data/pp1047a_outline_sheet30.png', 'ptWidth': 842, 'ptHeight': 595},
}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('/* Generated by tools/build_pp1047a.py - project data for PP1047A TCC */\n')
    f.write('window.PROJECT_DATA = ')
    json.dump(data, f, ensure_ascii=False, indent=1)
    f.write(';\n')
npins = sum(len(n['pins']) for n in NETS)
print(f'OK: {len(NETS)} nets, {npins} pin refs, {len(DEV)} devices -> {os.path.relpath(OUT)}')
