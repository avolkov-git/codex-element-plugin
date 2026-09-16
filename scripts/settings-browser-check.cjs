const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { loadSource, root, vscode: vscodeMock } = require("../tests/service-test-utils.cjs");

const fixture = pathToFileURL(path.join(__dirname, "settings-integrations-fixture.html")).href;
const darkTokens = {
  "editor-background": "#202020", "editor-foreground": "#ededed", foreground: "#ededed",
  descriptionForeground: "#aaa", "input-background": "#292929", "input-foreground": "#ededed",
  "input-border": "#666", "panel-border": "#424242", "sideBar-background": "#252525",
  "list-hoverBackground": "#343434", "list-inactiveSelectionBackground": "#393939",
  "list-inactiveSelectionForeground": "#ededed", "textLink-foreground": "#66b5ef",
  "button-background": "#1175b7", "button-hoverBackground": "#0b659f", errorForeground: "#ff8980",
  "testing-iconPassed": "#64bc98", "editorWarning-foreground": "#e3b563"
};

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function lastCommand(page, command) {
  const value = await page.evaluate(() => JSON.parse(document.documentElement.dataset.lastFixtureMessage));
  assert.equal(value.command, command);
  return value.payload;
}

async function fits(page, label) {
  const failures = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("button, .section-feedback, .editor-feedback, .browser-test-result, .integration-title-line, .integration-description, .settings-data-row, .settings-header")];
    return nodes.filter(node => node.getClientRects().length && !node.closest('[aria-hidden="true"]') && node.getAttribute("tabindex") !== "-1").flatMap(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1 ? [`${node.id || node.className}: ${Math.round(rect.left)}..${Math.round(rect.right)}, ${node.scrollWidth}/${node.clientWidth}`] : [];
    });
  });
  assert.deepEqual(failures, [], `${label}: text and controls fit`);
}

