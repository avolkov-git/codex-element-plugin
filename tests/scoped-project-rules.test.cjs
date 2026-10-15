const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");

const basePath = ".local-codex/rules.md";
const scopedPath = name => `.local-codex/rules/${name}.md`;
const rule = (selectors, body = "SCOPED") => `---\n${selectors}\n---\n${body}`;
const uri = fsPath => ({ scheme: "file", fsPath });

function fixture(t, files = {}) {
  // Match native canonical paths so read hooks also fire under Windows 8.3 TEMP.
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-rules-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace");
  const other = path.join(temporary, "workspace-other");
  fs.mkdirSync(root);
  fs.mkdirSync(other);
  const put = (relative, text, at = root) => {
    const file = path.join(at, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  put("Form.xbsl", "метод Test()\n;\n");
  for (const [relative, text] of Object.entries(files)) put(relative, text);
  const documents = [];
  const listeners = new Set();
  const workspace = {
    workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
    onDidChangeWorkspaceFolders(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
  };
  const hooks = {};
  const reads = [];
  let bytesRead = 0;
  let operations = 0;
  const promises = new Proxy(fs.promises, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      return async (...args) => {
        operations++;
        await hooks.before?.(key, ...args);
        const output = await value.apply(target, args);
        if (key !== "open") return output;
        const filePath = args[0];
        return new Proxy(output, {
          get(handle, name) {
            if (name !== "read") return typeof handle[name] === "function" ? handle[name].bind(handle) : handle[name];
            return async (...readArgs) => {
              const result = await handle.read(...readArgs);
              reads.push(filePath);
              bytesRead += result.bytesRead;
              await hooks.afterRead?.(filePath, result);
              return result;
            };
          },
        });
      };
    },
  });
  const logs = [];
  const logger = { info: message => logs.push(message), warn: message => logs.push(message) };
  const mocks = { fs: { ...fs, promises }, vscode: { workspace } };
  const scoped = loadSource("src/scopedProjectRules.ts", mocks);
  const read = scoped.RulesWorkspace.prototype.read;
  scoped.RulesWorkspace.prototype.read = async function (...args) {
    const text = await read.apply(this, args);
    await hooks.afterRuleRead?.(args[0]);
    return text;
  };
  const { RulesContextService } = loadSource("src/rulesContextService.ts", { ...mocks, "./scopedProjectRules": scoped });
  const service = new RulesContextService(logger);
  const target = (relative = "Form.xbsl", elementKind = "Форма") => ({ path: relative, elementKind });
  const build = (targets = [target()]) => service.buildContext("project", true, targets);
  const dirty = (relative, text, at = root) => {
    const document = { uri: uri(path.join(at, relative)), isDirty: true, isClosed: false, version: 1, text,
      getText() { const text = this.text; hooks.afterDirtyRead?.(this.uri.fsPath); return text; } };
    documents.push(document);
    return document;
  };
  const switchRoot = next => {
    workspace.workspaceFolders = next ? [{ uri: uri(next) }] : [];
    for (const listener of listeners) listener();
  };
  return { root, other, put, documents, workspace, hooks, reads, service, build, target, dirty, switchRoot, listeners,
    get bytesRead() { return bytesRead; }, get operations() { return operations; } };
}

function warnings(result) { return (result.warnings ?? []).join("\n"); }

test("disabled and general chats perform no filesystem reads", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  for (const [kind, enabled] of [["project", false], ["general", true], ["general", false]]) {
    const result = await f.service.buildContext(kind, enabled, [f.target()]);
    assert.equal(result.status.status, "disabled");
    assert.equal(result.text, undefined);
    assert.equal(result.scopedText, undefined);
    assert.equal(result.matchCount, 0);
  }
  assert.equal(f.operations, 0);
  assert.equal(f.listeners.size, 0);
});

test("legacy text and count are unchanged by selection; optional rules are separate", async t => {
  const f = fixture(t, { [basePath]: "BASE обязательные правила", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  const without = await f.service.buildContext("project", true);
  const withRules = await f.build();
  assert.equal(without.text, withRules.text);
  assert.equal(withRules.matchCount, 1);
  assert.match(withRules.text, /BASE обязательные правила/);
  assert.doesNotMatch(withRules.text, /SCOPED/);
  assert.match(withRules.scopedText, /SCOPED/);
  assert.doesNotMatch(withRules.scopedText, /BASE/);
  assert.equal(withRules.scopedMatchCount, 1);
  assert.equal(withRules.scopedPaths.join(), scopedPath("a"));
  assert.equal(withRules.status.status, "active");
  assert.equal(withRules.warnings, undefined);
});

test("AND across selector classes on the same target, OR inside each class", async t => {
  const f = fixture(t, {
    [basePath]: "BASE", "Other.yaml": "ВидЭлемента: Форма",
    [scopedPath("both")]: rule('paths: ["Missing.xbsl", "**/*.xbsl"]\nelementKinds: ["Справочник", "Форма"]', "BOTH"),
    [scopedPath("kind")]: rule('elementKinds: ["Форма"]', "KIND"),
    [scopedPath("path")]: rule('paths: ["**/*.yaml"]', "PATH"),
  });
  const crossTargets = await f.build([f.target("Form.xbsl", "ОбщийМодуль"), f.target("Other.yaml")]);
  assert.doesNotMatch(crossTargets.scopedText, /BOTH/);
  assert.match(crossTargets.scopedText, /KIND/);
  assert.match(crossTargets.scopedText, /PATH/);
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 2);
  assert.match(result.scopedText, /BOTH/);
  assert.match(result.scopedText, /KIND/);
  const noKind = await f.build([{ path: "Form.xbsl" }]);
  assert.equal(noKind.scopedMatchCount, 0);
  assert.equal(noKind.matchCount, 1);
});

test("no confirmed targets never activate arbitrary scoped or kind-only rules", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("kind")]: rule('elementKinds: ["Форма"]') });
  for (const targets of [[], [f.target("missing.xbsl")], [{ elementKind: "Форма" }], [f.target("")], [f.target(".")]]) {
    const result = await f.build(targets);
    assert.equal(result.scopedMatchCount, 0);
    assert.equal(result.scopedText, undefined);
    assert.match(result.text, /BASE/);
  }
  assert.ok(f.reads.every(file => file.endsWith("rules.md")));
});

