const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, vscode } = require("./service-test-utils.cjs");

function fixture(t, initial = "# Rules\nOriginal rules.\n", options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-base-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "resources", "context", "codex-element-language-rules.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, initial);
  const logs = [];
  const warnings = [];
  const bom = options.editorEncoding && initial.startsWith("\uFEFF") ? "\uFEFF" : "";
  const toEditorText = text => options.editorEncoding ? text.replace(/^\uFEFF/, "").replace(/\r?\n/g, "\r\n") : text;
  let editorText = toEditorText(initial);
  let edits = 0;
  let saves = 0;
  let opened = 0;
  let shown = 0;
  const document = {
    uri: { fsPath: sourcePath }, version: 1, isDirty: false, eol: options.editorEncoding ? 2 : 1,
    getText: () => editorText,
    positionAt: offset => offset,
    async save() {
      saves++;
      if (options.save) return options.save(document);
      fs.writeFileSync(sourcePath, bom + editorText);
      document.isDirty = false;
      return true;
    }
  };
  const editInEditor = text => { editorText = text; document.version++; document.isDirty = true; };
  const mockVscode = {
    ...vscode,
    Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { One: 1 }, EndOfLine: { LF: 1, CRLF: 2 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { replace(uri, range, text) { this.uri = uri; this.range = range; this.text = text; } },
    workspace: {
      async openTextDocument(uri) {
        opened++;
        assert.equal(uri.fsPath, sourcePath);
        if (!document.isDirty) {
          const disk = toEditorText(fs.readFileSync(sourcePath, "utf8"));
          if (editorText !== disk) { editorText = disk; document.version++; }
        }
        return document;
      },
      async applyEdit(edit) {
        assert.equal(edit.uri.fsPath, sourcePath);
        assert.equal(edit.range.start, 0);
        assert.equal(edit.range.end, editorText.length);
        if (options.applyEdit) return options.applyEdit(edit);
        edits++;
        editInEditor(toEditorText(edit.text));
        if (options.afterEdit) await options.afterEdit({ sourcePath, document, editInEditor });
        return true;
      }
    },
    window: {
      async showTextDocument(value) { assert.equal(value, document); shown++; },
      showWarningMessage: message => warnings.push(message)
    }
  };
  const { BaseContextService } = loadSource("src/baseContextService.ts", { vscode: mockVscode, ...options.mocks });
  const service = new BaseContextService({ extensionUri: { fsPath: root } }, {
    info: message => logs.push(message), warn: message => logs.push(message)
  });
  return {
    service, sourcePath, document, editInEditor, logs, warnings,
    counts: () => ({ edits, saves, opened, shown })
  };
}

test("base context read and save round-trip the shared rules file and return a reusable new revision", async t => {
  const f = fixture(t);
  const loaded = await f.service.readBaseContext();
  assert.equal(loaded.sourcePath, f.sourcePath);
  assert.equal(loaded.text, "# Rules\nOriginal rules.\n");
  assert.match(loaded.revision, /^[a-f0-9]{64}$/);
  assert.equal((await f.service.readBaseContext()).revision, loaded.revision);
  const revision = await f.service.saveBaseContext("# Updated\nNew rules.\n", loaded.revision);
  assert.notEqual(revision, loaded.revision);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "# Updated\nNew rules.\n");
  assert.equal((await f.service.readBaseContext()).revision, revision);
  const emptyRevision = await f.service.saveBaseContext("", revision);
  assert.equal((await f.service.readBaseContext()).text, "");
  assert.equal((await f.service.readBaseContext()).revision, emptyRevision);
  assert.equal(f.document.isDirty, false);
});

test("stale disk revision cannot overwrite a newer rules file", async t => {
  const f = fixture(t);
  const loaded = await f.service.readBaseContext();
  fs.writeFileSync(f.sourcePath, "Changed by another writer.\n");
  await assert.rejects(f.service.saveBaseContext("Stale webview draft", loaded.revision), /изменился.*Загрузите/);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Changed by another writer.\n");
  assert.equal(f.counts().edits, 0);
  assert.equal(f.counts().saves, 0);
});

