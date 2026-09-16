const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

// Compile just the source under test in memory; never consume or generate dist.
const filename = path.resolve(__dirname, "../src/logger.ts");
const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  fileName: filename,
}).outputText;
const LOGS = path.resolve(__dirname, "logger-fixture/logs");
const WORKSPACE = path.resolve(__dirname, "logger-fixture/workspace");
const PLUGIN = path.join(LOGS, "plugin.log");
const RUNTIME = path.join(LOGS, "runtime.log");
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Expected asynchronous checkpoint was not reached");
}

function nodeError(code) {
  return Object.assign(new Error("private/path token=RAW_SECRET https://private:credential@example.test"), { code });
}

function harness(t) {
  let now = 0;
  let active = 0;
  let maxActive = 0;
  const timers = new Set();
  const files = new Map();
  const directories = new Set();
  const calls = [];
  const hooks = {};
  const releases = [];
  const output = [];
  let outputError;
  let outputDisposed = 0;
  let shown = 0;
  const warnings = [];
  const commands = [];
  let commandError;

  const promises = {};
  for (const method of ["mkdir", "stat", "appendFile", "rm", "rename", "readdir", "copyFile"]) {
    promises[method] = async (...args) => {
      calls.push({ method, args });
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (hooks[method]) await hooks[method](...args);
        const [file, value] = args;
        if (method === "mkdir") { directories.add(file); return; }
        if (method === "stat") {
          if (!files.has(file)) throw nodeError("ENOENT");
          return { size: files.get(file).size };
        }
        if (method === "appendFile") {
          const previous = files.get(file) ?? { text: "", size: 0, regular: true };
          files.set(file, { ...previous, text: previous.text + value, size: previous.size + Buffer.byteLength(value) });
          return;
        }
        if (method === "rm") { files.delete(file); return; }
        if (method === "rename" || method === "copyFile") {
          if (!files.has(file)) throw nodeError("ENOENT");
          files.set(value, { ...files.get(file) });
          if (method === "rename") files.delete(file);
          return;
        }
        if (method === "readdir") {
          if (!directories.has(file)) throw nodeError("ENOENT");
          return [...files.entries()].filter(([name]) => path.dirname(name) === file)
            .map(([name, entry]) => ({ name: path.basename(name), isFile: () => entry.regular }));
        }
      } finally {
        active -= 1;
      }
    };
  }
  const vscode = {
    window: {
      createOutputChannel: () => ({
        append(text) {
          assert.equal(outputDisposed, 0, "no submissions after output disposal");
          output.push({ text, time: now });
          assert(Buffer.byteLength(text) <= 64 * 1024, "bounded output submission bytes");
          assert(text.split("\n").length - 1 <= 128, "bounded output submission lines");
          if (outputError) throw outputError;
        },
        appendLine() { assert.fail("per-line output submissions are forbidden"); },
        dispose() { outputDisposed += 1; },
        show() { shown += 1; },
      }),
      showWarningMessage: (message) => { warnings.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: WORKSPACE } }] },
    commands: { executeCommand: async (...args) => {
      commands.push(args);
      if (commandError) throw commandError;
    } },
    Uri: { file: (fsPath) => ({ fsPath }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, Error, Date,
    require: (name) => {
      if (name === "vscode") return vscode;
      if (name === "fs") return { promises, mkdirSync() { assert.fail("no synchronous directory creation"); } };
      if (name === "path") return path;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  }, { filename });
  const logger = new module.exports.Logger();
  t.after(async () => {
    for (const release of releases) release();
    for (const name of Object.keys(hooks)) delete hooks[name];
    logger.dispose();
    await logger.flush().catch(() => undefined);
    assert.equal(timers.size, 0);
    assert.equal(active, 0);
    assert.equal(outputDisposed, 1);
  });
  return {
    logger, redact: module.exports.redact, calls, files, output, hooks, timers, vscode, warnings, commands,
    text: (file = PLUGIN) => files.get(file)?.text ?? "",
    outputText: () => output.map((entry) => entry.text).join(""),
    count: (method) => calls.filter((call) => call.method === method).length,
    get maxActive() { return maxActive; },
    get outputDisposed() { return outputDisposed; },
    get shown() { return shown; },
    set outputError(value) { outputError = value; },
    set commandError(value) { commandError = value; },
    seed(file, text, size = Buffer.byteLength(text), regular = true) {
      files.set(file, { text, size, regular });
      directories.add(path.dirname(file));
    },
    block(method) {
      const entered = deferred();
      const gate = deferred();
      let first = true;
      hooks[method] = async () => {
        if (!first) return;
        first = false;
        entered.resolve();
        await gate.promise;
      };
      releases.push(gate.resolve);
      return { entered: entered.promise, release: gate.resolve };
    },
    async advance(ms) {
      const through = now + ms;
      while (true) {
        const timer = [...timers].filter((entry) => entry.at <= through).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        timers.delete(timer);
        now = timer.at;
        timer.fn();
        await settle();
      }
      now = through;
      await settle();
    },
  };
}

