/**
 * 登录方式的实现。宿主只接受两种返回形态：
 *  - authorize 返回 { method: "auto", callback }：宿主立刻在后台跑 callback，
 *    这就是扫码登录能把结果送回宿主的唯一通道（poll 自己不能把流程置成 done）。
 *  - 返回 { method: "code", ... }：宿主先打开 authorization.url，再等用户把回调
 *    地址或一次性 code 粘回来（手机验证码登录用它：滑块在网页里、验证码粘回来）。
 *
 * 动态提示：宿主 poll() 的 hint 取 authorization.instructions，且要求它不在
 * start 时烘进 flow 的文案里 —— 所以这里用 getter 暴露一个会变的提示字符串。
 */
import {
  LOGIN_PAGE_URL, POLL_INTERVAL_MS, PROVIDER_NAME, QR_TTL_MS, QUICK_LOGIN,
} from "./endpoints.mjs";
import { describe, fetchCatalog, isExpired, studioForm, text } from "./http.mjs";
import { credentialOf, localCredentialText } from "./import.mjs";
import {
  HINTS, SsoRejected, identitiesOf, pause, pollIdentities, qrcodeImage, scanSession, waitingHint,
} from "./scan.mjs";
import { accountSecret, settle } from "./session.mjs";

/** 微信扫码登录：二维码由宿主内嵌窗口显示，取码/轮询/换凭据都在插件内完成。 */
export async function authorizeScan(_inputs, { signal } = {}) {
  const fd = scanSession();
  let url;
  try {
    url = await qrcodeImage(fd, { signal });
  } catch (error) {
    return { type: "failed", error: describe(error) };
  }
  const state = { hint: HINTS.ready, expiresAt: Date.now() + QR_TTL_MS };
  return {
    method: "auto",
    url,
    get instructions() {
      return state.hint;
    },
    callback: (_code, options = {}) => completeScan(fd, state, options?.signal ?? signal),
  };
}

/** 二维码过期后还在轮询的节奏：慢了也还能接住「过期前最后一秒扫上」的那次确认。 */
const RETRY_AFTER_EXPIRY_MS = 5000;

async function completeScan(fd, state, signal) {
  // 第一次轮询之前就把提示换成「等待微信扫码…」：start 时烘进流程的 ready 文案会被
  // 宿主去重（与流程文案相同就不显示），不换的话前 1.5 秒看到的是宿主的默认提示。
  state.hint = HINTS.waiting;
  for (;;) {
    await pause(Date.now() >= state.expiresAt ? RETRY_AFTER_EXPIRY_MS : POLL_INTERVAL_MS, signal);
    let data;
    try {
      data = await pollIdentities(fd, { signal });
    } catch (error) {
      if (error instanceof SsoRejected) {
        state.hint = waitingHint(error.code, error.desc, Date.now() >= state.expiresAt);
        continue;
      }
      throw error;
    }
    const [identity] = identitiesOf(data);
    if (!identity) {
      state.hint = HINTS.unbound;
      continue;
    }
    state.hint = HINTS.settling;
    const settled = await settle(
      { accountId: identity.uid, uid: identity.uid, ssoSessionId: identity.ssoSessionId, token: "" },
      { requireWebToken: false, signal },
    );
    return { ...accountSecret(settled, { source: "scan" }), type: "success" };
  }
}

/** 粘贴 modelBearerToken：只校验它能否读到平台目录，读不到也先收下。 */
export async function authorizeToken(inputs = {}, { signal } = {}) {
  const key = text(inputs?.key);
  if (!key) return { type: "failed", error: "请填写 modelBearerToken" };
  try {
    await fetchCatalog(key, { signal });
  } catch (error) {
    if (isExpired(error)) {
      return { type: "failed", error: "AStudio 拒绝了这份模型凭据（HTTP 401/403），请换一个有效的 modelBearerToken" };
    }
    /* 目录读不到不等于凭据无效（可能只是网络问题），先收下，由对话请求检验。 */
  }
  return { type: "success", key, name: PROVIDER_NAME, metadata: { source: "paste" } };
}

