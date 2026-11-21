/**
 * 旧账号凭据升级。
 *
 * wasm 版 AStudio 包落盘的是 {key, session, source, uid}，既没有 refresh 也没有
 * expires，宿主按 host/auth-record.mjs:28-45 判成 api 型；而「401 自动续期」只认
 * oauth 型（host/allowance.mjs:29-38）。于是这些账号的 modelBearerToken 一旦过期，
 * 就只能重新登录。
 *
 * 插件接管 astudio 之后，趁一次 usage 读数把它们补成 oauth 型：先用会话换一次新凭据
 * （这一步同时验证了会话还活着），换到了才改形状 —— 会话已经死掉的账号保持原样，
 * 免得把一个「还能用一会儿」的 api 型账号改成「每次请求都要续期、续期必失败」的
 * oauth 型账号。
 */
import { REFRESH_MARK, TOKEN_TTL_MS } from "./endpoints.mjs";
import { describe, text } from "./http.mjs";
import { hasSession, keyOf, mintToken, sessionOf } from "./session.mjs";

/** 解 base64url（不依赖 Buffer，宿主与测试环境都能跑）。 */
function decodeSegment(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === "function") return atob(padded);
  return Buffer.from(padded, "base64").toString("binary");
}

/**
 * 模型凭据的到期时间（毫秒）。modelBearerToken 是 JWT，exp 就是上游认的过期点；
 * 解不出来（不是 JWT / 没有 exp / 环境不支持）返回 0，调用方回落到 TOKEN_TTL_MS。
 */
export function expiryOf(token, now = Date.now()) {
  const parts = text(token).split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(decodeSegment(parts[1]));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return 0;
    const ms = exp * 1000;
    // 已经过期的 JWT 不能直接搬过来，否则第一次请求就会被判成需要重新登录。
    return ms > now ? ms : 0;
  } catch {
    return 0;
  }
}

/**
 * 需要升级时返回新的 secret，否则返回 null。
 *
 * 只升级「有会话、有凭据、但还不是 oauth 型」的老账号：扫码登录产生的新账号本身
 * 就是 oauth 型，不会再被这里碰一次。
 */
export function legacySecret(auth, now = Date.now()) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const key = keyOf(auth);
  if (!key) return null;
  if (text(auth.refresh)) return null;
  if (!hasSession(auth)) return null;
  const source = text(auth.metadata?.source) || text(auth.source) || "legacy";
  return {
    ...auth,
    key,
    access: key,
    refresh: REFRESH_MARK,
    expires: expiryOf(key, now) || now + TOKEN_TTL_MS,
    type: "oauth",
    metadata: { ...(auth.metadata && typeof auth.metadata === "object" ? auth.metadata : {}), source },
  };
}

/** 每个账号在每个进程里最多试几次、间隔多久，避免会话已死时反复打上游。 */
const attempts = new Map();
const COOLDOWN_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

/** 只给测试用：清掉进程内的重试计数。 */
export function resetLegacyAttempts() {
  attempts.clear();
}

/**
 * 尝试把一个老账号升级成 oauth 型；返回是否真的写了新凭据。
 *
 * mint 默认是 session.mjs 的 mintToken（用 Cookie 会话换 modelBearerToken），
 * 测试里换成桩函数即可，不会出网。
 */
export async function upgradeLegacy(auth, { save, log = () => {}, now = Date.now(), mint = mintToken } = {}) {
  if (!legacySecret(auth)) return false;
  const id = text(auth?.session?.accountId) || text(auth?.uid) || "account";
  const state = attempts.get(id);
  if (state && (state.count >= MAX_ATTEMPTS || now - state.at < COOLDOWN_MS)) return false;
  attempts.set(id, { count: (state?.count ?? 0) + 1, at: now });
  let key;
  try {
    key = await mint(sessionOf(auth));
  } catch (error) {
    log(`AStudio 老账号凭据升级跳过（会话不可用）：${describe(error)}`);
    return false;
  }
  const next = legacySecret({ ...auth, key });
  if (!next || !key) return false;
  await save(next);
  return true;
}