function bounded(logger) {
  const metrics = logger.getMetrics();
  assert(metrics.queueLines >= 0 && metrics.queueLines <= 512);
  assert(metrics.queueBytes >= 0 && metrics.queueBytes <= 256 * 1024);
  assert(metrics.inflightLines >= 0 && metrics.inflightLines <= 128);
  assert(metrics.inflightBytes >= 0 && metrics.inflightBytes <= 64 * 1024);
  assert(metrics.inflight === 0 || metrics.inflight === 1);
  return metrics;
}

test("logger preserves levels, runtime mirroring, redaction and batches both sinks", async (t) => {
  const h = harness(t);
  h.logger.info("before files");
  h.logger.enableFileLogging(LOGS);
  for (let index = 0; index < 250; index += 1) {
    h.logger.info(`item ${index} token=info-secret`);
    if (index % 25 === 0) h.logger.runtime("warn", `runtime ${index} password=runtime-secret`);
  }
  h.logger.error("important failure");
  assert.equal(h.calls.length, 0);
  assert.equal(h.output.length, 0);
  assert.equal(h.timers.size, 1);
  await h.logger.flush();
  assert.match(h.outputText(), /before files/);
  assert.doesNotMatch(h.text(), /before files/);
  assert.match(h.text(), /\[error\] important failure/);
  assert.match(h.text(), /token=\*\*\*/);
  assert.doesNotMatch(h.outputText(), /info-secret|runtime-secret/);
  const runtimeLines = h.text(RUNTIME).trim().split("\n");
  assert.equal(runtimeLines.length, 10);
  for (const line of runtimeLines) assert(h.text().includes(line));
  assert.equal(h.count("mkdir"), 1);
  assert.equal(h.count("stat"), 2);
  assert(h.count("appendFile") <= 6);
  assert(h.output.length <= 4);
  assert.equal(h.maxActive, 1);
  const metrics = bounded(h.logger);
  assert.equal(metrics.queueLines + metrics.inflightLines, 0);
  assert.equal(metrics.batches, h.output.length);
  assert.equal(metrics.fileWrites, h.count("appendFile"));
  const snapshot = h.logger.getMetrics();
  snapshot.drops.info = 999;
  snapshot.queueBytes = 999;
  assert.equal(h.logger.getMetrics().drops.info, 0);
  assert.equal(h.logger.getMetrics().queueBytes, 0);
  function numericOnly(value) {
    for (const item of Object.values(value)) {
      if (typeof item === "object") numericOnly(item);
      else assert.equal(typeof item, "number");
    }
  }
  numericOnly(metrics);
});

