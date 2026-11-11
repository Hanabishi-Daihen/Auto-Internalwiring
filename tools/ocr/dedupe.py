import sys; sys.path.insert(0,'.')
import pickle
from ocr import bm, rot_polys, LABELS
allc,leaders=pickle.load(open('glyphdb.pkl','rb'))
extra=pickle.load(open('extra_templates.pkl','rb'))
base=[]
for lab,idx in LABELS.items():
    for k in idx: base.append((lab,allc[leaders[k]['members'][0]]['polys']))
def iou(a,b): return (a&b).sum()/max((a|b).sum(),1)
kept=[]; bms=[(lab,bm(p)[0]) for lab,p in base]
drop_conf=0; drop_dup=0
for lab,r,polys in extra:
    up=rot_polys(polys,{0:0,1:2,2:1}[r]); b=bm(up)[0]
    conf=any(l!=lab and iou(b,x)>0.9 for l,x in bms)
    dup=any(l==lab and iou(b,x)>0.85 for l,x in bms)
    if conf: drop_conf+=1; continue
    if dup: drop_dup+=1; continue
    kept.append((lab,0,up)); bms.append((lab,b))
print('extra',len(extra),'kept',len(kept),'dup',drop_dup,'conflict',drop_conf)
import collections; print(collections.Counter(k[0] for k in kept))
pickle.dump(kept,open('extra_templates.pkl','wb'))
