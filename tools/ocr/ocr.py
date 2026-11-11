import pickle, numpy as np, math
from PIL import Image, ImageDraw
from glyphs import clusters
N=24
LABELS={'1':[5,8,13,29,96,133],'2':[18,41,42,100,114,116,143,172,225],'3':[17,28,128,235,252,264,395],
'4':[24,27,99,115,270,292],'5':[43,59,145,166,179,339,360],'6':[38,63,170,178,220,249,318,346],
'7':[60,91,130,201,210,233,317,439],'8':[77,160,189],'9':[68,79,134,152,217,221],
'0':[15,22,52,94,119,140,151,155,161,237,255],'O':[56],'A':[54,66,71,81],'B':[34,86,191,277],
'C':[20,109,135,362,385],'D':[82,118],'E':[32,48,167,184,254],'F':[12,23,379],'G':[121,144,165],
'H':[103,280,290],'K':[36,76,141,460],'L':[70,90,440,444],'M':[35,154,190,331,355,413],'N':[39,69,372],
'P':[108],'R':[40,45,67,350],'S':[83,97,175,289],'T':[44,61,73,75,349],'U':[412],'V':[313,436],
'W':[250,279,281,389],'X':[55,174,188],'Y':[173],'/':[11,30,150,437],'+':[334],'<':[399],'m':[400,411]}
def rot_polys(polys,r):
    if r==0: return polys
    if r==1: return [[(y,-x) for x,y in pl] for pl in polys]     # 90 deg CCW (text reads bottom->top)
    return [[(-y,x) for x,y in pl] for pl in polys]               # 90 deg CW
def bm(polys,width=2):
    xs=[p[0] for pl in polys for p in pl]; ys=[p[1] for pl in polys for p in pl]
    x0,y0,x1,y1=min(xs),min(ys),max(xs),max(ys); w,h=x1-x0,y1-y0; s=(N-4)/max(w,h,1e-6)
    ox=(N-w*s)/2; oy=(N-h*s)/2
    im=Image.new('L',(N,N),0); dr=ImageDraw.Draw(im)
    for pl in polys:
        q=[((x-x0)*s+ox,(y-y0)*s+oy) for x,y in pl]
        if len(q)==1: q=q*2
        dr.line(q,fill=255,width=width)
    m=max(w,h,1e-3); return np.array(im)>0, math.log((w+.05*m)/(h+.05*m))
def dil(b):
    o=b.copy(); o[1:]|=b[:-1]; o[:-1]|=b[1:]; o[:,1:]|=b[:,:-1]; o[:,:-1]|=b[:,1:]; return o
class OCR:
    def __init__(self,dbfile,extra=None):
        allc,leaders=pickle.load(open(dbfile,'rb'))
        self.T=[]
        self.upright=[]   # (label, polys) upright templates, exported for the browser
        for lab,r,polys in (extra or []):
            up=rot_polys(polys,{0:0,1:2,2:1}[r])
            self.upright.append((lab,up))
            for rr in (0,1,2):
                b,la=bm(rot_polys(up,rr)); self.T.append((lab,rr,b,dil(b),la))
        for lab,idx in LABELS.items():
            for k in idx:
                c=allc[leaders[k]['members'][0]]
                self.upright.append((lab,c['polys']))
                for r in (0,1,2):
                    b,la=bm(rot_polys(c['polys'],r)); self.T.append((lab,r,b,dil(b),la))
    def classify(self,c):
        """-> dict rot -> (label, score)"""
        x0,y0,x1,y1=c['bbox']; w,h=x1-x0,y1-y0
        b,la=bm(c['polys']); bd=dil(b)
        best={}
        for lab,r,t,td,tla in self.T:
            if abs(la-tla)>0.45: continue
            # symmetric coverage score (tolerant to 1px shifts)
            s=0.5*((b&td).sum()/max(b.sum(),1)+(t&bd).sum()/max(t.sum(),1))
            if s>best.get(r,('',0))[1]: best[r]=(lab,s)
        return best
