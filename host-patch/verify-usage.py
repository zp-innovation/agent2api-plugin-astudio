"""验证 astudio-usage-compact.js：借面板自己的 CSS，把一段仿真的账号行装进真页面。

跑法（能访问到网关面板的机器上）：

    python verify-usage.py                          # 默认 http://192.168.10.10:3065
    python verify-usage.py http://127.0.0.1:3065

不登录面板：以面板自己的 /login 页当宿主文档（真 origin 才能同源取静态资源 —— 用
page.route 伪造出来的文档会被 Chromium 判成 public address space，去拿 192.168.x 的
私有资源会被 Private Network Access 拦掉），清空 body 后塞进仿真表格，再同源加载
/islands/ui.css、/css/page-accounts-table.css 与 /astudio-usage-compact.js（三者都不需要鉴权）。

断言：只装饰 data-provider="astudio" 的行、原生卡片被隐藏、读数与浮层内容正确、
点外面 / Esc 能关、整格替换后能自动重新装饰。截图写到 preview/。
"""

import asyncio
import pathlib
import sys

from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://192.168.10.10:3065").rstrip("/")
HERE = pathlib.Path(__file__).resolve().parent
SHOTS = HERE / "preview"

ACCOUNTS = [
    {"id": "a1", "provider": "astudio", "name": "18122032590", "plan": "体验版", "status": "额度充足",
     "tone": "ok", "updated": "15 秒前更新",
     "items": [{"label": "通用积分", "view": "剩 1500 积分"},
               {"label": "星火积分", "view": "剩 0 积分", "tone": "muted"}]},
    {"id": "a2", "provider": "astudio", "name": "18933924845", "plan": "体验版", "status": "额度充足",
     "tone": "ok", "updated": "15 秒前更新",
     "items": [{"label": "通用积分", "view": "剩 1500 积分"},
               {"label": "星火积分", "view": "剩 0 积分", "tone": "muted"}]},
    {"id": "a3", "provider": "astudio", "name": "18928906066", "plan": "体验版", "status": "额度充足",
     "tone": "ok", "updated": "刚刚更新",
     "items": [{"label": "通用积分", "view": "剩 1598 积分"},
               {"label": "星火积分", "view": "剩 0 积分", "tone": "muted"}]},
    {"id": "a4", "provider": "astudio", "name": "18998405512", "plan": "体验版", "status": "额度充足",
     "tone": "ok", "updated": "15 秒前更新",
     "items": [{"label": "通用积分", "view": "剩 1400 积分"},
               {"label": "星火积分", "view": "剩 0 积分", "tone": "muted"}]},
    {"id": "w1", "provider": "workbuddy", "name": "work_2049", "plan": "Free", "status": "额度充足",
     "tone": "ok", "updated": "15 秒前更新",
     "items": [{"label": "可用积分", "view": "剩 1922 积分"}]},
]

# 复刻面板 ui.js 里 hOe/mOe/BTe 产出的余额格标记（class 与层级一字不差）
BUILD_ROWS = """
(accounts) => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hostToggle = '<button type="button" class="usage-toggle ok" aria-expanded="false">' +
    '<span class="val">可用 19900 积分</span>' +
    '<span class="caret" aria-hidden="true">▾</span></button>';
  const cell = (a) =>
    '<span class="usage-sum-wrap flex flex-col gap-1">' +
      '<span class="usage-cell usage-window-cell"><span class="usage-window-quota">' +
        '<span class="usage-window-top">' +
          '<span class="usage-window-plan" title="' + esc(a.plan) + '">' + esc(a.plan) + '</span>' +
          '<span class="usage-window-status ' + a.tone + '" title="' + esc(a.status) + '"><span>' + esc(a.status) + '</span></span>' +
        '</span>' +
        '<span class="usage-window-grid grouped" style="--quota-columns:1">' +
          '<span class="usage-window-group"><span class="usage-window-group-name">积分</span>' +
            a.items.map((it) =>
              '<span class="usage-window-item ' + (it.tone || 'ok') + '">' +
                '<span class="usage-window-line">' +
                  '<span class="usage-window-label" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' +
                  '<span class="usage-window-value" title="' + esc(it.view) + '">' + esc(it.view) + '</span>' +
                '</span></span>').join('') +
          '</span>' +
        '</span>' +
        '<span class="usage-window-foot">' +
          '<span class="usage-window-updated" title="上次成功查询：' + esc(a.updated) + '">' +
            '<span class="usage-window-caption">分窗口额度 · </span>' + esc(a.updated) +
          '</span>' +
          '<button type="button" class="usage-window-detail">额度详情<span class="usage-window-caret">⌄</span></button>' +
        '</span>' +
      '</span></span></span>';
  document.getElementById("rows").innerHTML = accounts.map((a) =>
    '<tr class="acct-row" data-id="' + a.id + '" data-provider="' + a.provider + '">' +
      '<td class="cell-name">' + esc(a.name) + '</td>' +
      '<td class="cell-usage">' + (a.provider === "workbuddy" ? hostToggle : cell(a)) + '</td>' +
      '</tr>').join('');
}
"""


