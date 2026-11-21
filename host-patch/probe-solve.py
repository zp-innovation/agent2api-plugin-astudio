
import http.server, socketserver, threading, functools, json, os, random, base64
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\AStudio\host-patch\probe"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

GAP = """(() => {
  const bg = document.querySelector('.geetest_canvas_bg'), fb = document.querySelector('.geetest_canvas_fullbg'), sl = document.querySelector('.geetest_canvas_slice');
  const w = bg.width, h = bg.height;
  const A = bg.getContext('2d').getImageData(0,0,w,h).data;
  const B = fb.getContext('2d').getImageData(0,0,w,h).data;
  // piece bbox from slice alpha
  const S = sl.getContext('2d').getImageData(0,0,w,h).data;
  let px0=w, py0=h, px1=0, py1=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*4; if (S[i+3]>40){ if(x<px0)px0=x; if(x>px1)px1=x; if(y<py0)py0=y; if(y>py1)py1=y; } }
  // diff columns restricted to piece rows
  let best=-1,bx=0;
  for (let x=0;x<w;x++){
    let s=0;
    for (let y=py0;y<=py1;y++){ const i=(y*w+x)*4; s += Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]); }
    if (s>best){best=s;bx=x;}
  }
  return {w,h,piece:[px0,py0,px1,py1],holeX:bx,score:best};
})()"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 520, "height": 760})
    page.goto("http://127.0.0.1:8899/", wait_until="load", timeout=30000)
    page.wait_for_timeout(6500)
    info = page.evaluate(GAP)
    print("gap info", info)
    offset = info["holeX"] - info["piece"][0]
    print("offset", offset)
    box = page.query_selector(".geetest_slider_button").bounding_box()
    sx, sy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
    page.mouse.move(sx, sy); page.wait_for_timeout(180); page.mouse.down(); page.wait_for_timeout(200)
    target = sx + offset
    for i in range(1, 31):
        t = i/30
        page.mouse.move(sx + (target-sx)*(1-(1-t)**2.0) + random.uniform(-0.4,0.4), sy + random.uniform(-0.8,0.8))
        page.wait_for_timeout(random.randint(8, 24))
    page.wait_for_timeout(300)
    page.mouse.up(); page.wait_for_timeout(4500)
    print("log:", page.evaluate("window.__log.join(' / ')"))
    v = page.evaluate("JSON.stringify(window.__validate||null)")
    print("validate:", v)
    page.screenshot(path=os.path.join(ROOT, "geetest-solved.png"))
    b.close()
srv.shutdown()
