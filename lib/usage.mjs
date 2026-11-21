/**
 * 额度报告：账号面有会话就用 points/balance + membership/me（余额与会员），
 * 只有模型凭据（粘贴进来的账号）时用一次目录请求探活，等价于官方的行为。
 *
 * 积分是「余额型」窗口：不参与配额拦截（aside），避免某一池为 0 时误判整体不可用。
 */
import { MEMBERSHIP_ME, POINTS_BALANCE, PROVIDER_NAME } from "./endpoints.mjs";
import { numberOrNull } from "./catalog.mjs";
import { describe, fetchCatalog, isExpired, studioJson, text } from "./http.mjs";
import { keyOf, sessionOf } from "./session.mjs";

export async function usageReport(auth, { signal } = {}) {
  const key = keyOf(auth);
  if (!key) {
    return { signIn: "expired", error: "AStudio 账号缺少模型凭据（modelBearerToken），请重新登录或粘贴" };
  }
  const session = sessionOf(auth);
  const live = Boolean(session && session.accountId && (session.ssoSessionId || session.token));
  if (!live) {
    try {
      await fetchCatalog(key, { signal });
      return { plan: PROVIDER_NAME, windows: [] };
    } catch (error) {
      if (isExpired(error)) return { signIn: "expired", error: "AStudio 拒绝了这份凭据（HTTP 401/403），请重新登录" };
      return { windows: [], error: `AStudio 不可达：${describe(error)}` };
    }
  }

  const [points, membership] = await Promise.allSettled([
    studioJson(session, POINTS_BALANCE, { operation: "读取积分余额", signal }),
    studioJson(session, MEMBERSHIP_ME, { operation: "读取会员信息", signal }),
  ]);
  for (const item of [points, membership]) {
    if (item.status === "rejected" && isExpired(item.reason)) {
      return { signIn: "expired", error: describe(item.reason) };
    }
  }

  const windows = [];
  const failures = [];
  if (points.status === "fulfilled") {
    const total = numberOrNull(points.value?.totalBalance);
    const activity = numberOrNull(points.value?.activityBalance);
    const expireAt = points.value?.activityNextExpireTime;
    if (total !== null) {
      const row = { name: "通用积分", group: "积分", balance: total, unit: "积分", aside: true };
      if (activity !== null && activity > 0 && expireAt) {
        row.runsOutAt = expireAt;
        row.runsOut = activity;
      }
      windows.push(row);
    }
    const spark = numberOrNull(points.value?.sparkTotalBalance);
    if (spark !== null) windows.push({ name: "星火积分", group: "积分", balance: spark, unit: "积分", aside: true });
    if (total === null && spark === null) failures.push("积分余额读数不完整");
  } else {
    failures.push(describe(points.reason));
  }

  const report = { plan: PROVIDER_NAME, windows };
  if (membership.status === "fulfilled") {
    const plan = text(membership.value?.planName);
    if (plan) report.plan = plan;
    const until = membership.value?.endTime;
    if (until !== undefined && until !== null && until !== "") report.until = until;
    const user = text(membership.value?.uid) || text(session.accountId);
    if (user) report.user = user;
  } else {
    failures.push(describe(membership.reason));
  }
  if (failures.length) report.error = failures.join("；");
  return report;
}
