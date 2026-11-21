
import http.server, socketserver, threading, functools, json, os
from playwright.sync_api import sync_playwright
ROOT = r"D:\Development\Agent2Plugin\AStudio\host-patch\probe"
HTML = """<!doctype html><html><head><meta charset="utf-8"><title>geetest probe</title>
<style>body{background:#1e1f22;color:#ddd;font-family:system-ui;margin:0;padding:16px}</style></head>
<body><h3>geetest probe</h3><div id="w" style="width:320px"></div>
<pre id="log" style="font-size:11px;color:#8ab;white-space:pre-wrap"></pre>
<script src="https://static.geetest.com/static/tools/gt.js"></script>
<script>
window.__log = [];
function log(s){ window.__log.push(String(s)); document.getElementById('log').textContent = window.__log.join(' / '); }
(async () => {
  try {
    const r = await fetch("https://agent.xfyun.cn/xingchen-studio/chat/gee-captcha");
    const j = await r.json(); const d = j.data; window.__captcha = d;
    log("gt=" + d.gt + " ch=" + d.challenge);
    window.__g = window.initGeetest({
      gt: d.gt, challenge: d.challenge, success: d.success, new_captcha: d.new_captcha,
      https: true, offline: !d.success, product: "bind", width: "100%"
    }, (cap) => {
      window.__cap = cap; log("keys=" + Object.keys(cap).join(","));
      cap.onReady(() => { log("onReady"); cap.verify(); });
      cap.onSuccess(() => { log("SUCCESS " + JSON.stringify(cap.getValidate())); window.__validate = cap.getValidate(); });
      cap.onError((e) => log("onError " + JSON.stringify(e)));
    });
  } catch (e) { log("ERR " + (e && e.message)); }
})();
</script></body></html>"""
with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f: f.write(HTML)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 520, "height": 760})
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("PAGEERROR", str(e)[:300]))
    page.goto("http://127.0.0.1:8899/", wait_until="load", timeout=30000)
    page.wait_for_timeout(9000)
    print("log:", page.evaluate("window.__log.join(' / ')"))
    print("frames:", [f.url[:110] for f in page.frames])
    print("iframes:", page.evaluate("Array.from(document.querySelectorAll('iframe')).map(f=>f.src.slice(0,90))"))
    print("geetest nodes:", page.evaluate("document.querySelectorAll('[class*=geetest]').length"))
    print("bodytail:", page.evaluate("document.body.innerHTML.slice(-600)"))
    page.screenshot(path=os.path.join(ROOT, "geetest-probe.png"))
    print("shot ok")
    b.close()
srv.shutdown()
