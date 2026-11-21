import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeCredential, authorizeLocal, authorizeSms, authorizeSmsForm, codeFromUrl, smsCodeOf, splitPhone,
  submissionHint,
} from "../lib/login.mjs";
import { LOGIN_PAGE_URL } from "../lib/endpoints.mjs";
import { cookieFields, credentialOf, looksLikePath, parseJson } from "../lib/import.mjs";

const ok = (data) => ({ flag: true, code: 0, desc: "", data });
const bad = (code, desc) => ({ flag: false, code, desc, data: null });

/** 与 flow.test.mjs 同一套「按路径派发」的假上游。 */
function stub(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = method + " " + url.pathname;
    calls.push({ key, url, body: init.body });
    const handler = routes[key];
    if (!handler) return new Response("unexpected " + key, { status: 500 });
    const body = typeof handler === "function" ? await handler({ url, init, calls }) : handler;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const SETTLE = {
  "POST /xingchen-studio/tenant-app/v2/init-app": ok({ banned: false }),
  "GET /xingchen-studio/userInfo": ok({ userInfo: { uid: 22098822931, mobile: "18122032590", nickname: "老张" } }),
  "POST /xingchen-studio/auth/bearer-token": ok({ modelBearerToken: "bearer-sms" }),
};

test("phone numbers are split into country code plus subscriber number", () => {
  assert.deepEqual(splitPhone("18122032590"), { countryCode: "86", mobile: "18122032590" });
  assert.deepEqual(splitPhone("8618122032590"), { countryCode: "86", mobile: "18122032590" });
  assert.deepEqual(splitPhone("+86 181-2203-2590"), { countryCode: "86", mobile: "18122032590" });
  assert.deepEqual(splitPhone("+1 415-555-0132"), { countryCode: "1", mobile: "4155550132" });
  assert.equal(splitPhone(""), null);
  assert.equal(splitPhone("abc"), null);
});

test("sms sign-in opens the AStudio login page and waits for a pasted code", async () => {
  const world = stub({});
  try {
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    // login-policy.mjs:128-129 —— method:"code" 会让宿主弹出一次性 code 输入框
    assert.equal(authorization.method, "code");
    assert.equal(authorization.url, LOGIN_PAGE_URL);
    // 门户 SPA 的路由表里没有 /login（会落到 "*" 兜底渲染 404），登录是 overview 上自动弹出的模态框
    assert.match(authorization.url, /^https:\/\/agent\.xfyun\.cn\/studio-portal\/overview$/);
    assert.equal(typeof authorization.callback, "function");
    assert.match(authorization.instructions, /获取验证码/);
    assert.equal(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("sms sign-in posts the quick-login form and settles the account", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": ok({
      account_id: "22098822931", ssoSessionId: "sid-sms", token: "tok-sms", uid: 22098822931,
    }),
    ...SETTLE,
  });
  try {
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    const result = await authorization.callback("123456");
    assert.equal(result.type, "success");
    assert.equal(result.source, "sms");
    assert.equal(result.access, "bearer-sms");
    assert.equal(result.accountId, "22098822931");
    assert.deepEqual(result.session, {
      accountId: "22098822931", uid: "22098822931", ssoSessionId: "sid-sms", token: "tok-sms",
    });
    const login = world.calls.find((call) => call.key === "POST /xingchen-studio/login/phone-quick-login");
    assert.equal(login.body, "mobile=18122032590&verifyCode=123456&countryCode=86");
  } finally {
    world.restore();
  }
});

