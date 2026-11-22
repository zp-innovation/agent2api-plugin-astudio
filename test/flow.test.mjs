import assert from "node:assert/strict";
import test from "node:test";

import { authorizeScan } from "../lib/login.mjs";
import { renew, settle } from "../lib/session.mjs";
import { HINTS, hostOf, identitiesOf } from "../lib/scan.mjs";
import { usageReport } from "../lib/usage.mjs";
import { checkinReport } from "../lib/checkin.mjs";

const ok = (data) => ({ flag: true, code: 0, desc: "", data });
const busy = (code, desc) => ({ flag: false, code, desc, data: null });

/** 用一张「按路径派发」的假上游替换全局 fetch（插件里全部出网都走全局 fetch）。 */
function stub(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = method + " " + url.pathname;
    calls.push({ key, url });
    const handler = routes[key];
    if (!handler) return new Response("unexpected " + key, { status: 500 });
    const body = typeof handler === "function" ? await handler({ url, init, calls }) : handler;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test("scan sign-in completes end to end and reports the hint of each poll", async () => {
  let polls = 0;
  const seen = [];
  const holder = { auth: null };
  const world = stub({
    "GET /SSOService/wx/scanlogin/qrcode": ok("https://sso.xfyun.cn/static/qr/abc.png"),
    "GET /SSOService/wx/scanlogin/uids": () => {
      polls += 1;
      seen.push(holder.auth?.instructions);
      return polls === 1
        ? busy(20003, "请求地址错误")
        : ok({ infoList: [{ uid: 0, ssoSessionId: "placeholder" }, { uid: "10086", ssoSessionId: "sid-1" }], headimgurl: "" });
    },
    "POST /xingchen-studio/auth/bearer-token": ok({ modelBearerToken: "bearer-1" }),
    "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
    "GET /xingchen-studio/userInfo": ok({ userInfo: { uid: 10086, mobile: "13800000000", nickname: "星辰" } }),
  });
  try {
    const authorization = await authorizeScan(undefined, {});
    holder.auth = authorization;
    assert.equal(authorization.method, "auto");
    assert.equal(authorization.url, "https://sso.xfyun.cn/static/qr/abc.png");
    assert.equal(hostOf(authorization.url), "sso.xfyun.cn");
    assert.equal(authorization.instructions, HINTS.ready);

    const result = await authorization.callback();
    assert.equal(result.type, "success");
    assert.equal(result.access, "bearer-1");
    assert.equal(typeof result.refresh, "string");
    assert.ok(result.expires > Date.now());
    assert.equal(result.uid, "10086");
    assert.equal(result.accountId, "10086");
    assert.equal(result.name, "星辰");
    assert.deepEqual(result.session, { accountId: "10086", uid: "10086", ssoSessionId: "sid-1", token: "" });
    assert.equal(result.source, "scan");

    // 第一次轮询就已经是「等待扫码」：start 时的 ready 文案会被宿主去重（与流程文案
    // 相同就不显示），靠它会让面板前 1.5 秒显示宿主的默认提示。
    assert.deepEqual(seen, [HINTS.waiting, HINTS.waiting]);
    // 换凭据期间提示停在「正在换取模型凭据」，直到 callback 落定
    assert.equal(authorization.instructions, HINTS.settling);

    // SSO 请求不带 Cookie，也不带 clientType/studioVersion
    const sso = world.calls.filter((call) => call.url.hostname === "sso.xfyun.cn");
    assert.equal(sso.length, 3);
    for (const call of sso) {
      assert.equal(call.url.searchParams.get("fd").length, 8);
    }
    // 换凭据用的是 Cookie 会话
    const mint = world.calls.find((call) => call.key === "POST /xingchen-studio/auth/bearer-token");
    assert.ok(mint);
  } finally {
    world.restore();
  }
});

test("scanned but unbound wechat keeps waiting with its own hint", async () => {
  const holder = { auth: null };
  const seen = [];
  const controller = new AbortController();
  const world = stub({
    "GET /SSOService/wx/scanlogin/qrcode": ok("https://sso.xfyun.cn/static/qr/abc.png"),
    "GET /SSOService/wx/scanlogin/uids": () => {
      seen.push(holder.auth?.instructions);
      return ok({ infoList: [] });
    },
  });
  try {
    const authorization = await authorizeScan(undefined, { signal: controller.signal });
    holder.auth = authorization;
    const running = authorization.callback(undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 4_600));
    controller.abort(new Error("stop"));
    await assert.rejects(running);
    assert.ok(seen.includes(HINTS.unbound), JSON.stringify(seen));
    assert.ok(!seen.includes(HINTS.settling));
  } finally {
    world.restore();
  }
});

