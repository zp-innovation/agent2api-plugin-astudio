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
 *    credits[] 原样透给面板（name/unit/total/remain/startAt/expireAt/…），面板据此画
 *    「7天 N」角标与「X 天后到期」标签（bundle 的 v7/hC/w7/qOe）。
 *    AStudio 上游 points/balance 只给活动积分的**聚合**到期时刻，往往在 7 天之外，
 *    所以还要读 points/details 的逐笔发放批次：每笔自带 createTime/expireTime，
 *    这才等价于 AutoClaw 参考会话里 expiring-instances 的作用。逐笔读失败就退回
 *    聚合行 —— 展示增强不能让余额查询本身报错。
 */
import { MEMBERSHIP_ME, POINTS_BALANCE, POINTS_DETAILS, PROVIDER_NAME } from "./endpoints.mjs";
import { numberOrNull } from "./catalog.mjs";
import { describe, fetchCatalog, isExpired, studioJson, text } from "./http.mjs";
import { keyOf, sessionOf } from "./session.mjs";

/** 逐笔明细最多展示多少条：面板弹层滚动区撑得住，再多没意义。 */
const MAX_CREDIT_ROWS = 100;

/**
 * AStudio 给的时间串没有时区后缀（例 2026-12-24T00:04:21），实际是北京时间。
 * 宿主 reports.mjs 的 timestamp() 走 Date.parse —— 不补时区就会被当成容器 UTC，
 * 倒计时整体错 8 小时。已有 Z/±HH:mm 的就原样留着。
 */
function absoluteTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const s = text(value);
  if (!s) return null;
  const normalized = s.replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : normalized + "+08:00";
}

/** 一笔发放扣掉已消费的部分才是真正还剩下的（deductions 的形状上游不稳定，读不到就按原额）。 */
function remainOf(item, amount) {
  const deductions = Array.isArray(item?.deductions) ? item.deductions : [];
  let used = 0;
  let saw = false;
  for (const entry of deductions) {
    const value = numberOrNull(entry?.amount ?? entry?.value ?? entry?.points ?? entry?.deductAmount);
    if (value !== null && value > 0) { used += value; saw = true; }
  }
  return saw ? Math.max(0, amount - used) : amount;
}

/** 逐笔发放批次 → WorkBuddy 口径的 credits 行；任何失败都返回空表（让调用方回退聚合行）。 */
async function detailCredits(session, signal) {
  try {
    const query = "?pageNum=1&pageSize=" + MAX_CREDIT_ROWS + "&direction=CREDIT";
    const data = await studioJson(session, POINTS_DETAILS + query, { operation: "读取积分明细", signal });
    const items = Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.list) ? data.list
      : Array.isArray(data?.records) ? data.records : [];
    const rows = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (text(item.direction) && text(item.direction) !== "CREDIT") continue;
      const amount = numberOrNull(item.amount);
      if (amount === null || amount <= 0) continue;
      const expireAt = absoluteTime(item.expireTime ?? item.expirationTime);
      if (!expireAt) continue;
      const startAt = absoluteTime(item.createTime ?? item.grantTime);
      const name = text(item.reason) || text(item.sourceType)
        || (text(item.assetCode) === "SPARK_POINTS" ? "星火积分" : "通用积分");
      const row = { name, unit: "积分", total: amount, remain: remainOf(item, amount), expireAt };
      if (startAt) row.startAt = startAt;
      rows.push(row);
      if (rows.length >= MAX_CREDIT_ROWS) break;
    }
    return rows;
  } catch {
    return [];
  }
}

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
  let balance = null;
  let spark = null;
  let activity = null;
  let expireAt = null;
  if (points.status === "fulfilled") {
    const total = numberOrNull(points.value?.totalBalance);
    activity = numberOrNull(points.value?.activityBalance);
    expireAt = points.value?.activityNextExpireTime;
    if (total !== null) {
      const row = { name: "通用积分", group: "积分", balance: total, unit: "积分", aside: true };
      if (activity !== null && activity > 0 && expireAt) {
        row.runsOutAt = expireAt;
        row.runsOut = activity;
      }
      windows.push(row);
    }
    spark = numberOrNull(points.value?.sparkTotalBalance);
    if (spark !== null) {
      windows.push({ name: "星火积分", group: "积分", balance: spark, unit: "积分", aside: true });
    }
    if (total !== null || spark !== null) balance = (total ?? 0) + (spark ?? 0);
    else failures.push("积分余额读数不完整");
  } else {
    failures.push(describe(points.reason));
  }

  // 逐笔明细与余额并行请求，省一次往返；失败静默，下面用聚合行兜底。
  const detailRows = live && points.status === "fulfilled" ? await detailCredits(session, signal) : [];
  const credits = detailRows.length ? detailRows : aggregateCredits(activity, expireAt, spark);

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

/** points/details 拿不到时的降级：只用聚合口径，不伪造逐笔批次。 */
function aggregateCredits(activity, expireAt, spark) {
  const rows = [];
  if (activity !== null && activity > 0 && expireAt) {
    rows.push({ name: "通用积分", unit: "积分", total: activity, remain: activity, expireAt: absoluteTime(expireAt) });
  }
  if (spark !== null && spark > 0) rows.push({ name: "星火积分", unit: "积分", total: spark, remain: spark });
  return rows;
}