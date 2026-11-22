
import http.server, socketserver, threading, functools, json, os, base64
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\probe"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
DUMP = """(() => {
  const out = {};
  for (const cls of ['geetest_canvas_bg','geetest_canvas_slice','geetest_canvas_fullbg']) {
    const c = document.querySelector('.'+cls);
    out[cls] = c ? c.toDataURL('image/png') : null;
  }
  return out;
})()"""
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 520, "height": 760})
    page.goto("http://127.0.0.1:8899/", wait_until="load", timeout=30000)
    page.wait_for_timeout(7000)
    d = page.evaluate(DUMP)
    for k, v in d.items():
        if not v: print(k, "null"); continue
        raw = base64.b64decode(v.split(",")[1])
        fn = os.path.join(ROOT, k + ".png")
        open(fn, "wb").write(raw)
        print(k, len(raw), fn)
    b.close()
srv.shutdown()
