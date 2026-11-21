/**
 * 「导入凭据」类登录方式共用的解析器。
 *
 * 能认三种输入（面板里粘贴什么都能试）：
 *  1. Cookie 串：`ssoSessionId=…; sso_sessionid=…; account_id=…; token=…`
 *     （浏览器 DevTools → Application → Cookies，或 AStudio 客户端本机会话里的同一串）
 *  2. 凭据 JSON：`{"modelBearerToken": "…"}`、`{"account_id": "…", "ssoSessionId": "…"}`、
 *     以及宿主自己落盘过的 secret（`{"access": "…", "session": {…}}`）
 *  3. 本机会话文件路径：直接读该文件再按上面两种解析（只在网关本机有 AStudio 客户端时有用）
 */
import { describe, failed, text } from "./http.mjs";

/** 目录扫描的边界：最多两层、80 个候选文件、单个文件最多 512 KiB。 */
const MAX_LOCAL_FILES = 80;
const MAX_LOCAL_BYTES = 512 * 1024;
const LOCAL_EXTS = new Set([".json", ".txt", ".cookie", ".cookies", ".log", ".dat", ".ini", ""]);

/** Cookie 名 → 字段名。上游同一个会话有两个键名（ssoSessionId / sso_sessionid），都收。 */
const COOKIE_NAMES = new Map([
  ["ssosessionid", "ssoSessionId"],
  ["sso_sessionid", "ssoSessionId"],
  ["account_id", "accountId"],
  ["accountid", "accountId"],
  ["token", "token"],
  ["uid", "uid"],
]);

/** 从 Cookie 串里挑出会话字段；不是 Cookie 串返回 null。 */
export function cookieFields(raw) {
  const value = text(raw);
  if (!value || !value.includes("=")) return null;
  const fields = {};
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = COOKIE_NAMES.get(part.slice(0, index).trim().toLowerCase());
    if (!key) continue;
    const item = part.slice(index + 1).trim();
    if (item) fields[key] = item;
  }
  return Object.keys(fields).length ? fields : null;
}

/** 宽松地取 JSON：整串、或从第一个 { 到最后一个 } 之间的片段。 */
export function parseJson(raw) {
  const value = text(raw);
  if (!value) return null;
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  const candidates = [value];
  if (first >= 0 && last > first) candidates.push(value.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 已知的容器键：会话/凭据常被包一层。 */
const NESTS = ["session", "data", "secret", "auth", "credentials", "credential", "storage", "value", "account"];

/** 把嵌套结构摊平成一层字符串字段（最多 3 层，防止病态输入）。 */
export function unwrapFields(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return {};
  const flat = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number") flat[key] = String(item);
  }
  for (const nest of NESTS) {
    const child = value[nest];
    if (!child) continue;
    if (typeof child === "object" && !Array.isArray(child)) Object.assign(flat, unwrapFields(child, depth + 1));
    else if (typeof child === "string") {
      const inner = parseJson(child);
      if (inner) Object.assign(flat, unwrapFields(inner, depth + 1));
      else Object.assign(flat, cookieFields(child) ?? {});
    }
  }
  return flat;
}

function pick(fields, names) {
  for (const name of names) {
    const value = text(fields?.[name]);
    if (value) return value;
  }
  return "";
}

/**
 * 把一段粘贴文本解析成凭据：
 *  - 有 ssoSessionId/token → 会话（可以换模型凭据）
 *  - 只有 access/key/modelBearerToken → 死凭据
 * 解析不出任何东西返回 null。
 */
export function credentialOf(raw) {
  const value = text(raw);
  if (!value) return null;
  const json = parseJson(value);
  const fields = { ...(json ? unwrapFields(json) : {}), ...(cookieFields(value) ?? {}) };
  const accountId = pick(fields, ["accountId", "account_id", "accountid", "uid"]);
  const ssoSessionId = pick(fields, ["ssoSessionId", "sso_sessionid", "sessionId", "session_id"]);
  const token = pick(fields, ["token", "ssoToken", "sso_token"]);
  const key = pick(fields, ["access", "key", "modelBearerToken", "model_bearer_token", "bearerToken", "bearer_token", "apiKey", "api_key"]);
  const mobile = pick(fields, ["mobile", "phone", "phoneNum", "telephone"]);
  const nickname = pick(fields, ["nickname", "name", "userName", "username"]);
  if (!accountId && !ssoSessionId && !token && !key) return null;
  return { accountId, uid: pick(fields, ["uid"]) || accountId, ssoSessionId, token, key, mobile, nickname };
}

/** 看起来像本地路径（Windows 盘符 / UNC / POSIX / ~）。 */
export function looksLikePath(raw) {
  const value = text(raw);
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) return false;
  if (value.includes("=") && !value.includes(":\\")) return false;
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|~\.?[\\/])/.test(value) || /^~$/.test(value);
}

function homeOf() {
  return typeof process !== "undefined" ? text(process.env?.HOME || process.env?.USERPROFILE) : "";
}

async function readSmall(fs, path, size) {
  if (typeof size === "number" && size > MAX_LOCAL_BYTES) return "";
  const body = await fs.readFile(path, "utf8");
  return body.length > MAX_LOCAL_BYTES ? body.slice(0, MAX_LOCAL_BYTES) : body;
}

/** 广度优先收集候选文件（最多两层深、MAX_LOCAL_FILES 个），跳过明显无关的目录。 */
async function collectFiles(fs, dir, depth) {
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= MAX_LOCAL_FILES) break;
    const name = String(entry.name);
    if (name.startsWith(".") && name !== ".astudio") continue;
    if (/^(node_modules|Cache|Code Cache|GPUCache|blob_storage|logs?)$/i.test(name)) continue;
    const path = `${dir}/${name}`;
    if (entry.isDirectory()) {
      if (depth > 0) found.push(...await collectFiles(fs, path, depth - 1));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LOCAL_EXTS.has(name.slice(name.lastIndexOf(".")).toLowerCase()) && name.includes(".")) continue;
    found.push(path);
  }
  return found;
}

/**
 * 取本机登录态文本：
 *  - 不是路径 → 原样返回（面板里直接粘了 Cookie / JSON）
 *  - 是文件 → 读它
 *  - 是目录 → 在两层内找第一个「认得出会话或凭据」的文件
 */
export async function localCredentialText(raw) {
  const value = text(raw);
  if (!value) return "";
  if (!looksLikePath(value)) return value;
  const base = value.replace(/^~/, homeOf());
  let fs;
  try {
    fs = await import("node:fs/promises");
  } catch (error) {
    throw failed(`当前运行环境读不了本机文件：${describe(error)}`);
  }
  let info;
  try {
    info = await fs.stat(base);
  } catch (error) {
    throw failed(`读不到本机登录态路径（${base}）：${describe(error)}`);
  }
  if (!info.isDirectory()) return readSmall(fs, base, info.size);
  for (const file of await collectFiles(fs, base, 2)) {
    let body;
    try {
      body = await readSmall(fs, file);
    } catch {
      continue;
    }
    const credential = body ? credentialOf(body) : null;
    if (credential && (credential.ssoSessionId || credential.key)) return body;
  }
  throw failed(`在 ${base} 里没找到 AStudio 登录态：需要含 ssoSessionId / account_id 或 modelBearerToken 的文件`);
}
