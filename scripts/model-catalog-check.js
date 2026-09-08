"use strict";
const assert = require("node:assert/strict");
const { ModelCatalog } = require("../dist/modelCatalog");

async function main() {
  let now = 1000;
  let calls = 0;
  let failure = false;
  let snapshot;
  const errors = [];
  const models = [{ id: null, label: "Auto" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }];
  const catalog = new ModelCatalog(async () => {
    calls++;
    if (failure) throw new Error("offline");
    return models;
  }, (value) => { snapshot = value; }, (error) => errors.push(error), () => now, 100);

  const first = catalog.load();
  assert.equal(catalog.load(true), first, "concurrent reloads share a request");
  await first;
  assert.equal(calls, 1);
  assert.equal(snapshot.status, "ready");
  await catalog.load();
  assert.equal(calls, 1, "fresh catalog is cached");
  now += 100;
  await catalog.load();
  assert.equal(calls, 2, "expired catalog is refreshed");
  await catalog.load(true);
  assert.equal(calls, 3, "manual refresh bypasses TTL");
  failure = true;
  await catalog.load(true);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.options, models, "offline refresh keeps known models");
  assert.equal(errors.length, 1);
  failure = false;
  await catalog.load();
  assert.equal(snapshot.status, "ready", "failed reload can be retried");
  catalog.invalidate();
  assert.deepEqual(snapshot, { options: [], status: "idle" });

  const deferred = [];
  const pendingCatalog = new ModelCatalog(() => new Promise((resolve, reject) => deferred.push({ resolve, reject })), (value) => { snapshot = value; }, () => assert.fail("stale failure leaked"));
  const stale = pendingCatalog.load();
  await Promise.resolve();
  pendingCatalog.invalidate();
  const current = pendingCatalog.load();
  await Promise.resolve();
  deferred[1].resolve(models);
  await current;
  deferred[0].resolve([{ id: "old-account", label: "Old" }]);
  await stale;
  assert.equal(snapshot.options, models, "late result cannot overwrite new account catalog");
  const staleFailure = pendingCatalog.load(true);
  await Promise.resolve();
  pendingCatalog.invalidate();
  deferred[2].reject(new Error("old process exited"));
  await staleFailure;
  assert.equal(snapshot.status, "idle", "old process error cannot overwrite invalidated status");

  const empty = new ModelCatalog(async () => [{ id: null, label: "Auto" }], (value) => { snapshot = value; }, () => {});
  await empty.load();
  assert.equal(snapshot.status, "error", "synthetic Auto is not a successful model/list");
  console.log("Model catalog checks passed: TTL, refresh, single-flight, errors, invalidation, stale responses.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