/** 登录接口返回的 data → settle 的入参。字段名上游有几种写法，全收。 */
function identityOf(data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const accountId = text(source.account_id) || text(source.accountId) || text(source.uid);
  const ssoSessionId = text(source.ssoSessionId) || text(source.sso_sessionid) || text(source.token);
  return {
    accountId,
    uid: text(source.uid) || accountId,
    ssoSessionId,
    token: text(source.token) || ssoSessionId,
    mobile: text(source.mobile) || text(source.phoneNum) || text(source.phone),
  };
}

/** 「8618122032590」「+86 181 2203 2590」「18122032590」都拆成 { countryCode, mobile }。 */
export function splitPhone(raw) {
  const value = text(raw).trim();
  if (!value) return null;
  // 显式写了区号（+86 18122032590 / +1 4155550132）：区号与号码之间有分隔符才敢拆
  const explicit = /^\+\s*(\d{1,3})[\s-]+(\d[\d\s-]*)$/.exec(value);
  if (explicit) return { countryCode: explicit[1], mobile: explicit[2].replace(/\D/g, "") };
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 13 && digits.startsWith("86")) return { countryCode: "86", mobile: digits.slice(2) };
  if (digits.length === 11) return { countryCode: "86", mobile: digits };
  if (digits.length > 11) return { countryCode: digits.slice(0, digits.length - 11), mobile: digits.slice(-11) };
  return { countryCode: "86", mobile: digits };
}

/**
 * 从粘贴内容里挑出短信验证码：允许用户把整条短信一起粘进来。
 * 「【讯飞星辰】验证码 123456，5 分钟内有效」→ 123456；不会把 5 当成验证码的一部分。
 */
export function smsCodeOf(raw) {
  const value = text(raw);
  if (!value) return "";
  if (/^\d{4,8}$/.test(value)) return value;
  const hit = /(?:^|\D)(\d{4,8})(?!\d)/.exec(value);
  return hit ? hit[1] : "";
}

/**
 * 粘贴框里也可能是一条带 code 参数的网址（宿主 core/login.rs:820-830 会把整条回调地址
 * 原样交给插件，只有 URL 里带 code / authorization_code 时才会先被摘出来）。这里再兜一层。
 */
export function codeFromUrl(raw) {
  const value = text(raw).trim();
  if (!/^https?:\/\//i.test(value)) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  for (const key of ["code", "authorization_code", "verifyCode", "verify_code", "smsCode", "authCode"]) {
    const hit = smsCodeOf(url.searchParams.get(key) || "");
    if (hit) return hit;
  }
  return "";
}

/** 短信方式的诊断日志出口（index.mjs 的工厂里接到 client.app.log）。 */
let logger = () => {};
export function useLoginLogger(fn) {
  logger = typeof fn === "function" ? fn : () => {};
}

/**
 * 手机验证码登录（两段式）。
 *
 * ── 为什么验证码要用户自己取 ────────────────────────────────
 * 上游 login/mobile/send-verify-code 强制极验滑块，而极验只能由宿主渲染（wasm 包有
 * login.captcha.geetest 能力，脚本宿主只认 oauth/api）。所以插件既发不出这条短信、
 * 也画不出滑块：验证码只能由用户在网页登录页里自己取。
 *
 * 取到码之后有两条提交路径：这条（method:"code"，宿主开网页 + 弹粘贴框）和
 * authorizeSmsForm（method:"auto"，验证码在 start 时填好，不开窗口不弹框）。
 *
 * ── 现在的流程（宿主自己的 wps-lingxi「内嵌窗口登录」也是同一个形态）────────
 *  1. 用户在面板填手机号，点「登录并添加」；
 *  2. 宿主用 authorization.url 打开 AStudio 网页登录页，并因为 method:"code" 弹出
 *     「粘贴授权令牌或 code」输入框（login-policy.mjs:128-129 由 method 决定）；
 *  3. 用户在页面上完成滑块、点「获取验证码」，短信到了把码粘回面板；
 *  4. 回调里用不要滑块的 login/phone-quick-login 完成登录。
 *
 * 代价：验证码只能提交一次（宿主的回调是一次性的），填错要重新发起并重新取码；
 * 所以格式不对时在本地就先拦下，不浪费那次机会。
 */
