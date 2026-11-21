import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeCredential, authorizeLocal, authorizeSms, splitPhone,
} from "../lib/login.mjs";
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

test("sms sign-in posts the quick-login form and settles the account", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": ok({
      account_id: "22098822931", ssoSessionId: "sid-sms", token: "tok-sms", uid: 22098822931,
    }),
    ...SETTLE,
  });
  try {
    const result = await authorizeSms({ mobile: "18122032590", code: "123456" }, {});
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

test("sms sign-in refuses half-filled fields without touching the network", async () => {
  const world = stub({});
  try {
    const noPhone = await authorizeSms({ code: "123456" }, {});
    assert.equal(noPhone.type, "failed");
    assert.match(noPhone.error, /手机号/);
    const noCode = await authorizeSms({ mobile: "18122032590" }, {});
    assert.equal(noCode.type, "failed");
    assert.match(noCode.error, /验证码/);
    assert.equal(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("a rejected verification code comes back as the upstream reason", async () => {
  const world = stub({
    "POST /xingchen-studio/login/phone-quick-login": bad(10501002, "验证码无效，请重新获取并验证"),
  });
  try {
    const result = await authorizeSms({ mobile: "18122032590", code: "000000" }, {});
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