test("missing, empty or oversized legacy file does not block scoped rules", async t => {
  const f = fixture(t, { [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  for (const value of [undefined, "", "x".repeat(64 * 1024 + 1)]) {
    if (value !== undefined) f.put(basePath, value);
    const result = await f.build();
    assert.equal(result.matchCount, 0);
    assert.equal(result.text, undefined);
    assert.equal(result.scopedMatchCount, 1);
    assert.equal(result.status.status, "active");
    if (value) assert.match(warnings(result), /слишком большой/);
  }
});

test("disk edits and deletions are reflected on every call, including stale clean documents", async t => {
  const f = fixture(t, { [basePath]: "BASE1", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "SCOPED1") });
  await f.build();
  const clean = f.dirty(basePath, "OLD BUFFER");
  clean.isDirty = false;
  f.put(basePath, "BASE2");
  f.put(scopedPath("a"), rule('paths: ["**/*.xbsl"]', "SCOPED2"));
  const second = await f.build();
  assert.match(second.text, /BASE2/);
  assert.doesNotMatch(second.text, /OLD BUFFER/);
  assert.match(second.scopedText, /SCOPED2/);
  f.put(scopedPath("a"), rule('paths: ["**/*.yaml"]', "SCOPED3"));
  assert.equal((await f.build()).scopedMatchCount, 0);
  fs.unlinkSync(path.join(f.root, scopedPath("a")));
  fs.unlinkSync(path.join(f.root, basePath));
  const last = await f.build();
  assert.equal(last.text, undefined);
  assert.equal(last.scopedText, undefined);
  assert.equal(last.status.status, "missing");
});

test("dirty buffers and new file-backed buffers are scoped to the current workspace", async t => {
  const f = fixture(t, { [basePath]: "DISK", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "DISK_SCOPED") });
  const base = f.dirty(basePath, "DIRTY_BASE");
  const scoped = f.dirty(scopedPath("a"), rule('paths: ["**/*.xbsl"]', "DIRTY_SCOPED"));
  f.dirty(scopedPath("new"), rule('paths: ["**/*.xbsl"]', "NEW_BUFFER"));
  const result = await f.build();
  assert.match(result.text, /DIRTY_BASE/);
  assert.match(result.scopedText, /DIRTY_SCOPED/);
  assert.match(result.scopedText, /NEW_BUFFER/);
  scoped.text = rule('paths: ["**/*.yaml"]', "NO_MATCH");
  scoped.version++;
  assert.doesNotMatch((await f.build()).scopedText, /DIRTY_SCOPED|NO_MATCH/);
  base.isClosed = true;
  assert.match((await f.build()).text, /DISK/);
  f.put("Form.xbsl", "", f.other);
  f.put(basePath, "OTHER_BASE", f.other);
  f.put(scopedPath("a"), rule('paths: ["**/*.xbsl"]', "OTHER_SCOPED"), f.other);
  f.switchRoot(f.other);
  const other = await f.build();
  assert.match(other.text, /OTHER_BASE/);
  assert.match(other.scopedText, /OTHER_SCOPED/);
  assert.doesNotMatch(other.scopedText, /DIRTY|NEW_BUFFER/);
  assert.equal(f.listeners.size, 0);
});

test("dirty target must be file-backed inside current root; untitled buffers are ignored", async t => {
  const f = fixture(t, { [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  f.dirty("New.xbsl", "new source");
  assert.equal((await f.build([f.target("New.xbsl")])).scopedMatchCount, 1);
  f.documents[0].uri.scheme = "untitled";
  assert.equal((await f.build([f.target("New.xbsl")])).scopedMatchCount, 0);
});

for (const roundTrip of [false, true]) {
  test(`workspace switch during reading discards the old result (round trip: ${roundTrip})`, async t => {
    const f = fixture(t, { [basePath]: "OLD_BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "OLD_SCOPED") });
    f.hooks.afterRead = () => { delete f.hooks.afterRead; f.switchRoot(f.other); if (roundTrip) f.switchRoot(f.root); };
    const result = await f.build();
    assert.equal(result.text, undefined);
    assert.equal(result.scopedText, undefined);
    assert.equal(result.status.status, "error");
    assert.match(warnings(result), /Workspace изменился/);
    assert.equal(f.listeners.size, 0);
  });
}

test("outside, sibling-prefix, traversal, URI and unsupported platform targets are rejected", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('elementKinds: ["Форма"]') });
  const outside = f.put("Form.xbsl", "SECRET", f.other);
  for (const targetPath of [outside, "../workspace-other/Form.xbsl", "x/../Form.xbsl", "file:///Form.xbsl", "C:\\secret\\Form.xbsl", "Form.xbsl\0"]) {
    const result = await f.build([f.target(targetPath)]);
    assert.equal(result.scopedMatchCount, 0, targetPath);
    assert.match(result.text, /BASE/);
    assert.match(warnings(result), /Цель пропущена/);
  }
  assert.equal((await f.build([f.target(path.join(f.root, "Form.xbsl"))])).scopedMatchCount, 1);
});

for (const location of ["legacy", "scoped-file", "scoped-directory", "config-directory", "target", "target-directory", "internal-link"]) {
  test(`symlink/outside protection: ${location}`, async t => {
    const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "SAFE") });
    const externalRule = f.put("outside.md", rule('paths: ["**/*.xbsl"]', "SECRET"), f.other);
    const externalTarget = f.put("Form.xbsl", "", f.other);
    let targets = [f.target()];
    if (location === "legacy") {
      fs.unlinkSync(path.join(f.root, basePath));
      fs.symlinkSync(externalRule, path.join(f.root, basePath));
      f.dirty(basePath, "SECRET_BUFFER");
    } else if (location === "scoped-file" || location === "internal-link") {
      fs.symlinkSync(location === "internal-link" ? path.join(f.root, basePath) : externalRule, path.join(f.root, scopedPath("link")));
      f.dirty(scopedPath("link"), rule('paths: ["**/*.xbsl"]', "SECRET_BUFFER"));
    } else if (location === "scoped-directory" || location === "config-directory") {
      const dir = location === "scoped-directory" ? ".local-codex/rules" : ".local-codex";
      fs.rmSync(path.join(f.root, dir), { recursive: true });
      fs.symlinkSync(f.other, path.join(f.root, dir));
    } else if (location === "target") {
      fs.symlinkSync(externalTarget, path.join(f.root, "Link.xbsl"));
      targets = [f.target("Link.xbsl")];
    } else {
      fs.symlinkSync(f.other, path.join(f.root, "linked"));
      targets = [f.target("linked/Form.xbsl")];
    }
    const result = await f.build(targets);
    assert.doesNotMatch(`${result.text} ${result.scopedText}`, /SECRET/);
    assert.match(warnings(result), /символическ/i);
    assert.ok(f.reads.every(file => !file.startsWith(f.other)), "must not read any outside content");
    if (["scoped-file", "internal-link", "scoped-directory", "target", "target-directory"].includes(location)) assert.match(result.text, /BASE/);
  });
}

