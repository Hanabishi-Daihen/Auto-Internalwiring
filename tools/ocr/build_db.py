import sys; sys.path.insert(0,'.')
import fitz, pickle, numpy as np
from glyphs import clusters, bitmap
d=fitz.open(sys.argv[1]); pages=[int(x) for x in sys.argv[2].split(',')]
allc=[]
for pg in pages:
    for c in clusters(d[pg-1]):
        c['page']=pg; c['bm']=bitmap(c); allc.append(c)
leaders=[]
for i,c in enumerate(allc):
    w=c['bbox'][2]-c['bbox'][0]; h=c['bbox'][3]-c['bbox'][1]; la=np.log((w+.05)/(h+.05))
    best=None;bi=0
    for L in leaders:
        if abs(la-L['lasp'])>0.3: continue
        a=L['bm']; iou=(a&c['bm']).sum()/max((a|c['bm']).sum(),1)
        if iou>bi: bi=iou; best=L
    if best is not None and bi>0.72: best['members'].append(i)
    else: leaders.append(dict(bm=c['bm'],lasp=la,members=[i]))
leaders.sort(key=lambda L:-len(L['members']))
print('clusters',len(allc),'leaders',len(leaders),[round(sum(len(L['members']) for L in leaders[:k])/len(allc),3) for k in (50,100,200,300)])
pickle.dump((allc,leaders),open(sys.argv[3],'wb'))
