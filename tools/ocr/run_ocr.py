import sys; sys.path.insert(0,'.')
import fitz, pickle, re, json
from glyphs import clusters
from ocr import OCR
from words import char_items, assemble
o=OCR('glyphdb.pkl',pickle.load(open('extra_templates.pkl','rb')))
import numpy as np
from strokes import page_paths
def endpoints(page):
    pts=[]
    for q in page_paths(page):
        if not q['stroke']: continue
        for pl in q['polys']: pts.append(pl[0]); pts.append(pl[-1])
    return np.array(pts)
def is_terminal_circle(c,E):
    x0,y0,x1,y1=c['bbox']; w,h=x1-x0,y1-y0
    if not (1.0<w<4 and 0.85<w/max(h,1e-6)<1.18): return False
    allp=[p for pl in c['polys'] for p in pl]
    if len(c['polys'])>2: return False
    cx,cy,r=(x0+x1)/2,(y0+y1)/2,(w+h)/4
    d=np.hypot(E[:,0]-cx,E[:,1]-cy)
    return bool(((d>r-0.25)&(d<r+0.25)).sum()>=1)
def mk(paths):
    polys=[pl for p in paths for pl in p]
    xs=[q[0] for pl in polys for q in pl]; ys=[q[1] for pl in polys for q in pl]
    return dict(polys=polys,bbox=(min(xs),min(ys),max(xs),max(ys)),paths=paths)
def top(best): return max((v[1] for v in best.values()),default=0)
def split_touching(c):
    # characters drawn so close that they touch (e.g. '-8', 'K1'): try cutting the paths into two groups
    P=c['paths']
    if len(P)<2 or len(P)>8: return None
    best=None
    for axis in (0,1):
        order=sorted(range(len(P)),key=lambda i:min(q[axis] for pl in P[i] for q in pl))
        for k in range(1,len(P)):
            a=mk([P[i] for i in order[:k]]); b=mk([P[i] for i in order[k:]])
            ba,bb=o.classify(a),o.classify(b)
            sa=top(ba) if max(a['bbox'][2]-a['bbox'][0],a['bbox'][3]-a['bbox'][1])>=1.2 else (1 if is_line(a) else 0)
            sb=top(bb) if max(b['bbox'][2]-b['bbox'][0],b['bbox'][3]-b['bbox'][1])>=1.2 else (1 if is_line(b) else 0)
            sa=max(sa,0.85 if is_line(a) else 0); sb=max(sb,0.85 if is_line(b) else 0)
            if min(sa,sb)>=0.8 and (best is None or sa+sb>best[0]): best=(sa+sb,[(a,ba),(b,bb)])
    return best[1] if best else None
def is_line(c):
    x0,y0,x1,y1=c['bbox']; w,h=x1-x0,y1-y0
    return (h<0.12*w or w<0.12*h) and len(c['polys'])==1
def read_page(page):
    E=endpoints(page)
    res=[]
    for c in clusters(page):
        if is_terminal_circle(c,E): res.append((c,{})); c['terminal']=True; continue
        b=o.classify(c)
        w,h=c['bbox'][2]-c['bbox'][0],c['bbox'][3]-c['bbox'][1]
        if top(b)<0.8 and max(w,h)>=1.2:
            sp=split_touching(c)
            if sp:
                res.extend(sp); continue
        res.append((c,b))
    items=char_items(res)
    for it in items:
        if it['c'].get('terminal'): it['kind']='terminal'
    return assemble(items), items
if __name__=='__main__':
    d=fitz.open(sys.argv[1]); pages=[int(x) for x in sys.argv[2].split(',')]
    out={}
    for pg in pages:
        ws,_=read_page(d[pg-1]); out[pg]=[dict(text=w['text'],rot=w['rot'],bbox=w['bbox']) for w in ws]
        print(pg,len(ws),file=sys.stderr)
    json.dump(out,open(sys.argv[3],'w'))