test("workspace root may itself be a symlink; dirty canonical documents still match", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  const alias = path.join(f.other, "root-alias");
  fs.symlinkSync(f.root, alias);
  f.dirty(basePath, "DIRTY_CANONICAL");
  f.switchRoot(alias);
  const result = await f.build();
  assert.match(result.text, /DIRTY_CANONICAL/);
  assert.equal(result.scopedMatchCount, 1);
});

test("same-size rewrite, deletion and editor edits during a read are detected", async t => {
  for (const mode of ["rewrite", "delete", "editor"]) {
    const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "BEFORE") });
    const file = path.join(f.root, scopedPath("a"));
    const document = mode === "editor" ? f.dirty(scopedPath("a"), rule('paths: ["**/*.xbsl"]', "BEFORE")) : undefined;
    const hook = mode === "editor" ? "afterDirtyRead" : "afterRead";
    f.hooks[hook] = current => {
      if (current !== file) return;
      delete f.hooks[hook];
      if (mode === "rewrite") {
        const before = fs.statSync(file);
        f.put(scopedPath("a"), rule('paths: ["**/*.xbsl"]', "AFTER!"));
        fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
      } else if (mode === "delete") fs.unlinkSync(file);
      else { document.version++; document.text = rule('paths: ["**/*.xbsl"]', "AFTER!"); }
    };
    const result = await f.build();
    assert.equal(result.scopedText, undefined, mode);
    assert.match(result.text, /BASE/);
    assert.ok(result.warnings.length);
  }
});

test("a target replaced by an outside symlink during rule reading invalidates selection", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  const outside = f.put("Form.xbsl", "", f.other);
  f.hooks.afterRead = current => {
    if (!current.endsWith("a.md")) return;
    delete f.hooks.afterRead;
    fs.unlinkSync(path.join(f.root, "Form.xbsl"));
    fs.symlinkSync(outside, path.join(f.root, "Form.xbsl"));
  };
  const result = await f.build();
  assert.match(result.text, /BASE/);
  assert.equal(result.scopedText, undefined);
  assert.match(warnings(result), /Цели изменились/);
});

const invalidHeaders = [
  "{}", 'paths: []', 'paths: "**/*.xbsl"', 'unknown: ["**/*.xbsl"]', 'paths: ["**/*.xbsl"]\nunknown: true',
  'paths: ["**/*.xbsl"]\npaths: ["**/*.yaml"]', 'paths: [', 'paths: [null]', 'paths: [42]', 'elementKinds: [{}]',
  'paths: &p ["**/*.xbsl"]\nelementKinds: *p', 'paths: [!!str "**/*.xbsl"]', 'paths: ["**/*.xbsl"]\n<<: {}',
  `paths: [${Array.from({ length: 33 }, () => '"**/*.xbsl"').join(", ")}]`,
  'paths: ["' + "a".repeat(257) + '"]', 'elementKinds: [" Форма"]', 'elementKinds: ["Форма\\nBAD"]',
  'paths: ["**/*.xbsl"]\n#' + "x".repeat(8192),
];
test("invalid frontmatter cannot broaden selectors and never displaces legacy rules", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  const invalid = [...invalidHeaders.map(header => rule(header, "INVALID")), "no frontmatter", "---\npaths: []", rule('paths: ["**/*.xbsl"]', "")];
  invalid.forEach((text, i) => f.put(scopedPath(String(i).padStart(2, "0")), text));
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.equal(result.warnings.length, invalid.length);
  assert.match(warnings(result), /Некорректные дополнительные правила/);
});

test("restricted patterns have explicit directory and extension boundaries", async t => {
  const f = fixture(t);
  for (const file of ["UI/A.xbsl", "UI/Nested/A.xbsl", "UI2/A.xbsl", "A.xbsl.bak", "A.XBSL"]) f.put(file, "");
  const cases = [
    ["**/*.xbsl", ["Form.xbsl", "UI/A.xbsl", "UI/Nested/A.xbsl"], ["A.xbsl.bak", "A.XBSL"]],
    ["*.xbsl", ["Form.xbsl"], ["UI/A.xbsl"]],
    ["UI/*.xbsl", ["UI/A.xbsl"], ["UI/Nested/A.xbsl", "UI2/A.xbsl"]],
    ["UI/**/*.xbsl", ["UI/A.xbsl", "UI/Nested/A.xbsl"], ["UI2/A.xbsl", "Form.xbsl"]],
    ["UI/**", ["UI/A.xbsl", "UI/Nested/A.xbsl"], ["UI2/A.xbsl", "Form.xbsl"]],
    ["UI/A.xbsl", ["UI/A.xbsl"], ["UI/Nested/A.xbsl"]],
  ];
  for (const [pattern, matching, other] of cases) {
    f.put(scopedPath("a"), rule(`paths: [${JSON.stringify(pattern)}]`));
    for (const file of matching) assert.equal((await f.build([f.target(file)])).scopedMatchCount, 1, `${pattern}: ${file}`);
    for (const file of other) assert.equal((await f.build([f.target(file)])).scopedMatchCount, 0, `${pattern}: ${file}`);
  }
});

