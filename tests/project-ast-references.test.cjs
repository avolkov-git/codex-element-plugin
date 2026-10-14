const assert = require("node:assert/strict");
const test = require("node:test");
const { root, loadSource, logger } = require("./service-test-utils.cjs");
const { collectAstReferences } = loadSource("src/projectAstReferences.ts");
const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");

function node(kind, startOffset, endOffset, attributes = {}, children = [], role) {
  return { kind, startOffset, endOffset, startLine: 1, endLine: 1, attributes, children, role };
}

function call(text, name, start = text.indexOf(name)) {
  const prefix = node("StaticVariableAccess", start, start + name.length, { name }, [], "prefix");
  return node("StaticMethodInvocation", start, start + name.length + 2, {}, [prefix], "statements");
}

function flatten(root) {
  return [root, ...root.children.flatMap(flatten)];
}

function summary(references) {
  return Array.from(references, reference => ({ kind: reference.kind, name: reference.name,
    position: { ...reference.position }, endCharacter: reference.endCharacter }));
}

function expected(text, kind, name, offset) {
  assert.ok(offset >= 0, `missing expected ${name}`);
  const prefix = text.slice(0, offset).split(/\r\n|\r|\n/);
  const character = prefix.at(-1).length;
  return { kind, name, position: { line: prefix.length - 1, character }, endCharacter: character + name.length };
}

function checkReferences(root, text, references) {
  const nodes = new Set(flatten(root));
  const lines = text.split(/\r\n|\r|\n/);
  const seen = new Set();
  for (const reference of references) {
    assert.ok(nodes.has(reference.node));
    assert.ok(nodes.has(reference.nameNode));
    assert.equal(reference.nameNode.attributes.name, reference.name);
    assert.equal(lines[reference.position.line].slice(reference.position.character, reference.endCharacter), reference.name);
    const key = `${reference.position.line}:${reference.position.character}`;
    assert.ok(!seen.has(key), `duplicate occurrence ${key}`);
    seen.add(key);
    assert.deepEqual(Object.keys(reference).sort(), ["endCharacter", "kind", "name", "nameNode", "node", "position"]);
  }
}

test("source order, repeated occurrences, wrappers and no twelve-candidate limit", () => {
  const text = Array.from({ length: 24 }, () => "Pulse()").join(" ");
  const calls = Array.from(text.matchAll(/Pulse/g), match => call(text, "Pulse", match.index));
  const duplicate = { ...calls[0], children: [calls[0].children[0], calls[0]] };
  const tree = node("Module", 0, text.length, {}, [...calls.slice(1).reverse(), duplicate]);
  const before = JSON.stringify(tree);
  const refs = collectAstReferences(tree, text);
  assert.equal(refs.length, 24);
  assert.deepEqual(summary(refs), calls.map(item => expected(text, "call", "Pulse", item.startOffset)));
  assert.equal(JSON.stringify(tree), before);
  checkReferences(tree, text, refs);
});

test("scope pruning stops child declarations and lambdas, never the root or local variables", () => {
  const text = "Visible() Hidden()";
  for (const kind of ["Method", "AbstractMethod", "BslType", "BslObject", "BslEnum", "BslStructure", "BslException",
    "ObjectConstructor", "MethodDeclaration", "ClassDeclaration", "Lambda"]) {
    const visible = node("DeclareVariableStatement", 0, 9, { name: "Local" }, [call(text, "Visible")]);
    const nested = node(kind, 10, text.length, {}, [call(text, "Hidden")]);
    const tree = node(kind, 0, text.length, {}, [visible, nested]);
    assert.deepEqual(Array.from(collectAstReferences(tree, text), ref => ref.name), ["Visible", "Hidden"], kind);
    assert.deepEqual(Array.from(collectAstReferences(tree, text, { skipNestedScopes: true }), ref => ref.name), ["Visible"], kind);
    assert.deepEqual(Array.from(collectAstReferences(nested, text, { skipNestedScopes: true }), ref => ref.name), ["Hidden"], kind);
  }
});

test("missing, malformed and recovery name nodes never fall back to a receiver or argument", () => {
  const text = "Receiver.Target(Argument)";
  const receiver = node("StaticVariableAccess", 0, 8, { name: "Receiver" }, [], "source");
  const argument = node("NamedParam", 16, 24, { name: "Argument" }, [], "params");
  const missing = node("DynamicMethodInvocation", 0, text.length, {}, [
    node("DynamicVariableAccess", 0, 15, {}, [receiver], "prefix"), argument,
  ]);
  const first = { ...receiver, role: "first" };
  const badSegment = node("FeatureName", -1, -1, { name: "Target" }, [], "segments");
  const reference = node("MethodRef", 0, 15, {}, [first, badSegment]);
  const malformed = [
    node("TypeName", -1, -1, { name: "Target" }),
    node("TypeName", 9, text.length + 1, { name: "Target" }),
    node("TypeName", 9.5, 15, { name: "Target" }),
    node("TypeName", 9, 15, { name: "Other" }),
    node("TypeName", 9, 15, { name: "arget" }),
    node("TypeName", 9, 15, { name: null }),
  ];
  const tree = node("Module", 0, text.length, {}, [missing, reference, ...malformed]);
  assert.equal(collectAstReferences(tree, text).length, 0);
});

