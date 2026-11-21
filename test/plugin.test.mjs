import assert from "node:assert/strict";
import test from "node:test";

import * as entry from "../index.mjs";

const hooks = await entry.AStudioPlugin({});

test("the module exposes exactly one function for the host to probe", () => {
  const exported = Object.entries(entry);
  assert.deepEqual(exported.map(([name]) => name), ["AStudioPlugin"]);
  assert.equal(typeof entry.AStudioPlugin, "function");
});

test("the factory survives being called the way entries.mjs probes candidates", async () => {
  // entries.mjs:30 -> candidate(input, entry.options)，input 可能为空
  const hooks = await entry.AStudioPlugin(undefined, undefined);
  assert.equal(hooks.auth.provider, "astudio");
  assert.equal(typeof hooks.auth.icon, "string");
  assert.match(hooks.auth.icon, /^data:image\/png;base64,/);
  assert.equal(hooks.auth.keepAlive, true);
});

test("sign-in methods are exactly what the panel can render", () => {
  const methods = hooks.auth.methods;
  assert.ok(Array.isArray(methods));
  assert.equal(methods.length, 2);
  const [scan, paste] = methods;
  assert.equal(scan.type, "oauth");
  assert.equal(scan.label, "微信扫码登录");
  assert.equal(typeof scan.authorize, "function");
  assert.equal(scan.embeddedOnly, true);
  assert.equal(scan.localOnly, false);
  assert.equal(scan.manualCallback, false);
  assert.deepEqual(scan.prompts, []);
  // login-policy.mjs:9 只认 choice|external|plugin|none
  assert.ok(["choice", "external", "plugin", "none"].includes(scan.browserMode));
  assert.equal(paste.type, "api");
  assert.equal(paste.prompts[0].key, "key");
  assert.equal(paste.prompts[0].secret, true);
  assert.equal(typeof paste.authorize, "function");
});

test("the loader hands the gateway a bearer plus the version headers", async () => {
  const out = await hooks.auth.loader(async () => ({ access: "bearer-1" }));
  assert.equal(out.apiKey, "bearer-1");
  assert.equal(out.baseURL, "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1");
  assert.equal(out.headers.studioVersion, "3.6.0");
  assert.match(out.headers["user-agent"], /^AStudio\/3\.6\.0/);
  assert.ok(out.headers.clientType);
});

test("config seeds the fallback catalogue without dropping what is already there", () => {
  const configuration = { provider: { astudio: { models: { "custom-1": { name: "Mine" } } } } };
  hooks.config(configuration);
  const provider = configuration.provider.astudio;
  assert.equal(provider.name, "AStudio · zp");
  assert.equal(provider.npm, "@ai-sdk/openai");
  assert.equal(provider.models["custom-1"].name, "Mine");
  assert.equal(provider.models["astronclaw-auto"].name, "Auto");
  assert.equal(Object.keys(provider.models).length, 8);
});

test("a keyless account reads as an expired sign-in, not as a broken column", async () => {
  // reports.mjs:29 会把 signIn:"expired" 变成「需要重新登录」，这正是我们要的效果。
  const empty = await hooks.auth.usage(async () => ({}));
  assert.equal(empty.signIn, "expired");
  assert.match(empty.error, /模型凭据/);
});

test("usage keeps the plan when the upstream throws, so it degrades to a warning", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const report = await hooks.auth.usage(async () => ({
      access: "bearer-1",
      session: { accountId: "1", ssoSessionId: "s" },
    }));
    assert.equal(report.plan, "AStudio · zp");
    assert.deepEqual(report.windows, []);
    assert.match(report.error, /不可达|offline/);
    assert.equal(report.signIn, undefined);
  } finally {
    globalThis.fetch = before;
  }
});

test("checkin reports an outcome the host accepts for a bearer-only account", async () => {
  const report = await hooks.auth.checkin(async () => ({ access: "bearer-1" }));
  assert.equal(report.outcome, "ineligible");
  assert.match(report.message, /签到/);
});