test("unsupported and adversarial glob syntax is rejected, not approximated", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  const patterns = ["**", "*", "***/*.xbsl", "UI**/*.xbsl", "**/**/A.xbsl", "UI/**/A.xbsl", "../**", "/**/*.xbsl", "UI//*.xbsl",
    "./UI/**", "!**/*.xbsl", "**/*.{xbsl,yaml}", "**/[ab].xbsl", "**/?.xbsl", "**/a*.xbsl", "**/*.x*", "**/*.xbsl/extra",
    "UI\\**\\*.xbsl", "C:/**/*.xbsl", "[".repeat(250)];
  patterns.forEach((pattern, i) => f.put(scopedPath(String(i)), rule(`paths: [${JSON.stringify(pattern)}]`)));
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.equal(result.warnings.length, patterns.length);
  assert.match(result.text, /BASE/);
});

test("YAML block lists, CRLF and BOM are accepted; scope is rendered without raw frontmatter", async t => {
  const f = fixture(t, { [scopedPath("a")]: "\uFEFF" + rule('paths:\n  - "**/*.xbsl"\nelementKinds:\n  - Форма', "BODY").replace(/\n/g, "\r\n") });
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 1);
  assert.match(result.scopedText, /BODY/);
  assert.ok(result.scopedText.includes('Область действия: paths=["**/*.xbsl"]; elementKinds=["Форма"].'));
  assert.ok(result.scopedText.includes('Совпавшие цели (1 из 1): ["Form.xbsl"]'));
  assert.doesNotMatch(result.scopedText, /---|paths:\n|elementKinds:\n/);
});

test("each rule exposes its selectors and only its own matched targets in a multi-target task", async t => {
  const f = fixture(t, { [basePath]: "BASE", "UI/Form.xbsl": "", "Services/Worker.xbsl": "", "UI/Other.yaml": "",
    [scopedPath("a")]: rule('paths: ["UI/**"]\nelementKinds: ["Форма"]', "RULE_A"),
    [scopedPath("b")]: rule('paths: ["Services/*.xbsl"]\nelementKinds: ["ОбщийМодуль"]', "RULE_B"),
  });
  const result = await f.build([f.target("UI/Form.xbsl"), f.target("Services/Worker.xbsl", "ОбщийМодуль"), f.target("UI/Other.yaml", "Справочник")]);
  const blocks = result.scopedText.split("[Дополнительные правила проекта]").filter(Boolean);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes('Область действия: paths=["UI/**"]; elementKinds=["Форма"].'));
  assert.ok(blocks[0].includes('Совпавшие цели (1 из 1): ["UI/Form.xbsl"]'));
  assert.doesNotMatch(blocks[0], /Services\/Worker\.xbsl|UI\/Other\.yaml|RULE_B/);
  assert.ok(blocks[1].includes('Область действия: paths=["Services/*.xbsl"]; elementKinds=["ОбщийМодуль"].'));
  assert.ok(blocks[1].includes('Совпавшие цели (1 из 1): ["Services/Worker.xbsl"]'));
  assert.doesNotMatch(blocks[1], /UI\/Form\.xbsl|UI\/Other\.yaml|RULE_A/);
  for (const block of blocks) {
    assert.match(block, /И между заданными классами селекторов для одной цели; ИЛИ внутри каждого списка/);
    assert.match(block, /не ко всем целям задачи/);
    assert.match(block, /не отменяет базовые и общепроектные правила/);
    assert.ok(block.indexOf("Область действия:") < block.indexOf("Текст правила:"));
  }
  assert.match(result.text, /BASE/);
  assert.equal(result.scopedMatchCount, 2);
});

test("single-class scopes keep the missing selector explicit and deduplicate matched paths", async t => {
  const f = fixture(t, { [scopedPath("kind")]: rule('elementKinds: ["Форма", "Справочник"]', "KIND_ONLY"),
    [scopedPath("path")]: rule('paths: ["Form.xbsl", "Other.xbsl"]', "PATH_ONLY") });
  const result = await f.build([f.target(), f.target(path.join(f.root, "Form.xbsl")), f.target()]);
  assert.ok(result.scopedText.includes('Область действия: paths=без ограничения; elementKinds=["Форма","Справочник"].'));
  assert.ok(result.scopedText.includes('Область действия: paths=["Form.xbsl","Other.xbsl"]; elementKinds=без ограничения.'));
  assert.equal(result.scopedText.split('Совпавшие цели (1 из 1): ["Form.xbsl"]').length - 1, 2);
  assert.equal(result.warnings, undefined);
});

test("matched path lists are bounded and visibly incomplete, without widening the selectors", async t => {
  const f = fixture(t, { [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "BOUNDED_BODY") });
  const targets = Array.from({ length: 12 }, (_, i) => f.target(`Target${i}.xbsl`));
  for (const target of targets) f.put(target.path, "");
  const result = await f.build(targets);
  const line = result.scopedText.split("\n").find(line => line.startsWith("Совпавшие цели"));
  assert.match(line, /^Совпавшие цели \(8 из 12\): /);
  const paths = JSON.parse(line.slice(line.indexOf(": ") + 2));
  assert.deepEqual(paths, targets.slice(0, 8).map(target => target.path));
  assert.match(result.scopedText, /Список совпавших целей усечен: не показано 4/);
  assert.match(warnings(result), /список совпавших целей усечен, не показано 4/);
  assert.ok(result.scopedText.includes('paths=["**/*.xbsl"]'));
  assert.match(result.scopedText, /BOUNDED_BODY/);
  assert.ok(result.scopedText.length <= 12_000);
});

test("long matched paths are bounded by characters and are never sliced mid-path", async t => {
  const f = fixture(t, { [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "LONG_PATH_BODY") });
  const directory = Array.from({ length: 5 }, (_, i) => `${i}${"d".repeat(180)}`).join("/");
  const targets = Array.from({ length: 5 }, (_, i) => f.target(`${directory}/File${i}.xbsl`));
  for (const target of targets) f.put(target.path, "");
  const result = await f.build(targets);
  const line = result.scopedText.split("\n").find(line => line.startsWith("Совпавшие цели"));
  const list = line.slice(line.indexOf(": ") + 2);
  const paths = JSON.parse(list);
  assert.ok(list.length <= 4100);
  assert.ok(paths.length > 0 && paths.length < targets.length);
  assert.deepEqual(paths, targets.slice(0, paths.length).map(target => target.path));
  assert.match(warnings(result), /список совпавших целей усечен/);
  assert.match(result.scopedText, /LONG_PATH_BODY/);
  assert.ok(result.scopedText.length <= 12_000);
});

