const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { execFileSync } = require("node:child_process");
const { root, loadSource, logger } = require("./service-test-utils.cjs");
const { NativeXbslAstService, collectNativeAstSymbols } = loadSource("src/nativeXbslAstService.ts");

function fixture(t, overrides = {}, respond = automaticReply) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-ast-test-"));
  const extension = path.join(directory, "codex-element");
  const helperDir = path.join(extension, "resources/context/ast");
  fs.mkdirSync(helperDir, { recursive: true });
  fs.copyFileSync(path.join(root, "resources/context/ast/native-xbsl-ast.jar"), path.join(helperDir, "native-xbsl-ast.jar"));
  const repo = path.join(directory, "@1c-appengine-plugin/bin/appengine-lsp/repo");
  fs.mkdirSync(repo, { recursive: true });
  const jar = path.join(repo, "com.e1c.g5rt.lsp.server.appengine-9.1.9-1.jar");
  fs.writeFileSync(jar, "fixture-parser");
  const children = [];
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 137; child.emit("exit", 137); return true; };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const frame = chunk.toString();
        const [id, encoded] = frame.trimEnd().split("\t");
        const source = Buffer.from(encoded || "", "base64").toString("utf8");
        callback();
        queueMicrotask(() => respond(child, Number(id), source));
      },
    });
    children.push(child);
    return child;
  };
  const service = new NativeXbslAstService(extension, logger, { env: {}, nativeExtensionPaths: [], spawnProcess, ...overrides });
  t.after(() => { service.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, directory, extension, jar, repo, children, calls };
}

function reply(id, source) {
  return { id, status: "ready", partial: false, semanticBound: false, referencesExcluded: true, nodeCount: 1, diagnostics: [],
    root: { kind: "Module", startOffset: 0, endOffset: source.length, startLine: 1, endLine: Math.max(1, source.split("\n").length),
      attributes: { binded: false }, children: [] } };
}

function automaticReply(child, id, source) {
  if (!child.killed) child.stdout.write(JSON.stringify(reply(id, source)) + "\n");
}

async function until(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("condition timeout");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("helper source and Java 11 artifact hashes validate without javac", () => {
  const output = execFileSync(process.execPath, [path.join(root, "scripts/build-native-ast.js"), "--check"], {
    encoding: "utf8", env: { PATH: "", JAVA_HOME: "/missing-jdk" },
  });
  assert.match(output, /hashes match/);
  assert.match(execFileSync(process.execPath, [path.join(root, "scripts/build-native-ast.js")], {
    encoding: "utf8", env: { PATH: "", JAVA_HOME: "/missing-jdk" },
  }), /current/);
});

test("constructor is lazy; sibling parser discovery starts only syntax helper", async t => {
  const { service, calls } = fixture(t);
  assert.equal(calls.length, 0);
  const result = await service.parse("method Example()\n;\n");
  assert.equal(result.status, "ready");
  assert.equal(result.parserVersion, "9.1.9-1");
  assert.equal(result.semanticBound, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), "NativeXbslAst");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].args.includes("-Xmx256m"));
  assert.ok(!calls[0].args.some(arg => arg.includes("AppEngineServerMain")));
});

test("one process serves queued requests and an immutable bounded source/version cache", async t => {
  const { service, calls, jar } = fixture(t, { maxCacheEntries: 1 });
  const [a, b] = await Promise.all([service.parse("A"), service.parse("B")]);
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  assert.equal(calls.length, 1);
  const same = await service.parse("B");
  assert.equal(same.cacheHit, true);
  assert.ok(Object.isFrozen(same.root));
  assert.ok(Object.isFrozen(same.root.attributes));
  assert.equal(service.getMetrics().parseRequests, 2);
  await service.parse("A");
  assert.equal(service.getMetrics().parseRequests, 3);
  fs.appendFileSync(jar, "-updated-version");
  const changed = await service.parse("A");
  assert.equal(changed.cacheHit, false);
  assert.notEqual(changed.parserFingerprint, a.parserFingerprint);
  assert.equal(calls.length, 2);
});

test("UTF-8 response split inside Cyrillic characters is reassembled correctly", async t => {
  const { service } = fixture(t, {}, (child, id, source) => {
    const result = reply(id, source);
    result.root.attributes.name = "Проверка";
    const bytes = Buffer.from(JSON.stringify(result) + "\n");
    for (let i = 0; i < bytes.length; i++) child.stdout.write(bytes.subarray(i, i + 1));
  });
  assert.equal((await service.parse("Привет")).root.attributes.name, "Проверка");
});