test("sms sign-in refuses a missing phone or an empty paste without touching the network", async () => {
  const world = stub({});
  try {
    const noPhone = await authorizeSms({ code: "123456" }, {});
    assert.equal(noPhone.type, "failed");
    assert.match(noPhone.error, /手机号/);
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    const empty = await authorization.callback("  ");
    assert.equal(empty.type, "failed");
    assert.match(empty.error, /验证码/);
    // 用户把授权地址粘进框里时不能拿它去换登录，也不能消耗掉那次机会
    const wrong = await authorization.callback("https://agent.xfyun.cn/studio-portal/overview");
    assert.equal(wrong.type, "failed");
    assert.match(wrong.error, /验证码/);
    assert.equal(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("a whole SMS body still yields the six-digit code", () => {
  assert.equal(smsCodeOf("123456"), "123456");
  assert.equal(smsCodeOf("【讯飞星辰】验证码 123456，5 分钟内有效"), "123456");
  assert.equal(smsCodeOf("验证码:9876"), "9876");
  assert.equal(smsCodeOf("您的验证码是 4321，请勿泄露"), "4321");
  assert.equal(smsCodeOf("not a code"), "");
  assert.equal(smsCodeOf("1234567890123"), "");
  assert.equal(smsCodeOf(""), "");
});

test("pasting the page address is answered as an address, not as a bad code", async () => {
  const world = stub({});
  try {
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    // 宿主 shim 对非 code 型流程的文案是「复制浏览器地址栏中的完整回调地址粘贴提交」，
    // 用户照做就会把 overview 地址交上来；core/login.rs 会把它整条当成 code 传进来。
    const result = await authorization.callback("https://agent.xfyun.cn/studio-portal/overview");
    assert.equal(result.type, "failed");
    assert.match(result.error, /网页地址/);
    assert.match(result.error, /4-8 位数字/);
    // 手机号同理：11 位数字不是验证码
    const phone = await authorization.callback("18122032590");
    assert.match(phone.error, /手机号/);
    assert.equal(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("a code carried inside a callback URL is still accepted", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": ok({
      account_id: "22098822931", ssoSessionId: "sid-u", token: "tok-u", uid: 22098822931,
    }),
    ...SETTLE,
  });
  try {
    assert.equal(codeFromUrl("https://agent.xfyun.cn/studio-portal/overview?code=123456"), "123456");
    assert.equal(codeFromUrl("https://agent.xfyun.cn/studio-portal/overview"), "");
    assert.equal(codeFromUrl("123456"), "");
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    const result = await authorization.callback("https://agent.xfyun.cn/studio-portal/overview?code=123456");
    assert.equal(result.type, "success");
    const login = world.calls.find((call) => call.key === "POST /xingchen-studio/login/phone-quick-login");
    assert.equal(login.body, "mobile=18122032590&verifyCode=123456&countryCode=86");
  } finally {
    world.restore();
  }
});

test("the two-field sms method needs no window and signs in in one submit", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": ok({
      account_id: "22098822931", ssoSessionId: "sid-f2", token: "tok-f2", uid: 22098822931,
    }),
    ...SETTLE,
  });
  try {
    const noCode = await authorizeSmsForm({ mobile: "18122032590" }, {});
    assert.equal(noCode.type, "failed");
    assert.match(noCode.error, /验证码/);
    assert.equal(world.calls.length, 0);

    const authorization = await authorizeSmsForm({ mobile: "18122032590", code: "123456" }, {});
    // method:"auto" + 不返回 url ⇒ 宿主不建窗口、不弹粘贴框，start 之后立刻跑 callback
    assert.equal(authorization.method, "auto");
    assert.equal(authorization.url, "");
    const result = await authorization.callback(undefined);
    assert.equal(result.type, "success");
    assert.equal(result.source, "sms");
    assert.equal(result.access, "bearer-sms");
    assert.equal(result.session.ssoSessionId, "sid-f2");
  } finally {
    world.restore();
  }
});

test("submission hints name what the user actually pasted", () => {
  const phone = splitPhone("18122032590");
  assert.match(submissionHint("", phone), /没有收到验证码/);
  assert.match(submissionHint("http://x.test/a?b=1", phone), /网页地址/);
  assert.match(submissionHint("18122032590", phone), /手机号/);
  assert.match(submissionHint("这是一段话", phone), /4-8 位验证码/);
});

test("a rejected verification code comes back as the upstream reason", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": bad(10501002, "验证码无效，请重新获取并验证"),
  });
  try {
    const authorization = await authorizeSms({ mobile: "18122032590" }, {});
    const result = await authorization.callback("000000");
    assert.equal(result.type, "failed");
    assert.match(result.error, /验证码无效/);
  } finally {
    world.restore();
  }
});