test("a long quoted target is still displayed whole instead of yielding an empty match list", async () => {
  const { loadScopedRules } = loadSource("src/scopedProjectRules.ts", { vscode: {} });
  const filePath = `${'"'.repeat(2043)}.xbsl`;
  const workspace = {
    targetWarnings: [],
    confirmTarget: async target => target,
    rulePaths: async () => [scopedPath("a")],
    read: async () => rule('paths: ["**/*.xbsl"]', "QUOTED_BODY"),
    validateScopedReads: async () => {},
  };
  const result = await loadScopedRules(workspace, [{ path: filePath }]);
  assert.equal(result.scopedMatchCount, 1);
  const line = result.scopedText.split("\n").find(line => line.startsWith("Совпавшие цели"));
  const list = line.slice(line.indexOf(": ") + 2);
  assert.deepEqual(JSON.parse(list), [filePath]);
  assert.ok(list.length <= 4100);
  assert.ok(result.scopedText.length <= 12_000);
  assert.match(result.scopedText, /QUOTED_BODY/);
});

test("scope is never partially emitted when the remaining context cannot hold it", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "x".repeat(10_000)),
    [scopedPath("b")]: rule(`paths: ${JSON.stringify(["**/*.xbsl", ...Array.from({ length: 16 }, (_, i) => `${i}${"p".repeat(200)}.xbsl`)])}`, "UNSCOPED_BODY_MUST_NOT_LEAK") });
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 1);
  assert.equal(result.scopedPaths.join(), scopedPath("a"));
  assert.doesNotMatch(result.scopedText, /UNSCOPED_BODY_MUST_NOT_LEAK|Источник: .local-codex\/rules\/b.md/);
  assert.match(warnings(result), /b\.md пропущен, полная область действия не помещается/);
  assert.match(result.text, /BASE/);
  assert.ok(result.scopedText.length <= 12_000);
});

test("file bytes, UTF-8 buffers and context budgets stay independent of mandatory rules", async t => {
  const f = fixture(t, { [basePath]: "B".repeat(20_000),
    [scopedPath("00-big")]: rule('paths: ["**/*.xbsl"]', "x".repeat(33 * 1024)),
    [scopedPath("01-dirty")]: rule('paths: ["**/*.xbsl"]'),
    [scopedPath("02-long")]: rule('paths: ["**/*.xbsl"]', "C".repeat(20_000)),
  });
  f.dirty(scopedPath("01-dirty"), rule('paths: ["**/*.xbsl"]', "я".repeat(18_000)));
  const legacyOnly = await f.build([]);
  const result = await f.build();
  assert.equal(result.text, legacyOnly.text);
  assert.equal(result.matchCount, 1);
  assert.equal(result.scopedMatchCount, 1);
  assert.equal(result.scopedText.length, 12_000);
  assert.ok(result.scopedText.includes('Область действия: paths=["**/*.xbsl"]; elementKinds=без ограничения.'));
  assert.ok(result.scopedText.includes('Совпавшие цели (1 из 1): ["Form.xbsl"]'));
  assert.match(result.scopedText, /не отменяет базовые и общепроектные правила/);
  assert.equal(result.scopedPaths.join(), scopedPath("02-long"));
  assert.match(warnings(result), /слишком большой/);
  assert.match(warnings(result), /усечен/);
  assert.ok(!f.reads.some(file => file.endsWith("00-big.md")), "oversized files are not read");
});

test("a growing file cannot force an unbounded read", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  f.hooks.afterRead = current => {
    if (!current.endsWith("a.md")) return;
    delete f.hooks.afterRead;
    fs.appendFileSync(current, "x".repeat(1024 * 1024));
  };
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.ok(f.bytesRead <= 32 * 1024 + 5);
});

test("repeatedly growing files still share the total read budget", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  for (let i = 0; i < 20; i++) f.put(scopedPath(String(i)), rule('paths: ["**/*.xbsl"]'));
  const grown = new Set();
  f.hooks.afterRead = current => {
    if (current.endsWith("rules.md") || grown.has(current)) return;
    grown.add(current);
    fs.appendFileSync(current, "x".repeat(64 * 1024));
  };
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.match(warnings(result), /усечен.*256 КБ/);
  assert.ok(f.bytesRead <= 256 * 1024 + 5);
});

for (const mode of ["base-disk", "base-buffer", "scoped-disk", "scoped-buffer"]) {
  test(`previously read rules are revalidated before returning: ${mode}`, async t => {
    const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]', "FIRST"),
      [scopedPath("b")]: rule('paths: ["**/*.xbsl"]', "SECOND") });
    const relative = mode.startsWith("base") ? basePath : scopedPath("a");
    const document = mode.endsWith("buffer") ? f.dirty(relative, mode.startsWith("base") ? "BASE" : rule('paths: ["**/*.xbsl"]', "FIRST")) : undefined;
    f.hooks.afterRead = current => {
      if (!current.endsWith("b.md")) return;
      delete f.hooks.afterRead;
      if (document) { document.version++; document.text += "CHANGED"; }
      else fs.unlinkSync(path.join(f.root, relative));
    };
    const result = await f.build();
    if (mode.startsWith("base")) {
      assert.equal(result.text, undefined);
      assert.equal(result.matchCount, 0);
      assert.match(result.scopedText, /SECOND/);
    } else {
      assert.equal(result.scopedText, undefined);
      assert.equal(result.scopedMatchCount, 0);
      assert.match(result.text, /BASE/);
    }
    assert.match(warnings(result), /изменились во время сборки/);
  });
}

test("total read budget covers unmatched rules and reports truncation", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  for (let i = 0; i < 20; i++) f.put(scopedPath(String(i).padStart(2, "0")), rule('paths: ["**/*.yaml"]', "x".repeat(30_000)));
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.match(warnings(result), /усечен.*256 КБ/);
  assert.ok(f.bytesRead <= 256 * 1024 + 5);
});

