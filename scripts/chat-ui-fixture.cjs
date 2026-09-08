const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");

async function compile() {
  const build = require("./build-chat-ui.js");
  const ui = (await esbuild.build({ ...build, write: false })).outputFiles[0].text;
  const server = (await esbuild.build({ entryPoints: [path.join(root, "src/chatPanelManager.ts")], bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false })).outputFiles[0].text;
  const module = { exports: {} };
  const clipboard = [];
  const vscode = { window: { showWarningMessage: async () => undefined }, env: { openExternal: async () => true, clipboard: { writeText: async text => clipboard.push(text) } }, workspace: {} };
  vm.runInNewContext(server, { module, exports: module.exports, require: id => id === "vscode" ? vscode : require(id), setTimeout, clearTimeout, console, Buffer, process });
  return { ui, css: fs.readFileSync(path.join(root, "media/chat.css"), "utf8"), Manager: module.exports.ChatPanelManager, clipboard };
}

function makeSnapshot(count = 1000, chatId = "chat-a") {
  const now = "2026-09-08T10:00:00.000Z";
  const items = Array.from({ length: count }, (_, index) => ({ kind: "message", id: `item-${index}`, role: index % 3 === 0 ? "user" : "assistant", status: index === count - 1 ? "streaming" : "complete", createdAt: now,
    text: index === count - 1 ? "Streaming response" : `Message ${index}. Stable selection text and variable height.\n\n${"Some useful project details. ".repeat(index % 9 + 1)}${index % 7 === 0 ? "\n\n| Name | Value |\n| --- | --- |\n| field | checked |" : ""}` }));
  const window = (offset, end) => ({ chatId, revision: 1, turns: items.filter(item => item.kind === "turn-run" && items.slice(offset, end).some(child => child.turnId === item.turnId)), offset, totalCount: items.length, items: items.slice(offset, end), hasBefore: offset > 0, hasAfter: end < items.length });
  const meta = {
    kind: "chat", version: 1, chatHeaderMode: "collapsed",
    chat: { id: chatId, title: "Проверка проекта", kind: "project", status: "running", hasUnread: false, createdAt: now, updatedAt: now, archivedAt: null, lastReadAt: now, accessMode: "workspace-write", modelId: "gpt", modelLabel: "GPT", effort: "high", speed: "standard", queuedMessages: [], rulesEnabled: true, pendingApproval: null, pendingUserInput: null, backendThreadId: "thread-a", activeTurnId: "turn-a", activeRunMode: "normal" },
    auth: { status: "authenticated", accountLabel: "Test", profileLabel: "Test", accountType: "chatgpt", message: "", deviceCode: { status: "idle", loginId: "", verificationUrl: "", userCode: "" }, apiKey: { status: "idle" } },
    runtime: { status: "running", label: "Running" }, docs: { status: "configured", label: "Документация" }, projectContext: { status: "active", label: "Проект" }, rulesContext: { status: "active", label: "Правила" },
    contextWindow: { status: "ready", usedTokens: 1000, maxTokens: 10000, usedPercent: 10 }, modelOptions: [{ id: "gpt", label: "GPT", supportedEfforts: [{ value: "high", description: "High" }] }], modelOptionsStatus: "ready", pendingUserInput: null, pendingUserInputs: []
  };
  return { items, meta, window };
}