test("missing parser and missing helper are explicit optional-source failures", async t => {
  const { service, jar, extension, calls } = fixture(t);
  fs.unlinkSync(jar);
  assert.equal((await service.parse("test")).code, "parser_not_found");
  fs.rmSync(path.join(extension, "resources/context/ast/native-xbsl-ast.jar"));
  assert.equal((await service.parse("test")).code, "helper_not_found");
  assert.equal(calls.length, 0);
});

test("ambiguous native JAR directory is not guessed", async t => {
  const { service, repo, calls } = fixture(t);
  fs.writeFileSync(path.join(repo, "com.e1c.g5rt.lsp.server.appengine-9.2.4-6.jar"), "other");
  assert.equal((await service.parse("test")).status, "unavailable");
  assert.equal(calls.length, 0);
});

test("configured LSP path is authoritative; no silent fallback to another installation", async t => {
  const { service, calls } = fixture(t, { env: { LSP_SERVER_PATH: "/does-not-exist-lsp" } });
  assert.equal((await service.parse("test")).code, "parser_not_found");
  assert.equal(calls.length, 0);
});

test("native extension locations and configured LSP_SERVER_PATH are supported", async t => {
  const one = fixture(t);
  const remote = path.join(one.directory, "different-installation");
  fs.renameSync(path.dirname(path.dirname(path.dirname(one.repo))), remote);
  const service = new NativeXbslAstService(one.extension, logger, {
    env: { LSP_SERVER_PATH: path.join(remote, "bin/appengine-lsp") }, javaPath: process.execPath,
    spawnProcess: (_command, _args, _options) => {
      throw new Error("Marker: discovery reached spawn");
    },
  });
  t.after(() => service.dispose());
  assert.equal((await service.parse("test")).code, "process_failed");
  const byExtension = new NativeXbslAstService(one.extension, logger, {
    env: {}, nativeExtensionPaths: [remote], spawnProcess: () => { throw new Error("spawn"); },
  });
  t.after(() => byExtension.dispose());
  assert.equal((await byExtension.parse("test")).code, "process_failed");
});

test("E1C_IDE_JAVA_HOME accepts a file and a home, taking precedence over JAVA_HOME", async t => {
  const direct = fixture(t, { env: { E1C_IDE_JAVA_HOME: process.execPath, JAVA_HOME: "/missing" } });
  assert.equal((await direct.service.parse("one")).status, "ready");
  assert.equal(direct.calls[0].command, process.execPath);
  const home = fixture(t);
  const javaHome = path.join(home.directory, "jdk");
  fs.mkdirSync(path.join(javaHome, "bin"), { recursive: true });
  const java = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  fs.writeFileSync(java, "java-fixture");
  const third = fixture(t, { env: { E1C_IDE_JAVA_HOME: javaHome } });
  assert.equal((await third.service.parse("three")).status, "ready");
  assert.equal(third.calls[0].command, java);
  const missing = fixture(t, { env: { JAVA_HOME: "/missing-java-home" } });
  assert.equal((await missing.service.parse("four")).code, "java_not_found");
});

test("source/queue limits and pre-aborted requests do not spawn needless processes", async t => {
  const { service, calls } = fixture(t, { maxSourceBytes: 4, maxQueueSize: 1, timeoutMs: 60 }, () => {});
  assert.equal((await service.parse("Привет")).code, "source_limit");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await service.parse("A", { signal: controller.signal })).code, "cancelled");
  assert.equal(calls.length, 0);
  const pending = service.parse("wait");
  assert.equal((await service.parse("B")).code, "queue_limit");
  assert.equal((await pending).code, "timeout");
});

test("deadline kills a hung helper; next request can start a fresh worker", async t => {
  let answer = false;
  const { service, children } = fixture(t, { timeoutMs: 60 }, (child, id, source) => {
    if (answer) automaticReply(child, id, source);
  });
  assert.equal((await service.parse("first")).code, "timeout");
  assert.equal(children[0].killed, true);
  answer = true;
  const next = await service.parse("second");
  assert.equal(next.status, "ready");
  assert.equal(children.length, 2);
});