test("file count is bounded, sorted and reported; directory traversal is not recursive", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  for (let i = 69; i >= 0; i--) f.put(scopedPath(String(i).padStart(2, "0")), rule(`paths: ["**/*.${i < 63 ? "yaml" : "xbsl"}"]`, `RULE_${i}`));
  f.put(".local-codex/rules/nested/hidden.md", rule('paths: ["**/*.xbsl"]', "HIDDEN"));
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 1);
  assert.equal(result.scopedPaths[0], scopedPath("63"));
  assert.equal(new Set(f.reads.filter(file => !file.endsWith("rules.md"))).size, 64);
  assert.doesNotMatch(result.scopedText, /HIDDEN|RULE_6[4-9]/);
  assert.match(warnings(result), /первые 64 файла/);
});

test("directory entry cap fails closed without reading an arbitrary subset", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('paths: ["**/*.xbsl"]') });
  for (let i = 0; i < 256; i++) f.put(`.local-codex/rules/${i}.txt`, "");
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.match(warnings(result), /усечен.*256 записей/);
  assert.ok(f.reads.every(file => file.endsWith("rules.md")));
});

test("target count is bounded and caller mutations do not change the request snapshot", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("a")]: rule('elementKinds: ["Форма"]') });
  const targets = Array.from({ length: 64 }, () => f.target("Form.xbsl", "ОбщийМодуль"));
  targets.push(f.target());
  f.hooks.before = () => { delete f.hooks.before; targets[0].elementKind = "Форма"; };
  const result = await f.build(targets);
  assert.equal(result.scopedMatchCount, 0);
  assert.match(result.text, /BASE/);
  assert.match(warnings(result), /первые 64 цели/);
});

test("no workspace returns missing without reading rules", async t => {
  const f = fixture(t);
  f.switchRoot(undefined);
  const result = await f.build();
  assert.equal(result.status.status, "missing");
  assert.equal(f.operations, 0);
});

for (const legacy of [false, true]) {
  test(`a small dirty source replaces an oversized saved rule: ${legacy ? "legacy" : "scoped"}`, async t => {
    const relative = legacy ? basePath : scopedPath("a");
    const limit = (legacy ? 64 : 32) * 1024;
    const f = fixture(t, { [relative]: "x".repeat(limit + 1) });
    f.dirty(relative, legacy ? "CURRENT_BASE" : rule('paths: ["**/*.xbsl"]', "CURRENT_SCOPED"));
    const result = await f.build();
    assert.equal(legacy ? result.matchCount : result.scopedMatchCount, 1);
    assert.match(legacy ? result.text : result.scopedText, /CURRENT_/);
    assert.equal(result.warnings, undefined);
    assert.ok(!f.reads.includes(path.join(f.root, relative)), "a dirty source must not read stale disk content");
  });
}

test("scoped budget charges dirty UTF-8 sources once, not their saved copies", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  for (let i = 0; i < 10; i++) {
    const relative = scopedPath(String(i));
    f.put(relative, rule('paths: ["**/*.yaml"]', "x".repeat(30_000)));
    f.dirty(relative, rule(`paths: ["**/*.${i === 9 ? "xbsl" : "yaml"}"]`, "CURRENT"));
  }
  const result = await f.build();
  assert.equal(result.scopedMatchCount, 1);
  assert.equal(result.scopedPaths[0], scopedPath("9"));
  assert.equal(result.warnings, undefined);
  assert.ok(f.reads.every(file => file.endsWith("rules.md")));
});

test("dirty nonmatching sources still exhaust the shared scoped read budget", async t => {
  const f = fixture(t, { [basePath]: "BASE" });
  for (let i = 0; i < 10; i++) {
    const relative = scopedPath(String(i));
    f.dirty(relative, rule('paths: ["**/*.yaml"]', "я".repeat(15_000)));
  }
  f.put(scopedPath("z"), rule('paths: ["**/*.xbsl"]', "BEYOND_BUDGET"));
  const result = await f.build();
  assert.equal(result.scopedText, undefined);
  assert.match(warnings(result), /усечен.*256 КБ/);
  assert.ok(!f.reads.some(file => file.endsWith("z.md")));
  assert.match(result.text, /BASE/);
});

for (const source of ["disk", "dirty"]) {
  for (const initial of [rule('paths: ["**/*.yaml"]'), "malformed frontmatter", "x".repeat(33 * 1024)]) {
    test(`all observed rules are revalidated, including unmatched or rejected reads: ${source}, ${initial.length}`, async t => {
      const a = scopedPath("a"), b = scopedPath("b");
      const f = fixture(t, { [basePath]: "BASE", [a]: initial, [b]: rule('paths: ["**/*.yaml"]') });
      const docA = source === "dirty" ? f.dirty(a, initial) : undefined;
      const docB = source === "dirty" ? f.dirty(b, rule('paths: ["**/*.yaml"]')) : undefined;
      f.hooks.before = (operation, file) => {
        if (operation !== "lstat" || file !== path.join(f.root, b)) return;
        delete f.hooks.before;
        const nextA = rule('paths: ["**/*.xbsl"]', "CURRENT_A");
        const nextB = rule('paths: ["**/*.xbsl"]', "CURRENT_B");
        if (docA) {
          docA.text = nextA; docA.version++;
          docB.text = nextB; docB.version++;
        } else { f.put(a, nextA); f.put(b, nextB); }
      };
      const result = await f.build();
      assert.equal(result.scopedMatchCount, 0, "must not publish a mixed snapshot containing only B");
      assert.equal(result.scopedText, undefined);
      assert.match(warnings(result), /изменились во время сборки/);
      assert.match(result.text, /BASE/);
      const retry = await f.build();
      assert.equal(retry.scopedMatchCount, 2);
      assert.match(retry.scopedText, /CURRENT_A/);
      assert.match(retry.scopedText, /CURRENT_B/);
    });
  }
}

