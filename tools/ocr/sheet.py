import pickle, fitz, sys
from PIL import Image, ImageDraw
allc,leaders=pickle.load(open(sys.argv[1],'rb'))
d=fitz.open(sys.argv[2]); start=int(sys.argv[3]); cnt=int(sys.argv[4]); out=sys.argv[5]
TW,TH=130,120; COLS=10
def tile(k,L):
    c=allc[L['members'][0]]; x0,y0,x1,y1=c['bbox']
    im=Image.new('RGB',(TW,TH),'white'); dr=ImageDraw.Draw(im)
    s=50/max(x1-x0,y1-y0,0.5)
    for pl in c['polys']:
        q=[((x-x0)*s+8,(y-y0)*s+8) for x,y in pl]
        if len(q)==1: q=q*2
        dr.line(q,fill='black',width=3)
    pg=d[c['page']-1]; pad=4
    clip=fitz.Rect(x0-pad,y0-pad/2,x1+pad,y1+pad/2)
    pix=pg.get_pixmap(clip=clip,matrix=fitz.Matrix(6,6)); cim=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
    cim.thumbnail((60,50)); im.paste(cim,(TW-62,TH-52))
    dr.text((2,TH-12),f'#{k} n{len(L["members"])}',fill='red')
    return im
sub=leaders[start:start+cnt]; rows=(len(sub)+COLS-1)//COLS
S=Image.new('RGB',(TW*COLS,TH*rows),'white')
for i,L in enumerate(sub):
    S.paste(tile(start+i,L),((i%COLS)*TW,(i//COLS)*TH))
    ImageDraw.Draw(S).rectangle([(i%COLS)*TW,(i//COLS)*TH,(i%COLS)*TW+TW-1,(i//COLS)*TH+TH-1],outline='#ccc')
S.save(out)
