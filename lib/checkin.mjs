/**
 * 每日登录签到：读配置 → 读余额 → 触发每日登录 → 等 2.5 秒 → 再读余额，按增量判定。
 * 上游是异步发积分，所以只有看到增量才报 claimed；读不到增量就如实说没观测到。
 */
import { CHECKIN_REWARD_WAIT_MS, INIT_APP, PLAN_CONFIG, POINTS_BALANCE } from "./endpoints.mjs";
import { numberOrNull } from "./catalog.mjs";
import { describe, isExpired, studioJson } from "./http.mjs";
import { pause } from "./scan.mjs";
import { keyOf, sessionOf } from "./session.mjs";

function credit(value) {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

async function readPoints(session, { signal } = {}) {
  try {
    const data = await studioJson(session, POINTS_BALANCE, { operation: "读取积分余额", signal });
    return { points: numberOrNull(data?.totalBalance), spark: numberOrNull(data?.sparkTotalBalance) };
  } catch (error) {
    if (isExpired(error)) throw error;
    return { points: null, spark: null };
  }
}

export async function checkinReport(auth, { signal } = {}) {
  if (!keyOf(auth)) {
    return { outcome: "failed", message: "AStudio 账号缺少模型凭据（modelBearerToken），请重新登录或粘贴" };
  }
  const session = sessionOf(auth);
  const live = Boolean(session && session.accountId && (session.ssoSessionId || session.token));
  if (!live) {
    return { outcome: "ineligible", message: "该账号只有模型凭据（没有网页会话），无法执行每日登录签到" };
  }

  let config;
  try {
    config = await studioJson(session, PLAN_CONFIG, { operation: "读取每日登录配置", signal });
  } catch (error) {
    if (isExpired(error)) throw Object.assign(new Error(describe(error)), { signIn: "expired" });
    return { outcome: "failed", message: describe(error) };
  }
  if (config?.dailyLoginEnabled === false) {
    return { outcome: "inactive", message: "当前没有每日登录积分活动" };
  }

  const before = await readPoints(session, { signal });
  if (before.points === null && before.spark === null) {
    return { outcome: "failed", message: "签到前积分余额读数不完整" };
  }

  try {
    await studioJson(session, INIT_APP, { method: "POST", operation: "每日登录", signal });
  } catch (error) {
    if (isExpired(error)) throw Object.assign(new Error(describe(error)), { signIn: "expired" });
    return { outcome: "failed", message: `每日登录失败：${describe(error)}` };
  }

  await pause(CHECKIN_REWARD_WAIT_MS, signal);
  const after = await readPoints(session, { signal });

  const deltas = [];
  let comparable = 0;
  if (before.points !== null && after.points !== null) {
    comparable += 1;
    const delta = after.points - before.points;
    if (delta > 0) deltas.push(`通用积分 +${credit(delta)}`);
  }
  if (before.spark !== null && after.spark !== null) {
    comparable += 1;
    const delta = after.spark - before.spark;
    if (delta > 0) deltas.push(`星火积分 +${credit(delta)}`);
  }
  if (deltas.length) {
    const text = deltas.join("，");
    return { outcome: "claimed", credit: text, message: `每日登录奖励已到账：${text}` };
  }
  if (!comparable) {
    return { outcome: "failed", message: "签到前后积分读数不完整，无法确认奖励到账" };
  }
  // 上游异步发积分，没看到增量不代表失败：按 done 记录，让签到中心看到“已执行”。
  return { outcome: "done", message: "每日登录已执行，但未观测到新增积分（可能今日已领取或暂未到账）" };
}