for (const mutation of ["create", "rename", "delete", "dirty-create", "dirty-close"]) {
  test(`rule catalog changes invalidate selection: ${mutation}`, async t => {
    const a = scopedPath("a"), z = scopedPath("z");
    const f = fixture(t, { [basePath]: "BASE", [a]: rule('paths: ["**/*.xbsl"]', "A") });
    if (["rename", "delete"].includes(mutation)) f.put(z, rule('paths: ["**/*.xbsl"]', "Z"));
    const document = mutation === "dirty-close" ? f.dirty(z, rule('paths: ["**/*.xbsl"]', "Z")) : undefined;
    f.hooks.afterRuleRead = relative => {
      if (relative !== a) return;
      delete f.hooks.afterRuleRead;
      if (mutation === "create") f.put(z, rule('paths: ["**/*.xbsl"]', "Z"));
      if (mutation === "rename") fs.renameSync(path.join(f.root, z), path.join(f.root, scopedPath("new")));
      if (mutation === "delete") fs.unlinkSync(path.join(f.root, z));
      if (mutation === "dirty-create") f.dirty(z, rule('paths: ["**/*.xbsl"]', "Z"));
      if (document) document.isClosed = true;
    };
    const result = await f.build();
    assert.equal(result.scopedText, undefined);
    assert.equal(result.scopedMatchCount, 0);
    assert.match(warnings(result), /изменились во время сборки/);
    assert.match(result.text, /BASE/);
    const retry = await f.build();
    assert.equal(retry.scopedMatchCount, ["delete", "dirty-close"].includes(mutation) ? 1 : 2);
  });
}

const elementYaml = kind => `Имя: Element\nВидЭлемента: ${kind}\n`;

for (const suffix of [".xbsl", ".Объект.xbsl", ".Object.xbsl", ".НаборЗаписей.xbsl", ".Запись.xbsl", ".yaml", ".yml", ".YAML"]) {
  test(`path-only targets derive kinds from fresh paired YAML: ${suffix}`, async t => {
    const targetPath = `Project/Element${suffix}`;
    const yamlPath = /\.ya?ml$/i.test(suffix) ? targetPath : "Project/Element.yaml";
    const f = fixture(t, { [basePath]: "BASE", [targetPath]: "", [yamlPath]: elementYaml("Справочник"),
      [scopedPath("kind")]: rule('elementKinds: ["Справочник"]', "RIGHT_KIND"),
      [scopedPath("wrong")]: rule('elementKinds: ["Форма"]', "WRONG_KIND") });
    const result = await f.build([{ path: targetPath }]);
    assert.equal(result.scopedMatchCount, 1);
    assert.match(result.scopedText, /RIGHT_KIND/);
    assert.doesNotMatch(result.scopedText, /WRONG_KIND/);
    assert.ok(result.scopedText.includes(JSON.stringify([targetPath])));
    assert.equal(result.warnings, undefined);
  });
}

test("enriched kinds retain AND semantics for each confirmed target", async t => {
  const f = fixture(t, { "Catalog.Объект.xbsl": "", "Catalog.yaml": elementYaml("Справочник"),
    "Form.yaml": elementYaml("Форма"),
    [scopedPath("catalog")]: rule('paths: ["Catalog.Объект.xbsl"]\nelementKinds: ["Справочник"]', "CATALOG"),
    [scopedPath("form")]: rule('paths: ["Form.xbsl"]\nelementKinds: ["Форма"]', "FORM"),
    [scopedPath("cross")]: rule('paths: ["Form.xbsl"]\nelementKinds: ["Справочник"]', "WRONG_TARGET") });
  const result = await f.build([{ path: "Catalog.Объект.xbsl" }, { path: "Form.xbsl" }]);
  assert.equal(result.scopedMatchCount, 2);
  assert.match(result.scopedText, /CATALOG/);
  assert.match(result.scopedText, /FORM/);
  assert.doesNotMatch(result.scopedText, /WRONG_TARGET/);
});

test("arbitrary suffix targets cannot inherit a neighboring YAML kind", async t => {
  const f = fixture(t, { "Form.Other.xbsl": "", "Form.yaml": elementYaml("Форма"),
    [scopedPath("kind")]: rule('elementKinds: ["Форма"]', "WRONG_OWNER"),
    [scopedPath("path")]: rule('paths: ["Form.Other.xbsl"]', "EXPLICIT_PATH") });
  const result = await f.build([{ path: "Form.Other.xbsl" }]);
  assert.equal(result.scopedMatchCount, 1);
  assert.match(result.scopedText, /EXPLICIT_PATH/);
  assert.doesNotMatch(result.scopedText, /WRONG_OWNER/);
});

test("kind enrichment prefers current dirty YAML and ignores stale clean or untitled buffers", async t => {
  const f = fixture(t, { "Form.yaml": elementYaml("Справочник"),
    [scopedPath("catalog")]: rule('elementKinds: ["Справочник"]', "CATALOG"),
    [scopedPath("form")]: rule('elementKinds: ["Форма"]', "FORM") });
  const document = f.dirty("Form.yaml", elementYaml("Форма"));
  const targets = [{ path: "Form.xbsl" }];
  assert.match((await f.build(targets)).scopedText, /Текст правила:\nFORM/);
  document.text = elementYaml("ОбщийМодуль"); document.version++;
  assert.equal((await f.build(targets)).scopedMatchCount, 0);
  for (const state of ["clean", "untitled"]) {
    document.isDirty = state !== "clean";
    document.uri.scheme = state === "untitled" ? "untitled" : "file";
    const result = await f.build(targets);
    assert.equal(result.scopedMatchCount, 1);
    assert.match(result.scopedText, /CATALOG/);
  }
});

test("a new file-backed dirty YAML companion can supply the kind", async t => {
  const f = fixture(t, { [scopedPath("a")]: rule('elementKinds: ["Форма"]') });
  f.dirty("Form.yaml", elementYaml("Форма"));
  assert.equal((await f.build([{ path: "Form.xbsl" }])).scopedMatchCount, 1);
});

for (const source of ["disk", "dirty", "new-dirty", "new-disk"]) {
  test(`YAML source or companion catalog changes invalidate enriched selection: ${source}`, async t => {
    const f = fixture(t, { [basePath]: "BASE", [scopedPath("path")]: rule('paths: ["**/*.xbsl"]'),
      [scopedPath("kind")]: rule('elementKinds: ["Форма"]') });
    if (!source.startsWith("new-")) f.put("Form.yaml", elementYaml("Форма"));
    const document = source === "dirty" ? f.dirty("Form.yaml", elementYaml("Форма")) : undefined;
    f.hooks.afterRuleRead = relative => {
      if (relative !== scopedPath("path")) return;
      delete f.hooks.afterRuleRead;
      if (document) { document.text = elementYaml("Справочник"); document.version++; }
      else if (source === "new-dirty") f.dirty("Form.yaml", elementYaml("Справочник"));
      else f.put("Form.yaml", elementYaml("Справочник"));
    };
    const result = await f.build([{ path: "Form.xbsl" }]);
    assert.equal(result.scopedText, undefined);
    assert.match(warnings(result), /изменились во время сборки/);
    assert.match(result.text, /BASE/);
    const retry = await f.build([{ path: "Form.xbsl" }]);
    assert.equal(retry.scopedMatchCount, 1);
    assert.equal(retry.scopedPaths[0], scopedPath("path"));
  });
}

