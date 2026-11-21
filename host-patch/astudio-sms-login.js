/**
 * AStudio · zp —— 在面板里完成「手机号 + 极验滑块 + 短信验证码」登录。
 *
 * ── 为什么要宿主侧补丁 ──────────────────────────────────────
 * 上游 login/mobile/send-verify-code 强制要极验滑块三件，而脚本插件既画不出滑块
 * （宿主只接受 oauth/api 两种 type）、也没有 login.captcha.geetest 能力。但滑块可以
 * 在**面板自己的页面**里画：
 *   · AStudio 的接口 CORS 全开（access-control-allow-origin: *），chat/gee-captcha 直连即可；
 *   · 极验 v4 只按 document.referrer 判定来源（实测：只改 Referer 头 → 通过；
 *     只伪造 document.referrer → 同样通过），页内伪造就够；
 *   · 面板桥的 httpCall 用的是全局 fetch，包一层就能截住 login/start。
 *
 * ── 干了什么 ───────────────────────────────────────────────
 * 1. 截住 POST /api/session/login/start（provider=astudio、methodIndex=1）；
 * 2. 弹面板内对话框：确认手机号 → 取 chat/gee-captcha → 加载极验 gt.js → 用户拖滑块；
 * 3. 拖完拿到三件，带着 inputs.captcha 重发 start —— 插件用它们发短信（同一个出口 IP）；
 * 4. 把 start 响应里的 manualCallback 改成 false，宿主就不弹它那个「粘贴授权令牌或 code」框；
 * 5. 面板自己弹验证码输入框，提交走 workbuddyDesktop.submitLoginCallback(state, 验证码)，
 *    插件的 login/phone-quick-login 收尾落账号。
 *
 * 补丁不在（或取滑块配置失败）时一切照旧：宿主打开网页登录页，用户自己取码再粘回来。
 *
 * 安装：sudo bash install.sh（镜像升级覆盖 /app/ui 后要重跑）
 */