async function runScenario(browser, scenario, artifacts) {
  const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.addEventListener("message", event => {
      if (event.data.type === "settings.snapshot") window.fixtureSnapshot = structuredClone(event.data.snapshot);
    });
  });
  await page.goto(fixture);
  if (scenario.dark) await page.evaluate(tokens => {
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--vscode-${name}`, value);
  }, darkTokens);
  const emit = (event, payload, scope) => page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), { type: "event", event, payload, scope });
  const update = patch => page.evaluate(patch => {
    const snapshot = structuredClone(window.fixtureSnapshot);
    for (const [key, value] of Object.entries(patch)) snapshot[key] = typeof value === "object" && value !== null ? { ...snapshot[key], ...value } : value;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "settings.snapshot", snapshot } }));
  }, patch);
  const nav = async name => { await page.locator(`[data-settings-page="${name}"]`).click(); await settle(page); };
  const shot = async suffix => { await settle(page); await fits(page, suffix); await page.screenshot({ path: path.join(artifacts, `settings-${scenario.width}-${scenario.dark ? "dark" : "light"}-${suffix}.png`) }); };

  await page.locator("#test-browser").waitFor();
  assert.equal(await page.locator("#browser-base-url, #browser-origins, .browser-boundary-note").count(), 0);
  assert.equal(await page.locator(".settings-nav-button").count(), 5);
  assert.equal(await page.locator(".settings-brand svg").count(), 1);
  assert.equal(await page.locator(".settings-nav-button svg").count(), 5);
  assert.equal(await page.locator("[data-mcp-row]").count(), 2, "managed browser is not duplicated among MCP servers");
  assert.match(await page.locator(".browser-section").innerText(), /Тестовое приложение/);
  assert.equal((await page.locator(".settings-version").innerText()).trim(), require("../package.json").version);
  await shot("tools");

  // Autosave has one owner; unrelated acknowledgements must not unlock it.
  await page.locator("#browser-enabled").uncheck();
  assert.deepEqual(await lastCommand(page, "settings.browser.save"), { enabled: false, disableSandbox: false });
  assert(await page.locator("#browser-enabled").isDisabled());
  await emit("settings.saved", "Прокси сохранён.", "proxy");
  assert(await page.locator("#browser-enabled").isDisabled());
  await page.locator(".settings-main").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await emit("settings.error", "Console не вернула адрес приложения. Повторите проверку.", "browser");
  await settle(page);
  const browserFeedback = page.locator('[data-feedback-scope="browser"]');
  assert.equal(await browserFeedback.getAttribute("role"), "alert");
  assert(!await page.locator("#browser-enabled").isChecked());
  assert(!await page.locator("#save-browser").isDisabled());
  const bounds = await browserFeedback.boundingBox();
  assert(bounds.y >= 0 && bounds.y + bounds.height <= scenario.height + 1, "error remains visible at its action");
  await update({ browser: { application: { status: "ready", url: "http://element.internal:9090/applications/new/", name: "Новое приложение того же проекта" } } });
  assert(!await page.locator("#browser-enabled").isChecked(), "snapshot preserves browser draft");
  await page.locator("#save-browser").click();
  await emit("settings.saved", "Браузерное тестирование выключено.", "browser");
  await page.locator("#test-browser").click();
  await lastCommand(page, "settings.browser.test");
  await emit("settings.browser.test.result", { status: "failed", message: "Не удалось запустить Chromium.", details: "Проверьте доступ к исполняемому файлу и права пользователя службы Element." });
  assert.match(await page.locator(".browser-test-result").innerText(), /Не удалось запустить Chromium/);
  await shot("browser-error");

  await page.locator("#open-browser-settings").click();
  await page.locator("#browser-disable-sandbox").check();
  await update({ browser: { application: { status: "error", url: "", name: "", message: "Приложение IDE не выбрано." } } });
  assert(await page.locator("#browser-disable-sandbox").isChecked());
  await page.locator("#save-browser").click();
  assert.deepEqual(await lastCommand(page, "settings.browser.save"), { enabled: false, disableSandbox: true });
  await emit("settings.saved", "Параметры браузера сохранены.", "browser");
  await page.locator("#close-settings-drawer").click();
  await page.locator("#refresh-browser-application").click();
  await lastCommand(page, "settings.browser.application.refresh");
  assert.equal(await page.locator("#refresh-browser-application").count(), 0);
  await update({ browser: { enabled: false, disableSandbox: true, application: { status: "ready", url: "http://element.internal:9090/applications/new/", name: "Новое приложение" } } });

  // HTTP/stdio drafts survive transport changes and backend refreshes.
  await page.locator("#add-mcp").click();
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), "mcp-name");
  await page.locator("#save-mcp").click();
  assert.match(await page.locator('[data-feedback-scope="mcp-editor"]').innerText(), /Укажите имя/);
  await page.locator("#mcp-name").fill("my server");
  await page.locator("#mcp-url").fill("http://127.0.0.1:9901/mcp");
  await page.locator("#mcp-bearer-env").fill("ELEMENT_TOKEN");
  await page.locator("#mcp-transport").selectOption("stdio");
  await page.locator("#mcp-command").fill("node");
  await page.locator("#mcp-args").fill("server.js\n--stdio");
  await page.locator("#mcp-transport").selectOption("http");
  assert.equal(await page.locator("#mcp-url").inputValue(), "http://127.0.0.1:9901/mcp");
  await update({ integrations: { updatedAt: new Date().toISOString() } });
  assert.equal(await page.locator("#mcp-bearer-env").inputValue(), "ELEMENT_TOKEN");
  await page.locator("#save-mcp").click();
  const server = await lastCommand(page, "settings.mcp.save");
  assert.equal(server.name, "my-server");
  assert.equal(server.url, "http://127.0.0.1:9901/mcp");
  assert(await page.locator("#save-mcp").isDisabled());
  await emit("settings.mcp.error", "Не удалось записать конфигурацию сервера.");
  assert.equal(await page.locator("#mcp-name").inputValue(), "my-server");
  await shot("mcp-error");
  await page.locator("#save-mcp").click();
  await emit("settings.mcp.saved", "MCP-сервер сохранён.");
  assert.equal(await page.locator(".settings-drawer").count(), 0);
  await page.locator('[data-mcp-edit="element-docs"]').click();
  await page.locator("#mcp-url").fill("http://127.0.0.1:9910/mcp");
  await page.locator("#close-settings-drawer").click();
  await page.locator('[data-mcp-toggle="element-docs"]').uncheck();
  await lastCommand(page, "settings.mcp.toggle");
  const disabledServers = await page.evaluate(() => window.fixtureSnapshot.integrations.mcpServers.map(server => server.name === "element-docs" ? { ...server, enabled: false } : server));
  await update({ integrations: { mcpServers: disabledServers } });
  await page.locator('[data-mcp-edit="element-docs"]').click();
  assert.equal(await page.locator("#mcp-url").inputValue(), "http://127.0.0.1:9910/mcp");
  await page.locator("#save-mcp").click();
  assert.equal((await lastCommand(page, "settings.mcp.save")).enabled, false, "saved editor draft cannot re-enable a server disabled in the list");
  await emit("settings.mcp.saved", "MCP-сервер сохранён.");
  await page.locator('[data-mcp-edit="element-docs"]').click();
  await page.locator('[data-mcp-delete="element-docs"]').click();
  assert.deepEqual(await lastCommand(page, "settings.mcp.delete"), { name: "element-docs" });
  await emit("settings.mcp.deleted", { name: "element-docs" });
  assert.equal(await page.locator(".settings-drawer").count(), 0);

  // A failed refresh is retryable, and its error belongs to the active scope.
  await nav("skills");
  assert.equal(await page.locator(".skill-row").count(), 18);
  await page.locator("#skills-search").fill("Analytics");
  assert.equal(await page.locator(".skill-row").count(), 1);
  await page.locator("#skills-search").fill("");
  await page.locator("#skills-source").selectOption("repo");
  assert.equal(await page.locator(".skill-row").count(), 3);
  await page.locator("#skills-source").selectOption("all");
  await page.locator("#skills-enabled").selectOption("disabled");
  assert.equal(await page.locator(".skill-row").count(), 5);
  await page.locator(".skill-row [data-skill-toggle]").first().check();
  assert.equal((await lastCommand(page, "settings.skill.toggle")).enabled, true);
  await page.locator("#skills-enabled").selectOption("all");
  await page.locator("#refresh-skills").click();
  assert.deepEqual(await lastCommand(page, "settings.integrations.refresh"), { scope: "skills" });
  await update({ integrations: { status: "loading", mcpStatus: "loading", skillsStatus: "loading" } });
  await emit("settings.error", "Не удалось обновить навыки.", "skills");
  assert(!await page.locator("#refresh-skills").isDisabled());
  await shot("skills");
  await update({ integrations: { status: "ready", mcpStatus: "ready", skillsStatus: "ready" } });

  // Secret drafts stay in memory, not webview persistence, and retain caret/focus.
  await nav("connection");
  await page.locator("#proxy-url").fill("http://proxy.example:8080");
  await page.locator("#proxy-username").fill("developer");
  await page.locator("#proxy-password").fill("private-test-draft");
  await update({ integrations: { updatedAt: new Date().toISOString() } });
  await settle(page);
  assert.equal(await page.locator("#proxy-password").inputValue(), "private-test-draft");
  assert.equal(await page.evaluate(() => document.activeElement.id), "proxy-password");
  await nav("docs");
  await page.locator("#docs-normalized-path").fill("F:\\docs\\ai-docs");
  await nav("connection");
  assert.equal(await page.locator("#proxy-password").inputValue(), "private-test-draft");
  const persisted = await page.evaluate(() => window.acquireVsCodeApi().getState());
  assert.deepEqual(persisted, { activePage: "connection" });
  await page.locator("#save-proxy").click();
  assert.equal((await lastCommand(page, "settings.proxy.save")).password, "private-test-draft");
  await emit("settings.saved", "Прокси сохранён.", "proxy");
  assert.equal(await page.locator("#proxy-password").inputValue(), "");
  await shot("connection");

  await nav("docs");
  assert.equal(await page.locator("#docs-normalized-path").inputValue(), "F:\\docs\\ai-docs");
  await page.locator("#normalize-docs").click();
  await lastCommand(page, "settings.docs.normalize");
  await emit("settings.docs.normalize.progress", { status: "idle", stage: "cancelled", percent: 0, message: "Нормализация отменена." });
  await emit("settings.saved", "Нормализация отменена.", "docs");
  assert(!await page.locator("#normalize-docs").isDisabled());
  await page.locator("#open-base-context").click();
  await lastCommand(page, "settings.docs.baseContext.read");
  await emit("settings.docs.baseContext.loaded", { text: "# Общие правила\nИсходный контекст", revision: "revision-a", sourcePath: "F:\\plugins\\codex-element\\resources\\context\\codex-element-language-rules.md" });
  await page.locator("#base-context-text").fill("# Общие правила\nОбновлённый контекст");
  await update({ integrations: { updatedAt: new Date().toISOString() } });
  assert.match(await page.locator("#base-context-text").inputValue(), /Обновлённый/);
  await page.locator("#save-base-context").click();
  assert.deepEqual(await lastCommand(page, "settings.docs.baseContext.save"), { text: "# Общие правила\nОбновлённый контекст", revision: "revision-a" });
  await emit("settings.docs.baseContext.error", "Файл изменён в IDE. Перечитайте его перед сохранением.");
  assert.match(await page.locator('[data-feedback-scope="context"]').innerText(), /изменён/);
  assert(!await page.locator("#reload-base-context").isDisabled());
  await page.locator("#reload-base-context").click();
  await shot("context");
  await page.locator("#cancel-reload-base-context").click();
  assert.match(await page.locator("#base-context-text").inputValue(), /Обновлённый/);
  await page.locator("#reload-base-context").click();
  await page.locator("#confirm-reload-base-context").click();
  await lastCommand(page, "settings.docs.baseContext.read");
  await emit("settings.docs.baseContext.error", "Не удалось прочитать файл.");
  assert.match(await page.locator("#base-context-text").inputValue(), /Обновлённый/, "failed reload preserves the draft");
  await page.locator("#reload-base-context").click();
  await page.locator("#confirm-reload-base-context").click();
  await emit("settings.docs.baseContext.loaded", { text: "Актуальный файл", revision: "revision-b", sourcePath: "F:\\plugins\\codex-element\\resources\\context\\codex-element-language-rules.md" });
  await page.locator("#base-context-text").fill("Актуальный файл с правками");
  await page.locator("#save-base-context").click();
  assert.equal((await lastCommand(page, "settings.docs.baseContext.save")).revision, "revision-b");
  await emit("settings.docs.baseContext.saved", { revision: "revision-c", message: "Базовый контекст сохранён." });
  await page.locator("#close-settings-drawer").click();
  await shot("docs");

  await nav("system");
  assert.match(await page.locator(".system-components").innerText(), /0\.154\.0/);
  await shot("system");
  await page.locator("#open-ripgrep").click();
  await page.locator("#tools-ripgrep-path").fill("F:\\tools\\rg.exe");
  await page.locator("#close-settings-drawer").click();
  await page.locator("#open-ripgrep").click();
  assert.equal(await page.locator("#tools-ripgrep-path").inputValue(), "F:\\tools\\rg.exe");
  await page.locator("#save-ripgrep").click();
  assert.deepEqual(await lastCommand(page, "settings.tools.ripgrep.save"), { ripgrepPath: "F:\\tools\\rg.exe" });
  await emit("settings.error", "Файл ripgrep не найден.", "tools");
  await settle(page);
  assert.match(await page.locator('.settings-drawer-footer [role="alert"]').innerText(), /не найден/);
  await page.locator("#close-settings-drawer").click();
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), "open-ripgrep");
  await page.locator("#open-ripgrep").click();
  await page.locator("#close-settings-drawer").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "install-ripgrep");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-drawer").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
}

async function checkWebviewAssets(browser, fallback) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const { renderWebviewHtml } = loadSource("src/webviewHtml.ts", { vscode: vscodeMock });
  const html = renderWebviewHtml({
    extensionUri: { fsPath: root },
    webview: { cspSource: "http://settings.fixture", asWebviewUri: uri => new URL(`http://settings.fixture/${path.relative(root, uri.fsPath).split(path.sep).join("/")}`) },
    scriptPath: "media/settings.js", preloadScriptPaths: ["media/settings-icons.js"], stylePath: "media/settings.css", title: "Настройки"
  });
  await page.addInitScript(() => {
    window.fixtureMessages = [];
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState: () => {},
      postMessage(message) {
        window.fixtureMessages.push(message);
        if (message.type === "ready") queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "settings.snapshot", snapshot: { extensionVersion: "1.0.3" } } })));
      }
    });
  });
  const assets = new Set(["/media/settings.js", "/media/settings-icons.js", "/media/settings.css"]);
  await page.route("http://settings.fixture/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") return route.fulfill({ body: html, contentType: "text/html" });
    if (fallback === true || (fallback === "icons" && pathname.endsWith("settings-icons.js")) || !assets.has(pathname)) return route.abort();
    return route.fulfill({ body: await fs.readFile(path.join(root, pathname)), contentType: pathname.endsWith(".css") ? "text/css" : "text/javascript" });
  });
  await page.goto("http://settings.fixture/");
  await page.locator("#test-browser").waitFor();
  assert.equal(await page.locator(".settings-brand svg").count(), 1);
  assert.equal(await page.locator(".settings-nav-button svg").count(), 5);
  assert.equal(await page.locator(".settings-workspace").evaluate(node => getComputedStyle(node).display), "grid");
  const ready = await page.evaluate(() => window.fixtureMessages.filter(message => message.type === "ready"));
  assert.equal(ready.length, 1, "webview mounts once");
  assert.equal(ready[0].assetMode, fallback ? "inline fallback" : "external");
  assert.deepEqual(errors, [], "production HTML runs under its CSP with no external dependencies");
  await page.close();
}

async function main() {
  const artifacts = process.env.CODEX_TEST_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), "codex-settings-browser-"));
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  try {
    for (const scenario of [{ width: 1280, height: 900 }, { width: 1024, height: 820 }, { width: 390, height: 844 }, { width: 900, height: 900, dark: true }]) await runScenario(browser, scenario, artifacts);
    await checkWebviewAssets(browser, false);
    await checkWebviewAssets(browser, true);
    await checkWebviewAssets(browser, "icons");
    console.log(`PASS: settings navigation, drawers, persistence, scoped actions/errors, filters and responsive light/dark UI. Screenshots: ${artifacts}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