for (const invalid of ["Имя: Form\n", "ВидЭлемента: Форма\n", "Имя: Form\nNested:\n  ВидЭлемента: Форма\n",
  "Имя: Form\nВидЭлемента: Форма\nВидЭлемента: Справочник\n", "Имя: Form\nВидЭлемента: [\n"]) {
  test(`malformed or non-element YAML does not invent a kind: ${JSON.stringify(invalid)}`, async t => {
    const f = fixture(t, { "Form.yaml": invalid,
      [scopedPath("kind")]: rule('elementKinds: ["Форма"]', "WRONG_KIND"),
      [scopedPath("path")]: rule('paths: ["**/*.xbsl"]', "PATH_RULE") });
    const result = await f.build([{ path: "Form.xbsl" }]);
    assert.equal(result.scopedMatchCount, 1);
    assert.match(result.scopedText, /PATH_RULE/);
    assert.doesNotMatch(result.scopedText, /WRONG_KIND/);
  });
}

test("companion enrichment rejects ambiguous, neighboring and cross-directory YAML", async t => {
  const f = fixture(t, { "Other/Form.yaml": elementYaml("Форма"), "Forms.yaml": elementYaml("Форма"),
    "Element.Объект.xbsl": "", "Element.yaml": elementYaml("Форма"), "Element.yml": elementYaml("Справочник"),
    [scopedPath("kind")]: rule('elementKinds: ["Форма", "Справочник"]', "WRONG_KIND"),
    [scopedPath("path")]: rule('paths: ["**/*.xbsl"]', "PATH_RULE") });
  const result = await f.build([{ path: "Form.xbsl" }, { path: "Element.Объект.xbsl" }]);
  assert.equal(result.scopedMatchCount, 1);
  assert.match(result.scopedText, /PATH_RULE/);
  assert.match(warnings(result), /неоднозначная пара/);
  assert.ok(!f.reads.some(file => /\.ya?ml$/.test(file)), "no arbitrary choice among ambiguous companions");
});

for (const internal of [false, true]) {
  test(`paired YAML symlinks cannot supply a kind, even with a dirty overlay: internal=${internal}`, async t => {
    const f = fixture(t, { [basePath]: "BASE", [scopedPath("kind")]: rule('elementKinds: ["Форма"]', "SECRET_KIND"),
      [scopedPath("path")]: rule('paths: ["**/*.xbsl"]', "PATH_RULE") });
    const secret = f.put("private/Secret.yaml", elementYaml("Форма"), internal ? f.root : f.other);
    fs.symlinkSync(secret, path.join(f.root, "Form.yaml"));
    f.dirty("Form.yaml", elementYaml("Форма"));
    const result = await f.build([{ path: "Form.xbsl" }]);
    assert.equal(result.scopedMatchCount, 1);
    assert.match(result.scopedText, /PATH_RULE/);
    assert.doesNotMatch(result.scopedText, /SECRET_KIND/);
    assert.match(warnings(result), /символическ/i);
    assert.ok(!f.reads.some(file => file === secret || file.endsWith("Form.yaml")));
  });
}

test("YAML enrichment enforces independent file and total budgets without spending the rules budget", async t => {
  const f = fixture(t, { [basePath]: "BASE", [scopedPath("kind")]: rule('elementKinds: ["Форма"]', "KIND"),
    [scopedPath("path")]: rule('paths: ["**/*.xbsl"]', "PATH_RULE") });
  const targets = [];
  for (let i = 0; i < 6; i++) {
    f.put(`Element${i}.xbsl`, "");
    f.put(`Element${i}.yaml`, elementYaml("Форма") + "#" + "x".repeat(250 * 1024));
    targets.push({ path: `Element${i}.xbsl` });
  }
  f.put("Huge.xbsl", "");
  f.put("Huge.yaml", elementYaml("Форма") + "#" + "x".repeat(257 * 1024));
  const huge = await f.build([{ path: "Huge.xbsl" }]);
  assert.equal(huge.scopedMatchCount, 1);
  assert.match(warnings(huge), /слишком большой/);
  assert.ok(!f.reads.some(file => file.endsWith("Huge.yaml")));
  const result = await f.build(targets);
  assert.equal(result.scopedMatchCount, 2);
  assert.match(result.scopedText, /PATH_RULE/);
  assert.match(warnings(result), /лимит чтения YAML 1 МБ/);
  assert.ok(f.bytesRead < 1024 * 1024 + 1024);
  assert.ok(!f.reads.some(file => file.endsWith("Element5.yaml")));
  const kindBlock = result.scopedText.split("[Дополнительные правила проекта]")[1];
  assert.doesNotMatch(kindBlock, /Element[45]\.xbsl/);
});

test("small dirty YAML replaces oversized saved YAML and is shared by companion targets", async t => {
  const f = fixture(t, { "Element.Объект.xbsl": "", "Element.Запись.xbsl": "",
    "Element.yaml": "x".repeat(257 * 1024), [scopedPath("kind")]: rule('elementKinds: ["Форма"]') });
  const document = f.dirty("Element.yaml", elementYaml("Форма"));
  let reads = 0;
  const getText = document.getText;
  document.getText = function () { reads++; return getText.call(this); };
  const result = await f.build([{ path: "Element.Объект.xbsl" }, { path: "Element.Запись.xbsl" }]);
  assert.equal(result.scopedMatchCount, 1);
  assert.equal(reads, 1);
  assert.equal(result.warnings, undefined);
  assert.ok(!f.reads.some(file => file.endsWith("Element.yaml")));
  assert.match(result.scopedText, /Совпавшие цели \(2 из 2\)/);
});
