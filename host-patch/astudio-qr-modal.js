/* Agent2API · 让二维码登录在面板内弹窗显示（宿主侧补丁，不属于插件代码）

   为什么要打这个补丁
   ─────────────────
   网页面板的登录桥接脚本是**编译进 agent2api-server 二进制**的
   （desktop-tauri/src-tauri/server/src/web_shim.rs 的 shim_js()），
   它对任何非空 authUrl 都走同一条路：

     var second = window.open('about:blank', '_blank');
     second.opener = null;
     second.location.replace(authUrl);

   于是「微信扫码登录」这种只返回**一张二维码图片 URL** 的登录方式会在
   浏览器里开一个新标签页；用户扫完码还得自己回去关掉它，手机上更是直接
   跳到另一个页面。插件侧无法改变这件事：插件只能决定 authUrl 的值。

   这个补丁只做一件事：把登录流程要打开的那个窗口截下来。若目标 URL
   看起来就是一张图片（二维码接口 / 图片后缀），改成在面板内用弹窗显示
   <img>，并实时跟随 login:state 的 hint；登录结束（成功 / 失败 / 取消）
   自动关闭。非图片 URL（真正的授权页）仍然开新标签页，行为不变。

   拦截点为什么是 window.open('about:blank', '_blank')
   ────────────────────────────────────────────────
   全仓库（含 /app/ui 下所有前端脚本）只有 shim 的 runLoginFlow 这一处
   用这个签名开空窗口；旧版登录用 'a2a-login' 这个窗口名，粘贴回调的
   「打开授权页」和短信验证页都是直接给 URL —— 都不受影响。

   安装：见同目录 install.sh。镜像升级会覆盖 /app/ui，升级后重新执行一次。
*/
(() => {
  'use strict';

  /** 看起来就是一张图（二维码接口或图片后缀）才当二维码处理 */
  const IMAGE_URL = /(?:^|\/)(?:showqrcode|qrcode|qr-?code)(?:\/|\?|#|$)|\/qrcode\/|\.(?:png|jpe?g|gif|webp|svg)(?:\?|#|$)/i;

  const nativeOpen = window.open.bind(window);
  const bridge = () => window.workbuddyDesktop || null;

  let overlay = null;
  let hintNode = null;
  let poll = 0;

  const isImageUrl = (url) => typeof url === 'string'
    && /^https?:\/\//i.test(url) && IMAGE_URL.test(url);

  function onKey(event) {
    if (event.key !== 'Escape' || !overlay) return;
    // 下层「添加账号」弹窗自己也监听 Esc：不拦住会顺带把它关掉，
    // 再触发一次登录取消（与 shim 里 ensureOverlay 的处理一致）。
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function close() {
    if (poll) { clearInterval(poll); poll = 0; }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    hintNode = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function cancel() {
    const api = bridge();
    close();
    try { if (api && typeof api.cancelLogin === 'function') api.cancelLogin(); } catch (e) { /* 无害 */ }
  }

  function tick() {
    const api = bridge();
    if (!api || typeof api.getLoginState !== 'function') return;
    let state;
    try { state = api.getLoginState(); } catch (e) { return; }
    Promise.resolve(state).then((snap) => {
      if (!overlay) return;
      if (!snap || snap.active !== true) { close(); return; }
      const hint = typeof snap.hint === 'string' ? snap.hint.trim() : '';
      if (hintNode && hint) hintNode.textContent = hint;
    }, () => { /* 读状态失败就保持上一次的提示 */ });
  }

  function card(titleText, build) {
    // close() 会把 hintNode 之类一起清空，所以正文必须在它之后才构建
    close();
    const backdrop = document.createElement('div');
    backdrop.id = 'a2a-qr-overlay';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;'
      + 'align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1f22;color:#e8e8e8;border-radius:10px;'
      + 'padding:22px 24px 18px;width:min(340px,86vw);box-shadow:0 12px 40px rgba(0,0,0,.4);'
      + 'font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;';
    const title = document.createElement('div');
    title.textContent = titleText;
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:14px;text-align:center;';
    const body = document.createElement('div');
    build(body);
    box.appendChild(title);
    box.appendChild(body);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    overlay = backdrop;
    document.addEventListener('keydown', onKey, true);
  }

  function footer(buttons) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:16px;';
    buttons.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.text;
      button.style.cssText = 'flex:1;padding:8px 0;border-radius:6px;font-size:14px;cursor:pointer;'
        + (item.primary
          ? 'border:0;background:#4c7dff;color:#fff;'
          : 'border:1px solid #3a3b3f;background:transparent;color:#c9c9c9;');
      button.addEventListener('click', item.onClick);
      row.appendChild(button);
    });
    return row;
  }

  /** 二维码弹窗：图 + 实时提示 + 取消 */
  function showQr(url) {
    card('扫码登录', (body) => {

    const image = document.createElement('img');
    image.src = url;
    image.alt = '登录二维码';
    image.width = 260;
    image.height = 260;
    image.style.cssText = 'display:block;width:260px;height:260px;margin:0 auto;background:#fff;'
      + 'border-radius:8px;padding:6px;box-sizing:border-box;';
    body.appendChild(image);

    hintNode = document.createElement('div');
    hintNode.textContent = '二维码已就绪，请在手机上扫码';
    hintNode.style.cssText = 'margin-top:12px;text-align:center;color:#9a9a9a;font-size:13px;'
      + 'white-space:pre-wrap;min-height:20px;';
    body.appendChild(hintNode);

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '在新标签页打开二维码';
    link.style.cssText = 'display:block;margin-top:6px;text-align:center;color:#7fa7ff;'
      + 'font-size:12px;text-decoration:none;';
    body.appendChild(link);

    image.addEventListener('error', () => {
      if (hintNode) hintNode.textContent = '二维码图片加载失败：请点下面的链接在新标签页打开。';
    });

    body.appendChild(footer([{ text: '取消登录', onClick: cancel }]));
    });
    tick();
    poll = setInterval(tick, 800);
  }

  /** 非图片 URL 且弹窗被浏览器拦下时的兜底：把链接摆出来 */
  function showLink(url) {
    card('浏览器拦截了弹出窗口', (body) => {
    const tip = document.createElement('div');
    tip.textContent = '浏览器拦截了弹出窗口，请点击下面的链接打开授权页：';
    body.appendChild(tip);
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = url;
    link.style.cssText = 'display:block;margin-top:8px;color:#7fa7ff;font-size:12px;'
      + 'word-break:break-all;';
    body.appendChild(link);
    body.appendChild(footer([{ text: '关闭', primary: true, onClick: close }]));
    });
  }

  /** 假的窗口句柄：等 shim 把真正的 authUrl 赋给 location 时再决定怎么展示 */
  function deferredWindow() {
    let target = 'about:blank';
    const navigate = (next) => {
      const url = String(next == null ? '' : next);
      target = url;
      if (isImageUrl(url)) { showQr(url); return; }
      let opened = null;
      try { opened = nativeOpen('about:blank', '_blank'); } catch (e) { opened = null; }
      if (opened) {
        try { opened.opener = null; } catch (e) { /* 跨域时改不了，忽略 */ }
        try { opened.location.replace(url); } catch (e) { try { opened.location.href = url; } catch (e2) { /* 无害 */ } }
      } else {
        showLink(url);
      }
    };
    const handle = {
      closed: false,
      opener: null,
      focus() { /* 假句柄无需聚焦 */ },
      close() { handle.closed = true; },
      location: {
        get href() { return target; },
        set href(value) { if (String(value) && String(value) !== 'about:blank') navigate(value); },
        replace(value) { navigate(value); },
        assign(value) { navigate(value); },
      },
    };
    return handle;
  }

  window.open = function (url, name, features) {
    const target = typeof url === 'string' ? url.trim() : '';
    const blank = target === '' || target === 'about:blank';
    // 只截 shim 的动态登录这一种（空窗口 + '_blank'）；其余原样放行。
    if (blank && String(name || '') === '_blank') return deferredWindow();
    return nativeOpen(url, name, features);
  };
})();
