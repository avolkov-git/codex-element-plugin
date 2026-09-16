const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { test } = require("node:test");

const pluginRoot = path.resolve(process.env.CODEX_TEST_PLUGIN_ROOT || path.join(__dirname, ".."));
class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const disposable = () => ({ dispose() {} });
function uri(value) {
  const url = new URL(value);
  return { scheme: url.protocol.slice(0, -1), path: decodeURIComponent(url.pathname), fsPath: url.protocol === "file:" ? fileURLToPath(url) : decodeURIComponent(url.pathname), toString: () => url.toString() };
}
const Uri = { file: (value) => uri(pathToFileURL(value).toString()), parse: uri, joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts)), from: (value) => uri(`${value.scheme}://${value.path}`) };

async function activateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-"));
  const oldConfigRoot = process.env.CODEX_ELEMENT_CONFIG_ROOT;
  process.env.CODEX_ELEMENT_CONFIG_ROOT = path.join(root, "config");
  const lines = [], commands = new Map(), providers = new Map(), serializers = new Map();
  const configChanges = new Emitter(), workspaceChanges = new Emitter();
  const events = [configChanges, workspaceChanges];
  const vscode = {
    EventEmitter: Emitter, Uri,
    workspace: {
      workspaceFolders: [{ uri: Uri.file(path.join(root, "workspace")), name: "fixture", index: 0 }], textDocuments: [],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      onDidChangeConfiguration: configChanges.event, onDidChangeWorkspaceFolders: workspaceChanges.event,
      registerTextDocumentContentProvider: disposable,
      createFileSystemWatcher: () => { throw new Error("Workspace watcher must remain lazy during startup"); },
    },
    window: {
      createOutputChannel: () => ({ append: (value) => lines.push(value), appendLine: (value) => lines.push(value), show() {}, dispose() {} }),
      registerWebviewViewProvider: (id, provider) => { assert(!providers.has(id)); providers.set(id, provider); return disposable(); },
      registerWebviewPanelSerializer: (id, serializer) => { serializers.set(id, serializer); return disposable(); },
      showErrorMessage: async (message) => { lines.push(`error: ${message}`); },
      showWarningMessage: async (message) => { lines.push(`warn: ${message}`); },
      showInformationMessage: async (message) => { lines.push(`info: ${message}`); },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); },
      executeCommand: async (id) => { if (commands.has(id)) return commands.get(id)(); throw new Error(`Command unavailable: ${id}`); },
    },
  };
  const memento = () => ({ get: (_, fallback) => fallback, update: async () => {} });
  const context = {
    extensionUri: Uri.file(pluginRoot), extensionPath: pluginRoot,
    extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"))) },
    globalStorageUri: Uri.file(path.join(root, "global")), storageUri: Uri.file(path.join(root, "storage")),
    globalState: memento(), workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    subscriptions: [], asAbsolutePath: (name) => path.join(pluginRoot, name),
  };
  const originalLoad = Module._load;
  let extension;
  Module._load = function (id, ...args) { return id === "vscode" ? vscode : originalLoad.call(this, id, ...args); };
  t.after(async () => {
    try { await extension?.deactivate(); }
    finally {
      for (const subscription of [...context.subscriptions].reverse()) subscription.dispose();
      for (const event of events) event.dispose();
      Module._load = originalLoad;
      if (oldConfigRoot === undefined) delete process.env.CODEX_ELEMENT_CONFIG_ROOT; else process.env.CODEX_ELEMENT_CONFIG_ROOT = oldConfigRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  extension = require(path.join(pluginRoot, "dist/extension.js"));
  await extension.activate(context);
  return { lines, commands, providers, serializers, context };
}

test("compiled extension activates before credentials/MCP exist and registers a nonblank sidebar", { timeout: 10000 }, async (t) => {
  for (const relativePath of ["dist/extension.js", "media/sidebar.js", "media/sidebar.css", "resources/icons/codex.svg"]) {
    const file = path.join(pluginRoot, relativePath);
    assert(fs.statSync(file).isFile(), `missing file: ${relativePath}`);
    fs.accessSync(file, fs.constants.R_OK);
  }
  const fixture = await activateFixture(t);
  assert(fixture.commands.has("codexElement.openLogs"));
  assert(fixture.commands.has("codexElement.openSettings"));
  assert.equal(fixture.serializers.size, 2);
  const provider = fixture.providers.get("codexElement.sidebar");
  assert(provider);
  const messages = new Emitter(), visible = new Emitter(), disposed = new Emitter();
  const frames = [];
  const view = {
    visible: true, onDidChangeVisibility: visible.event, onDidDispose: disposed.event,
    webview: { html: "", options: {}, cspSource: "http://assets.invalid", asWebviewUri: (value) => ({ toString: () => `http://assets.invalid${value.path}` }),
      onDidReceiveMessage: messages.event,
      postMessage: async (message) => { frames.push(message); if (message.type === "sidebar.snapshot") queueMicrotask(() => messages.fire({ type: "sidebar.ack", revision: message.revision })); return true; },
    },
  };
  t.after(() => { disposed.fire(); messages.dispose(); visible.dispose(); disposed.dispose(); });
  provider.resolveWebviewView(view);
  assert(view.webview.html.includes("Codex загружается"));
  assert(view.webview.html.includes("__codexElementRunInlineFallback"));
  messages.fire({ type: "ready", assetMode: "inline fallback" });
  const deadline = Date.now() + 5000;
  while (!frames.some((frame) => frame.type === "sidebar.snapshot" && frame.snapshot.auth.status === "error") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await fixture.context.subscriptions[0].flush();
  assert(fixture.lines.some((line) => line.includes("Codex activation completed")));
  const snapshot = frames.filter((frame) => frame.type === "sidebar.snapshot").at(-1)?.snapshot;
  assert(snapshot, "ready must receive a sidebar snapshot");
  assert.equal(snapshot.auth.status, "error");
  assert(snapshot.auth.message.includes("IDE"));
  assert.equal(snapshot.chats.length, 0);
  assert(!fixture.lines.some((line) => line.includes("Starting bundled")), "Codex must not spawn for unverified identity");
});
