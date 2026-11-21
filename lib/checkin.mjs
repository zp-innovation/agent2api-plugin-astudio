/**
 * 每日登录签到：读配置 → 读余额 → 触发每日登录 → 领取推广位里的登录积分 → 再读余额。
 *
 * 关键（2026-11-21 实测）：tenant-app/v2/init-app 只记录「今天登录过」，不发积分。
 * 积分在推广服务里，必须把当天的 DAILY_REWARD_DIALOG 待领取项 complete 掉才到账；
 * 客户端左下角「限时每日福利 · 今日可领 100 积分 · 领取」点的那一下就是这个请求。
 * 只调 init-app 的账号会出现「面板显示已签到、余额没变」的假成功。
 */
import {
  CHECKIN_REWARD_WAIT_MS,
  CLIENT_POPUPS_COMPLETE,
  CLIENT_POPUPS_PENDING,
  INIT_APP,
  PLAN_CONFIG,
  POINTS_BALANCE,
} from "./endpoints.mjs";
import { numberOrNull } from "./catalog.mjs";
import { describe, isExpired, studioJson } from "./http.mjs";
import { pause } from "./scan.mjs";
import { keyOf, sessionOf } from "./session.mjs";

/** 推广位里代表「登录积分」的组件类型；popupCode 兜底匹配 REWARD。 */
const REWARD_COMPONENTS = new Set(["DAILY_REWARD_DIALOG"]);

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

function rewardItems(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.popups) ? data.popups : [];
  return list.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (REWARD_COMPONENTS.has(item.componentType)) return true;
    return typeof item.popupCode === "string" && /REWARD/i.test(item.popupCode);
  });
}

async function pendingRewards(session, { signal } = {}) {
  const data = await studioJson(session, CLIENT_POPUPS_PENDING, { operation: "读取待领取的登录积分", signal });
  return rewardItems(data);
}

/**
 * 领取今天待发的登录积分（客户端「领取」按钮的同一条请求）。
 * 返回领取成功的条数；任何一条失败都会抛错，由调用方决定怎么报。
 */
export async function claimDailyRewards(session, { signal } = {}) {
  const rewards = await pendingRewards(session, { signal });
  let claimed = 0;
  for (const item of rewards) {
    const popupId = Number(item.popupId);
    const instanceKey = typeof item.instanceKey === "string" ? item.instanceKey.trim() : "";
    if (!Number.isFinite(popupId) || !instanceKey) continue;
    await studioJson(session, CLIENT_POPUPS_COMPLETE, {
      method: "POST",
      operation: "领取每日登录积分",
      signal,
      body: JSON.stringify({ popupId, instanceKey, completed: true }),
    });
    claimed += 1;
  }
  return claimed;
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

  // 真正发积分的一步。失败不回滚登录（登录本身已经成功），单独如实上报。
  let claimedRewards = 0;
  let claimError = "";
  try {
    claimedRewards = await claimDailyRewards(session, { signal });
  } catch (error) {
    if (isExpired(error)) throw Object.assign(new Error(describe(error)), { signIn: "expired" });
    claimError = describe(error);
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
  if (claimedRewards > 0) {
    // 服务端已经确认领取，只是余额还没刷新（上游异步记账）。
    return {
      outcome: "claimed",
      message: `已领取今日登录积分（服务端确认 ${claimedRewards} 项奖励），积分读数暂未更新，稍后刷新可见`,
    };
  }
  if (claimError) {
    return { outcome: "failed", message: `登录成功，但没有领到登录积分：${claimError}` };
  }
  if (!comparable) {
    return { outcome: "failed", message: "签到前后积分读数不完整，无法确认奖励到账" };
  }
  return { outcome: "done", message: "今日登录已完成，没有待领取的登录积分（今天已经领过）" };
}
