const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { loadSource, vscode } = require("./service-test-utils.cjs");

function fixture(behavior = () => {}, disableSandbox = false) {
  const calls = [];
  const stopped = [];
  const logs = [];
  class RuntimeProcessManager {
    start(options) {
      this.options = options;
      calls.push(options);
      queueMicrotask(() => {
        if (behavior(options) === false) return;
        options.onStdout(options.args[0] === "-e" ? '{"browserVersion":"151.0.7922.10"}' : "v20.20.2");
        options.onExit(0, null);
      });
    }
    async stop() { stopped.push(this.options); }
  }
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", {
    vscode, "./runtimeProcessManager": { RuntimeProcessManager }
  });
  const service = new BrowserRuntimeService({}, {}, { info: value => logs.push(value), warn: value => logs.push(value) });
  service.resolveRuntime = () => ({ root: "/fixture", nodePath: "/fixture/node.exe", launcherPath: "/fixture/cli.js",
    browserExecutablePath: "/fixture/chrome.exe", manifest: { platformId: "win32-x64", playwrightMcpVersion: "0.0.78", nodeVersion: "v20.20.2" } });
  service.getSettingsView = () => ({ disableSandbox });
  return { service, calls, stopped, logs };
}

test("browser check uses Playwright instead of chrome.exe --version, coalesces duplicate checks, and cleans up", async () => {
  const f = fixture();
  assert.match(f.service.getView().statusMessage, /найдены/);
  const pending = f.service.test();
  assert.equal(f.service.test(), pending);
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.match(result.message, /нажатие кнопки выполнено/);
  assert.match(result.details, /Chromium 151\.0\.7922\.10/);
  assert.match(result.details, /Playwright MCP 0\.0\.78/);
  assert.equal(f.calls.length, 3);
  assert.equal(f.stopped.length, 3);
  assert(f.calls.every(call => call.command.endsWith("node.exe")), "never directly execute the Windows GUI browser");
  assert.equal(f.calls.filter(call => call.args[0] === "--version").length, 1, "only Node has a CLI version probe");
  assert.equal(f.calls[2].args[4], "0");
  assert(f.logs.some(log => log.includes("Browser check passed")));
  await f.service.test();
  assert.equal(f.calls.length, 6, "a later retry runs a fresh check");
});

for (const stage of ["node", "launcher", "browser"]) {
  test(`${stage} failure is visible and later stages are not started`, async () => {
    const f = fixture(options => {
      const current = options.args[0] === "-e" ? "browser" : options.args[0] === "--version" ? "node" : "launcher";
      if (current !== stage) return;
      options.onStderr("fixture: executable unavailable");
      options.onExit(1, null);
      return false;
    });
    const result = await f.service.test();
    assert.equal(result.status, "failed");
    assert.match(result.details, /fixture: executable unavailable/);
    assert.match(result.message, /логи Codex/);
    assert.equal(f.calls.length, ["node", "launcher", "browser"].indexOf(stage) + 1);
    assert.equal(f.stopped.length, f.calls.length);
    assert(f.logs.some(log => log.includes("Browser check failed")));
  });
}

test("spawn failure and an invalid browser reply cannot be reported as ready", async () => {
  const failed = fixture(options => { options.onError(new Error("spawn denied")); return false; });
  assert.equal((await failed.service.test()).status, "failed");
  assert.equal(failed.stopped.length, 1);
  const invalid = fixture(options => {
    if (options.args[0] !== "-e") return;
    options.onStdout('{"browserVersion":""}');
    options.onExit(0, null);
    return false;
  });
  assert.equal((await invalid.service.test()).status, "failed");
});

test("browser deadline terminates the owned process tree and retains bounded stderr", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(options => {
    if (options.args[0] !== "-e") return;
    options.onStderr("x".repeat(100000) + " fixture-hang");
    return false;
  });
  const pending = f.service.test();
  for (let step = 0; step < 30; step++) await Promise.resolve();
  assert.equal(f.calls.length, 3);
  t.mock.timers.tick(45_000);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.details, /45 с/);
  assert.match(result.details, /fixture-hang/);
  assert(result.details.length < 2200);
  assert.equal(f.stopped.length, 3);
});

test("probe script launches headless, navigates and clicks offline, reads the live version and always closes", async () => {
  const f = fixture(undefined, true);
  await f.service.test();
  const args = f.calls[2].args;
  assert.equal(args[4], "1", "preserve the explicitly configured sandbox option");
  for (const failClick of [false, true]) {
    let closed = false;
    let clicked = false;
    let html = "";
    let title = "Codex browser check";
    let output;
    let failure;
    let exited;
    const page = {
      setDefaultTimeout(value) { assert.equal(value, 5000); },
      async goto(url) { assert(url.startsWith("data:text/html,")); html = decodeURIComponent(url.slice("data:text/html,".length)); },
      getByRole(role, options) {
        assert.equal(role, "button"); assert.equal(options.name, "Check");
        return { async click() {
          if (failClick) throw new Error("fixture click failed");
          const button = {};
          const document = { querySelector: () => button, title };
          vm.runInNewContext(html.match(/<script>(.*?)<\/script>/s)[1], { document });
          button.onclick();
          title = document.title;
          clicked = true;
        } };
      },
      async title() { return title; }
    };
    const completed = vm.runInNewContext(args[1], {
      require(modulePath) {
        assert.equal(modulePath, path.join("/fixture", "node_modules", "playwright"));
        return { chromium: { async launch(options) {
          assert.equal(options.headless, true);
          assert.equal(options.executablePath, "/fixture/chrome.exe");
          assert.equal(options.timeout, 20000);
          assert.equal(options.args.join(","), "--no-sandbox,--disable-setuid-sandbox");
          return { async newPage() { return page; }, version() { assert(clicked); return "151.0.7922.10"; }, async close() { closed = true; } };
        } } };
      },
      process: { argv: ["node", ...args.slice(2)], exit(code) { exited = code; } },
      console: { log(value) { output = JSON.parse(value); }, error(error) { failure = error; } }
    });
    await completed;
    assert(closed);
    if (failClick) { assert.equal(exited, 1); assert.match(failure, /fixture click failed/); }
    else assert.equal(output.browserVersion, "151.0.7922.10");
  }
});