export async function authorizeSms(inputs = {}, { signal } = {}) {
  const phone = splitPhone(inputs?.mobile);
  if (!phone || phone.mobile.length < 6) return { type: "failed", error: "请填写手机号（例如 18122032590）" };
  // 直接在面板里填了验证码（旧用法）也认：等价于回调马上被调用。
  const pasted = smsCodeOf(inputs?.code);
  const callback = (raw, options = {}) => {
    const submitted = text(raw).trim();
    logger(`AStudio 手机验证码回调收到 ${submitted.length} 个字符：${submitted.slice(0, 60)}`);
    const code = smsCodeOf(raw) || codeFromUrl(raw) || pasted;
    return completeSms(phone, code, options?.signal ?? signal, submitted);
  };
  return {
    method: "code",
    url: LOGIN_PAGE_URL,
    instructions: "网页已打开（如果面板让你粘「完整回调地址」，请改粘短信验证码）。步骤：① 在网页登录框里填这个手机号 → ② 勾选「已同意《服务协议》和《隐私协议》」→ ③ 点「获取验证码」并拖动滑块 → ④ 把手机短信里的 4-8 位数字粘回面板弹出的框。不要在网页上点「登录」，那个登录跟这里无关；这里要的只是短信里的数字。",
    callback,
  };
}

/**
 * 手机验证码登录（先取码再填，一次提交）。
 *
 * 宿主对 method:"code" 的流程只给一次回调机会，而粘贴框的提示语、覆盖层文案都是宿主
 * 写的（网页端甚至只弹 shim 覆盖层，文案是「复制浏览器地址栏中的完整回调地址粘贴提交」），
 * 用户很容易把地址栏 URL 当成「回调地址」交上来 —— 实测就这样丢过一次登录机会。
 * 这条方式把验证码做成 start 时的必填输入项：不开窗口、不弹粘贴框，用户先在网页里取好码，
 * 一次提交就完成登录。
 */
export async function authorizeSmsForm(inputs = {}, { signal } = {}) {
  const phone = splitPhone(inputs?.mobile);
  if (!phone || phone.mobile.length < 6) return { type: "failed", error: "请填写手机号（例如 18122032590）" };
  const code = smsCodeOf(inputs?.code);
  if (!code) {
    return {
      type: "failed",
      error: `请填写短信验证码（4-8 位数字）。还没有验证码时，先打开 ${LOGIN_PAGE_URL} 用这个手机号取一次码。`,
    };
  }
  return {
    method: "auto",
    url: "",
    callback: (raw, options = {}) => completeSms(phone, smsCodeOf(raw) || code, options?.signal ?? signal, text(raw)),
  };
}