(() => {
  "use strict";
  if (window.__a2aAstudioSms) return;
  window.__a2aAstudioSms = true;

  const PROVIDER = "astudio";
  // astudio 插件的方法表：0 扫码 / 1 手机验证码登录 / 2 手机验证码（已收到码）/ 3 粘贴 / 4 JSON / 5 本机
  const SMS_METHOD_INDEX = 1;
  const START_PATH = "/api/session/login/start";
  const GEE_CONFIG = "https://agent.xfyun.cn/xingchen-studio/chat/gee-captcha";
  const GT_SDK = "https://static.geetest.com/static/tools/gt.js";
  const REFERER = "https://agent.xfyun.cn/studio-portal/overview";

  /* ── 1. document.referrer 伪造（只在取滑块期间生效）──────────── */
  let fakeReferrer = null;
  try {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "referrer");
    const real = desc && typeof desc.get === "function" ? desc.get : null;
    Object.defineProperty(Document.prototype, "referrer", {
      configurable: true,
      get() {
        if (fakeReferrer) return fakeReferrer;
        return real ? real.call(this) : "";
      },
    });
  } catch (error) {
    /* 老浏览器改不了就算了：极验会回 error_113，用户还能退回网页登录 */
  }

  /* ── 2. 极验：配置 → SDK → 滑块 → 三件 ─────────────────────── */
  let sdkPromise = null;

  function loadSdk() {
    if (window.initGeetest) return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = GT_SDK;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          sdkPromise = null;
          reject(new Error("极验脚本加载失败（static.geetest.com 不可达）"));
        };
        document.head.appendChild(script);
      });
    }
    return sdkPromise;
  }

  async function captchaConfig() {
    const response = await fetch(GEE_CONFIG, {
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("取滑块配置失败（HTTP " + response.status + "）");
    }
    if (!payload || payload.flag !== true || Number(payload.code) !== 0) {
      throw new Error("取滑块配置失败：" + ((payload && payload.desc) || "HTTP " + response.status));
    }
    const data = payload.data || {};
    if (!data.gt || !data.challenge) throw new Error("滑块配置不完整");
    return data;
  }

  /** 让用户在极验自己的浮层里拖完滑块，返回 {geetest_challenge, geetest_validate, geetest_seccode}。 */
  function solveSlider(config) {
    return new Promise((resolve, reject) => {
      const holder = document.createElement("div");
      holder.id = "a2a-geetest-holder";
      document.body.appendChild(holder);
      let settled = false;
      const cleanup = () => {
        const node = document.getElementById("a2a-geetest-holder");
        if (node) node.remove();
        document.querySelectorAll(".geetest_panel, .geetest_mask").forEach((n) => n.remove());
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      try {
        window.initGeetest({
          gt: config.gt,
          challenge: config.challenge,
          offline: !config.success,
          new_captcha: config.new_captcha,
          https: true,
          product: "bind",
          width: "100%",
        }, (captcha) => {
          if (!captcha) return finish(reject, new Error("滑块初始化失败"));
          captcha.onReady(() => { captcha.verify(); });
          captcha.onSuccess(() => {
            const value = captcha.getValidate() || {};
            if (!value.geetest_challenge || !value.geetest_validate || !value.geetest_seccode) {
              return finish(reject, new Error("滑块结果不完整，请重新拖一次"));
            }
            finish(resolve, {
              geetest_challenge: value.geetest_challenge,
              geetest_validate: value.geetest_validate,
              geetest_seccode: value.geetest_seccode,
            });
          });
          captcha.onError((error) => {
            const raw = (error && (error.msg || error.message)) || "请重试";
            // 极验偶发「服务端forbidden：请联系极验官网客服」（短时间重复校验会被拒），文案要能指导用户
            const text = /forbidden|客服|error_113/i.test(raw)
              ? "极验暂时拒绝了这次校验（短时间内重试太频繁）：等几秒再点「获取验证码」"
              : "滑块校验没通过：" + raw;
            finish(reject, new Error(text));
          });
          captcha.onClose(() => finish(reject, new Error("已关闭滑块")));
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /* ── 3. 面板内对话框 ─────────────────────────────────────── */
  const CSS = [
    "#a2a-sms-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}",
    "#a2a-sms-card{background:#1e1f22;color:#e8e8e8;border-radius:10px;width:min(340px,86vw);padding:18px 18px 14px;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 18px 48px rgba(0,0,0,.5)}",
    "#a2a-sms-card h3{margin:0 0 2px;font-size:15px;font-weight:600}",
    "#a2a-sms-card .a2a-sub{color:#8b8b8b;font-size:12px;margin-bottom:14px}",
    "#a2a-sms-card label{display:block;color:#9a9a9a;font-size:12px;margin:10px 0 5px}",
    "#a2a-sms-card input{width:100%;box-sizing:border-box;background:#2a2b2f;border:1px solid #3a3b40;border-radius:6px;color:#fff;padding:8px 10px;font-size:13px;outline:none}",
    "#a2a-sms-card input:focus{border-color:#4f7cff}",
    "#a2a-sms-card .a2a-actions{display:flex;gap:8px;margin-top:14px}",
    "#a2a-sms-card button{flex:1;border:0;border-radius:6px;padding:9px 12px;font-size:13px;cursor:pointer}",
    "#a2a-sms-card button.primary{background:#4f7cff;color:#fff}",
    "#a2a-sms-card button.primary:disabled{background:#37415c;color:#9aa4bd;cursor:default}",
    "#a2a-sms-card button.ghost{background:#2a2b2f;color:#c8c8c8}",
    "#a2a-sms-hint{margin-top:12px;color:#9a9a9a;font-size:12px;min-height:18px;word-break:break-all}",
    "#a2a-sms-hint.error{color:#ff8b8b}",
  ].join("\n");

  function buildModal() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "a2a-sms-overlay";
    overlay.innerHTML = [
      '<div id="a2a-sms-card">',
      "  <h3>手机验证码登录</h3>",
      '  <div class="a2a-sub">AStudio · zp</div>',
      '  <label for="a2a-sms-phone">手机号</label>',
      '  <input id="a2a-sms-phone" inputmode="numeric" autocomplete="tel" placeholder="18122032590">',
      '  <label for="a2a-sms-code" id="a2a-sms-code-label" style="display:none">短信验证码</label>',
      '  <input id="a2a-sms-code" inputmode="numeric" autocomplete="one-time-code" placeholder="短信里的 4-8 位数字" style="display:none">',
      '  <div class="a2a-actions">',
      '    <button class="primary" id="a2a-sms-main">获取验证码</button>',
      '    <button class="ghost" id="a2a-sms-cancel">取消</button>',
      "  </div>",
      '  <div id="a2a-sms-hint"></div>',
      "</div>",
    ].join("\n");
    document.body.appendChild(overlay);

    const phone = overlay.querySelector("#a2a-sms-phone");
    const code = overlay.querySelector("#a2a-sms-code");
    const codeLabel = overlay.querySelector("#a2a-sms-code-label");
    const main = overlay.querySelector("#a2a-sms-main");
    const cancel = overlay.querySelector("#a2a-sms-cancel");
    const hint = overlay.querySelector("#a2a-sms-hint");

    let stage = "phone";
    let onCaptcha = null;
    let onSubmit = null;
    let watcher = 0;
    let closed = false;

    const setHint = (text, isError) => {
      hint.textContent = text || "";
      hint.className = isError ? "error" : "";
    };

    const close = () => {
      if (closed) return;
      closed = true;
      if (watcher) clearInterval(watcher);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      style.remove();
      document.querySelectorAll(".geetest_panel, .geetest_mask").forEach((n) => n.remove());
      if (onCaptcha) {
        const fn = onCaptcha;
        onCaptcha = null;
        fn({ canceled: true });
      }
    };

    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", close);

    main.addEventListener("click", async () => {
      if (stage === "phone") {
        const value = phone.value.replace(/\s+/g, "");
        if (!/^\d{6,15}$/.test(value)) {
          setHint("请填手机号，例如 18122032590", true);
          phone.focus();
          return;
        }
        stage = "captcha";
        main.disabled = true;
        main.textContent = "加载滑块…";
        setHint("正在准备滑块校验…");
        try {
          const config = await captchaConfig();
          // 从加载 SDK 起就伪造 referrer：gt.js 可能在脚本初始化时就读取它，
          // 只在拖拽期间伪造会偶发「服务端 forbidden：请联系极验官网客服」。
          fakeReferrer = REFERER;
          await loadSdk();
          setHint("请拖动下面的滑块完成拼图");
          const tokens = await solveSlider(config);
          fakeReferrer = null;
          stage = "phone";
          main.disabled = false;
          main.textContent = "获取验证码";
          if (onCaptcha) {
            const fn = onCaptcha;
            onCaptcha = null;
            fn({ phone: value, tokens });
          }
        } catch (error) {
          fakeReferrer = null;
          stage = "phone";
          main.disabled = false;
          main.textContent = "获取验证码";
          setHint((error && error.message) || String(error), true);
        }
        return;
      }
      if (stage === "code") {
        const value = code.value.replace(/\D/g, "");
        if (value.length < 4 || value.length > 8) {
          setHint("请填 4-8 位短信验证码", true);
          code.focus();
          return;
        }
        main.disabled = true;
        main.textContent = "登录中…";
        setHint("正在用这个验证码完成登录…");
        if (onSubmit) await onSubmit(value);
      }
    });

    phone.addEventListener("keydown", (event) => {
      if (event.key === "Enter") main.click();
    });
    code.addEventListener("keydown", (event) => {
      if (event.key === "Enter") main.click();
    });

    return {
      /** 等用户确认手机号并拖完滑块。 */
      askCaptcha(mobile) {
        if (mobile) phone.value = String(mobile).replace(/\D/g, "");
        phone.focus();
        phone.select();
        return new Promise((resolve) => { onCaptcha = resolve; });
      },
      sending() {
        main.disabled = true;
        main.textContent = "发送中…";
        setHint("滑块已通过，正在给这个手机号发短信…");
      },
      /** 短信已发出：切到「填验证码」。 */
      toCode(submit) {
        stage = "code";
        onSubmit = submit;
        main.disabled = false;
        main.textContent = "登录";
        codeLabel.style.display = "block";
        code.style.display = "block";
        phone.disabled = true;
        setHint("短信已发出（也可能在拦截里），把 4-8 位数字填进来点「登录」");
        code.focus();
      },
      /** 登录中：轮询宿主快照，流程一结束就收摊，结果由面板自己展示。 */
      watch() {
        watcher = setInterval(async () => {
          try {
            const snap = await window.workbuddyDesktop.getLoginState();
            if (!snap || snap.active !== true) close();
          } catch (error) { /* 快照读不到就继续等 */ }
        }, 800);
      },
      fail(message) {
        main.disabled = false;
        main.textContent = "重试";
        stage = "phone";
        setHint(message || "登录失败", true);
      },
      close,
      isClosed: () => closed,
    };
  }

  /* ── 4. 截住 login/start ─────────────────────────────────── */
  const nativeFetch = window.fetch.bind(window);

  function parseBody(init) {
    if (!init || typeof init.body !== "string") return null;
    try {
      return JSON.parse(init.body);
    } catch (error) {
      return null;
    }
  }

  function rebuild(text, response, headers) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: headers || response.headers,
    });
  }

  /** 把 start 响应里的 manualCallback 关掉，宿主就不会再弹「粘贴授权令牌或 code」。 */
  async function patchStart(response) {
    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return { ok: false, response: rebuild(raw, response) };
    }
    const data = payload && payload.data;
    const state = data && (data.state || data.flow);
    if (!response.ok || !state) return { ok: false, response: rebuild(raw, response) };
    const patched = Object.assign({}, payload, {
      data: Object.assign({}, data, { manualCallback: false, callbackInput: "url" }),
    });
    return {
      ok: true,
      state: String(state),
      response: rebuild(JSON.stringify(patched), response, { "content-type": "application/json" }),
    };
  }

  function canceled() {
    const error = new Error("已取消这次登录");
    error.canceled = true;
    return error;
  }

  async function runSmsFlow(input, init, body) {
    const modal = buildModal();
    try {
      const answer = await modal.askCaptcha(body && body.inputs && body.inputs.mobile);
      if (answer.canceled) throw canceled();
      modal.sending();
      const next = Object.assign({}, body, {
        inputs: Object.assign({}, body.inputs || {}, {
          mobile: answer.phone,
          captcha: JSON.stringify(answer.tokens),
        }),
      });
      const response = await nativeFetch(input, Object.assign({}, init, { body: JSON.stringify(next) }));
      const patched = await patchStart(response);
      if (!patched.ok) {
        modal.close();
        return patched.response;
      }
      modal.toCode(async (code) => {
        try {
          await window.workbuddyDesktop.submitLoginCallback(patched.state, code);
          modal.watch();
        } catch (error) {
          modal.fail((error && error.message) || "提交验证码失败");
        }
      });
      modal.watch();
      return patched.response;
    } catch (error) {
      modal.close();
      throw error;
    }
  }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf(START_PATH) === -1) return nativeFetch(input, init);
      const body = parseBody(init);
      if (!body || body.provider !== PROVIDER || Number(body.methodIndex) !== SMS_METHOD_INDEX) {
        return nativeFetch(input, init);
      }
      if (body.inputs && body.inputs.captcha) return nativeFetch(input, init);
      return runSmsFlow(input, init, body);
    } catch (error) {
      return nativeFetch(input, init);
    }
  };
})();
