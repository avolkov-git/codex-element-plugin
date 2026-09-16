const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");

const client = loadSource("src/elementConsoleClient.ts");
class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const configChanges = new Emitter();
let configured;
const vscode = { EventEmitter: Emitter, workspace: {
  onDidChangeConfiguration: configChanges.event,
  getConfiguration: (section) => { assert.equal(section, "1C"); return { get: (key, fallback) => configured?.[key] ?? fallback }; },
}, commands: { executeCommand() { throw new Error("MCP and IDE command providers are not installed"); } } };
const { ElementIdentityService, identityFromConsole, resolveElementIdentity, normalizeConsoleServer } = loadSource("src/elementIdentityService.ts", { vscode, "./elementConsoleClient": client });
const user = { id: "user-a", "user-list-id": "list-a", login: "private-login", "is-active": true, "access-tokens": [{ "client-secret": "response-secret" }] };
const project = { id: "project-deployment-a", "space-id": "space-a", name: "Private project", deleted: false };
const connection = { server: "https://console.invalid", clientId: "private-client", clientSecret: "private-secret", projectId: project.id };
const reply = async (url) => url.pathname.endsWith("/sys/token") ? { id_token: "private-token" } : url.pathname.endsWith("/me") ? user : project;
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
function logger() { const lines = []; return { lines, info: (message) => lines.push(message), warn: (message) => lines.push(message) }; }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function assertPrivate(text) {
  for (const secret of ["private-client", "private-secret", "private-token", "private-login", "Private project", "response-secret"]) assert(!text.includes(secret), `leaked ${secret}`);
}
async function consoleServer(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    handler(req, res, calls);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { connection: { ...connection, server: `http://127.0.0.1:${server.address().port}/prefix` }, calls };
}

test("standalone plugin uses only the current IDE's Console endpoints, with no MCP, subprocess or activation network", async (t) => {
  const fixture = await consoleServer(t, (req, res) => {
    if (req.url.endsWith("/sys/token")) json(res, { id_token: "private-token" });
    else if (req.url.endsWith("/me")) json(res, user);
    else if (req.url.endsWith(`/projects/${project.id}`)) json(res, project);
    else assert.fail(`Unexpected dependency: ${req.url}`);
  });
  configured = fixture.connection;
  const log = logger();
  const service = new ElementIdentityService(undefined, undefined, log);
  t.after(() => service.dispose());
  assert.equal(fixture.calls.length, 0);
  const identity = await service.resolve();
  assert.equal(identity.userId, user.id);
  assert.equal(identity.projectName, project.name);
  assert.deepEqual(fixture.calls.map(({ method, path }) => [method, path]), [
    ["POST", "/prefix/console/sys/token"], ["GET", "/prefix/console/api/v2/me"], ["GET", `/prefix/console/api/v2/projects/${project.id}`],
  ]);
  assert.equal(fixture.calls[0].body, "grant_type=CLIENT_CREDENTIALS");
  assert.equal(fixture.calls[0].headers.authorization, `Basic ${Buffer.from("private-client:private-secret").toString("base64")}`);
  assert.equal(fixture.calls[1].headers.authorization, "Bearer private-token");
  assert.equal(await service.resolve(), identity);
  assert.equal(fixture.calls.length, 3);
  assertPrivate(log.lines.join("\n"));
});

test("both token response contracts are supported; id_token takes precedence", async () => {
  for (const token of [{ id_token: "private-token", access_token: "Not implemented" }, { access_token: "private-token" }]) {
    await resolveElementIdentity(connection, async (url, method, headers) => {
      if (method === "POST") return token;
      assert.equal(headers.Authorization, "Bearer private-token");
      return reply(url);
    });
  }
  for (const token of [{}, { access_token: "Not implemented" }, { id_token: 123 }, { id_token: " " }]) {
    await assert.rejects(resolveElementIdentity(connection, async () => token), (error) => error.code === "token_missing");
  }
});

test("camelCase Console DTO fields produce the same scope, not an alternative user/profile", () => {
  const expected = identityFromConsole(connection.server, project.id, user, project);
  const actual = identityFromConsole(connection.server, project.id, { id: user.id, userListId: "list-a", isActive: true, login: user.login }, { id: project.id, name: project.name, spaceId: "space-a", deleted: false });
  assert.equal(actual.userKey, expected.userKey);
  assert.equal(actual.projectKey, expected.projectKey);
});

