/**
 * 额度报告：账号面有会话就用 points/balance + membership/me（余额与会员），
 * 只有模型凭据（粘贴进来的账号）时用一次目录请求探活，等价于官方的行为。
 *
 * ── 两层读数，各有各的用途（别混）─────────────────────────────
 * 1) `windows` 是账号明细里逐行展示的读数。积分是「余额型」窗口，标
 *    `aside: true`：它不参与配额拦截，避免某一池为 0 时被当成整体不可用
 *    （宿主 `accounts_list/balance.rs` 的 ratio 口径也会跳过 aside 行）。
 * 2) 顶层 `balance` 是**一个数**，宿主 `reports.mjs:37` 把它映射成
 *    `usage.available`：面板每个分组右侧的「可用合计」就是按它求和的
 *    （前端 `KTe`／后端 `accounts_list/balance.rs:40`：`totalLeft` 优先，
 *    其次 `available`，两个都读不到就记「计入 0/N」并显示「—」）。
 *    所以这一层必须有值 —— 少了它，这张卡在账号页永远显示「—」。
 *
 *    取值是**两个积分池之和**：通用积分是主池，星火积分是另一只可花的池子，
 *    只报哪一个都会在另一只为 0 时把合计算小。副作用要说清：`available` 同时
 *    是选路「余额不足跳过」的依据（阈值 1，mode=skip），所以两池同时为 0 时
 *    账号会被跳过 —— 那本来也打不动请求，符合预期。
 * 3) `credits` 是 WorkBuddy 式积分明细。新镜像宿主 `reports.mjs` 已把
 *    credits[] 原样透给面板（name/unit/total/remain/expireAt/…），面板据此画
 *    「7天 N」角标与「X 天后到期」标签。AStudio 上游只给活动积分的绝对到期
 *    时刻 activityNextExpireTime，照实上报：进入 7 天内时面板会自动按 WorkBuddy
 *    的口径显示倒计时，未进入前显示绝对到期日期（不伪造一个 7 天批次）。
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
  const credits = [];
  const failures = [];
  let balance = null;
  if (points.status === "fulfilled") {
    const total = numberOrNull(points.value?.totalBalance);
    const activity = numberOrNull(points.value?.activityBalance);
    const expireAt = points.value?.activityNextExpireTime;
    if (total !== null) {
      const row = { name: "通用积分", group: "积分", balance: total, unit: "积分", aside: true };
      if (activity !== null && activity > 0 && expireAt) {
        row.runsOutAt = expireAt;
        row.runsOut = activity;
        // WorkBuddy 式明细：同一笔活动积分，带绝对到期时刻。宿主 reports.mjs
        // 会把 expireAt 经 timestamp() 转成毫秒，面板的 7 天窗口判定据此生效。
        credits.push({ name: "通用积分", unit: "积分", total, remain: activity, expireAt });
      }
      windows.push(row);
    }
    const spark = numberOrNull(points.value?.sparkTotalBalance);
    if (spark !== null) {
      windows.push({ name: "星火积分", group: "积分", balance: spark, unit: "积分", aside: true });
      if (spark > 0) credits.push({ name: "星火积分", unit: "积分", total: spark, remain: spark });
    }
    if (total !== null || spark !== null) balance = (total ?? 0) + (spark ?? 0);
    else failures.push("积分余额读数不完整");
  } else {
    failures.push(describe(points.reason));
  }

  const report = { plan: PROVIDER_NAME, windows, unit: "积分" };
  if (balance !== null) report.balance = balance;
  if (credits.length) report.credits = credits;
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