async def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1180, "height": 620})
        page.on("pageerror", lambda e: print("pageerror:", e))

        await page.goto(BASE + "/login", wait_until="domcontentloaded")
        await page.evaluate(
            """() => {
              document.head.innerHTML = "";
              document.body.innerHTML = "";
              // 面板的真实主题：浅色。tokens.css 定义 --ui-*，ui.css 定义组件，缺一个都会串色。
              document.documentElement.setAttribute("data-theme", "light");
              const mk = (href) => {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = href;
                document.head.appendChild(link);
              };
              mk("/css/tokens.css");
              mk("/islands/ui.css");
              mk("/css/page-accounts-table.css");
              const style = document.createElement("style");
              style.textContent =
                "body{margin:0;padding:18px 22px;background:var(--ui-background,#f6f6f7);" +
                "font-family:var(--ui-font-sans,system-ui)}" +
                "table{width:100%;border-collapse:collapse;background:var(--ui-surface,#fff)}" +
                ".acct-row td{padding:10px 12px;border-top:1px solid var(--ui-hairline,#eee);vertical-align:top}" +
                ".cell-name{font-weight:600;width:220px}.cell-usage{width:380px}" +
                ".flex{display:flex}.flex-col{flex-direction:column}.gap-1{gap:4px}.mt-1{margin-top:4px}";
              document.head.appendChild(style);
              const table = document.createElement("table");
              const body = document.createElement("tbody");
              body.id = "rows";
              table.appendChild(body);
              document.body.appendChild(table);
            }"""
        )
        await page.evaluate(BUILD_ROWS, ACCOUNTS)
        await page.add_script_tag(url="/astudio-usage-compact.js")
        await page.wait_for_timeout(800)

        lines = await page.eval_on_selector_all(
            "tr.acct-row .a2a-usage-line", "els => els.map(e => e.textContent)"
        )
        classes = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='astudio'] .a2a-usage-line", "els => els.map(e => e.className)"
        )
        val_text = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='astudio'] .a2a-usage-line .val", "els => els.map(e => e.textContent)"
        )
        caret_text = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='astudio'] .a2a-usage-line .caret", "els => els.map(e => e.textContent)"
        )
        wb_toggle = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='workbuddy'] .usage-toggle", "els => els.map(e => e.textContent)"
        )
        print("装饰出的单条读数：", lines)
        hidden = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='astudio'] .usage-window-cell",
            "els => els.map(e => getComputedStyle(e).display)",
        )
        untouched = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='workbuddy'] .a2a-usage-line",
            "els => els.length",
        )
        print("AStudio 按钮 class（应 usage-toggle ok）：", classes)
        print("AStudio .val 读数：", val_text)
        print("AStudio .caret（应 ▾）：", caret_text)
        print("astudio 原生卡片 display（应全 none）：", hidden)
        print("workbuddy 行被装饰数（应 0）：", untouched)
        print("WorkBuddy 宿主胶囊（对比基准）：", wb_toggle)
        await page.screenshot(path=str(SHOTS / "usage-1-closed.png"))

        await page.click("tr.acct-row[data-provider='astudio'] .a2a-usage-line")
        await page.wait_for_timeout(250)
        text = await page.eval_on_selector("#a2a-usage-pop", "e => e.innerText")
        pop_classes = await page.eval_on_selector_all(
            "#a2a-usage-pop [class]", "els => els.map(e => e.className)"
        )
        print("浮层内容：", text.replace(chr(10), " | "))
        print("浮层复用的宿主类：", sorted(set(pop_classes)))
        await page.screenshot(path=str(SHOTS / "usage-2-open.png"))

        await page.mouse.click(30, 560)
        await page.wait_for_timeout(150)
        print("点外面关闭（应 True）：", await page.eval_on_selector("#a2a-usage-pop", "e => e.hidden"))

        await page.click("tr.acct-row[data-provider='astudio'] .a2a-usage-line")
        await page.wait_for_timeout(150)
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)
        print("Esc 关闭（应 True）：", await page.eval_on_selector("#a2a-usage-pop", "e => e.hidden"))

        await page.evaluate(
            """async () => {
              const td = document.querySelector("tr.acct-row[data-provider='astudio'] td.cell-usage");
              td.innerHTML = td.innerHTML;
              await new Promise((r) => setTimeout(r, 300));
            }"""
        )
        await page.wait_for_timeout(300)
        again = await page.eval_on_selector_all(
            "tr.acct-row[data-provider='astudio'] .a2a-usage-line", "els => els.length"
        )
        print("整格替换后重新装饰的行数（应 4）：", again)
        await browser.close()


asyncio.run(main())