/** 回调内容不是验证码时，按用户实际交了什么东西给出能自己纠正的话。 */
export function submissionHint(submitted, phone) {
  const retry = "这次登录已经结束：请再点一次「登录并添加」，在网页里重新获取验证码后再粘回来。";
  const value = text(submitted).trim();
  if (!value) {
    return `没有收到验证码。面板弹出的那个框要填的是手机短信里的 4-8 位数字（不是手机号，也不是授权令牌）。${retry}`;
  }
  if (/^https?:\/\//i.test(value)) {
    return `你粘进来的是网页地址（${value.slice(0, 80)}），不是短信验证码。不要点网页上的「登录」、也不要粘地址栏 —— 把手机短信里的 4-8 位数字粘到那个框里就行。${retry}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits && (digits === phone.mobile || digits === `${phone.countryCode}${phone.mobile}`)) {
    return `你粘进来的是手机号，不是短信验证码。${retry}`;
  }
  return `「${value.slice(0, 40)}」里没有 4-8 位验证码。那个框只认手机短信里的数字（例如 123456），不是手机号、不是授权令牌、也不是网址。${retry}`;
}

async function completeSms(phone, code, signal, submitted = "") {
  if (!code) {
    return { type: "failed", error: submissionHint(submitted, phone) };
  }
  let data;
  try {
    data = await studioForm(QUICK_LOGIN, {
      mobile: phone.mobile,
      verifyCode: code,
      countryCode: phone.countryCode,
    }, { operation: "手机验证码登录", signal });
  } catch (error) {
    const message = describe(error);
    // 验证码错/过期时流程已经结束，光说「验证码无效」会让人以为还能再试一次。
    return {
      type: "failed",
      error: /验证码/.test(message)
        ? `${message}。这次登录已经结束：请重新获取一次验证码，再提交一遍。`
        : message,
    };
  }
  try {
    const settled = await settle(identityOf(data), { requireWebToken: false, signal });
    return { ...accountSecret(settled, { source: "sms" }), type: "success" };
  } catch (error) {
    return { type: "failed", error: describe(error) };
  }
}

/** 导入凭据（粘贴 JSON / Cookie 串）。 */
export async function authorizeCredential(inputs = {}, { signal } = {}) {
  const raw = text(inputs?.json) || text(inputs?.credential);
  if (!raw) return { type: "failed", error: "请粘贴凭据 JSON 或 Cookie 串" };
  return importCredential(raw, "json", signal);
}

/** 导入本机登录态（读网关本机的文件/目录，或直接粘贴内容）。 */
export async function authorizeLocal(inputs = {}, { signal } = {}) {
  const raw = text(inputs?.path) || text(inputs?.file);
  if (!raw) return { type: "failed", error: "请填写本机登录态文件的路径（也可以直接粘贴内容）" };
  let body;
  try {
    body = await localCredentialText(raw);
  } catch (error) {
    return { type: "failed", error: describe(error) };
  }
  return importCredential(body, "local", signal);
}

/**
 * 凭据 → 账号：有会话就换一次模型凭据（顺带验证会话还活着），
 * 会话换不动但带了 modelBearerToken 时退成纯凭据账号。
 */
async function importCredential(raw, source, signal) {
  const credential = credentialOf(raw);
  if (!credential) {
    return {
      type: "failed",
      error: "认不出这份凭据：需要 Cookie 串（ssoSessionId=…; account_id=…）或含 modelBearerToken / ssoSessionId 的 JSON",
    };
  }
  const ssoSessionId = credential.ssoSessionId || credential.token;
  if (ssoSessionId && (credential.accountId || credential.uid)) {
    try {
      const settled = await settle({
        accountId: credential.accountId || credential.uid,
        uid: credential.uid,
        ssoSessionId,
        token: credential.token || ssoSessionId,
        mobile: credential.mobile,
        nickname: credential.nickname,
      }, { requireWebToken: false, signal });
      return { ...accountSecret(settled, { source }), type: "success" };
    } catch (error) {
      if (!credential.key) return { type: "failed", error: describe(error) };
    }
  }
  if (!credential.key) {
    return { type: "failed", error: "这份凭据里没有可用的会话（ssoSessionId / account_id）或 modelBearerToken" };
  }
  try {
    await fetchCatalog(credential.key, { signal });
  } catch (error) {
    if (isExpired(error)) return { type: "failed", error: "这份 modelBearerToken 已失效（HTTP 401/403），请换一份" };
    /* 网络问题先收下，由对话请求检验 */
  }
  return {
    type: "success",
    key: credential.key,
    name: credential.mobile || credential.nickname || PROVIDER_NAME,
    metadata: { source },
  };
}