test("a refused qrcode request becomes a readable failure", async () => {
  const world = stub({ "GET /SSOService/wx/scanlogin/qrcode": busy(50000, "系统繁忙") });
  try {
    const authorization = await authorizeScan(undefined, {});
    assert.equal(authorization.type, "failed");
    assert.match(authorization.error, /系统繁忙/);
    assert.match(authorization.error, /获取扫码二维码失败/);
  } finally {
    world.restore();
  }
});

test("placeholders never settle a sign-in", () => {
  assert.deepEqual(identitiesOf({ infoList: [{ uid: 0, ssoSessionId: "x" }, { uid: "7" }] }), []);
});

test("settle refuses an account without an id", async () => {
  await assert.rejects(settle({ accountId: "", uid: "" }, { requireWebToken: false }), /缺少账号/);
});

test("renew mints a fresh bearer from the saved session", async () => {
  const world = stub({ "POST /xingchen-studio/auth/bearer-token": ok({ modelBearerToken: "bearer-2" }) });
  try {
    const next = await renew({ session: { accountId: "10086", uid: "10086", ssoSessionId: "sid-1" } });
    assert.equal(next.access, "bearer-2");
    assert.equal(next.type, "oauth");
    assert.ok(next.expires > Date.now());
    assert.equal(next.session.ssoSessionId, "sid-1");
  } finally {
    world.restore();
  }
});

test("renew without a session asks for a new sign-in", async () => {
  await assert.rejects(renew({ access: "x", key: "x" }), (error) => error.signIn === "expired");
});

test("usage reports both point pools without letting them gate requests", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1200, sparkTotalBalance: 0, activityBalance: 500, activityNextExpireTime: "2027-01-01 00:00:00" }),
    "GET /xingchen-studio/membership/me": ok({ planName: "旗舰版", endTime: "2027-06-01 00:00:00", uid: 10086 }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "10086", ssoSessionId: "sid-1" } });
    assert.equal(report.plan, "旗舰版");
    assert.equal(report.user, "10086");
    assert.equal(report.until, "2027-06-01 00:00:00");
    assert.deepEqual(report.windows.map((row) => row.name), ["通用积分", "星火积分"]);
    for (const row of report.windows) assert.equal(row.aside, true);
    assert.equal(report.windows[0].balance, 1200);
    assert.equal(report.windows[0].runsOut, 500);
    assert.equal(report.error, undefined);
    // 顶层这一个数是面板「可用合计」和选路「余额不足」唯一的依据。
    assert.equal(report.balance, 1200);
  } finally {
    world.restore();
  }
});

test("usage reports credits with the absolute expiry for WorkBuddy-style countdown", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1600, activityBalance: 1600, activityNextExpireTime: "2026-12-15T04:54:08", sparkTotalBalance: 0 }),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.equal(report.unit, "积分");
    assert.deepEqual(report.credits, [
      { name: "通用积分", unit: "积分", total: 1600, remain: 1600, expireAt: "2026-12-15T04:54:08+08:00" },
    ]);
    // 星火积分为 0 时不占一行，避免面板出现「剩 0」的噪声明细。
    assert.equal(report.credits.length, 1);
  } finally {
    world.restore();
  }
});