test("Console activation metadata does not change the confirmed history owner or project", () => {
  const expected = identityFromConsole(connection.server, project.id, user, project);
  for (const metadata of [{ "is-active": false }, { isActive: false }, { "is-active": true, isActive: true }, {}]) {
    const { "is-active": unused, ...identityFields } = user;
    assert.deepEqual(identityFromConsole(connection.server, project.id, { ...identityFields, ...metadata }, project), expected);
  }
});

test("Element token login with is-active=false opens only the identity confirmed by /me and project", async (t) => {
  const fixture = await consoleServer(t, (req, res) => {
    if (req.url.endsWith("/sys/token")) json(res, { id_token: "private-token" });
    else if (req.url.endsWith("/me")) json(res, { ...user, "is-active": false });
    else if (req.url.endsWith(`/projects/${project.id}`)) json(res, project);
    else assert.fail(`Unexpected dependency: ${req.url}`);
  });
  const log = logger();
  const service = new ElementIdentityService(() => fixture.connection, undefined, log);
  t.after(() => service.dispose());
  const identity = await service.resolve();
  assert.deepEqual(identity, identityFromConsole(fixture.connection.server, project.id, user, project));
  assert.equal(service.getCurrent(), identity);
  assert.equal(fixture.calls.length, 3);
  assert(log.lines.some((line) => line.includes("identity verified")));
  assert(!log.lines.some((line) => line.includes("identity rejected")));
  assertPrivate(log.lines.join("\n"));
});

for (const [field, value, reason] of [
  ["id", undefined, "missing"], ["id", 123, "invalid-type"], ["user-list-id", undefined, "missing"], ["user-list-id", null, "null"],
  ["user-list-id", " ", "empty"], ["is-active", "false", "invalid-type"], ["is-active", null, "invalid-type"],
]) {
  test(`invalid user ${field}:${reason} is diagnosed without leaking Console bodies or selecting fallback history`, async (t) => {
    const log = logger();
    const service = new ElementIdentityService(() => connection, (url) => url.pathname.endsWith("/me") ? Promise.resolve({ ...user, "is-active": false, [field]: value }) : reply(url), log);
    t.after(() => service.dispose());
    await assert.rejects(service.resolve(), (error) => {
      assert.equal(error.code, "identity_fields");
      assert(error.diagnostic.includes(`user.${field}:${reason}`));
      assertPrivate(error.message + error.diagnostic);
      return true;
    });
    assert.equal(service.getCurrent(), undefined);
    assert(log.lines.some((line) => line.includes(`user.${field}:${reason}`)));
    assertPrivate(log.lines.join("\n"));
  });
}

for (const [field, value, reason] of [
  ["id", "another-project", "mismatch"], ["id", undefined, "missing"], ["name", "", "empty"],
  ["space-id", undefined, "missing"], ["space-id", "", "empty"], ["space-id", {}, "invalid-type"], ["deleted", true, "deleted"], ["deleted", "false", "invalid-type"],
]) {
  test(`invalid project ${field}:${reason} cannot open history`, () => {
    assert.throws(() => identityFromConsole(connection.server, project.id, { ...user, "is-active": false }, { ...project, [field]: value }), (error) => {
      assert.equal(error.code, "identity_fields");
      assert(error.diagnostic.includes(`project.${field}:${reason}`));
      assertPrivate(error.message + error.diagnostic);
      return true;
    });
  });
}

test("conflicting DTO aliases are rejected instead of guessing which value to trust", () => {
  for (const [u, p, field] of [
    [{ ...user, userListId: "another-list" }, project, "user.user-list-id"],
    [{ ...user, isActive: false }, project, "user.is-active"],
    [user, { ...project, spaceId: null }, "project.space-id"],
  ]) assert.throws(() => identityFromConsole(connection.server, project.id, u, p), (error) => error.diagnostic.includes(`${field}:conflict`));
});

test("project UUID case differences are valid, arbitrary identifier differences are not", () => {
  const id = "019e4f95-7fb3-7273-ba33-e37571fbc595";
  assert.doesNotThrow(() => identityFromConsole(connection.server, id.toUpperCase(), user, { ...project, id }));
  assert.throws(() => identityFromConsole(connection.server, project.id.toUpperCase(), user, project));
});

