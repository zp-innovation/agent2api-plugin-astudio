import assert from "node:assert/strict";
import test from "node:test";

import { checkinReport } from "../lib/checkin.mjs";

const ok = (data) => ({ flag: true, code: 0, desc: "", data });
const deny = (code, desc) => ({ flag: false, code, desc, data: null });

/** 按「METHOD path」派发假上游，并记录每次请求的头与体。 */
function stub(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = method + " " + url.pathname;
    const entry = { key, url, headers: init.headers ?? {}, body: init.body };
    calls.push(entry);
    const handler = routes[key];
    if (!handler) return new Response("unexpected " + key, { status: 500 });
    const body = typeof handler === "function" ? await handler({ url, init, entry }) : handler;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const auth = {
  key: "bearer-1",
  session: { accountId: "10086", ssoSessionId: "sid-1", token: "sid-1" },
};

const base = {
  "GET /xingchen-studio/membership/plan-config": ok({ dailyLoginEnabled: true, dailyLoginValidDays: 31, plans: [] }),
  "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
};

test("checkin claims the pending daily reward, which is what actually pays", async () => {
  let reads = 0;
  const world = stub({
    ...base,
    "GET /xingchen-studio/points/balance": () => {
      reads += 1;
      return ok({ totalBalance: reads === 1 ? 1300 : 1400, sparkTotalBalance: 0 });
    },
    "GET /xingchen-studio/client-popups/pending": ok([
      {
        popupId: 2,
        popupCode: "DAILY_LOGIN_REWARD_V1",
        popupType: "BANNER",
        componentType: "DAILY_REWARD_DIALOG",
        priority: 100,
        instanceKey: "20261121",
        payload: { title: "今日登录积分已到账" },
      },
      // 非奖励类推广位不该被动手
      { popupId: 7, componentType: "NEW_USER_DIALOG_V2", instanceKey: "keep" },
    ]),
    "POST /xingchen-studio/client-popups/complete": ok(null),
  });
  try {
    const report = await checkinReport(auth, {});
    assert.equal(report.outcome, "claimed");
    assert.equal(report.credit, "通用积分 +100");
    assert.match(report.message, /通用积分 \+100/);

    const complete = world.calls.filter((call) => call.key === "POST /xingchen-studio/client-popups/complete");
    assert.equal(complete.length, 1, "只领奖励类推广位");
    assert.deepEqual(JSON.parse(complete[0].body), { popupId: 2, instanceKey: "20261121", completed: true });
  } finally {
    world.restore();
  }
});

test("popup requests carry the desktop identity headers the promo service demands", async () => {
  const world = stub({
    ...base,
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1300, sparkTotalBalance: 0 }),
    "GET /xingchen-studio/client-popups/pending": ok([]),
  });
  try {
    await checkinReport(auth, {});
    const pending = world.calls.find((call) => call.key === "GET /xingchen-studio/client-popups/pending");
    assert.ok(pending, "必须查待领取列表");
    assert.ok(["21", "22"].includes(pending.headers.clientType), "clientType 缺了上游回 11001001");
    assert.equal(pending.headers.studioVersion, "3.6.0");
  } finally {
    world.restore();
  }
});

test("nothing pending and no balance change reports an honest done, not a fake claim", async () => {
  const world = stub({
    ...base,
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1300, sparkTotalBalance: 0 }),
    "GET /xingchen-studio/client-popups/pending": ok({ popups: [] }),
  });
  try {
    const report = await checkinReport(auth, {});
    assert.equal(report.outcome, "done");
    assert.match(report.message, /今天已经领过/);
    assert.equal(report.credit, undefined);
  } finally {
    world.restore();
  }
});

test("a rejected claim is reported as failed even though the login itself worked", async () => {
  const world = stub({
    ...base,
    "GET /xingchen-studio/points/balance": ok({ totalBalance: 1300, sparkTotalBalance: 0 }),
    "GET /xingchen-studio/client-popups/pending": ok([
      { popupId: 2, componentType: "DAILY_REWARD_DIALOG", instanceKey: "20261121" },
    ]),
    "POST /xingchen-studio/client-popups/complete": deny(11003001, "推广位不存在"),
  });
  try {
    const report = await checkinReport(auth, {});
    assert.equal(report.outcome, "failed");
    assert.match(report.message, /没有领到登录积分/);
    assert.match(report.message, /推广位不存在/);
  } finally {
    world.restore();
  }
});