test("logger paces sustained output to five bounded appends per second", async (t) => {
  const h = harness(t);
  for (let tick = 0; tick < 200; tick += 1) {
    for (let index = 0; index < 30; index += 1) h.logger.info("repeated notification");
    bounded(h.logger);
    await h.advance(10);
  }
  assert(h.output.length <= 10, `${h.output.length} output calls in two seconds`);
  for (let index = 1; index < h.output.length; index += 1) {
    assert(h.output[index].time - h.output[index - 1].time >= 200);
  }
  assert(h.logger.getMetrics().drops.info > 4000);
  assert.match(h.outputText(), /Logger queue dropped records: info=\d+, warn=0, error=0/);
  await h.logger.flush();
  assert.equal(h.logger.getMetrics().queueLines, 0);
  assert.equal(h.calls.length, 0);
});

test("slow disk plus 50k notifications remains bounded and does not starve errors", async (t) => {
  const h = harness(t);
  const blocked = h.block("appendFile");
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("info", "first runtime record");
  const firstFlush = h.logger.flush();
  await blocked.entered;
  for (let index = 0; index < 50000; index += 1) {
    h.logger.runtime("info", "repeated token=hidden");
    if (index % 1000 === 0) bounded(h.logger);
  }
  for (let index = 0; index < 400; index += 1) h.logger.warn(`warning ${index}`);
  h.logger.runtime("error", "critical runtime error");
  const during = bounded(h.logger);
  assert.equal(during.inflight, 1);
  assert(during.drops.info > 49000);
  assert.equal(during.drops.error, 0);
  assert.equal(h.output.length, 1);
  assert.equal(h.count("appendFile"), 1);
  assert.equal(h.count("stat"), 1);
  assert.equal(h.timers.size, 0);
  blocked.release();
  await firstFlush;
  assert(h.logger.getMetrics().queueLines > 0, "flush does not chase later traffic");
  await h.logger.flush();
  assert.match(h.text(RUNTIME), /\[error\] critical runtime error/);
  assert.match(h.text(), /Logger queue dropped records/);
  assert.doesNotMatch(h.outputText(), /hidden/);
  assert.equal(h.count("mkdir"), 1);
  assert.equal(h.count("stat"), 2);
  assert(h.count("appendFile") <= 12);
  assert.equal(h.maxActive, 1);
  assert.equal(bounded(h.logger).queueBytes, 0);
});

test("byte pressure and an error-only flood evict old errors with explicit counters", async (t) => {
  const h = harness(t);
  const blocked = h.block("appendFile");
  h.logger.enableFileLogging(LOGS);
  const first = h.logger.flush();
  await blocked.entered;
  for (let index = 0; index < 2000; index += 1) {
    h.logger.error(`error-${index} ${"x".repeat(7000)}`);
    bounded(h.logger);
  }
  const metrics = h.logger.getMetrics();
  assert(metrics.queueLines < 40, "byte cap, not only line cap, limits large records");
  assert.equal(metrics.drops.error + metrics.queueLines, 2000);
  assert(metrics.drops.error > 1900);
  blocked.release();
  await first;
  await h.logger.flush();
  assert.match(h.text(), /error-1999 /);
  assert.doesNotMatch(h.text(), /error-0 /);
  assert.match(h.text(), /error=19\d\d/);
  assert(h.count("appendFile") < 10);
});

test("full warning queue rejects info/warnings but an error can evict a warning", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 600; index += 1) h.logger.warn(`warning ${index}`);
  h.logger.info("discard this info");
  h.logger.error("keep this error");
  const metrics = bounded(h.logger);
  assert.equal(metrics.queueLines, 512);
  assert.equal(metrics.drops.warn, 89);
  assert.equal(metrics.drops.info, 1);
  assert.equal(metrics.drops.error, 0);
  await h.logger.flush();
  assert.match(h.outputText(), /keep this error/);
  assert.doesNotMatch(h.outputText(), /discard this info/);
});