test("read includes unsaved editor content; newer dirty edits invalidate the webview revision", async t => {
  const f = fixture(t);
  f.editInEditor("Unsaved editor rules.");
  const loaded = await f.service.readBaseContext();
  assert.equal(loaded.text, "Unsaved editor rules.");
  f.editInEditor("Newer unsaved rules.");
  await assert.rejects(f.service.saveBaseContext("Stale webview draft", loaded.revision), /изменился/);
  assert.equal(f.document.getText(), "Newer unsaved rules.");
  assert.equal(f.counts().saves, 0);
  const current = await f.service.readBaseContext();
  await f.service.saveBaseContext("Approved editor and webview rules.", current.revision);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Approved editor and webview rules.");
});

test("disk changes during applyEdit are detected before saving and retained", async t => {
  const f = fixture(t, "Initial", { afterEdit: ({ sourcePath }) => fs.writeFileSync(sourcePath, "Concurrent disk rules") });
  const loaded = await f.service.readBaseContext();
  await assert.rejects(f.service.saveBaseContext("Webview draft", loaded.revision), /изменился/);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Concurrent disk rules");
  assert.equal(f.counts().saves, 0);
});

test("editor changes during applyEdit are not saved or rolled back", async t => {
  const f = fixture(t, "Initial", { afterEdit: ({ editInEditor }) => editInEditor("Concurrent editor rules") });
  const loaded = await f.service.readBaseContext();
  await assert.rejects(f.service.saveBaseContext("Webview draft", loaded.revision), /изменился/);
  assert.equal(f.document.getText(), "Concurrent editor rules");
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Initial");
  assert.equal(f.counts().saves, 0);
});

test("96 KiB UTF-8 boundary is accepted; larger ASCII and multibyte payloads never mutate the document", async t => {
  const f = fixture(t);
  const loaded = await f.service.readBaseContext();
  for (const text of ["x".repeat(96 * 1024 + 1), "я".repeat(48 * 1024 + 1)]) {
    await assert.rejects(f.service.saveBaseContext(text, loaded.revision), /96 КБ.*UTF-8/);
  }
  assert.equal(f.counts().edits, 0);
  assert.equal(f.counts().saves, 0);
  const boundary = "я".repeat(48 * 1024);
  const revision = await f.service.saveBaseContext(boundary, loaded.revision);
  assert.equal(fs.statSync(f.sourcePath).size, 96 * 1024);
  assert.equal((await f.service.readBaseContext()).revision, revision);
});

test("oversized disk files and dirty editor buffers are rejected on read", async t => {
  const disk = fixture(t, "x".repeat(96 * 1024 + 1));
  await assert.rejects(disk.service.readBaseContext(), /96 КБ/);
  assert.equal(disk.counts().opened, 0);
  const editor = fixture(t);
  editor.editInEditor("я".repeat(48 * 1024 + 1));
  await assert.rejects(editor.service.readBaseContext(), /96 КБ/);
});

test("document API preserves CRLF and UTF-8 BOM while enforcing the resulting file size", async t => {
  const f = fixture(t, "\uFEFF# Rules\r\nInitial\r\n", { editorEncoding: true });
  const loaded = await f.service.readBaseContext();
  assert.equal(loaded.text, "# Rules\r\nInitial\r\n");
  await assert.rejects(f.service.saveBaseContext("x".repeat(96 * 1024), loaded.revision), /96 КБ/);
  assert.equal(f.counts().edits, 0);
  await assert.rejects(f.service.saveBaseContext("x\n".repeat(40 * 1024), loaded.revision), /96 КБ/);
  assert.equal(f.counts().edits, 0, "CRLF expansion must be checked before changing the editor");
  assert.equal(f.counts().saves, 0, "CRLF expansion must not persist an oversized file");
  const revision = await f.service.saveBaseContext("# Rules\nUpdated\n", loaded.revision);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "\uFEFF# Rules\r\nUpdated\r\n");
  assert.equal((await f.service.readBaseContext()).revision, revision);
});

