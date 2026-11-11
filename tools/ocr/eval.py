import json, re, sys
ocr=json.load(open(sys.argv[1]))
src=open('/home/user/Auto-Internalwiring/data/pp1047a_tcc.js').read()
P=json.loads(src[src.index('=')+1:].strip().rstrip(';'))
dev={}; wire={}
for n in P['nets']:
    for ref,sh in n['pins']:
        d=ref.split(':')[0]
        if d.startswith('-') and not d.startswith('-TB'): dev.setdefault(int(sh),set()).add(d)
    if re.match(r'^[A-Z]{1,2}\d+$|^\d{3}$',n['wire']): wire.setdefault(int(n['sheet']),set()).add(n['wire'])
tot_d=hit_d=tot_w=hit_w=0; miss=[]
for sh in range(7,23):
    words=set(w['text'] for w in ocr[str(sh)])
    for d in dev.get(sh,()):
        tot_d+=1
        if d in words: hit_d+=1
        else: miss.append((sh,d))
    for w in wire.get(sh,()):
        tot_w+=1
        if w in words: hit_w+=1
        else: miss.append((sh,'w:'+w))
print(f'devices {hit_d}/{tot_d}  wires {hit_w}/{tot_w}')
print(miss)
