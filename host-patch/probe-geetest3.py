
import http.server, socketserver, threading, functools, json, os
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\probe"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 520, "height": 760})
    page.goto("http://127.0.0.1:8899/", wait_until="load", timeout=30000)
    page.wait_for_timeout(6000)
    print(page.evaluate("""(() => {
      const c = document.querySelector('.geetest_canvas_bg');
      try { const d = c.getContext('2d').getImageData(0,0,2,2); return 'clean:' + d.data.length; }
      catch (e) { return 'tainted:' + e.name; }
    })()"""))
    b.close()
srv.shutdown()
