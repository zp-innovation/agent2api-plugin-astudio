import assert from "node:assert/strict";
import test from "node:test";

import { REFRESH_MARK, TOKEN_TTL_MS } from "../lib/endpoints.mjs";
import { expiryOf, legacySecret, resetLegacyAttempts, upgradeLegacy } from "../lib/legacy.mjs";

/** 造一个形状与 modelBearerToken 一致的 JWT（签名段随便填，我们不验签）。 */
function jwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.c2ln`;
}

const session = { accountId: "22098822931", ssoSessionId: "2b1c0a8e-1f4d-4a1b-9c3e-7f5a6d8b9e01", token: "2b1c0a8e-1f4d-4a1b-9c3e-7f5a6d8b9e01", uid: "22098822931" };

test("the expiry comes from the JWT exp claim", () => {
  const exp = 1_900_000_000;
  assert.equal(expiryOf(jwt({ exp })), exp * 1000);
});

test("a token we cannot date falls back instead of guessing", () => {
  assert.equal(expiryOf("not-a-jwt"), 0);
  assert.equal(expiryOf(""), 0);
  assert.equal(expiryOf(jwt({ sub: "no-exp" })), 0);
  assert.equal(expiryOf(jwt({ exp: "soon" })), 0);
  // 已经过期的 exp 不能搬过来，否则第一个请求就会被判成需要重新登录。
  assert.equal(expiryOf(jwt({ exp: 1_600_000_000 })), 0);
});

test("an account the wasm pack left behind becomes a refreshable oauth secret", () => {
  const exp = 1_900_000_000;
  const wasm = { key: jwt({ exp }), name: "18122032590", proxy: null, session, source: "sms", uid: "22098822931" };
  const next = legacySecret(wasm);
  assert.equal(next.type, "oauth");
  assert.equal(next.key, wasm.key);
  assert.equal(next.access, wasm.key);
  assert.equal(next.refresh, REFRESH_MARK);
  assert.equal(next.expires, exp * 1000);
  // 会话原样留着：401 之后 renew 要靠它换新凭据。
  assert.deepEqual(next.session, session);
  assert.equal(next.metadata.source, "sms");
  // host/auth-record.mjs:34-37 对 oauth 型的三条硬要求
  assert.equal(typeof next.refresh, "string");
  assert.equal(typeof next.access, "string");
  assert.ok(Number.isFinite(next.expires) && next.expires >= 0);
});

test("an undated token still gets a usable expiry", () => {
  const now = Date.now();
  const next = legacySecret({ key: "opaque-token", session, uid: "1" }, now);
  assert.equal(next.expires, now + TOKEN_TTL_MS);
});

test("nothing to upgrade is left alone", () => {
  // 已经是 oauth 型
  assert.equal(legacySecret({ key: "k", access: "k", refresh: REFRESH_MARK, expires: Date.now() + 1e6, session }), null);
  // 只有 Bearer、没有网页会话：升级了也没法续期
  assert.equal(legacySecret({ key: "k" }), null);
  assert.equal(legacySecret({ session }), null);
  assert.equal(legacySecret(null), null);
  assert.equal(legacySecret([]), null);
});
test("a live session is upgraded, and the fresh bearer is what gets saved", async () => {
  resetLegacyAttempts();
  const saved = [];
  const fresh = jwt({ exp: 1_900_000_000 });
  const ok = await upgradeLegacy({ key: "stale", session, uid: "22098822931" }, {
    save: (next) => saved.push(next),
    mint: async () => fresh,
  });
  assert.equal(ok, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].access, fresh);
  assert.equal(saved[0].refresh, REFRESH_MARK);
  assert.equal(saved[0].expires, 1_900_000_000 * 1000);
  assert.deepEqual(saved[0].session, session);
});

test("a dead session is left alone instead of becoming a broken oauth account", async () => {
  resetLegacyAttempts();
  const saved = [];
  const ok = await upgradeLegacy({ key: "still-good", session, uid: "22097891230" }, {
    save: (next) => saved.push(next),
    mint: async () => { throw new Error("ssoSessionId 已失效"); },
  });
  assert.equal(ok, false);
  assert.deepEqual(saved, []);
});

test("a failed upgrade backs off instead of hammering the upstream on every poll", async () => {
  resetLegacyAttempts();
  let calls = 0;
  const mint = async () => { calls += 1; throw new Error("offline"); };
  const auth = { key: "k", session, uid: "20582291448" };
  const now = Date.now();
  assert.equal(await upgradeLegacy(auth, { save: () => {}, mint, now }), false);
  assert.equal(await upgradeLegacy(auth, { save: () => {}, mint, now: now + 1000 }), false);
  assert.equal(calls, 1);
  // 冷却期过去后会再试一次
  assert.equal(await upgradeLegacy(auth, { save: () => {}, mint, now: now + 11 * 60_000 }), false);
  assert.equal(calls, 2);
});

test("an account that is already oauth is never touched", async () => {
  resetLegacyAttempts();
  let called = false;
  const ok = await upgradeLegacy({ key: "k", access: "k", refresh: REFRESH_MARK, expires: Date.now() + 1e6, session }, {
    save: () => {},
    mint: async () => { called = true; return "x"; },
  });
  assert.equal(ok, false);
  assert.equal(called, false);
});
