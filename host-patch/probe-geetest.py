
import http.server, socketserver, threading, functools, json, os, sys, time
from playwright.sync_api import sync_playwright

ROOT = r"D:\Development\Agent2Plugin\AStudio\host-patch\probe"
os.makedirs(ROOT, exist_ok=True)

HTML = """<!doctype html><html><head><meta charset="utf-8"><title>geetest probe</title>
<style>body{background:#1e1f22;color:#ddd;font-family:system-ui;margin:0;padding:16px}
#w{width:320px;background:#2b2c30;border-radius:10px;padding:12px}</style></head>
<body><h3>geetest probe</h3><div id="w"></div><pre id="log" style="font-size:11px;color:#8ab"></pre>
<script src="https://static.geetest.com/static/tools/gt.js"></script>
<script>
window.__log = [];
function log(s){ window.__log.push(String(s)); document.getElementById('log').textContent = window.__log.join("\n"); }
(async () => {
  try {
    log("initGeetest typeof=" + typeof window.initGeetest);
    const r = await fetch("https://agent.xfyun.cn/xingchen-studio/chat/gee-captcha");
    const j = await r.json();
    log("captcha http=" + r.status + " flag=" + j.flag + " code=" + j.code);
    const d = j.data;
    log("gt=" + d.gt + " challenge=" + d.challenge + " success=" + d.success + " new_captcha=" + d.new_captcha);
    window.__captcha = d;
    if (typeof window.initGeetest !== "function") { log("NO initGeetest"); return; }
    window.__g = window.initGeetest({
      gt: d.gt, challenge: d.challenge, success: d.success, new_captcha: d.new_captcha,
      https: true, offline: !d.success, product: "embed", width: "100%"
    }, (cap) => {
      log("init callback, type=" + cap.getType());
      cap.onReady(() => { log("onReady"); cap.verify(); });
      cap.onError((e) => log("onError " + JSON.stringify(e)));
      cap.onClose(() => log("onClose"));
      cap.onSuccess(() => { const v = cap.getValidate(); log("onSuccess " + JSON.stringify(v)); window.__validate = v; });
      cap.onFail && cap.onFail(() => log("onFail"));
    });
  } catch (e) { log("ERR " + (e && e.message)); }
})();
</script></body></html>"""

with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
    f.write(HTML)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8899), handler)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

out = os.path.join(ROOT, "geetest-probe.png")
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 480, "height": 640})
    page = ctx.new_page()
    page.on("console", lambda m: print("CONSOLE", m.type, m.text[:200]))
    page.goto("http://127.0.0.1:8899/", wait_until="load")
    page.wait_for_timeout(8000)
    log = page.evaluate("window.__log")
    print("LOG:", json.dumps(log, ensure_ascii=False, indent=1))
    print("frames:", [f.url for f in page.frames])
    page.screenshot(path=out)
    print("shot", out)
    b.close()
srv.shutdown()
