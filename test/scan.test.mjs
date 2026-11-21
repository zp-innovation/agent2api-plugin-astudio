import assert from "node:assert/strict";
import test from "node:test";

import { STUDIO_BASE, PROVIDER_ID, STUDIO_VERSION } from "../lib/endpoints.mjs";
import { cookieHeader, desktopHeaders, scalar, text } from "../lib/http.mjs";
import {
  HINTS, SsoRejected, identitiesOf, imageUrlOf, hostOf, scanSession, waitingHint,
} from "../lib/scan.mjs";

test("scan_session_is_eight_alphanumeric", () => {
  for (let index = 0; index < 50; index += 1) {
    const fd = scanSession();
    assert.equal(fd.length, 8);
    assert.match(fd, /^[A-Za-z0-9]{8}$/);
  }
  assert.notEqual(scanSession(), scanSession());
});

test("host_is_taken_from_the_image_url", () => {
  assert.equal(hostOf("https://sso.xfyun.cn/img/qr.png"), "sso.xfyun.cn");
  assert.equal(hostOf(""), "");
});

test("host_drops_port_and_userinfo", () => {
  assert.equal(hostOf("https://user:pass@cdn.example.com:8443/qr.png"), "cdn.example.com");
  assert.equal(hostOf("https://CDN.Example.COM:443/qr.png"), "cdn.example.com");
});

test("identities_skip_placeholder_uid", () => {
  const list = identitiesOf({
    infoList: [
      { uid: 0, ssoSessionId: "abc" },
      { uid: "0", ssoSessionId: "abc" },
      { uid: "12345", ssoSessionId: "" },
      { uid: 67890, ssoSessionId: "sid-1" },
      { uid: "24680", ssoSessionId: "sid-2" },
      null,
    ],
  });
  assert.deepEqual(list, [
    { uid: "67890", ssoSessionId: "sid-1" },
    { uid: "24680", ssoSessionId: "sid-2" },
  ]);
});

test("identities_empty_when_nobody_scanned", () => {
  assert.deepEqual(identitiesOf(null), []);
  assert.deepEqual(identitiesOf({}), []);
  assert.deepEqual(identitiesOf({ infoList: [] }), []);
});

test("not_scanned_yet_says_waiting_not_broken", () => {
  // 实测两种「还没扫码」：20003「请求地址错误」与 -1「暂无数据」
  assert.equal(waitingHint("20003", "请求地址错误", false), HINTS.waiting);
  assert.equal(waitingHint("-1", "暂无数据", false), HINTS.waiting);
  assert.equal(waitingHint("", "", false), HINTS.waiting);
  const busy = waitingHint("50000", "系统繁忙", false);
  assert.ok(busy.includes("系统繁忙"), busy);
  assert.ok(busy.startsWith(HINTS.waiting), busy);
  assert.equal(waitingHint("20003", "请求地址错误", true), HINTS.expired);
});

test("image url is read from string or object", () => {
  assert.equal(imageUrlOf(" https://a.test/qr.png "), "https://a.test/qr.png");
  assert.equal(imageUrlOf({ url: "https://b.test/qr.png" }), "https://b.test/qr.png");
  assert.equal(imageUrlOf({ imageUrl: "https://c.test/qr.png" }), "https://c.test/qr.png");
  assert.equal(imageUrlOf({}), "");
  assert.equal(imageUrlOf(null), "");
});

test("sso rejection keeps upstream code and description", () => {
  const error = new SsoRejected("20003", "请求地址错误");
  assert.equal(error.code, "20003");
  assert.equal(error.desc, "请求地址错误");
  assert.ok(error instanceof Error);
});

test("cookie header keeps the official order and repeats the sso id", () => {
  const header = cookieHeader({ ssoSessionId: "sid", accountId: "42", token: "" });
  assert.equal(header, "ssoSessionId=sid; sso_sessionid=sid; account_id=42");
  assert.equal(cookieHeader({}), "");
  assert.equal(cookieHeader({ token: "t" }), "token=t");
});

test("desktop headers carry the version gate", () => {
  const headers = desktopHeaders();
  assert.equal(headers.studioVersion, STUDIO_VERSION);
  assert.equal(headers["user-agent"], `AStudio/${STUDIO_VERSION}`);
});

test("scalar drops the zero placeholder", () => {
  assert.equal(scalar(0), "");
  assert.equal(scalar("0"), "");
  assert.equal(scalar(7), "7");
  assert.equal(scalar(" 9 "), "9");
  assert.equal(scalar(null), "");
  assert.equal(text(undefined), "");
});

test("endpoints are the official hosts", () => {
  assert.equal(PROVIDER_ID, "astudio");
  assert.equal(STUDIO_BASE, "https://agent.xfyun.cn/xingchen-studio/");
});