test("exact terminal names distinguish namespaces from equally named identifiers", () => {
  const text = "Box::Box<Box>\r\nCall:: /* Call */ Call()\rLast()";
  const outer = node("TypeName", 0, 8, { name: "Box", namespace: ["Box"] }, [], "type");
  const inner = node("TypeName", 9, 12, { name: "Box" }, [], "typeNames");
  const generic = node("GenTypeName", 0, 13, { name: "Box" }, [outer, inner]);
  const invocation = call(text, "Call", text.indexOf("Call"));
  invocation.children[0].endOffset = text.indexOf("Call()");
  invocation.children[0].endOffset += "Call".length;
  const tree = node("Module", 0, text.length, {}, [call(text, "Last"), generic, invocation]);
  const refs = collectAstReferences(tree, text);
  assert.deepEqual(summary(refs), [expected(text, "type", "Box", 5), expected(text, "type", "Box", 9),
    expected(text, "call", "Call", text.indexOf("Call()")), expected(text, "call", "Last", text.indexOf("Last"))]);
  checkReferences(tree, text, refs);
});

const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;

async function parse(t, source) {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => service.dispose());
  const result = await service.parse(source);
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.partial, false, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.semanticBound, false);
  assert.ok(result.root);
  return result.root;
}

test("real native AST: static, dynamic, chained, null-safe and generic calls keep exact name nodes", { skip: !realJar }, async t => {
  const text = ["method Test()", "    Direct()", "    Receiver.Call()", "    Receiver?.Safe()",
    "    Receiver.First().Second()", "    Namespace::Generic<Generic>(Named = Inner())", "    this.Local()",
    "    global.GlobalCall()", "    Call:: /* Call */ Call /* Call */ ()", ";", ""].join("\n");
  const tree = await parse(t, text);
  const refs = collectAstReferences(tree, text);
  const items = [
    ["call", "Direct", "Direct()"], ["call", "Call", "Call()"], ["call", "Safe", "Safe()"],
    ["call", "First", "First()"], ["call", "Second", "Second()"], ["call", "Generic", "Generic<"],
    ["type", "Generic", "Generic>"], ["call", "Inner", "Inner()"], ["call", "Local", "Local()"],
    ["call", "GlobalCall", "GlobalCall()"], ["call", "Call", "Call /*"],
  ];
  assert.deepEqual(summary(refs), items.map(([kind, name, needle]) => expected(text, kind, name, text.indexOf(needle))));
  assert.equal(refs.find(ref => ref.name === "Direct").nameNode.kind, "StaticVariableAccess");
  assert.equal(refs.find(ref => ref.name === "Second").nameNode.kind, "FeatureName");
  assert.equal(refs.find(ref => ref.name === "Safe").node.children.find(child => child.role === "prefix").attributes.safe, true);
  checkReferences(tree, text, refs);
});

test("real native AST: MethodRef first/segments, context flags, generics and signature types", { skip: !realJar }, async t => {
  const expressions = ["&ReceivePulse", "&Receiver.ReceivePulse", "&Receiver.Nested.ReceivePulse", "&Namespace::ReceivePulse",
    "&Receiver.ReceivePulse<ReceivePulse>(ReceivePulse)", "&Box<ReceivePulse>.ReceivePulse",
    "&this.ReceivePulse", "&global.ReceivePulse"];
  const text = ["method Test()", ...expressions.map((expr, index) => `    val R${index} = ${expr}`), ";", ""].join("\n");
  const tree = await parse(t, text);
  const refs = collectAstReferences(tree, text);
  const wanted = [];
  for (let index = 0; index < expressions.length; index += 1) {
    const expression = expressions[index];
    const start = text.indexOf(expression);
    const offsets = Array.from(expression.matchAll(/ReceivePulse/g), match => start + match.index);
    for (let occurrence = 0; occurrence < offsets.length; occurrence += 1) {
      const isType = index === 4 ? occurrence > 0 : index === 5 && occurrence === 0;
      wanted.push(expected(text, isType ? "type" : "method-reference", "ReceivePulse", offsets[occurrence]));
    }
  }
  assert.deepEqual(summary(refs), wanted);
  const methods = refs.filter(ref => ref.kind === "method-reference");
  assert.equal(methods.length, expressions.length);
  assert.equal(methods[0].nameNode.role, "first");
  assert.equal(methods[1].nameNode.role, "segments");
  assert.deepEqual(Array.from(methods[2].node.children, child => [child.role, child.attributes.name]),
    [["first", "Receiver"], ["segments", "Nested"], ["segments", "ReceivePulse"]]);
  assert.equal(methods[4].node.attributes.explicitGenParams, true);
  assert.equal(methods[4].node.attributes.explicitMethodParams, true);
  assert.equal(methods[5].node.attributes.dotAfterGen, true);
  assert.equal(methods[6].node.attributes.explicitObjectCtx, true);
  assert.equal(methods[7].node.attributes.explicitGlobalCtx, true);
  checkReferences(tree, text, refs);
});