test("cancelling a queued request does not terminate active parse", async t => {
  let frame;
  const { service, children } = fixture(t, {}, (child, id, source) => { frame = { child, id, source }; });
  const first = service.parse("first");
  await until(() => frame);
  const controller = new AbortController();
  const next = service.parse("second", { signal: controller.signal });
  controller.abort();
  assert.equal((await next).code, "cancelled");
  assert.equal(children[0].killed, false);
  automaticReply(frame.child, frame.id, frame.source);
  assert.equal((await first).status, "ready");
});

test("active cancellation and disposal settle promises and stop only the helper", async t => {
  const { service, children } = fixture(t, {}, () => {});
  const controller = new AbortController();
  const pending = service.parse("first", { signal: controller.signal });
  await until(() => children.length);
  controller.abort();
  assert.equal((await pending).code, "cancelled");
  assert.equal(children[0].killed, true);
  const one = service.parse("one");
  const two = service.parse("two");
  service.dispose();
  assert.equal((await one).code, "disposed");
  assert.equal((await two).code, "disposed");
  assert.equal((await service.parse("later")).code, "disposed");
});

test("oversized, malformed and incompatible protocol responses fail explicitly", async t => {
  for (const [output, expected] of [
    ["x".repeat(200), "ast_limit"], ["not-json\n", "protocol_error"],
    [JSON.stringify({ id: 0, status: "unavailable" }) + "\n", "parser_api_unavailable"],
    [JSON.stringify({ id: 987, status: "ready" }) + "\n", "protocol_error"],
  ]) {
    const { service, children } = fixture(t, { maxResponseBytes: 128 }, child => child.stdout.write(output));
    assert.equal((await service.parse("test")).code, expected);
    assert.equal(children[0].killed, true);
  }
});

test("invalid tree shape/offsets are rejected, not exposed as a successful AST", async t => {
  const { service } = fixture(t, {}, (child, id, source) => {
    const result = reply(id, source);
    result.root.endOffset = source.length + 100;
    child.stdout.write(JSON.stringify(result) + "\n");
  });
  assert.equal((await service.parse("test")).code, "protocol_error");
  assert.equal(service.getMetrics().cacheEntries, 0);
});

test("idle worker is disposed while the cache remains reusable", async t => {
  const { service, children } = fixture(t, { idleTimeoutMs: 10 });
  await service.parse("test");
  await until(() => children[0].killed);
  assert.equal((await service.parse("test")).cacheHit, true);
  assert.equal(children.length, 1);
});

test("collector follows only dynamic prefix/name, not a receiver or argument name", () => {
  const node = (kind, role, name, children = []) => ({ kind, role, attributes: { name }, children,
    startOffset: 0, endOffset: 20, startLine: 1, endLine: 1 });
  const dynamic = node("DynamicMethodInvocation", "statements", null, [
    node("DynamicVariableAccess", "prefix", null, [
      node("StaticVariableAccess", "source", "Receiver"), node("FeatureName", "name", "ActualMethod"),
    ]),
    node("ParamsContainer", "params", null, [node("NamedParam", "params", "ArgumentName")]),
  ]);
  const symbols = collectNativeAstSymbols({ status: "ready", root: dynamic });
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, "ActualMethod");
  dynamic.children[0].children.pop();
  assert.equal(collectNativeAstSymbols({ status: "ready", root: dynamic }).length, 0);
});

const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;