test("giant and multibyte input is omitted safely; ordinary secrets and newlines are redacted", async (t) => {
  const h = harness(t);
  h.logger.enableFileLogging(LOGS);
  const secrets = "sk-1234567890abcdef password=alpha token=beta secret=gamma api_key=delta " +
    'https://user:credential@example.test "apiKey": "json-key" password="two words" ' +
    "Authorization: Bearer bearer-value Basic abcdef==";
  h.logger.error(secrets);
  h.logger.info("first\nforged\rline\u2028end");
  h.logger.runtime("error", `token=${"giant-secret".repeat(100000)}`);
  h.logger.warn("\u754c".repeat(4000));
  h.logger.error(`${"x".repeat(8180)} password=boundary-secret`);
  h.logger.info("api_key=" + "z".repeat(8100));
  await h.logger.flush();
  assert.equal(h.logger.getMetrics().oversizedLines, 3);
  assert.match(h.outputText(), /first\\nforged\\nline\\nend/);
  assert.match(h.text(RUNTIME), /\[error\] \[oversized message omitted/);
  assert.doesNotMatch(h.outputText(), /1234567890abcdef|alpha|beta|gamma|delta|credential|json-key|two words|bearer-value|abcdef==|giant-secret|boundary-secret|zzzz/);
  for (const line of h.outputText().trimEnd().split("\n")) assert(Buffer.byteLength(`${line}\n`) <= 8192);
  assert.equal(h.redact("password=a&token=b secret=c api-key=d https://u:p@example.test sk-12345678"),
    "password=***&token=*** secret=*** api-key=*** https://***:***@example.test sk-***");
  assert.equal(h.redact("token=punctuation;inside,credential} password='two words'"), "token=*** password=***");
});

test("rotation includes incoming batch size, retains five backups, and caches file sizes", async (t) => {
  const h = harness(t);
  h.seed(PLUGIN, "previous plugin\n", MAX_FILE_BYTES - 10);
  h.seed(RUNTIME, "previous runtime\n", MAX_FILE_BYTES - 10);
  for (let index = 1; index <= 5; index += 1) h.seed(`${PLUGIN}.${index}`, `backup ${index}`);
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("error", "new runtime record");
  await h.logger.flush();
  assert.equal(h.text(`${PLUGIN}.1`), "previous plugin\n");
  assert.equal(h.text(`${PLUGIN}.5`), "backup 4");
  assert.equal(h.text(`${RUNTIME}.1`), "previous runtime\n");
  assert(!h.files.has(`${PLUGIN}.6`));
  assert.match(h.text(), /new runtime record/);
  assert(h.files.get(PLUGIN).size <= MAX_FILE_BYTES);
  assert(h.files.get(RUNTIME).size <= MAX_FILE_BYTES);
  assert.equal(h.count("rename"), 10);
  for (let index = 0; index < 20; index += 1) {
    h.logger.runtime("info", `later ${index}`);
    await h.logger.flush();
  }
  assert.equal(h.count("stat"), 2);
  assert.equal(h.count("mkdir"), 1);
  assert.equal(h.count("rename"), 10);
});

test("cached byte accounting rotates when a later batch crosses the file limit", async (t) => {
  const h = harness(t);
  h.seed(PLUGIN, "old data\n", MAX_FILE_BYTES - 512);
  h.logger.enableFileLogging(LOGS);
  h.logger.info("fits in the existing log");
  await h.logger.flush();
  assert.equal(h.count("rename"), 0);
  h.logger.error("x".repeat(1024));
  await h.logger.flush();
  assert.equal(h.count("rename"), 5);
  assert.equal(h.count("stat"), 1);
  assert.match(h.text(`${PLUGIN}.1`), /fits in the existing log/);
  assert.doesNotMatch(h.text(), /fits in the existing log/);
  assert(h.files.get(PLUGIN).size < 2048);
});

for (const [method, code, operation] of [
  ["mkdir", "EACCES", "create log directory"],
  ["stat", "EACCES", "stat plugin.log"],
  ["appendFile", "ENOSPC", "append plugin.log"],
  ["rm", "EPERM", "rotate plugin.log"],
  ["rename", "EPERM", "rotate plugin.log"],
]) {
  test(`${method} failures are useful, bounded, sanitized and recover on later traffic`, async (t) => {
    const h = harness(t);
    if (method === "rename" || method === "rm") h.seed(PLUGIN, "previous", MAX_FILE_BYTES);
    h.hooks[method] = async () => { throw nodeError(code); };
    h.logger.enableFileLogging(LOGS);
    h.logger.error("user failure");
    await assert.rejects(h.logger.flush(), (error) => {
      assert(error.message.includes(operation));
      assert(error.message.includes(code));
      assert.doesNotMatch(error.message, /RAW_SECRET|credential|private/);
      return true;
    });
    const metrics = bounded(h.logger);
    assert.equal(metrics.fileErrors, 1);
    assert.equal(metrics.fileDroppedLines, 2);
    assert.equal(metrics.inflight + metrics.queueLines, 0);
    assert.equal(h.output.length, 2, "one data batch and one output-only diagnostic");
    assert.match(h.outputText(), /Failed file operations: 1/);
    assert.doesNotMatch(h.outputText(), /RAW_SECRET|credential|private/);
    const failedCalls = h.calls.length;
    await h.advance(10000);
    assert.equal(h.calls.length, failedCalls, "diagnostics must not retry the failing file sink");
    await h.logger.flush();
    delete h.hooks[method];
    h.logger.error("recovered");
    await h.logger.flush();
    assert.match(h.text(), /recovered/);
    assert.doesNotMatch(h.text(), /Failed file operations/);
  });
}

test("background failures remain visible to the next explicit flush without unhandled rejections", async (t) => {
  const h = harness(t);
  h.hooks.appendFile = async () => { throw nodeError("ENOSPC"); };
  h.logger.enableFileLogging(LOGS);
  await h.advance(1000);
  assert.equal(h.count("appendFile"), 1);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.logger.flush(), /ENOSPC.*Free disk space/);
  await h.logger.flush();
});