test("real native AST: nested generic TypeName leaves and constructor references are not method names", { skip: !realJar }, async t => {
  const text = ["method Test(P: Box::Box<Box<Box>>): Box<Box>",
    "    val X: Box<Box> = new Box<Box>()", "    val Constructor = &Box<Box>.new(Box)", ";", ""].join("\n");
  const tree = await parse(t, text);
  const refs = collectAstReferences(tree, text);
  const offsets = Array.from(text.matchAll(/Box/g), match => match.index).slice(1);
  assert.deepEqual(summary(refs), offsets.map(offset => expected(text, "type", "Box", offset)));
  assert.ok(refs.some(ref => ref.node.kind === "MethodRef" && ref.node.attributes.ctor === true));
  assert.equal(refs.filter(ref => ref.node.kind === "MethodRef").length, 1);
  checkReferences(tree, text, refs);
});

test("real native AST: S4 callback, declaration/lambda scope pruning and root exemption", { skip: !realJar }, async t => {
  const text = ["method WireTelemetry()", "    val Listener = &ReceivePulse", "    val Callback = method() ->",
    "        FlushQueue()", "    ;", "    Install(Listener, Callback)", ";", "",
    "method ReceivePulse()", "    return", ";", ""].join("\n");
  const tree = await parse(t, text);
  const method = tree.children.find(child => child.kind === "Method");
  const refs = collectAstReferences(method, text, { skipNestedScopes: true });
  assert.deepEqual(summary(refs), [expected(text, "method-reference", "ReceivePulse", text.indexOf("ReceivePulse")),
    expected(text, "call", "Install", text.indexOf("Install"))]);
  assert.deepEqual({ ...refs[0].position }, { line: 1, character: 20 });
  assert.deepEqual(Array.from(collectAstReferences(method, text), ref => ref.name), ["ReceivePulse", "FlushQueue", "Install"]);
  assert.equal(collectAstReferences(tree, text, { skipNestedScopes: true }).length, 0);
  const lambda = flatten(tree).find(child => child.kind === "Lambda");
  assert.deepEqual(Array.from(collectAstReferences(lambda, text, { skipNestedScopes: true }), ref => ref.name), ["FlushQueue"]);
  checkReferences(tree, text, refs);
});

test("real native AST: CRLF, non-BMP and Cyrillic same-line references retain UTF-16 positions", { skip: !realJar }, async t => {
  const name = "\u041f\u0440\u0438\u043d\u044f\u0442\u044c";
  const receiver = "\u041e\u0431\u044a\u0435\u043a\u0442";
  const text = ["method Test()", `    Outer("\u{1f600}", &${name}, ${receiver}.${name}(), &${receiver}.${name})`, ";", ""].join("\r\n");
  const tree = await parse(t, text);
  const refs = collectAstReferences(tree, text);
  const offsets = Array.from(text.matchAll(new RegExp(name, "g")), match => match.index);
  assert.deepEqual(summary(refs), [expected(text, "call", "Outer", text.indexOf("Outer")),
    ...offsets.map((offset, index) => expected(text, index === 1 ? "call" : "method-reference", name, offset))]);
  assert.equal(refs[1].position.character, 17);
  assert.equal(new Set(refs.map(ref => ref.position.character)).size, 4);
  checkReferences(tree, text, refs);
});

test("real native AST: parameter shadows and receiver syntax are extracted without false binding", { skip: !realJar }, async t => {
  const text = ["method Wire(Module: Object, ReceivePulse: Object)",
    "    Module.ReceivePulse()", "    val A = &Module.ReceivePulse", "    val B = &ReceivePulse",
    "    val C = &Module.Nested.ReceivePulse", "    ReceivePulse()", ";", ""].join("\n");
  const tree = await parse(t, text);
  const refs = collectAstReferences(tree, text);
  const names = Array.from(refs, ref => [ref.kind, ref.name]);
  assert.deepEqual(names, [["type", "Object"], ["type", "Object"], ["call", "ReceivePulse"],
    ["method-reference", "ReceivePulse"], ["method-reference", "ReceivePulse"],
    ["method-reference", "ReceivePulse"], ["call", "ReceivePulse"]]);
  assert.equal(refs[2].node.kind, "DynamicMethodInvocation");
  assert.equal(refs.at(-1).node.kind, "StaticMethodInvocation");
  assert.equal(refs[3].node.children.find(child => child.role === "first").attributes.name, "Module");
  assert.equal(refs[4].nameNode.role, "first");
  assert.ok(refs.every(ref => !Object.hasOwn(ref, "targets") && !Object.hasOwn(ref, "confidence")));
  checkReferences(tree, text, refs);
});
