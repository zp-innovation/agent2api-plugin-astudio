/**
 * AStudio 的两套出网：
 *  - 账号面（agent.xfyun.cn/xingchen-studio/...）：Cookie 会话，信封 {flag, code, desc, data}
 *  - 模型面（框架网关）：Authorization: Bearer <modelBearerToken>
 *
 * 错误分两类：
 *  - failed：可以提示、可以重试（网络、非 JSON、业务拒绝）
 *  - expired：凭据/会话失效，必须引导用户重新登录
 */
import { MODEL_MANAGER_URL, STUDIO_BASE, STUDIO_VERSION, USER_AGENT } from "./endpoints.mjs";

const TIMEOUT_MS = 20_000;

export class StudioError extends Error {
  constructor(message, kind = "failed") {
    super(message);
    this.name = "StudioError";
    this.kind = kind;
  }
}

export const failed = (message) => new StudioError(message, "failed");
export const expired = (message) => new StudioError(message, "expired");
export const isExpired = (error) => error instanceof StudioError && error.kind === "expired";

export function describe(error) {
  const message = String(error?.message ?? error ?? "").trim();
  return message || "未知错误";
}

/**
 * 把「调用方的取消信号」和「超时」合成一个 signal。
 * 注意不能用 AbortSignal.any：部分运行时还没有实现。
 */
export function withDeadline(signal, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(failed("请求超时")), ms);
  const relay = () => controller.abort(signal?.reason ?? failed("已取消"));
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    },
  };
}

/** 官方桌面端的身份头；模型目录也要带，否则只给 7 条模型。 */
export function desktopHeaders() {
  const platform = typeof process !== "undefined" ? process.platform : "";
  const headers = { studioVersion: STUDIO_VERSION, "user-agent": USER_AGENT };
  if (platform === "win32") headers.clientType = "21";
  else if (platform === "darwin") headers.clientType = "22";
  return headers;
}

/**
 * AStudio 的会话 Cookie。顺序固定，ssoSessionId 刻意发两遍（两个键名上游都读）。
 */
export function cookieHeader(session) {
  const parts = [];
  const sso = text(session?.ssoSessionId);
  if (sso) parts.push(`ssoSessionId=${sso}`, `sso_sessionid=${sso}`);
  const account = text(session?.accountId);
  if (account) parts.push(`account_id=${account}`);
  const token = text(session?.token);
  if (token) parts.push(`token=${token}`);
  return parts.join("; ");
}

export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 上游把 id 有时给数字有时给字符串，"0" 视作缺失。 */
export function scalar(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? "" : String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" || trimmed === "0" ? "" : trimmed;
  }
  return "";
}

function codeOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const trimmed = text(value);
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

async function drain(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* 丢掉响应体即可 */
  }
}

/** 信封判定：{flag, code, desc, data}，flag=true 且 code=0 才算成功。 */
function envelope(payload, status, operation) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failed(`AStudio ${operation}返回的结果格式异常`);
  }
  const code = codeOf(payload.code);
  const desc = text(payload.desc);
  const ok = status >= 200 && status < 300;
  if (!ok || payload.flag === false || (code !== null && code !== 0)) {
    if (code === 80000 || desc.includes("重新登录")) {
      throw expired("AStudio 会话已失效，请重新登录 AStudio");
    }
    throw failed(desc
      ? `AStudio ${operation}失败（HTTP ${status}：${desc}）`
      : `AStudio ${operation}失败（HTTP ${status}）`);
  }
  if (payload.flag !== true || code !== 0) {
    throw failed(`AStudio ${operation}返回的成功状态不完整`);
  }
  if (payload.data === null || payload.data === undefined) {
    throw failed(`AStudio ${operation}返回的数据不完整`);
  }
  return payload.data;
}

/**
 * 登录类接口（没有会话可带）：表单体 + 与账号面相同的信封判定。
 * 实测上游接受 application/x-www-form-urlencoded（官方客户端发的是 multipart，
 * 两者都能过），这里用表单体省掉手工拼 multipart 边界。
 */
export async function studioForm(path, fields, { operation = "请求", signal } = {}) {
  const gate = withDeadline(signal);
  let response;
  try {
    response = await fetch(STUDIO_BASE + String(path).replace(/^\/+/, ""), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...desktopHeaders(),
      },
      body: new URLSearchParams(fields ?? {}).toString(),
      signal: gate.signal,
    });
  } catch (error) {
    gate.done();
    throw failed(`AStudio ${operation}网络失败：${describe(error)}`);
  }
  try {
    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw failed(`读取 AStudio ${operation}响应失败：${describe(error)}`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw failed(`AStudio ${operation}返回的不是 JSON（HTTP ${response.status}）`);
    }
    return envelope(payload, response.status, operation);
  } finally {
    gate.done();
  }
}

/**
 * 账号面请求：拿 data，其余情况抛 StudioError。
 * 与官方实现逐条对齐（HTTP 状态、flag/code、80000 与「重新登录」）。
 */
export async function studioJson(session, path, { method = "GET", operation = "请求", signal } = {}) {
  const cookie = cookieHeader(session);
  if (!cookie) throw failed(`AStudio ${operation}需要账号会话，请重新登录`);
  const gate = withDeadline(signal);
  let response;
  try {
    response = await fetch(STUDIO_BASE + String(path).replace(/^\/+/, ""), {
      method,
      headers: { accept: "application/json", cookie, ...desktopHeaders() },
      signal: gate.signal,
      ...(method === "POST" ? { body: "" } : {}),
    });
  } catch (error) {
    gate.done();
    throw failed(`AStudio ${operation}网络失败：${describe(error)}`);
  }
  try {
    if (response.status === 401 || response.status === 403) {
      await drain(response);
      throw expired(`AStudio 会话已失效（HTTP ${response.status}），请重新登录 AStudio`);
    }
    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw failed(`读取 AStudio ${operation}响应失败：${describe(error)}`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw failed(`AStudio ${operation}返回的不是 JSON（HTTP ${response.status}）`);
    }
    return envelope(payload, response.status, operation);
  } finally {
    gate.done();
  }
}

/** 模型目录（平台侧），401/403 视为凭据失效。 */
export async function fetchCatalog(key, { signal } = {}) {
  const token = text(key);
  if (!token) throw failed("AStudio 账号缺少模型凭据（modelBearerToken）");
  const gate = withDeadline(signal);
  let response;
  try {
    response = await fetch(MODEL_MANAGER_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...desktopHeaders() },
      signal: gate.signal,
    });
  } catch (error) {
    gate.done();
    throw failed(`AStudio 模型目录请求失败：${describe(error)}`);
  }
  try {
    if (response.status === 401 || response.status === 403) {
      await drain(response);
      throw expired("AStudio 拒绝了这份模型凭据（HTTP 401/403）");
    }
    if (response.status < 200 || response.status >= 300) {
      await drain(response);
      throw failed(`AStudio 模型目录不可用（HTTP ${response.status}）`);
    }
    const body = await response.text().catch(() => "");
    try {
      return JSON.parse(body);
    } catch {
      throw failed("AStudio 模型目录不是有效 JSON");
    }
  } finally {
    gate.done();
  }
}