test("a broken plugin sink does not prevent best-effort runtime error delivery", async (t) => {
  const h = harness(t);
  h.hooks.appendFile = async (file) => { if (file === PLUGIN) throw nodeError("ENOSPC"); };
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("error", "runtime survives token=runtime-secret");
  await assert.rejects(h.logger.flush(), /append plugin.log failed \(ENOSPC\)/);
  assert.match(h.text(RUNTIME), /runtime survives token=\*\*\*/);
  assert.equal(h.count("appendFile"), 2);
  assert.equal(h.count("stat"), 2);
  assert.equal(h.logger.getMetrics().fileDroppedLines, 2);
  assert.equal(h.logger.getMetrics().fileErrors, 1);
  assert.doesNotMatch(h.outputText(), /runtime-secret|RAW_SECRET/);
});

test("a removed log directory invalidates cached state and is recreated on later traffic", async (t) => {
  const h = harness(t);
  h.logger.enableFileLogging(LOGS);
  await h.logger.flush();
  h.hooks.appendFile = async () => { throw nodeError("ENOENT"); };
  h.logger.error("directory removed");
  await assert.rejects(h.logger.flush(), /ENOENT/);
  delete h.hooks.appendFile;
  h.files.delete(PLUGIN);
  h.logger.error("directory restored");
  await h.logger.flush();
  assert.equal(h.count("mkdir"), 2);
  assert.equal(h.count("stat"), 2);
  assert.match(h.text(), /directory restored/);
});

test("output failure cannot recurse or prevent file writes; unknown codes are never echoed", async (t) => {
  const h = harness(t);
  h.outputError = nodeError("token=CODE_SECRET");
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("error", "persist despite broken output");
  await assert.rejects(h.logger.flush(), /append output channel failed \(UNKNOWN\)/);
  assert.equal(h.output.length, 1);
  assert.equal(h.logger.getMetrics().outputErrors, 1);
  assert.equal(h.logger.getMetrics().outputDroppedLines, 2);
  assert.match(h.text(RUNTIME), /persist despite broken output/);
  assert.doesNotMatch(JSON.stringify(h.logger.getMetrics()), /CODE_SECRET|RAW_SECRET/);
  await h.advance(10000);
  assert.equal(h.output.length, 1);
});

