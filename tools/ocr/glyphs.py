import fitz, itertools, numpy as np
from collections import defaultdict
from strokes import page_paths
from PIL import Image, ImageDraw
TOL=0.25; SMALL=6.5; N=24
def clusters(page, tol=None):
    P=page_paths(page)
    small=[q for q in P if q['stroke'] and not q['fill'] and max(q['bbox'][2]-q['bbox'][0],q['bbox'][3]-q['bbox'][1])<SMALL]
    TOLX=TOL if tol is None else tol
    n=len(small); par=list(range(n))
    def f(x):
        while par[x]!=x: par[x]=par[par[x]]; x=par[x]
        return x
    grid=defaultdict(list)
    for i,q in enumerate(small):
        x0,y0,x1,y1=q['bbox']
        for gx in range(int(x0//4),int(x1//4)+1):
            for gy in range(int(y0//4),int(y1//4)+1): grid[(gx,gy)].append(i)
    pts=[np.array([pt for pl in q['polys'] for pt in pl]) for q in small]
    ends=[np.array([pl[0] for pl in q['polys']]+[pl[-1] for pl in q['polys']]) for q in small]
    segs=[]
    for q in small:
        S=[(pl[k],pl[k+1]) for pl in q['polys'] for k in range(len(pl)-1)]
        segs.append(np.array(S) if S else np.zeros((0,2,2)))
    def cross(S1,S2):
        # any proper segment intersection (e.g. the strokes of '4' or '+')
        if len(S1)==0 or len(S2)==0: return False
        a=S1[:,0][:,None]; b=S1[:,1][:,None]; c=S2[:,0][None]; d=S2[:,1][None]
        def orient(p,q,r): return (q[...,0]-p[...,0])*(r[...,1]-p[...,1])-(q[...,1]-p[...,1])*(r[...,0]-p[...,0])
        o1=orient(a,b,c); o2=orient(a,b,d); o3=orient(c,d,a); o4=orient(c,d,b)
        return bool(((o1*o2<0)&(o3*o4<0)).any())
    def pdist(P,S):
        # min distance from points P (m,2) to segments S (k,2,2)
        if len(S)==0 or len(P)==0: return 9e9
        a=S[:,0][None]; b=S[:,1][None]; p=P[:,None]
        ab=b-a; t=((p-a)*ab).sum(-1)/np.maximum((ab*ab).sum(-1),1e-9); t=np.clip(t,0,1)
        q=a+t[...,None]*ab
        return np.sqrt(((p-q)**2).sum(-1)).min()
    for cell in grid.values():
        for i,j in itertools.combinations(cell,2):
            if f(i)==f(j): continue
            A,B=small[i]['bbox'],small[j]['bbox']
            if A[0]>B[2]+TOLX or B[0]>A[2]+TOLX or A[1]>B[3]+TOLX or B[1]>A[3]+TOLX: continue
            if pdist(ends[i],segs[j])<TOLX or pdist(ends[j],segs[i])<TOLX or cross(segs[i],segs[j]) or pdist(pts[i],segs[j])<0.18: par[f(i)]=f(j)
    groups=defaultdict(list)
    for i in range(n): groups[f(i)].append(i)
    out=[]
    for g in groups.values():
        polys=[pl for i in g for pl in small[i]['polys']]
        xs=[p[0] for pl in polys for p in pl]; ys=[p[1] for pl in polys for p in pl]
        out.append(dict(polys=polys,bbox=(min(xs),min(ys),max(xs),max(ys)),paths=[small[i]['polys'] for i in g]))
    return out
def bitmap(c):
    x0,y0,x1,y1=c['bbox']; w,h=x1-x0,y1-y0; s=(N-4)/max(w,h,0.3)
    ox=(N-w*s)/2; oy=(N-h*s)/2
    im=Image.new('L',(N,N),0); dr=ImageDraw.Draw(im)
    for pl in c['polys']:
        q=[((x-x0)*s+ox,(y-y0)*s+oy) for x,y in pl]
        if len(q)==1: q=q*2
        dr.line(q,fill=255,width=2)
    return (np.array(im)>0)
