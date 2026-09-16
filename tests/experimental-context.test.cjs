const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");
const { readExperimentalContext, writeExperimentalContext, EXPERIMENTAL_CONTEXT_KEY } = loadSource("src/experimentalContext.ts");

function fixture(overrides = {}) {
  const calls = [];
  const responses = {
    "experimentalFeature/list": { data: [{ name: "context_management", stage: "underDevelopment", enabled: false }], nextCursor: null },
    "config/read": { config: { features: { context_management: { experimental_mode: false } } }, layers: [{ name: { type: "user", file: "/user/config.toml" }, version: "revision-a" }] },
    "account/read": { account: { type: "chatgpt", planType: "plus" } },
    "config/value/write": { status: "ok", version: "revision-b" },
    ...overrides
  };
  return { calls, responses, request: async (method, params) => { calls.push({ method, params }); return responses[method]; } };
}

test("context reads native capability, layered config and account without exposing credentials", async () => {
  const h = fixture();
  const view = await readExperimentalContext(h.request, "scope-a");
  assert.equal(view.status, "ready");
  assert.equal(view.enabled, false);
  assert.equal(view.canChange, true);
  assert.equal(view.revision, "revision-a");
  assert.equal(view.scopeId, "scope-a");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { method: "config/read", params: { includeLayers: true } });
  assert(!JSON.stringify(view).includes("/user/"));
});

for (const plan of ["plus", "pro", "pro_lite", "Pro Lite"]) {
  test(`context is configurable with documented ChatGPT plan ${plan}`, async () => {
    const h = fixture({ "account/read": { account: { type: "chatgpt", planType: plan } } });
    assert.equal((await readExperimentalContext(h.request, "a")).canChange, true);
  });
}

for (const account of [null, { type: "apiKey" }, { type: "chatgpt", planType: "free" }, { type: "chatgpt", planType: "future-plan" }]) {
  test(`unconfirmed eligibility cannot enable context: ${JSON.stringify(account)}`, async () => {
    const h = fixture({ "account/read": { account } });
    assert.equal((await readExperimentalContext(h.request, "a")).canChange, false);
    h.responses["config/read"].config.features.context_management.experimental_mode = true;
    const view = await readExperimentalContext(h.request, "a");
    assert.equal(view.eligible, false);
    assert.equal(view.canChange, true, "an enabled setting can still be switched off");
  });
}

test("unsupported runtime and malformed pagination do not enable the control", async () => {
  const h = fixture({ "experimentalFeature/list": { data: [], nextCursor: null } });
  assert.equal((await readExperimentalContext(h.request, "a")).status, "unsupported");
  assert.equal(h.calls.length, 1);
  h.responses["experimentalFeature/list"].nextCursor = "loop";
  await assert.rejects(readExperimentalContext(h.request, "a"), /полный список/);
  const paged = fixture();
  const calls = [];
  const view = await readExperimentalContext(async (method, params) => {
    if (method === "experimentalFeature/list") {
      calls.push(params.cursor);
      if (!params.cursor) return { data: [], nextCursor: "page2" };
    }
    return paged.request(method, params);
  }, "scope");
  assert.equal(view.status, "ready");
  assert.deepEqual(calls, [null, "page2"]);
});

test("only the unprofiled user config layer supplies the write revision", async () => {
  const h = fixture();
  h.responses["config/read"].layers = [
    { name: { type: "user", profile: "work" }, version: "wrong-profile" },
    { name: { type: "user" }, version: "disabled", disabledReason: "policy" },
    { name: { type: "project" }, version: "wrong-project" }
  ];
  const view = await readExperimentalContext(h.request, "a");
  assert.equal(view.canChange, false);
  assert.equal(view.revision, "");
});

test("context writes exactly one feature key with optimistic concurrency", async () => {
  const h = fixture();
  await writeExperimentalContext(h.request, true, "revision-a");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ method: "config/value/write", params: {
    keyPath: EXPERIMENTAL_CONTEXT_KEY, value: true, mergeStrategy: "upsert", expectedVersion: "revision-a"
  } }]);
  await assert.rejects(writeExperimentalContext(h.request, true, ""), /Версия/);
  for (const response of [{ status: "okOverridden" }, { status: "ok", overriddenMetadata: {} }, { status: "unknown" }]) {
    h.responses["config/value/write"] = response;
    await assert.rejects(writeExperimentalContext(h.request, true, "revision-a"));
  }
});
