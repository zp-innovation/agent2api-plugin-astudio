
import json, urllib.request, secrets, string, os
from playwright.sync_api import sync_playwright

PATCH = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\astudio-qr-modal.js"
OUT = r"D:\Development\Agent2Plugin\plugins\agent2api-plugin-astudio\host-patch\preview"
os.makedirs(OUT, exist_ok=True)

# 1) 拿一张真二维码（上游 SSO 取码接口，8 位会话号）
fd = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
req = urllib.request.Request(
    "https://sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd=" + fd,
    headers={"Accept": "application/json", "User-Agent": "AStudio/3.6.0"})
with urllib.request.urlopen(req, timeout=20) as r:
    body = json.loads(r.read().decode())
qr = body.get("data")
print("qr url:", qr[:70] if isinstance(qr, str) else qr)

HTML = """<!doctype html><html><body style="margin:0;background:#0f1115;color:#8b8f98;
font:14px system-ui;padding:24px">添加账号 · 微信扫码登录（模拟面板背景）</body></html>"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 820, "height": 680})
    page.set_content(HTML)
    page.add_script_tag(path=PATCH)
    page.evaluate("""() => {
      window.__canceled = 0;
      window.__hint = '等待微信扫码…';
      window.workbuddyDesktop = {
        getLoginState: () => Promise.resolve({ active: true, hint: window.__hint, provider: 'astudio' }),
        cancelLogin: () => { window.__canceled += 1; return Promise.resolve({ canceled: true }); },
      };
    }""")

    # 2) 复刻 shim 的动态登录：开空窗口 → 断开 opener → 把 authUrl 塞进 location
    page.evaluate("""(url) => {
      const second = window.open('about:blank', '_blank');
      second.opener = null;
      second.location.replace(url);
    }""", qr)
    page.wait_for_timeout(2500)

    info = page.evaluate("""() => {
      const ov = document.getElementById('a2a-qr-overlay');
      const img = ov && ov.querySelector('img');
      return {
        overlay: !!ov,
        imgSrc: img ? img.src.slice(0, 60) : null,
        imgComplete: img ? img.complete : null,
        naturalWidth: img ? img.naturalWidth : null,
        text: ov ? ov.innerText : null,
        pages: 'ok',
      };
    }""")
    print("after open:", json.dumps(info, ensure_ascii=False))
    print("context pages:", len(page.context.pages))
    page.screenshot(path=os.path.join(OUT, "qr-modal.png"))

    # 3) hint 跟随 login:state 实时更新
    page.evaluate("() => { window.__hint = '微信已扫码，正在换取模型凭据…'; }")
    page.wait_for_timeout(1200)
    print("hint now:", page.evaluate("() => document.querySelector('#a2a-qr-overlay').innerText"))
    page.screenshot(path=os.path.join(OUT, "qr-modal-scanned.png"))

    # 4) 取消：调 cancelLogin 并关掉弹窗
    page.click("#a2a-qr-overlay button")
    page.wait_for_timeout(300)
    print("canceled:", page.evaluate("() => window.__canceled"),
          "overlay gone:", page.evaluate("() => !document.getElementById('a2a-qr-overlay')"))

    # 5) 非图片 URL 仍然开新标签页
    before = len(page.context.pages)
    page.evaluate("""() => {
      const second = window.open('about:blank', '_blank');
      second.location.replace('https://example.com/authorize?x=1');
    }""")
    page.wait_for_timeout(800)
    print("pages before/after non-image:", before, len(page.context.pages),
          "overlay:", page.evaluate("() => !!document.getElementById('a2a-qr-overlay')"))

    browser.close()
print("done")
