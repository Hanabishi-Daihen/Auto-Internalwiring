import fitz, math
def bez(p0,p1,p2,p3,n=6):
    out=[]
    for i in range(n+1):
        t=i/n; a=(1-t)**3; b=3*(1-t)**2*t; c=3*(1-t)*t*t; d=t**3
        out.append((a*p0.x+b*p1.x+c*p2.x+d*p3.x, a*p0.y+b*p1.y+c*p2.y+d*p3.y))
    return out
def page_paths(page):
    """-> list of dict(polys=[[(x,y)...]], bbox, fill) per drawing path"""
    out=[]
    for g in page.get_drawings():
        polys=[]; cur=[]
        for it in g['items']:
            if it[0]=='l':
                a,b=it[1],it[2]
                if cur and abs(cur[-1][0]-a.x)<1e-3 and abs(cur[-1][1]-a.y)<1e-3: cur.append((b.x,b.y))
                else:
                    if cur: polys.append(cur)
                    cur=[(a.x,a.y),(b.x,b.y)]
            elif it[0]=='c':
                pts=bez(*it[1:5])
                if cur and abs(cur[-1][0]-pts[0][0])<1e-3 and abs(cur[-1][1]-pts[0][1])<1e-3: cur+=pts[1:]
                else:
                    if cur: polys.append(cur)
                    cur=pts
            elif it[0]=='re':
                r=it[1]; 
                if cur: polys.append(cur); cur=[]
                polys.append([(r.x0,r.y0),(r.x1,r.y0),(r.x1,r.y1),(r.x0,r.y1),(r.x0,r.y0)])
            elif it[0]=='qu':
                q=it[1]
                if cur: polys.append(cur); cur=[]
                polys.append([(q.ul.x,q.ul.y),(q.ur.x,q.ur.y),(q.lr.x,q.lr.y),(q.ll.x,q.ll.y),(q.ul.x,q.ul.y)])
        if cur: polys.append(cur)
        r=g['rect']
        out.append(dict(polys=polys,bbox=(r.x0,r.y0,r.x1,r.y1),fill='f' in g['type'],stroke='s' in g['type']))
    return out
