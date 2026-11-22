
import http.server, socketserver, threading, functools, json, random, os
from playwright.sync_api import sync_playwright

ROOT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

GAP = """(() => {
  const bg = document.querySelector('.geetest_canvas_bg'), fb = document.querySelector('.geetest_canvas_fullbg'), sl = document.querySelector('.geetest_canvas_slice');
  const w = bg.width, h = bg.height;
  const A = bg.getContext('2d').getImageData(0,0,w,h).data, B = fb.getContext('2d').getImageData(0,0,w,h).data, S = sl.getContext('2d').getImageData(0,0,w,h).data;
  let px0=w, py0=h, px1=0, py1=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*4; if (S[i+3]>40){ if(x<px0)px0=x; if(x>px1)px1=x; if(y<py0)py0=y; if(y>py1)py1=y; } }
  // 只在拼图块自己的形状内比较 bg 与 fullbg：洞的位置差异最大
  const pts = [];
  for (let y=py0;y<=py1;y+=2) for (let x=px0;x<=px1;x+=2){ const i=(y*w+x)*4; if (S[i+3]>40) pts.push([x-px0, y]); }
  const pw = px1-px0+1;
  let best=-1, bo=0;
  for (let o=0; o<=w-pw; o++){
    let s=0;
    for (let k=0;k<pts.length;k++){ const X=o+pts[k][0], Y=pts[k][1]; const i=(Y*w+X)*4;
      s += Math.abs(A[i]-B[i]) + Math.abs(A[i+1]-B[i+1]) + Math.abs(A[i+2]-B[i+2]); }
    if (s>best){ best=s; bo=o; }
  }
  // 列累加作为参照
  let cbest=-1, cx=0;
  for (let x=0;x<w;x++){ let s=0; for (let y=py0;y<=py1;y++){ const i=(y*w+x)*4; s+=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]); } if(s>cbest){cbest=s;cx=x;} }
  return {pieceX:px0, holeX:bo+px0, maskOffset:bo, colOffset:cx-px0, score:best, maskPixels:pts.length};
})()"""

MOBILE = "18122032590"
OUT = ROOT + "/preview/"

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 560, "height": 780})
    page.on("console", lambda m: print("CONSOLE", m.type, m.text[:300]))
    page.on("pageerror", lambda e: print("PAGEERROR", str(e)[:300]))
    if os.environ.get("GEE_REFERER_HEADER") == "1":
        def add_ref(route):
            route.continue_(headers={**route.request.headers, "referer": "https://agent.xfyun.cn/studio-portal/overview"})
        page.route("**/api.geevisit.com/**", add_ref)
        print("referer header injection: ON")
    page.goto("http://127.0.0.1:8899/probe/sms.html", wait_until="load", timeout=30000)
    page.evaluate("""() => { window.__p = window.fetch('/api/session/login/start', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ provider: 'astudio', methodIndex: 1, mode: 'external', inputs: { mobile: '18122032590' } })
      }).then(r => r.json()).then(j => { window.__resp = j; return j; }); }""")
    page.wait_for_selector("#a2a-sms-overlay", timeout=15000)
    page.wait_for_timeout(400)
    page.screenshot(path=OUT + "sms-1-phone.png")
    print("phone prefilled:", page.input_value("#a2a-sms-phone"))

    page.click("#a2a-sms-main")
    page.wait_for_selector(".geetest_slider_button", timeout=40000)
    page.wait_for_timeout(1200)
    page.screenshot(path=OUT + "sms-2-slider.png")
    info = page.evaluate(GAP); off = info["holeX"] - info["pieceX"]
    print("gap:", json.dumps(info), "offset:", off)

    box = page.query_selector(".geetest_slider_button").bounding_box()
    print("button box:", json.dumps(box))
    print("top element at button:", page.evaluate("""(b) => {
        const n = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2);
        return n ? (n.tagName + '.' + (n.className || '') + ' | parent=' + (n.parentElement && n.parentElement.className)) : 'none';
    }""", box))
    print("panel parent chain:", page.evaluate("""() => {
        let n = document.querySelector('.geetest_panel'); const out = [];
        while (n && out.length < 6) { out.push(n.tagName + '.' + (n.className||'') + ' z=' + getComputedStyle(n).zIndex + ' pos=' + getComputedStyle(n).position); n = n.parentElement; }
        return out;
    }"""))
    # 缺口算法偶尔算偏（拼图块贴边时得分并列），偏了就再来一次：极验失败后按钮会回位。
    solved = False
    for attempt in range(1, 4):
        info = page.evaluate(GAP); off = info["maskOffset"]
        box = page.query_selector(".geetest_slider_button").bounding_box()
        print("attempt", attempt, "gap:", json.dumps(info), "offset:", off, "button:", json.dumps(box))
        sx, sy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
        page.mouse.move(sx, sy); page.wait_for_timeout(180); page.mouse.down(); page.wait_for_timeout(200)
        for i in range(1, 31):
            t = i/30
            page.mouse.move(sx + off*(1-(1-t)**2.0) + random.uniform(-0.4,0.4), sy + random.uniform(-0.8,0.8))
            page.wait_for_timeout(random.randint(8,24))
        page.wait_for_timeout(300); page.mouse.up()
        try:
            page.wait_for_selector("#a2a-sms-code", state="visible", timeout=6000)
            solved = True
            break
        except Exception:
            page.wait_for_timeout(1500)
    page.screenshot(path=OUT + "sms-2b-after-drag.png")
    print("hint after drag:", page.inner_text("#a2a-sms-hint"))
    print("geetest nodes left:", page.evaluate("document.querySelectorAll('.geetest_panel').length"))
    if not solved:
        raise SystemExit("滑块三次都没通过")

    page.wait_for_timeout(300)
    page.wait_for_timeout(300)
    page.screenshot(path=OUT + "sms-3-code.png")

    calls = page.evaluate("window.__startCalls")
    print("start calls:", len(calls))
    second = json.loads(calls[-1]["body"])
    print("captcha forwarded:", bool(second["inputs"].get("captcha")))
    print("mobile forwarded:", second["inputs"].get("mobile"))
    tokens = json.loads(second["inputs"]["captcha"])
    print("tokens:", json.dumps(tokens, ensure_ascii=False))

    page.fill("#a2a-sms-code", "123456")
    page.click("#a2a-sms-main")
    page.wait_for_function("window.__submitted !== null", timeout=15000)
    print("submitted:", json.dumps(page.evaluate("window.__submitted")))

    resp = page.evaluate("window.__resp")
    print("start response manualCallback:", resp["data"]["manualCallback"], "state:", resp["data"]["state"])

    page.evaluate("window.__active = false")
    page.wait_for_timeout(1600)
    print("overlay removed:", page.evaluate("!document.querySelector('#a2a-sms-overlay')"))
    page.screenshot(path=OUT + "sms-4-closed.png")
    b.close()
srv.shutdown()