async function createFixture(page, compiled, { count = 1000, fallback = false, persisted = {}, dark = false } = {}) {
  const data = makeSnapshot(count);
  const outbound = [], inbound = [], calls = [];
  const uploadedBytes = new Map();
  let active = data.meta.chat.id;
  let heldAcks = false;
  const manager = new compiled.Manager({}, {
    getActiveChatSnapshot: () => ({ ...data.meta, transcriptWindow: data.window(Math.max(0, data.items.length - 120), data.items.length) }),
    getActiveChatId: () => active,
    getChat: id => id === "chat-a" || id === "chat-b" ? { ...data.meta.chat, id } : undefined,
    getTranscriptBefore: (_id, beforeId, amount = 40, offset) => { const found = data.items.findIndex(item => item.id === beforeId); const end = found >= 0 ? found : Math.min(data.items.length, offset); return data.window(Math.max(0, end - amount), end); },
    getTranscriptAfter: (_id, afterId, amount = 40, offset) => { const found = data.items.findIndex(item => item.id === afterId); const start = (found >= 0 ? found : offset) + 1; return data.window(start, Math.min(data.items.length, start + amount)); },
    getTurnTranscriptWindow: (_chatId, turnId, offset, count) => { const children = data.items.filter(item => item.turnId === turnId && item.kind !== "turn-run"); return { items: children.slice(offset, offset + count), totalCount: children.length, offset }; },
    exportChatHistory: () => ({ chats: [data.meta.chat], transcripts: { "chat-a": data.items } }),
    getChatHeaderMode: () => data.meta.chatHeaderMode
  }, { info() {}, warn() {} }, {
    ensureHistoryLoaded: async () => {},
    resolveAttachments: async value => value ?? [],
    sendPrompt: async (...args) => { calls.push(["send", ...args]); },
    steerTurn: async (...args) => { calls.push(["steer", ...args]); },
    queuePrompt: async (...args) => { calls.push(["queue", ...args]); return true; },
    cancelTurn: async id => { calls.push(["cancel", id]); data.meta.chat.status = "idle"; manager.postAllSnapshots(); },
    markReadToBottom() {},
    setChatHeaderMode: mode => { data.meta.chatHeaderMode = mode; manager.postAllSnapshots(); },
    resolveApproval: async (...args) => { calls.push(["approval", ...args]); data.meta.chat.pendingApproval = null; manager.postAllSnapshots(); },
    resolveUserInput: async (...args) => { calls.push(["userInput", ...args]); data.meta.pendingUserInput = null; data.meta.pendingUserInputs = []; manager.postAllSnapshots(); return true; },
    loadSkills: async () => [{ name: "test", path: "/test", displayName: "Test skill", enabled: true, description: "Skill", shortDescription: "Fixture", scope: "user", dependencyCount: 0 }],
    loadModels: async () => {},
    featureRequest: async (name, payload, chatId) => {
      calls.push([name, payload, chatId]);
      if (name === "history.search") return { ok: true, items: [{ chatId, itemId: "item-50", title: "Found result", excerpt: "History excerpt" }], nextOffset: null };
      if (name === "history.jump") return { ok: true, chatId, itemId: "item-50", index: 50, window: data.window(20, 100) };
      if (name === "history.migration.list") return { ok: true, items: [{ id: "legacy-1", chatCount: 2, updatedAt: "2026-09-08" }] };
      if (name === "project.actions") return { ok: true, items: [{ id: "check", label: "Проверить проект", available: true }, { id: "blocked", label: "Disabled", available: false, reason: "Unavailable" }] };
      if (name === "review.list") return { ok: true, items: [{ id: "review-1", path: "src/test.xbsl", revision: "hash-1", change: "modified", canStage: true, canRevert: true }] };
      if (name === "review.open") return { ok: true, review: { id: "review-1", path: "src/test.xbsl", revision: "hash-1", before: { text: "before" }, after: { text: "after" }, full: true }, opened: true };
      if (name === "browser.artifacts.list") return { ok: true, items: [{ id: "artifact-1", name: "Console", kind: "console", size: 20 }] };
      if (name === "browser.artifacts.open") return { ok: true, preview: { text: "Console ready" }, artifact: { name: "Console" } };
      return { ok: true };
    },
    startAttachmentUpload: async (_chatId, value) => ({ uploadId: value.uploadId }),
    appendAttachmentUpload: async value => { const total = (uploadedBytes.get(value.uploadId) ?? 0) + Buffer.from(value.data, "base64").length; uploadedBytes.set(value.uploadId, total); return { uploadId: value.uploadId, chatId: "chat-a", chunkIndex: value.chunkIndex, receivedBytes: total }; },
    completeAttachmentUpload: async value => ({ chatId: "chat-a", attachment: { id: value.uploadId, name: "upload.txt", kind: "file", path: "/upload.txt", displayPath: "upload.txt", source: "upload" } }),
    cancelAttachmentUpload: async () => {}, discardAttachment: async () => {}, openAttachment: async () => {}
  });
  const panel = { visible: true, webview: { postMessage: async value => { outbound.push(structuredClone(value)); await page.evaluate(value => window.postMessage(value, "*"), value); return true; } } };
  manager.panel = panel;
  await page.exposeBinding("hostMessage", async (_source, value) => {
    inbound.push(value);
    if (heldAcks && value.type === "chat.ack") return;
    await manager.handleMessage(panel, value);
  });
  await page.addInitScript(({ persisted }) => {
    window.fixtureState = persisted;
    window.acquireCount = 0;
    window.acquireVsCodeApi = () => {
      if (++window.acquireCount > 1) throw new Error("Double acquire");
      return { postMessage: value => void window.hostMessage(value), getState: () => window.fixtureState, setState: value => { window.fixtureState = structuredClone(value); } };
    };
    window.codexXbslHighlighter = { supports: language => ["xbsl", "yaml"].includes(language), highlight: async code => code.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]), cancel() {}, dispose() {} };
  }, { persisted });
  const cssTheme = dark ? "--vscode-editor-background:#202124;--vscode-editor-foreground:#e6e6e6;--vscode-editorWidget-background:#2b2d30;--vscode-input-background:#25272a;--vscode-panel-border:#46494d;--vscode-descriptionForeground:#b1b4b9;--vscode-list-hoverBackground:#35383d;" : "";
  const nonce = "fixture123";
  const inline = compiled.ui.replace(/<\/script/gi, "<\\/script");
  const html = `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; worker-src blob:"><style>${compiled.css}body{${cssTheme}}</style></head><body class="${dark ? "vscode-dark" : "vscode-light"}"><div id="root"></div>${fallback ? `<script nonce="${nonce}">window.__codexElementWebviewAssetMode='inline fallback';${inline}</script><script nonce="${nonce}" defer src="/prefix/chat.js"></script>` : `<script nonce="${nonce}" src="/prefix/chat.js"></script>`}</body></html>`;
  await page.route("**/*", async route => route.fulfill({ contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html", body: route.request().url().endsWith(".js") ? compiled.ui : html }));
  await page.goto("http://chat-fixture.invalid/prefix/index.html");
  await page.locator("[data-role=prompt-input]").waitFor();
  await page.waitForTimeout(250);
  return { data, manager, panel, inbound, outbound, calls, holdAcks: value => { heldAcks = value; },
    flush: async () => { data.meta.version++; manager.postAllSnapshots(); await page.waitForTimeout(100); },
    dispose: () => { clearTimeout(manager.flushTimer); clearTimeout(manager.ackTimer); manager.ready = false; manager.panel = undefined; } };
}
module.exports = { compile, createFixture, makeSnapshot };
