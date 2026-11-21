/**
 * 微信扫码登录的 SSO 协议（三条请求里的前两条，全部在插件进程内完成）：
 *  1) GET /SSOService/wx/scanlogin/qrcode?fd=<会话号> → data 是二维码图片 URL
 *  2) GET /SSOService/wx/scanlogin/uids?fd=<会话号>   → data = { infoList: [{ ssoSessionId, uid }] }
 *
 * 这两条请求不带 Cookie、不带 clientType/studioVersion，只有 Accept + User-Agent。
 * fd 是插件自己生成的 8 位 [A-Za-z0-9]，不需要预注册。
 *
 * 关键语义：flag=false 或 code!=0 是「还没人扫码」的正常态 —— 实测为
 * code=20003「请求地址错误」，或 code=-1「暂无数据」，两者都必须当 Pending 处理，
 * 不能把上游文案当错误抛给用户。
 */
import {
  POLL_INTERVAL_MS, QR_TTL_MS, SCAN_QRCODE, SCAN_SESSION_LEN, SCAN_UIDS, SSO_BASE, USER_AGENT,
} from "./endpoints.mjs";
import { describe, failed, scalar, text, withDeadline } from "./http.mjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 面板上会一直轮换显示的提示文案。 */
export const HINTS = {
  ready: "二维码已就绪，请在微信中扫码",
  waiting: "等待微信扫码…",
  expired: "二维码已过期：请取消这次登录，再点一次「微信扫码登录」",
  unbound: "微信已扫码，但这个微信还没有绑定星辰账号：请先在星辰网页端完成绑定，再扫一次",
  settling: "微信已确认，正在换取模型凭据…",
};

/** 上游的业务拒绝（还没扫码）。不是故障。 */
export class SsoRejected extends Error {
  constructor(code, desc) {
    super(text(desc) || `扫码登录上游返回 code ${text(code) || "未知"}`);
    this.name = "SsoRejected";
    this.code = text(code);
    this.desc = text(desc);
  }
}

export function scanSession(length = SCAN_SESSION_LEN) {
  const size = Number.isSafeInteger(length) && length > 0 ? length : SCAN_SESSION_LEN;
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** 白名单只需要主机名：剥掉 userinfo 与端口，并小写。 */
export function hostOf(url) {
  const raw = text(url);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    const rest = raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
    const authority = rest.split(/[/?#]/)[0] ?? "";
    const afterUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    const host = afterUser.includes(":") ? afterUser.slice(0, afterUser.lastIndexOf(":")) : afterUser;
    return host.toLowerCase();
  }
}

/** 二维码图片地址：上游给字符串，偶尔给对象。 */
export function imageUrlOf(data) {
  if (typeof data === "string") return text(data);
  if (data && typeof data === "object") {
    for (const key of ["url", "imageUrl", "image", "qrcode"]) {
      const value = text(data[key]);
      if (value) return value;
    }
  }
  return "";
}

async function ssoCall(path, fd, { signal } = {}) {
  const url = `${SSO_BASE}${path}?fd=${encodeURIComponent(fd)}`;
  const gate = withDeadline(signal);
  let response;
  let body;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: gate.signal,
    });
    body = await response.text();
  } catch (error) {
    throw failed(`扫码登录网络失败：${describe(error)}`);
  } finally {
    gate.done();
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw failed(`扫码登录返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failed("扫码登录返回的结果格式异常");
  }
  const code = typeof payload.code === "number" ? String(payload.code) : text(payload.code);
  if (payload.flag !== true || (code && code !== "0")) {
    throw new SsoRejected(code, payload.desc);
  }
  return payload.data ?? null;
}

export async function qrcodeImage(fd, { signal } = {}) {
  let data;
  try {
    data = await ssoCall(SCAN_QRCODE, fd, { signal });
  } catch (error) {
    // 取码阶段的业务拒绝就是真失败（不同于 uids 的「还没扫码」），文案要能直接看懂。
    if (error instanceof SsoRejected) {
      throw failed(`获取扫码二维码失败（${error.desc || error.code || "上游未说明原因"}）`);
    }
    throw error;
  }
  const url = imageUrlOf(data);
  if (!url) throw failed("获取扫码二维码失败：上游返回了空的图片地址");
  return url;
}

export async function pollIdentities(fd, { signal } = {}) {
  return ssoCall(SCAN_UIDS, fd, { signal });
}

/** infoList → [{ uid, ssoSessionId }]；占位 uid（0）与缺字段的项跳过。 */
export function identitiesOf(data) {
  const list = Array.isArray(data?.infoList) ? data.infoList : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const uid = scalar(item.uid);
    const ssoSessionId = text(item.ssoSessionId);
    if (!uid || !ssoSessionId) continue;
    out.push({ uid, ssoSessionId });
  }
  return out;
}

/** 实测过的「同等一会儿就好」的 code：20003 请求地址错误、-1 暂无数据。 */
const NOBODY_YET = new Set(["20003", "-1"]);

/**
 * 未扫码时的提示。过期优先；其余按上游 code/desc 区分：已知的「还没扫」与空 desc
 * 一律是干净的「等待微信扫码…」，其它 code 把 desc 附在后面方便排查。
 */
export function waitingHint(code, desc, isOverdue) {
  if (isOverdue) return HINTS.expired;
  const reason = text(desc);
  const raw = text(code);
  if (!raw || NOBODY_YET.has(raw) || !reason) return HINTS.waiting;
  return `${HINTS.waiting}（${reason}）`;
}

export function pause(ms, signal) {
  const delay = Number.isFinite(ms) && ms > 0 ? ms : POLL_INTERVAL_MS;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? failed("已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? failed("已取消"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { QR_TTL_MS, POLL_INTERVAL_MS };