test("flush coalesces concurrent callers and extends only to their acceptance boundary", async (t) => {
  const h = harness(t);
  const blocked = h.block("appendFile");
  h.logger.enableFileLogging(LOGS);
  const first = h.logger.flush();
  await blocked.entered;
  h.logger.error("included by second flush");
  const second = h.logger.flush();
  assert.equal(first, second);
  h.logger.error("after both flushes");
  blocked.release();
  await second;
  assert.match(h.text(), /included by second flush/);
  assert.doesNotMatch(h.text(), /after both flushes/);
  assert.equal(h.logger.getMetrics().queueLines, 1);
  await h.logger.flush();
  assert.match(h.text(), /after both flushes/);
});

test("a flush arriving at the drain completion boundary still includes its accepted records", async (t) => {
  for (let delay = 0; delay < 20; delay += 1) {
    const h = harness(t);
    let nextFlush;
    let first = true;
    h.hooks.appendFile = () => {
      if (!first) return;
      first = false;
      let completion = Promise.resolve();
      for (let step = 0; step < delay; step += 1) completion = completion.then(() => undefined);
      void completion.then(() => {
        h.logger.error("completion boundary record");
        nextFlush = h.logger.flush();
      });
    };
    h.logger.enableFileLogging(LOGS);
    await h.logger.flush();
    await until(() => nextFlush);
    await nextFlush;
    assert.match(h.text(), /completion boundary record/, `microtask delay ${delay}`);
  }
});

test("new drops and persistent disk failure cannot keep a snapshot flush alive", async (t) => {
  const h = harness(t);
  h.logger.enableFileLogging(LOGS);
  for (let index = 0; index < 300; index += 1) h.logger.info("accepted before flush");
  h.hooks.appendFile = async () => {
    for (let index = 0; index < 10000; index += 1) h.logger.info("later flood");
    throw nodeError("ENOSPC");
  };
  await assert.rejects(h.logger.flush(), /ENOSPC/);
  assert(h.count("appendFile") <= 3);
  assert(bounded(h.logger).queueLines > 0);
  assert.equal(h.timers.size, 1);
});

test("export drains its snapshot and pauses writes/rotation while copying under a flood", async (t) => {
  const h = harness(t);
  h.seed(`${PLUGIN}.1`, "backup\n");
  h.seed(path.join(LOGS, "unrelated.json"), "do not copy");
  h.seed(`${RUNTIME}.2`, "symlink content", 10, false);
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("error", "before export token=export-secret");
  const blocked = h.block("copyFile");
  const exporting = h.logger.exportLogsToWorkspace();
  assert.equal(h.logger.exportLogsToWorkspace(), exporting);
  await blocked.entered;
  const writes = h.count("appendFile");
  for (let index = 0; index < 10000; index += 1) h.logger.info("during export");
  h.logger.runtime("error", "during export error");
  bounded(h.logger);
  let flushed = false;
  const flush = h.logger.flush().then(() => { flushed = true; });
  await h.advance(1000);
  assert.equal(h.count("appendFile"), writes);
  assert.equal(flushed, false);
  blocked.release();
  const target = await exporting;
  await flush;
  assert.equal(target, path.join(WORKSPACE, ".local-codex", "logs"));
  const copies = [...h.files.entries()].filter(([file]) => path.dirname(file) === target);
  assert.equal(copies.length, 3);
  const exportedText = copies.map(([, file]) => file.text).join("");
  assert.match(exportedText, /before export token=\*\*\*/);
  assert.doesNotMatch(exportedText, /during export|export-secret|do not copy|symlink/);
  assert.match(h.text(RUNTIME), /during export error/);
  assert.equal(h.count("readdir"), 1);
  assert.equal(h.maxActive, 1);
});