test("missing credentials do not invoke any network or use MCP/environment credentials", async () => {
  for (const field of ["server", "clientId", "clientSecret", "projectId"]) {
    let requests = 0;
    await assert.rejects(resolveElementIdentity({ ...connection, [field]: "" }, async () => { requests++; }), (error) => {
      assert.equal(error.code, "configuration_missing");
      assert(error.diagnostic.includes(field));
      assertPrivate(error.message + error.diagnostic);
      return true;
    });
    assert.equal(requests, 0);
  }
});

test("server prefix is preserved; credentials, query strings and unsupported protocols in the URL are rejected", () => {
  assert.equal(normalizeConsoleServer("https://host.test/prefix/console/"), "https://host.test/prefix/console");
  for (const url of ["https://private-client:private-secret@host", "https://host?token=private-token", "file:///tmp", "not-url"]) {
    assert.throws(() => normalizeConsoleServer(url), (error) => { assertPrivate(error.message + error.diagnostic); return error.code === "configuration_invalid"; });
  }
});

test("401 refreshes Console token exactly once, without MCP or another connection", async (t) => {
  let tokens = 0;
  const fixture = await consoleServer(t, (req, res) => {
    if (req.url.endsWith("/sys/token")) json(res, { id_token: `token-${++tokens}` });
    else if (req.headers.authorization === "Bearer token-1") json(res, { message: "private-secret" }, 401);
    else json(res, req.url.endsWith("/me") ? user : project);
  });
  const identity = await resolveElementIdentity(fixture.connection);
  assert.equal(identity.userId, user.id);
  assert.equal(tokens, 2);
  assert.equal(fixture.calls.length, 5);
});

for (const status of [401, 403, 404, 302, 500]) {
  test(`HTTP ${status} stops safely with bounded requests and does not expose response/redirect content`, async (t) => {
    const fixture = await consoleServer(t, (req, res) => {
      if (req.url.endsWith("/sys/token")) json(res, { id_token: "private-token" });
      else { res.setHeader("Location", "https://private-client:private-secret@example.test/"); json(res, { message: "private-token" }, status); }
    });
    await assert.rejects(resolveElementIdentity(fixture.connection), (error) => {
      assert.equal(error.stage, "user"); assert.equal(error.statusCode, status);
      assertPrivate(error.message + error.diagnostic);
      return true;
    });
    assert.equal(fixture.calls.length, status === 401 ? 4 : 2);
  });
}

for (const stage of ["token", "user", "project"]) {
  for (const status of [401, 403]) {
    test(`is-active=false cannot bypass Console HTTP ${status} at ${stage} or retain cached identity`, async (t) => {
      let deny = false;
      const fixture = await consoleServer(t, (req, res) => {
        const requestStage = req.url.endsWith("/sys/token") ? "token" : req.url.endsWith("/me") ? "user" : "project";
        if (deny && requestStage === stage) { json(res, { message: "private-secret" }, status); return; }
        json(res, requestStage === "token" ? { id_token: "private-token" } : requestStage === "user" ? { ...user, "is-active": false } : project);
      });
      const log = logger();
      const service = new ElementIdentityService(() => fixture.connection, undefined, log);
      t.after(() => service.dispose());
      assert.equal((await service.resolve()).userId, user.id);
      deny = true;
      const initialCalls = fixture.calls.length;
      await assert.rejects(service.resolve(true), (error) => {
        assert.equal(error.stage, stage);
        assert.equal(error.statusCode, status);
        assertPrivate(error.message + error.diagnostic);
        return true;
      });
      assert.equal(service.getCurrent(), undefined);
      const expectedCalls = { token: 1, user: 2, project: 3 }[stage] + (status === 401 && stage !== "token" ? 2 : 0);
      assert.equal(fixture.calls.length - initialCalls, expectedCalls);
      assertPrivate(log.lines.join("\n"));
    });
  }
}

