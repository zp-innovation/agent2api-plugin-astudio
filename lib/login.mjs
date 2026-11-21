/**
 * 登录方式的实现。宿主只接受两种返回形态：
 *  - authorize 返回 { method: "auto", callback }：宿主立刻在后台跑 callback，
 *    这就是扫码登录能把结果送回宿主的唯一通道（poll 自己不能把流程置成 done）。
 *  - 返回 { method: "code", ... }：等用户粘贴回调地址，扫码用不到。
 *
 * 动态提示：宿主 poll() 的 hint 取 authorization.instructions，且要求它不在
 * start 时烘进 flow 的文案里 —— 所以这里用 getter 暴露一个会变的提示字符串。
 */
import { POLL_INTERVAL_MS, PROVIDER_NAME, QR_TTL_MS } from "./endpoints.mjs";
import { describe, fetchCatalog, isExpired, text } from "./http.mjs";
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
