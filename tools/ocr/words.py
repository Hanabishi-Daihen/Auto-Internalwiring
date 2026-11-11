import math
def char_items(res, minscore=0.8):
    items=[]
    for c,best in res:
        x0,y0,x1,y1=c['bbox']; w,h=x1-x0,y1-y0
        it=dict(c=c,bbox=c['bbox'],w=w,h=h,best=best)
        if max(w,h)<1.2 and min(w,h)>0.5: it['kind']='junction'          # wire junction dot outline
        elif best and max(v[1] for v in best.values())>=minscore and max(w,h)>=1.2: it['kind']='char'
        elif max(w,h)<0.45: it['kind']='dot'
        elif h<0.12*w and w<6.5: it['kind']='hline'
        elif w<0.12*h and h<6.5: it['kind']='vline'
        else: it['kind']='other'
        items.append(it)
    return items
def assemble(items):
    chars=[i for i in items if i['kind']=='char']
    # per rotation char height
    def H(it,r): return it['h'] if r==0 else it['w']
    n=len(chars); par=list(range(n))
    def f(x):
        while par[x]!=x: par[x]=par[par[x]]; x=par[x]
        return x
    link={}
    for i,a in enumerate(chars):
        for j,b in enumerate(chars):
            if i==j: continue
            for r in (0,1,2):
                if r not in a['best'] or r not in b['best']: continue
                ma=max(v[1] for v in a['best'].values()); mb=max(v[1] for v in b['best'].values())
                if a['best'][r][1]<max(0.8,ma-0.06) or b['best'][r][1]<max(0.8,mb-0.06): continue
                ha,hb=H(a,r),H(b,r)
                if abs(ha-hb)>0.35*max(ha,hb): continue
                Hm=max(ha,hb); A,B=a['bbox'],b['bbox']
                if r==0: ok=abs(A[3]-B[3])<0.25*Hm and -0.05*Hm<=B[0]-A[2]<0.62*Hm
                elif r==1: ok=abs(A[2]-B[2])<0.25*Hm and -0.05*Hm<=A[1]-B[3]<0.62*Hm      # B above A, baseline right
                else: ok=abs(A[0]-B[0])<0.25*Hm and -0.05*Hm<=B[1]-A[3]<0.62*Hm          # B below A, baseline left
                if ok: link.setdefault((i,j),[]).append(r)
    for (i,j),rs in link.items(): par[f(i)]=f(j)
    groups={}
    for i in range(n): groups.setdefault(f(i),[]).append(i)
    words=[]
    for g in groups.values():
        # choose rotation by total score (single chars: prefer upright)
        tot={}
        for i in g:
            for r,(lab,s) in chars[i]['best'].items(): tot[r]=tot.get(r,0)+s+(0.02 if r==0 else 0.01 if r==1 else 0)
        if len(g)>1:
            pair_r=[r for (i,j),rs in link.items() if i in g for r in rs]
            for r in pair_r: tot[r]=tot.get(r,0)+0.5
        r=max(tot,key=tot.get)
        key=(lambda i: chars[i]['bbox'][0]) if r==0 else (lambda i: -chars[i]['bbox'][3]) if r==1 else (lambda i: chars[i]['bbox'][1])
        g.sort(key=key)
        txt=''.join(chars[i]['best'].get(r,('?',0))[0] for i in g)
        xs=[chars[i]['bbox'] for i in g]
        bb=(min(b[0] for b in xs),min(b[1] for b in xs),max(b[2] for b in xs),max(b[3] for b in xs))
        words.append(dict(text=txt,rot=r,bbox=bb,members=g,H=sum(H(chars[i],r) for i in g)/len(g)))
    # attach dashes / dots / '-' prefixes
    for it in items:
        if it['kind'] not in ('hline','vline','dot'): continue
        X0,Y0,X1,Y1=it['bbox']
        for w in words:
            b=w['bbox']; Hm=w['H']; r=w['rot']
            if it['kind']=='hline' and r==0 and abs((Y0+Y1)/2-(b[1]+b[3])/2)<0.25*Hm and 0<=b[0]-X1<0.8*Hm and 0.25*Hm<it['w']<1.0*Hm:
                w['text']='-'+w['text']; w['bbox']=(X0,b[1],b[2],b[3]); break
            if it['kind']=='vline' and r==1 and abs((X0+X1)/2-(b[0]+b[2])/2)<0.25*Hm and 0<=Y0-b[3]<0.8*Hm and 0.25*Hm<it['h']<1.0*Hm:
                w['text']='-'+w['text']; w['bbox']=(b[0],b[1],b[2],Y1); break
            if it['kind']=='dot':
                cx,cy=(X0+X1)/2,(Y0+Y1)/2
                if r==0 and abs(cy-b[3])<0.25*Hm and b[0]<cx<b[2]: w.setdefault('dots',[]).append(cx); break
                if r==1 and abs(cx-b[2])<0.25*Hm and b[1]<cy<b[3]: w.setdefault('dots',[]).append(-cy); break
                if r==2 and abs(cx-b[0])<0.25*Hm and b[1]<cy<b[3]: w.setdefault('dots',[]).append(cy); break
    for w in words:
        w['text']=fix_o0(w['text'])
    for w in words:
        if not w.get('dots'): continue
        # positions of chars along reading axis
        pos=[]
        for i in w['members']:
            bb=chars[i]['bbox']
            pos.append((bb[0]+bb[2])/2 if w['rot']==0 else -(bb[1]+bb[3])/2 if w['rot']==1 else (bb[1]+bb[3])/2)
        txt=list(w['text'][-len(pos):]); pre=w['text'][:len(w['text'])-len(pos)]
        out=pre
        for k,ch in enumerate(txt):
            out+=ch
            if k+1<len(pos) and any(pos[k]<d<pos[k+1] for d in w['dots']): out+='.'
        w['text']=out
    return words

def fix_o0(t):
    """O/0 look alike in the CAD font: decide from the neighbours"""
    c=list(t)
    for k,ch in enumerate(c):
        if ch not in 'O0': continue
        L=c[k-1] if k>0 else ''; R=c[k+1] if k+1<len(c) else ''
        dig=sum(x.isdigit() for x in (L,R)); let=sum(x.isalpha() and x not in 'O' for x in (L,R))
        if dig>=1 and let==0: c[k]='0'
        elif let==2: c[k]='O'
    return ''.join(c)
