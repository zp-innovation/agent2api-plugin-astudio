
import http.server, socketserver, threading, functools, json, os, random, base64, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\probe"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

GAP = """(() => {
  const bg = document.querySelector('.geetest_canvas_bg'), fb = document.querySelector('.geetest_canvas_fullbg'), sl = document.querySelector('.geetest_canvas_slice');
  const w = bg.width, h = bg.height;
  const A = bg.getContext('2d').getImageData(0,0,w,h).data, B = fb.getContext('2d').getImageData(0,0,w,h).data, S = sl.getContext('2d').getImageData(0,0,w,h).data;
  let px0=w, py0=h, px1=0, py1=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*4; if (S[i+3]>40){ if(x<px0)px0=x; if(x>px1)px1=x; if(y<py0)py0=y; if(y>py1)py1=y; } }
  let best=-1,bx=0;
  for (let x=0;x<w;x++){ let s=0; for (let y=py0;y<=py1;y++){ const i=(y*w+x)*4; s+=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]); } if(s>best){best=s;bx=x;} }
  return {pieceX:px0, holeX:bx, score:best};
})()"""

MOBILE = "18122032590"

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 520, "height": 760})
    page.goto("http://127.0.0.1:8899/", wait_until="load", timeout=30000)
    page.wait_for_timeout(6500)
    info = page.evaluate(GAP); off = info["holeX"] - info["pieceX"]
    box = page.query_selector(".geetest_slider_button").bounding_box()
    sx, sy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
    page.mouse.move(sx, sy); page.wait_for_timeout(180); page.mouse.down(); page.wait_for_timeout(200)
    for i in range(1, 31):
        t=i/30
        page.mouse.move(sx + off*(1-(1-t)**2.0) + random.uniform(-0.4,0.4), sy + random.uniform(-0.8,0.8))
        page.wait_for_timeout(random.randint(8,24))
    page.wait_for_timeout(300); page.mouse.up(); page.wait_for_timeout(4500)
    v = page.evaluate("window.__validate||null")
    print("validate:", json.dumps(v, ensure_ascii=False))
    b.close()
srv.shutdown()

if not v:
    raise SystemExit("no validate")

# mimic the desktop client: multipart, seccode base64-encoded
boundary = "----astudio" + str(random.randint(100000,999999))
def part(name, value):
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()
body = b""
body += part("geetest_challenge", v["geetest_challenge"])
body += part("geetest_validate", v["geetest_validate"])
body += part("geetest_seccode", base64.b64encode(v["geetest_seccode"].encode()).decode())
body += part("mobile", MOBILE)
body += part("countryCode", "86")
body += f"--{boundary}--\r\n".encode()
req = urllib.request.Request("https://agent.xfyun.cn/xingchen-studio/login/mobile/send-verify-code", data=body, method="POST")
req.add_header("content-type", f"multipart/form-data; boundary={boundary}")
req.add_header("clientType", "21"); req.add_header("studioVersion", "3.6.0")
req.add_header("user-agent", "AStudio/3.6.0"); req.add_header("accept", "application/json, text/plain, */*")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("SEND", r.status, r.read().decode()[:400])
except urllib.error.HTTPError as e:
    print("SEND ERR", e.code, e.read().decode()[:400])
