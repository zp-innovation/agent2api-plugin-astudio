/**
 * AStudio 账号的会话与凭据。
 *
 * 扫码登录拿到的就是「账号面会话」：只有 ssoSessionId 与 uid，没有网页 token。
 * uid 即 account_id。模型凭据（modelBearerToken）用这份 Cookie 会话换出来，
 * 所以 secret 里同时保存会话与凭据：凭据到期/被拒时可以再换一次，不必重新扫码。
 */
import {
  AUTH_BEARER_TOKEN, INIT_APP, MODEL_CONFIGS, PROVIDER_ID, REFRESH_MARK, TOKEN_TTL_MS, USER_INFO,
} from "./endpoints.mjs";
import { directoryKey as pickDirectoryKey, directoryRows } from "./catalog.mjs";
import { describe, expired, failed, isExpired, scalar, studioJson, text } from "./http.mjs";

/** 从账号 secret 里还原会话；没有会话返回 null。 */
export function sessionOf(auth) {
  const raw = auth?.session ?? auth?.metadata?.session;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const accountId = text(raw.accountId);
  const ssoSessionId = text(raw.ssoSessionId);
  const token = text(raw.token);
  if (!accountId && !ssoSessionId && !token) return null;
  return { accountId, uid: text(raw.uid) || accountId, ssoSessionId, token };
}

export function keyOf(auth) {
  return text(auth?.access) || text(auth?.key);
}

export function hasSession(auth) {
  const session = sessionOf(auth);
  return Boolean(session && session.accountId && (session.ssoSessionId || session.token));
}

/** 用 Cookie 会话换模型凭据。 */
export async function mintToken(session, { signal } = {}) {
  const data = await studioJson(session, AUTH_BEARER_TOKEN, { method: "POST", operation: "换取模型凭据", signal });
  const token = text(data?.modelBearerToken);
  if (!token) throw failed("AStudio 没有返回模型凭据（modelBearerToken 为空）");
  return token;
}

/** 换不到模型凭据时，退到账号目录里的 api_key。 */
export async function directoryFallbackKey(session, { signal } = {}) {
  const data = await studioJson(session, MODEL_CONFIGS, { operation: "读取 AStudio 账号模型目录", signal });
  const key = pickDirectoryKey(directoryRows(data));
  if (!key) throw failed("这个 AStudio 账号没有可用的模型凭据（模型 token 与目录 api_key 都为空）");
  return key;
}

/** 登录收尾：封禁检查 → 补用户信息 → 铸模型凭据。 */
export async function settle(input, { requireWebToken = false, signal } = {}) {
  const account = {
    accountId: text(input?.accountId),
    uid: text(input?.uid) || text(input?.accountId),
    ssoSessionId: text(input?.ssoSessionId),
    token: text(input?.token),
    mobile: text(input?.mobile),
    nickname: text(input?.nickname),
  };
  if (!account.accountId || (requireWebToken && !account.token)) {
    throw failed("AStudio 登录返回不完整（缺少账号或令牌）");
  }
  let banned = false;
  try {
    const data = await studioJson(account, INIT_APP, { method: "POST", operation: "初始化账号", signal });
    banned = data?.banned === true;
  } catch {
    /* 封禁探测失败不阻断登录，与官方实现一致 */
  }
  if (banned) throw failed("AStudio 账号已被封禁");
  if (!account.uid || !account.mobile || !account.nickname) {
    try {
      const value = await studioJson(account, USER_INFO, { operation: "读取用户信息", signal });
      const info = value && typeof value === "object" && value.userInfo && typeof value.userInfo === "object" ? value.userInfo : value;
      if (!account.uid) account.uid = scalar(info?.uid);
      if (!account.mobile) account.mobile = text(info?.mobile) || text(info?.telephone);
      if (!account.nickname) account.nickname = text(info?.nickname) || text(info?.username);
    } catch {
      /* 用户信息只是锦上添花 */
    }
  }
  let key = "";
  try {
    key = await mintToken(account, { signal });
  } catch (error) {
    if (isExpired(error)) throw error;
  }
  if (!key) key = await directoryFallbackKey(account, { signal });
  return { ...account, key };
}

/**
 * 把 settle 的结果包装成宿主能落盘的 secret：
 * access = modelBearerToken（对话用）、refresh = 可重铸标记（oauth 型账号）、
 * session = 账号面会话（余额/签到/目录用）。
 */
export function accountSecret(account, { source = "scan" } = {}) {
  const key = text(account?.key);
  if (!key) throw failed("这个 AStudio 账号没有可用的模型凭据（模型 token 与目录 api_key 都为空）");
  const uid = text(account.uid) || text(account.accountId);
  const secret = {
    type: "oauth",
    access: key,
    refresh: REFRESH_MARK,
    expires: Date.now() + TOKEN_TTL_MS,
    name: text(account.nickname) || text(account.mobile) || uid || PROVIDER_ID,
    uid,
    accountId: text(account.accountId) || uid,
    source,
    session: {
      accountId: text(account.accountId) || uid,
      uid,
      ssoSessionId: text(account.ssoSessionId),
      token: text(account.token),
    },
    metadata: { provider: PROVIDER_ID, source },
  };
  if (text(account.mobile)) secret.mobile = text(account.mobile);
  if (text(account.nickname)) secret.nickname = text(account.nickname);
  return secret;
}

/**
 * hooks.auth.refresh：凭据到期或上游 401 时，用会话重铸一次。
 * 会话本身失效（401/403 或 code=80000）才算登录过期。
 */
export async function renew(auth, { signal } = {}) {
  const session = sessionOf(auth);
  if (!session || !session.accountId || (!session.ssoSessionId && !session.token)) {
    throw Object.assign(new Error("这个 AStudio 账号没有可续期的网页会话，请重新登录"), { signIn: "expired" });
  }
  let key = "";
  try {
    key = await mintToken(session, { signal });
  } catch (error) {
    if (isExpired(error)) throw Object.assign(new Error(describe(error)), { signIn: "expired" });
    throw error;
  }
  if (!key) {
    try {
      key = await directoryFallbackKey(session, { signal });
    } catch (error) {
      if (isExpired(error)) throw Object.assign(new Error(describe(error)), { signIn: "expired" });
      throw error;
    }
  }
  return {
    type: "oauth",
    access: key,
    refresh: REFRESH_MARK,
    expires: Date.now() + TOKEN_TTL_MS,
    session: {
      accountId: session.accountId,
      uid: session.uid,
      ssoSessionId: session.ssoSessionId,
      token: session.token,
    },
  };
}

export { expired, isExpired };
