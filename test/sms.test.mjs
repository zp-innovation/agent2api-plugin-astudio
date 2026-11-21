import assert from "node:assert/strict";
import test from "node:test";

import { authorizeSms } from "../lib/login.mjs";
import { captchaOf, maskPhone, sendSmsCode } from "../lib/sms.mjs";
import { LOGIN_PAGE_URL } from "../lib/endpoints.mjs";

const ok = (data) => ({ flag: true, code: 0, desc: "", data });
const busy = (code, desc) => ({ flag: false, code, desc, data: null });

const CAPTCHA = {
  geetest_challenge: "challenge-1",
  geetest_validate: "validate-1",
  geetest_seccode: "validate-1|jordan",
};
/** captchaOf 归一化之后的形状（sendSmsCode 的内部入参）。 */
const TRIO = { challenge: "challenge-1", validate: "validate-1", seccode: "validate-1|jordan" };

/** 按「方法 + 路径」派发的假上游，同时留下 init 供断言。 */
function stub(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = method + " " + url.pathname;
    calls.push({ key, url, init });
    const handler = routes[key];
    if (!handler) return new Response("unexpected " + key, { status: 500 });
    const body = typeof handler === "function" ? await handler({ url, init, calls }) : handler;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test("captchaOf takes the three geetest tokens as an object or a JSON string", () => {
  assert.deepEqual(captchaOf({ captcha: CAPTCHA }), {
    challenge: "challenge-1",
    validate: "validate-1",
    seccode: "validate-1|jordan",
  });
  assert.deepEqual(captchaOf({ captcha: JSON.stringify(CAPTCHA) })?.challenge, "challenge-1");
  assert.equal(captchaOf({}), null);
  assert.equal(captchaOf({ captcha: "not json" }), null);
  assert.equal(captchaOf({ captcha: { geetest_challenge: "c", geetest_validate: "v" } }), null);
  assert.equal(captchaOf(undefined), null);
});

test("maskPhone keeps the number out of the hint", () => {
  assert.equal(maskPhone("18122032590"), "181****2590");
  assert.equal(maskPhone(""), "");
});

test("sendSmsCode posts the geetest trio as multipart with a base64 seccode", async () => {
  const world = stub({ "POST /xingchen-studio/login/mobile/send-verify-code": ok(null) });
  try {
    await sendSmsCode({ countryCode: "86", mobile: "18122032590" }, TRIO, {});
    const [call] = world.calls;
    assert.equal(call.key, "POST /xingchen-studio/login/mobile/send-verify-code");
    assert.match(call.init.headers["content-type"], /^multipart\/form-data; boundary=/);
    const body = call.init.body;
    assert.match(body, /name="geetest_challenge"\r\n\r\nchallenge-1/);
    assert.match(body, /name="geetest_validate"\r\n\r\nvalidate-1/);
    // 官方客户端对 seccode 先 base64 再发
    const seccode = Buffer.from("validate-1|jordan", "utf8").toString("base64");
    assert.ok(body.includes(seccode), body);
    assert.match(body, /name="mobile"\r\n\r\n18122032590/);
    assert.match(body, /name="countryCode"\r\n\r\n86/);
  } finally {
    world.restore();
  }
});

test("a refused captcha reads as 'drag it again', not as a raw upstream code", async () => {
  const world = stub({ "POST /xingchen-studio/login/mobile/send-verify-code": busy(20009, "geetest verify failed") });
  try {
    await assert.rejects(sendSmsCode({ countryCode: "86", mobile: "18122032590" }, TRIO, {}), /滑块校验没通过/);
  } finally {
    world.restore();
  }
});

test("the panel path sends the sms itself and then finishes with the code", async () => {
  const world = stub({
    "POST /xingchen-studio/login/mobile/send-verify-code": ok(null),
    "POST /xingchen-studio/login/phone-quick-login": ok({
      account_id: "10086", uid: 10086, ssoSessionId: "sid-9", token: "sid-9", mobile: "18122032590",
    }),
    "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
    "POST /xingchen-studio/auth/bearer-token": ok({ modelBearerToken: "bearer-9" }),
  });
  try {
    const authorization = await authorizeSms({ mobile: "18122032590", captcha: JSON.stringify(CAPTCHA) }, {});
    assert.equal(authorization.method, "code");
    // 空 url：宿主不开窗口，面板补丁自己弹验证码输入框
    assert.equal(authorization.url, "");
    assert.match(authorization.instructions, /181\*\*\*\*2590/);
    assert.ok(world.calls.some((call) => call.key === "POST /xingchen-studio/login/mobile/send-verify-code"));

    const result = await authorization.callback("123456");
    assert.equal(result.type, "success");
    assert.equal(result.access, "bearer-9");
    assert.equal(result.source, "sms");
    assert.equal(result.accountId, "10086");
    assert.equal(result.session.ssoSessionId, "sid-9");
    assert.ok(world.calls.some((call) => call.key === "POST /xingchen-studio/login/phone-quick-login"));
  } finally {
    world.restore();
  }
});

test("the panel path refuses the sign-in when the sms cannot be sent", async () => {
  const world = stub({ "POST /xingchen-studio/login/mobile/send-verify-code": busy(20009, "geetest verify failed") });
  try {
    const authorization = await authorizeSms({ mobile: "18122032590", captcha: CAPTCHA }, {});
    assert.equal(authorization.type, "failed");
    assert.match(authorization.error, /滑块校验没通过/);
  } finally {
    world.restore();
  }
});

test("without a captcha the method still opens the login page", async () => {
  const authorization = await authorizeSms({ mobile: "18122032590" }, {});
  assert.equal(authorization.method, "code");
  assert.equal(authorization.url, LOGIN_PAGE_URL);
});
