
import http.server, socketserver, threading, functools, os, random
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\probe"
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), h); srv.daemon_threads=True
threading.Thread(target=srv.serve_forever, daemon=True).start()
GAP = """(() => {
  const bg=document.querySelector('.geetest_canvas_bg'), fb=document.querySelector('.geetest_canvas_fullbg'), sl=document.querySelector('.geetest_canvas_slice');
  const w=bg.width,h=bg.height;
  const A=bg.getContext('2d').getImageData(0,0,w,h).data,B=fb.getContext('2d').getImageData(0,0,w,h).data,S=sl.getContext('2d').getImageData(0,0,w,h).data;
  let px0=w,py0=h,px1=0,py1=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4; if(S[i+3]>40){if(x<px0)px0=x;if(x>px1)px1=x;if(y<py0)py0=y;if(y>py1)py1=y;}}
  let best=-1,bx=0;
  for(let x=0;x<w;x++){let s=0;for(let y=py0;y<=py1;y++){const i=(y*w+x)*4;s+=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]);}if(s>best){best=s;bx=x;}}
  return {pieceX:px0,holeX:bx};})()"""
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":560,"height":760})
    pg.goto("http://127.0.0.1:8899/card.html", wait_until="load")
    pg.wait_for_timeout(7000)
    pg.screenshot(path=os.path.join(ROOT,"card2-ready.png"))
    info = pg.evaluate(GAP); off = info["holeX"]-info["pieceX"]
    box = pg.query_selector(".geetest_slider_button").bounding_box()
    sx,sy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
    pg.mouse.move(sx,sy); pg.wait_for_timeout(150); pg.mouse.down(); pg.wait_for_timeout(180)
    for i in range(1,31):
        t=i/30
        pg.mouse.move(sx+off*(1-(1-t)**2.0)+random.uniform(-0.4,0.4), sy+random.uniform(-0.8,0.8))
        pg.wait_for_timeout(random.randint(8,24))
    pg.wait_for_timeout(280); pg.mouse.up(); pg.wait_for_timeout(4000)
    print("log:", " | ".join(pg.evaluate("window.__log")))
    print("validate:", pg.evaluate("window.__validate||null"))
    b.close()
srv.shutdown()
