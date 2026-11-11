import sys; sys.path.insert(0,'.')
import fitz, pickle, json, re
import run_ocr
from words import char_items, assemble
src=open('/home/user/Auto-Internalwiring/data/pp1047a_tcc.js').read()
P=json.loads(src[src.index('=')+1:].strip().rstrip(';'))
truth={}
for n in P['nets']:
    for ref,sh in n['pins']:
        d,pin=(ref.split(':')+[''])[:2]
        if d.startswith('-'): truth.setdefault(int(sh),set()).update([d] if not d.startswith('-TB') else [])
        if d.startswith('-TB'): truth.setdefault(int(sh),set()).add(pin.split('#')[0])
    truth.setdefault(int(n['sheet']),set()).add(n['wire'])
d=fitz.open('../sch.pdf')
extra=pickle.load(open('extra_templates.pkl','rb'))
CONF={'8':'B0693SE','0':'ODCQUG8','O':'0DCQ','B':'8','6':'0G8','9':'08','U':'0OV','D':'0O','G':'C06','5':'S','S':'58'}
added=0
for sh in range(7,23):
    ws,items=run_ocr.read_page(d[sh-1])
    chars=[i for i in items if i['kind']=='char']
    cands=truth.get(sh,set())
    for w in ws:
        t=w['text']; core=t.lstrip('-'); m=w['members']
        allt=set(x.lstrip('-') for xs in truth.values() for x in xs)
        if core in allt: continue
        if len(core)!=len(m) or len(core)<2: continue
        best=None; nbest=0
        for c in cands:
            cc=c.lstrip('-')
            if len(cc)!=len(core) or c.startswith('-')!=t.startswith('-') and t.startswith('-'): continue
            diff=[k for k in range(len(cc)) if cc[k]!=core[k]]
            if len(diff)==1 and len(cc)>=2 and core[diff[0]] in CONF.get(cc[diff[0]],''): 
                if best is None or len(diff)<best[1]: best=(cc,len(diff),diff); nbest=1
                elif len(diff)==best[1] and cc!=best[0]: nbest+=1
        if not best or nbest>1: continue
        cc,_,diff=best
        for k in diff:
            ch=cc[k]
            if not re.match(r'[A-Z0-9]',ch): continue
            extra.append((ch,w['rot'],chars[m[k]]['c']['polys'])); added+=1
print('added',added)
pickle.dump(extra,open('extra_templates.pkl','wb'))