test("credentials are recognised from cookies, JSON and the host's own secret shape", () => {
  assert.deepEqual(cookieFields("ssoSessionId=a; sso_sessionid=b; account_id=c; other=x"), {
    ssoSessionId: "b", accountId: "c",
  });
  assert.equal(cookieFields("not a cookie"), null);

  assert.deepEqual(credentialOf('{"modelBearerToken":"b1","mobile":"18122032590"}').key, "b1");

  const secret = credentialOf(JSON.stringify({
    access: "b2", session: { accountId: "9", ssoSessionId: "sid", token: "tok" },
  }));
  assert.equal(secret.key, "b2");
  assert.equal(secret.accountId, "9");
  assert.equal(secret.ssoSessionId, "sid");

  // 宿主落盘过的 secret 外面可能还包着 JSON 字符串
  const nested = JSON.stringify({ data: JSON.stringify({ account_id: "7", ssoSessionId: "s" }) });
  assert.equal(credentialOf(nested).accountId, "7");

  assert.equal(credentialOf("随便一段文字"), null);
  assert.equal(credentialOf(""), null);
  assert.deepEqual(parseJson('前言 {"a":1} 后话'), { a: 1 });
});

test("importing a cookie string signs in through the session and keeps the source", async () => {
  const world = stub({ ...SETTLE });
  try {
    const result = await authorizeCredential({
      json: "ssoSessionId=sid-x; account_id=22098822931; token=tok-x",
    }, {});
    assert.equal(result.type, "success");
    assert.equal(result.source, "json");
    assert.equal(result.access, "bearer-sms");
    assert.equal(result.session.ssoSessionId, "sid-x");
  } finally {
    world.restore();
  }
});

test("importing a bare bearer token yields an api-style account", async () => {
  const world = stub({
    "GET /xingchen-studio/bot/models/configs": ok([{ api_key: "b1", is_current: true }]),
  });
  try {
    const result = await authorizeCredential({ json: '{"modelBearerToken":"b1","mobile":"18122032590"}' }, {});
    assert.equal(result.type, "success");
    assert.equal(result.key, "b1");
    assert.equal(result.name, "18122032590");
    assert.equal(result.metadata.source, "json");
  } finally {
    world.restore();
  }
});

test("importing a file path reads it, and a directory is searched for the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "astudio-import-"));
  const nested = join(dir, "Local Storage");
  await mkdir(nested);
  await writeFile(join(nested, "session.json"), JSON.stringify({ account_id: "5", ssoSessionId: "sid-f" }), "utf8");
  const world = stub({ ...SETTLE });
  try {
    const result = await authorizeLocal({ path: dir }, {});
    assert.equal(result.type, "success");
    assert.equal(result.source, "local");
    assert.equal(result.session.ssoSessionId, "sid-f");
    assert.equal(result.session.accountId, "5");
  } finally {
    world.restore();
  }
});

test("a missing path or an empty directory fails with a readable reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "astudio-empty-"));
  const world = stub({});
  try {
    const missing = await authorizeLocal({ path: join(dir, "nope.json") }, {});
    assert.equal(missing.type, "failed");
    assert.match(missing.error, /读不到/);
    const empty = await authorizeLocal({ path: dir }, {});
    assert.equal(empty.type, "failed");
    assert.match(empty.error, /没找到/);
    assert.equal(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("only path-looking strings are treated as files", () => {
  assert.equal(looksLikePath("C:\\Users\\a\\session.json"), true);
  assert.equal(looksLikePath("/home/a/session.json"), true);
  assert.equal(looksLikePath("~/session.json"), true);
  assert.equal(looksLikePath("\\\\host\\share\\x.json"), true);
  assert.equal(looksLikePath("ssoSessionId=a; account_id=b"), false);
  assert.equal(looksLikePath('{"a":1}'), false);
  assert.equal(looksLikePath(""), false);
});