test("malformed, truncated and oversized Console responses fail without retaining raw body content", async (t) => {
  const fixture = await consoleServer(t, (req, res) => {
    if (req.url.endsWith("/malformed")) { res.end("private-token: not JSON"); return; }
    if (req.url.endsWith("/oversized")) { res.end(JSON.stringify({ text: "x".repeat(1024 * 1024) })); return; }
    res.writeHead(200, { "Content-Length": "4096" }); res.write("private-secret"); setImmediate(() => res.destroy());
  });
  for (const [endpoint, code] of [["malformed", "response_json"], ["oversized", "response_size"], ["truncated", "network"]]) {
    await assert.rejects(client.requestConsoleJson(new URL(`${fixture.connection.server}/${endpoint}`), "GET", {}), (error) => {
      assert.equal(error.code, code); assertPrivate(error.message + error.diagnostic); return true;
    });
  }
});

test("non-object DTOs are diagnosed by stage, not silently converted into an empty user", async () => {
  for (const payload of [[], null, "private-secret"]) {
    await assert.rejects(resolveElementIdentity(connection, (url) => url.pathname.endsWith("/me") ? Promise.resolve(payload) : reply(url)), (error) => {
      assert.equal(error.stage, "user"); assert.equal(error.code, "response_shape"); assertPrivate(error.message + error.diagnostic); return true;
    });
  }
});

test("unexpected transport exceptions are sanitized before reaching the UI/logger", async () => {
  await assert.rejects(resolveElementIdentity(connection, async () => { throw new Error("private-secret private-token"); }), (error) => {
    assert.equal(error.code, "network"); assertPrivate(error.message + error.diagnostic); return true;
  });
});

test("invalidation aborts actual HTTP and prevents old identity publication", async (t) => {
  const started = deferred();
  const fixture = await consoleServer(t, (req, res) => {
    if (req.url.endsWith("/sys/token")) json(res, { id_token: "private-token" });
    else started.resolve();
  });
  const service = new ElementIdentityService(() => fixture.connection);
  t.after(() => service.dispose());
  const pending = service.resolve();
  const rejected = assert.rejects(pending, (error) => error.code === "cancelled");
  await started.promise;
  service.invalidate();
  await rejected;
  assert.equal(service.getCurrent(), undefined);
  assert.equal(fixture.calls.length, 2);
});

test("credential change during the very first lookup does not reuse the previous pending identity", async (t) => {
  let current = { ...connection };
  const started = deferred(), old = deferred();
  const service = new ElementIdentityService(() => current, async (url, method, headers) => {
    if (method === "POST") return { id_token: headers.Authorization.endsWith(Buffer.from("private-client:private-secret").toString("base64")) ? "old" : "new" };
    if (url.pathname.endsWith("/me") && headers.Authorization === "Bearer old") { started.resolve(); return old.promise; }
    return url.pathname.endsWith("/me") ? { ...user, id: "user-b" } : project;
  });
  t.after(() => service.dispose());
  const pending = service.resolve();
  const rejected = assert.rejects(pending, /изменился|отменена/);
  await started.promise;
  current.clientSecret = "new-secret";
  const next = await service.resolve();
  old.resolve(user);
  await rejected;
  assert.equal(next.userId, "user-b");
  assert.equal(service.getCurrent().userId, "user-b");
});

test("concurrent lookups coalesce, but separate IDE instances never share identity or tokens", async (t) => {
  const calls = [];
  const lookup = async (url, method, headers) => {
    calls.push(url.pathname);
    if (method === "POST") return { id_token: headers.Authorization };
    return url.pathname.endsWith("/me") ? { ...user, id: headers.Authorization.includes(Buffer.from("b:secret-b").toString("base64")) ? "user-b" : "user-a" } : project;
  };
  const a = new ElementIdentityService(() => connection, lookup);
  const b = new ElementIdentityService(() => ({ ...connection, clientId: "b", clientSecret: "secret-b" }), lookup);
  t.after(() => { a.dispose(); b.dispose(); });
  const [a1, a2, b1] = await Promise.all([a.resolve(), a.resolve(), b.resolve()]);
  assert.equal(a1, a2);
  assert.notEqual(a1.userKey, b1.userKey);
  assert.equal(calls.length, 6);
});

test("configuration changes invalidate cached scope and disposed service cannot restart", async () => {
  const service = new ElementIdentityService(() => connection, reply);
  await service.resolve();
  configChanges.fire({ affectsConfiguration: (key) => key === "1C.projectId" });
  assert.equal(service.getCurrent(), undefined);
  service.dispose();
  await assert.rejects(service.resolve(), /остановлена/);
});
