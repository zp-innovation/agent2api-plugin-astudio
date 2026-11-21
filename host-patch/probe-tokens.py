import http.server, socketserver, threading, functools, json, random, sys
from playwright.sync_api import sync_playwright

ROOT = r"D:\Development\Agent2Plugin\AStudio\host-patch\probe"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

GAP = """(() => {
  const bg = document.querySelector('.geetest_canvas_bg'), fb = document.querySelector('.geetest_canvas_fullbg'), sl = document.querySelector('.geetest_canvas_slice');
  if (!bg || !fb || !sl) return null;
  const w = bg.width, h = bg.height;
  const A = bg.getContext('2d').getImageData(0,0,w,h).data, B = fb.getContext('2d').getImageData(0,0,w,h).data, S = sl.getContext('2d').getImageData(0,0,w,h).data;
  let px0=w, py0=h, px1=0, py1=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*4; if (S[i+3]>40){ if(x<px0)px0=x; if(x>px1)px1=x; if(y<py0)py0=y; if(y>py1)py1=y; } }
  const pts = [];
  for (let y=py0;y<=py1;y+=2) for (let x=px0;x<=px1;x+=2){ const i=(y*w+x)*4; if (S[i+3]>40) pts.push([x-px0, y]); }
  const pw = px1-px0+1;
  let best=-1, bo=0;
  for (let o=0; o<=w-pw; o++){ let s=0; for (let k=0;k<pts.length;k++){ const X=o+pts[k][0], Y=pts[k][1]; const i=(Y*w+X)*4; s += Math.abs(A[i]-B[i]) + Math.abs(A[i+1]-B[i+1]) + Math.abs(A[i+2]-B[i+2]); } if (s>best){ best=s; bo=o; } }
  return { pieceX:px0, offset:bo, score:best };
})()"""

tokens = None
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 520, "height": 760})
    page.goto("http://127.0.0.1:8899/index.html", wait_until="load", timeout=30000)
    for attempt in range(1, 5):
        try:
            page.wait_for_selector(".geetest_slider_button", timeout=25000)
        except Exception as e:
            print("no slider:", e, file=sys.stderr); break
        page.wait_for_timeout(900)
        info = page.evaluate(GAP)
        if not info:
            print("no canvas", file=sys.stderr); break
        off = info["offset"]
        box = page.query_selector(".geetest_slider_button").bounding_box()
        sx, sy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
        page.mouse.move(sx, sy); page.wait_for_timeout(180); page.mouse.down(); page.wait_for_timeout(200)
        for i in range(1, 31):
            t = i/30
            page.mouse.move(sx + off*(1-(1-t)**2.0) + random.uniform(-0.4,0.4), sy + random.uniform(-0.8,0.8))
            page.wait_for_timeout(random.randint(8,24))
        page.wait_for_timeout(300); page.mouse.up()
        for _ in range(16):
            page.wait_for_timeout(400)
            v = page.evaluate("window.__validate || null")
            if v: tokens = v; break
            if page.evaluate("Boolean(window.__log && window.__log.some(s=>s.startsWith('onError')))"): break
        print("attempt", attempt, "gap", json.dumps(info), "off", off, "tokens", bool(tokens), file=sys.stderr)
        if tokens: break
        err = page.evaluate("window.__log.join(' / ')")
        print("  log:", err[:200], file=sys.stderr)
        if "forbidden" in err: 
            print("geetest rate limited", file=sys.stderr); break
        page.reload(wait_until="load")
        page.wait_for_timeout(1500)
    b.close()

if tokens:
    print("TOKENS " + json.dumps(tokens, ensure_ascii=False))
else:
    print("TOKENS null")