test("real native parser: RU/EN full containment AST, exact ranges and roles, reusable worker", { skip: !realJar }, async t => {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const source = '// метод Ложный()\r\nимпорт Стд::Время\r\n\r\nструктура Пользователь\r\n    знч Имя: Строка\r\n;\r\n\r\nметод Пример(Значение: Число): Строка\r\n    если Значение >= 90\r\n        возврат "Отлично😀"\r\n    ;\r\n    возврат Другое(Значение)\r\n;\r\n';
  const result = await service.parse(source);
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, false);
  assert.equal(result.semanticBound, false);
  assert.equal(result.referencesExcluded, true);
  const nodes = flatten(result.root);
  assert.equal(nodes.length, result.nodeCount);
  for (const kind of ["Method", "IfStatement", "ReturnStatement", "BinaryExpression", "RichString", "Parameter", "TypeName", "StaticMethodInvocation", "BslStructure"]) {
    assert.ok(nodes.some(node => node.kind === kind), `missing full AST node ${kind}`);
  }
  const method = nodes.find(node => node.kind === "Method");
  assert.equal(source.slice(method.startOffset, method.endOffset), source.slice(source.indexOf("метод Пример"), source.lastIndexOf(";") + 1));
  assert.equal(method.startLine, 8);
  assert.equal(method.endLine, 13);
  assert.equal(method.role, "methods");
  assert.ok(method.children.some(node => node.role === "returnTypes"));
  assert.ok(method.children.some(node => node.role === "parameters"));
  const symbols = collectNativeAstSymbols(result);
  assert.ok(symbols.some(symbol => symbol.kind === "method" && symbol.name === "Пример"));
  assert.ok(!symbols.some(symbol => symbol.name === "Ложный"));
  assert.ok(symbols.some(symbol => symbol.kind === "import" && symbol.name === "Стд::Время"));
  assert.ok(symbols.some(symbol => symbol.kind === "type" && symbol.name === "Пользователь"));
  assert.ok(symbols.some(symbol => symbol.kind === "call" && symbol.name === "Другое"));
  assert.equal((await service.parse(source)).cacheHit, true);
  const english = await service.parse("method Save(): Number\n    return 1\n;\n");
  assert.equal(english.status, "ready");
  assert.equal(english.partial, false);
  assert.ok(collectNativeAstSymbols(english).some(symbol => symbol.name === "Save"));
  assert.equal(service.getMetrics().processStarts, 1);
  const largeNumber = await service.parse("method Large(): Number\n    return 9007199254740993\n;\n");
  assert.equal(largeNumber.status, "ready");
  const literal = flatten(largeNumber.root).find(node => node.kind === "LiteralWithNumberParts");
  assert.equal(literal.attributes.value, "9007199254740993");
});

test("real native parser: incomplete source retains partial AST and diagnostics", { skip: !realJar }, async t => {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const result = await service.parse("метод Незавершенный(\n");
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, true);
  assert.ok(result.diagnostics.length);
  assert.ok(result.diagnostics[0].message);
  assert.equal(result.diagnostics[0].line, 1);
  assert.ok(collectNativeAstSymbols(result).some(symbol => symbol.name === "Незавершенный"));
});

test("real native parser: unknown names are syntax, never claimed as bound semantics", { skip: !realJar }, async t => {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const result = await service.parse("метод Тест(): НеизвестныйТип\n    возврат НеизвестныйМетод()\n;\n");
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, false);
  assert.equal(result.semanticBound, false);
  assert.equal(result.root.attributes.binded, false);
  assert.equal(flatten(result.root).find(node => node.kind === "StaticMethodInvocation").attributes.method, null);
});

test("real native parser: collects direct, chained and null-safe dynamic calls", { skip: !realJar }, async t => {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const source = 'метод Пример()\n    Статический()\n    Результат.Добавить(1ч)\n    Список.Получить().Проверить(1д)\n    Возможно?.Выполнить()\n;\n';
  const result = await service.parse(source);
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, false);
  const calls = collectNativeAstSymbols(result).filter(symbol => symbol.kind === "call");
  assert.equal(calls.length, flatten(result.root).filter(node => /MethodInvocation$/.test(node.kind)).length);
  assert.deepEqual(Array.from(calls, call => call.name).sort(), ["Статический", "Добавить", "Получить", "Проверить", "Выполнить"].sort());
  assert.equal(calls.filter(call => call.nodeKind === "DynamicMethodInvocation").length, 4);
  for (const call of calls) {
    const slice = source.slice(call.startOffset, call.endOffset);
    assert.ok(slice.includes(call.name));
    assert.ok(slice.endsWith(")"));
  }
});

test("real native parser: duration values keep native representation, type and original lexeme", { skip: !realJar }, async t => {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const source = "метод Длительности()\n    знч Час = 1ч\n    знч День = 1д\n;\n";
  const result = await service.parse(source);
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, false);
  const literals = flatten(result.root).filter(node => node.kind === "LiteralWithNumberParts");
  assert.equal(literals.length, 2);
  const expected = { "1ч": "PT1H", "1д": "PT24H" };
  for (const literal of literals) {
    const lexeme = source.slice(literal.startOffset, literal.endOffset);
    assert.equal(literal.attributes.value, expected[lexeme]);
    assert.equal(literal.attributeValueTypes.value, "java.time.Duration");
    assert.equal(literal.attributeSources.value, lexeme);
    assert.ok(!literal.omittedAttributes.includes("value"));
    assert.equal(literal.attributes.typeInfo, null);
  }
  assert.equal(result.semanticBound, false);
});

function flatten(root) {
  const nodes = [];
  const stack = root ? [root] : [];
  while (stack.length) { const node = stack.pop(); nodes.push(node); stack.push(...node.children); }
  return nodes;
}