test("export and open-folder failures are sanitized and do not wedge the writer", async (t) => {
  const h = harness(t);
  assert.equal(await h.logger.exportLogsToWorkspace(), undefined);
  await h.logger.openLogFolder();
  assert.equal(h.warnings.length, 1);
  h.logger.enableFileLogging(LOGS);
  h.hooks.copyFile = async () => { throw nodeError("EACCES"); };
  await assert.rejects(h.logger.exportLogsToWorkspace(), (error) => {
    assert.match(error.message, /export logs failed \(EACCES\).*permissions/);
    assert.doesNotMatch(error.message, /RAW_SECRET|credential|private/);
    return true;
  });
  h.logger.info("after failed export");
  await h.logger.flush();
  assert.match(h.text(), /after failed export/);
  await h.logger.openLogFolder();
  assert.equal(h.commands[0][0], "revealFileInOS");
  assert.equal(h.commands[0][1].fsPath, LOGS);
  h.commandError = nodeError("EPERM");
  await assert.rejects(h.logger.openLogFolder(), /open log folder failed \(EPERM\)/);
  h.vscode.workspace.workspaceFolders = [];
  assert.equal(await h.logger.exportLogsToWorkspace(), undefined);
  h.logger.show();
  assert.equal(h.shown, 1);
});

test("export propagates flush failure before enumeration or copying", async (t) => {
  const h = harness(t);
  h.hooks.appendFile = async () => { throw nodeError("ENOSPC"); };
  h.logger.enableFileLogging(LOGS);
  await assert.rejects(h.logger.exportLogsToWorkspace(), /append plugin.log failed \(ENOSPC\)/);
  assert.equal(h.count("readdir"), 0);
  assert.equal(h.count("copyFile"), 0);
});

test("changing file destinations does not reroute already accepted records", async (t) => {
  const h = harness(t);
  h.logger.enableFileLogging(LOGS);
  h.logger.error("first directory");
  const secondDirectory = path.join(LOGS, "second");
  h.logger.enableFileLogging(secondDirectory);
  h.logger.error("second directory");
  await h.logger.flush();
  assert.match(h.text(), /first directory/);
  assert.doesNotMatch(h.text(), /second directory/);
  assert.match(h.text(path.join(secondDirectory, "plugin.log")), /second directory/);
  assert.equal(h.count("mkdir"), 2);
});

test("dispose drains slow writes, is idempotent, rejects late traffic and can be awaited via flush", async (t) => {
  const h = harness(t);
  const blocked = h.block("appendFile");
  h.logger.enableFileLogging(LOGS);
  h.logger.runtime("error", "before dispose");
  h.logger.dispose();
  await blocked.entered;
  assert.equal(h.outputDisposed, 0);
  h.logger.dispose();
  h.logger.info("after dispose");
  h.logger.error("late error");
  h.logger.runtime("error", "late runtime error");
  h.logger.enableFileLogging(path.join(LOGS, "late"));
  h.logger.show();
  assert.equal(h.timers.size, 0);
  blocked.release();
  await h.logger.flush();
  assert.equal(h.outputDisposed, 1);
  assert.equal(h.shown, 0);
  assert.match(h.text(RUNTIME), /before dispose/);
  assert.doesNotMatch(h.outputText(), /after dispose|late/);
  assert.equal(bounded(h.logger).inflight, 0);
});

test("dispose during export waits for the copy and drains traffic already accepted", async (t) => {
  const h = harness(t);
  h.logger.enableFileLogging(LOGS);
  const blocked = h.block("copyFile");
  const exporting = h.logger.exportLogsToWorkspace();
  await blocked.entered;
  h.logger.error("accepted during export");
  h.logger.dispose();
  assert.equal(h.outputDisposed, 0);
  blocked.release();
  await exporting;
  await h.logger.flush();
  assert.match(h.text(), /accepted during export/);
  assert.equal(h.outputDisposed, 1);
});

test("dispose reports failed final writes through flush and still closes output exactly once", async (t) => {
  const h = harness(t);
  h.hooks.appendFile = async () => { throw nodeError("ENOSPC"); };
  h.logger.enableFileLogging(LOGS);
  h.logger.dispose();
  await assert.rejects(h.logger.flush(), /ENOSPC/);
  assert.equal(h.outputDisposed, 1);
  assert.equal(h.output.length, 2);
});
