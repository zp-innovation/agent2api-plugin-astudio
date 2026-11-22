/**
 * 额度报告：账号面有会话就用 points/balance + membership/me（余额与会员），
 * 只有模型凭据（粘贴进来的账号）时用一次目录请求探活，等价于官方的行为。
 *
 * ── 三层读数，各有各的用途（别混）─────────────────────────────
 * 1) **不再上报 `windows`。** 面板 LOe() 的分支顺序是 totalLeft → windows → available：
 *    `windows` 非空就会渲染「分窗口额度」整块卡片（体验版 / 额度详情 / 通用积分 /
 *    星火积分 / 分窗口额度）。用户要的是 WorkBuddy / AutoClaw 那种**一条胶囊 + 弹窗**
 *    的形态，所以这里不发 windows，让面板直接落到 available 分支，胶囊上只显示
 *    「可用 N 积分」。积分明细改由 credits（见第 3 层）在弹窗里展示。
 *
 * 2) 顶层 `balance` 是**一个数**，宿主 reports.mjs:37 把它映射成
 *    `usage.available`：面板每个分组右侧的「可用合计」就是按它求和的
 *    （前端 KTe／后端 accounts_list/balance.rs:40：totalLeft 优先，其次 available，
 *    两个都读不到就记「计入 0/N」并显示「—」）。所以这一层必须有值 —— 少了它，
 *    这张卡在账号页永远显示「—」。
 *
 *    取值是**两个积分池之和**：通用积分是主池，星火积分是另一只可花的池子，
 *    只报哪一个都会在另一只为 0 时把合计算小。副作用要说清：available 同时
 *    是选路「余额不足跳过」的依据（阈值 1，mode=skip），所以两池同时为 0 时
 *    账号会被跳过 —— 那本来也打不动请求，符合预期。
 *
 * 3) `credits` 是 WorkBuddy 式积分明细。新镜像宿主 reports.mjs 已把
 *    credits[] 原样透给面板（name/unit/total/remain/startAt/expireAt/…），面板据此画
 *    「7天 N」角标与「X 天后到期」标签（bundle 的 v7/hC/w7/qOe）。
 *    AStudio 上游 points/balance 只给活动积分的**聚合**到期时刻，往往在 7 天之外，
 *    所以还要读 points/details 的逐笔发放批次：每笔自带 createTime/expireTime。
 *    逐笔读失败就退回聚合行 —— 展示增强不能让余额查询本身报错。
 *    同池子的多笔发放合并成一条：先按（名称+到期+生效+数额+剩余）去重，再按池子
 *    汇总（total/remain 相加、expireAt 取最近、startAt 取最早），最终每个池子一条，
 *    与 AutoClaw / WorkBuddy 的形态一致。
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

/**
 * 逐笔发放批次 → WorkBuddy 口径的 credits 行。
 *
 * ── 为什么要收敛成一条 ───────────────────────────────────
 * AStudio 的 points/details 把每一次发放都摊开：实测一个账号有 7 笔「每日登录赠送」
 * 加 1 笔「客户端下载奖励」，8 行明细在弹窗里就是 8 条重复读数。面板 WorkBuddy /
 * AutoClaw 的形态是**一条**：同一池子的批次合并成一行，重复的批次去掉。
 * 所以这里做两步：
 *   1) 去重：同名 + 同到期 + 同数额的批次只留一条；
 *   2) 合并：同池子的不同批次汇总（total/remain 相加，到期取**最近**的一笔，
 *      生效时间取最早的一笔），最终每个积分池只出一行。
 * 任何失败都返回空表（让调用方回退聚合行）——展示增强不能让余额查询报错。
 */
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
      rows.push({
        name,
        pool: text(item.assetCode) === "SPARK_POINTS" ? "spark" : "general",
        unit: "积分",
        total: amount,
        remain: remainOf(item, amount),
        startAt: startAt ?? null,
        expireAt,
      });
      if (rows.length >= MAX_CREDIT_ROWS) break;
    }
    return collapseCredits(rows);
  } catch {
    return [];
  }
}

/** 去重 + 按池子合并成一行；行内没有的字段不出现（别给面板塞空值）。 */
function collapseCredits(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = [row.name, row.expireAt, row.startAt ?? "", row.total, row.remain].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const byPool = new Map();
  for (const row of unique) {
    let pool = byPool.get(row.pool);
    if (!pool) {
      pool = { name: row.pool === "spark" ? "星火积分" : "通用积分", unit: "积分", total: 0, remain: 0, startAt: null, expireAt: row.expireAt };
      byPool.set(row.pool, pool);
    }
    pool.total += row.total;
    pool.remain += row.remain;
    if (row.expireAt < pool.expireAt) pool.expireAt = row.expireAt;
    if (row.startAt && (!pool.startAt || row.startAt < pool.startAt)) pool.startAt = row.startAt;
  }

  const collapsed = [...byPool.values()];
  collapsed.sort((a, b) => (a.expireAt < b.expireAt ? -1 : a.expireAt > b.expireAt ? 1 : 0));
  for (const row of collapsed) {
    if (!row.startAt) delete row.startAt;
  }
  return collapsed;
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
      return { plan: PROVIDER_NAME };
    } catch (error) {
      if (isExpired(error)) return { signIn: "expired", error: "AStudio 拒绝了这份凭据（HTTP 401/403），请重新登录" };
      return { error: `AStudio 不可达：${describe(error)}` };
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

  const failures = [];
  let balance = null;
  let spark = null;
  let activity = null;
  let expireAt = null;
  if (points.status === "fulfilled") {
    const total = numberOrNull(points.value?.totalBalance);
    activity = numberOrNull(points.value?.activityBalance);
    expireAt = points.value?.activityNextExpireTime;
    spark = numberOrNull(points.value?.sparkTotalBalance);
    if (total !== null || spark !== null) balance = (total ?? 0) + (spark ?? 0);
    else failures.push("积分余额读数不完整");
  } else {
    failures.push(describe(points.reason));
  }

  // 逐笔明细与余额并行请求，省一次往返；失败静默，下面用聚合行兜底。
  const detailRows = live && points.status === "fulfilled" ? await detailCredits(session, signal) : [];
  const credits = detailRows.length ? detailRows : aggregateCredits(activity, expireAt, spark);

  const report = { plan: PROVIDER_NAME, unit: "积分" };
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