test("usage turns per-grant point details into credits with absolute expiry", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1600, sparkTotalBalance: 0 }),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
    "GET /xingchen-studio/points/details": ({ url }) => ok({
      total: 2,
      items: [
        { assetCode: "GENERAL_POINTS", direction: "CREDIT", amount: 100, balanceAfter: 1500,
          reason: "每日登录赠送", createTime: "2026-11-20T01:02:03", expireTime: "2026-11-27T01:02:03",
          deductions: [{ amount: 40 }] },
        { assetCode: "GENERAL_POINTS", direction: "CREDIT", amount: 1500, balanceAfter: 1600,
          reason: "客户端下载奖励", createTime: "2026-11-01T00:00:00", expireTime: "2027-02-15T04:54:03" },
      ],
    }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.equal(report.balance, 1600);
    assert.equal(report.credits.length, 2);
    assert.deepEqual(report.credits[0], {
      name: "每日登录赠送", unit: "积分", total: 100, remain: 60,
      startAt: "2026-11-20T01:02:03+08:00", expireAt: "2026-11-27T01:02:03+08:00",
    });
    assert.equal(report.credits[1].expireAt, "2027-02-15T04:54:03+08:00");
    // 逐笔查询带分页与方向，别把 DEBIT 也拉进来。
    const call = world.calls.find((c) => c.key === "GET /xingchen-studio/points/details");
    assert.match(call.url.searchParams.get("direction"), /CREDIT/);
  } finally {
    world.restore();
  }
});

test("usage falls back to the aggregate expiry when point details fail", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 900, activityBalance: 300, activityNextExpireTime: "2026-12-15T04:54:08" }),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.deepEqual(report.credits, [
      { name: "通用积分", unit: "积分", total: 300, remain: 300, expireAt: "2026-12-15T04:54:08+08:00" },
    ]);
    assert.equal(report.error, undefined);
  } finally {
    world.restore();
  }
});

test("usage credit rows cover a non-zero spark pool without inventing an expiry", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1200, sparkTotalBalance: 300 }),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    // 没给活动积分/到期时刻时不伪造一行带 expireAt 的明细。
    assert.deepEqual(report.credits.map((c) => c.name), ["星火积分"]);
    assert.equal(report.credits[0].remain, 300);
    assert.equal("expireAt" in report.credits[0], false);
  } finally {
    world.restore();
  }
});

test("usage adds both point pools into the single available number", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1200, sparkTotalBalance: 300 }),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s", token: "t" } });
    assert.equal(report.balance, 1500);
    assert.deepEqual(report.windows.map((row) => row.balance), [1200, 300]);
    assert.equal(report.plan, "体验版");
  } finally {
    world.restore();
  }
});

test("usage keeps the available number one shape: absent when the reading failed", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": busy(50000, "系统繁忙"),
    "GET /xingchen-studio/membership/me": ok({ planName: "体验版" }),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s", token: "t" } });
    assert.equal("balance" in report, false);
    assert.deepEqual(report.windows, []);
    assert.match(report.error, /系统繁忙/);
  } finally {
    world.restore();
  }
});

test("usage surfaces an expired session instead of a broken reading", async () => {
  const world = stub({
    "GET /xingchen-studio/points/balance": () => ({ flag: false, code: 80000, desc: "请重新登录", data: null }),
    "GET /xingchen-studio/membership/me": ok({}),
  });
  try {
    const report = await usageReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.equal(report.signIn, "expired");
  } finally {
    world.restore();
  }
});

test("checkin reports the points it actually saw arrive", async () => {
  let reads = 0;
  const world = stub({
    "GET /xingchen-studio/membership/plan-config": ok({ dailyLoginEnabled: true }),
    "GET /xingchen-studio/points/balance": () => {
      reads += 1;
      return ok({ totalBalance: reads === 1 ? 100 : 130, sparkTotalBalance: 0 });
    },
    "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
  });
  try {
    const report = await checkinReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.equal(report.outcome, "claimed");
    assert.match(report.credit, /通用积分 \+30/);
  } finally {
    world.restore();
  }
});

test("checkin says so when the reward is not observable yet", async () => {
  const world = stub({
    "GET /xingchen-studio/membership/plan-config": ok({ dailyLoginEnabled: true }),
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 100, sparkTotalBalance: 0 }),
    "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
    "GET /xingchen-studio/client-popups/pending": ok([]),
  });
  try {
    const report = await checkinReport({ access: "bearer-1", session: { accountId: "1", ssoSessionId: "s" } });
    assert.equal(report.outcome, "done");
    assert.match(report.message, /今天已经领过/);
  } finally {
    world.restore();
  }
});

test("checkin is ineligible for a paste-only account", async () => {
  const report = await checkinReport({ access: "bearer-1" });
  assert.equal(report.outcome, "ineligible");
});