test("missing or malformed revisions fail before any edit or save", async t => {
  const f = fixture(t);
  for (const revision of [undefined, null, "", "not-a-revision", 42]) {
    await assert.rejects(f.service.saveBaseContext("new text", revision), /Некорректные данные/);
  }
  assert.equal(f.counts().opened, 0);
});

for (const code of ["EACCES", "EPERM", "EROFS", "NoPermissions"]) {
  test(`${code} read errors are Russian and do not expose secret error content`, async t => {
    const f = fixture(t, "Initial", { mocks: { fs: { promises: { open: async () => {
      throw Object.assign(new Error("secret-token=fixture-secret"), { code });
    } } } } });
    await assert.rejects(f.service.readBaseContext(), error => {
      assert.match(error.message, /Недостаточно прав/);
      assert(!error.message.includes("fixture-secret"));
      return true;
    });
    assert(!f.logs.join("\n").includes("fixture-secret"));
  });
}

test("save permission failure is localized, keeps the editor draft and releases the save lock", async t => {
  const options = { save: async () => { throw Object.assign(new Error("secret-token=fixture-secret"), { code: "EACCES" }); } };
  const f = fixture(t, "Initial", options);
  const loaded = await f.service.readBaseContext();
  await assert.rejects(f.service.saveBaseContext("Draft", loaded.revision), /Недостаточно прав/);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Initial");
  assert.equal(f.document.getText(), "Draft");
  assert.equal(f.document.isDirty, true);
  assert(!f.logs.join("\n").includes("fixture-secret"));
  const current = await f.service.readBaseContext();
  delete options.save;
  await f.service.saveBaseContext("Draft", current.revision);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Draft");
});

test("failed applyEdit or save does not report success or truncate the file", async t => {
  for (const options of [{ applyEdit: async () => false }, { save: async () => false }]) {
    const f = fixture(t, "Initial", options);
    const loaded = await f.service.readBaseContext();
    await assert.rejects(f.service.saveBaseContext("Draft", loaded.revision), /Не удалось/);
    assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "Initial");
    await f.service.readBaseContext();
  }
});

test("concurrent saves cannot both accept the same revision", async t => {
  const f = fixture(t);
  const loaded = await f.service.readBaseContext();
  const first = f.service.saveBaseContext("First writer", loaded.revision);
  await assert.rejects(f.service.saveBaseContext("Second writer", loaded.revision), /еще выполняется/);
  await first;
  await assert.rejects(f.service.saveBaseContext("Second writer", loaded.revision), /изменился/);
  assert.equal(fs.readFileSync(f.sourcePath, "utf8"), "First writer");
});

test("buildContext and openBaseContextFile retain formatting, truncation and missing-file recovery", async t => {
  const f = fixture(t, "# Rules\r\n" + "x".repeat(20_000));
  const built = await f.service.buildContext();
  assert.equal(built.matchCount, 1);
  assert.equal(built.sourcePath, f.sourcePath);
  assert.match(built.text, /Базовые правила Codex Element/);
  assert(built.text.endsWith("…"));
  assert.equal(await f.service.openBaseContextFile(), f.sourcePath);
  assert.equal(f.counts().shown, 1);
  fs.unlinkSync(f.sourcePath);
  await assert.rejects(f.service.readBaseContext(), /Файл базового контекста не найден/);
  assert.equal((await f.service.buildContext()).matchCount, 0);
  assert.equal(await f.service.openBaseContextFile(), f.sourcePath);
  assert.match(fs.readFileSync(f.sourcePath, "utf8"), /Базовый контекст Codex Element/);
});
