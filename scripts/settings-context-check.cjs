const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

async function main() {
  const artifacts = process.env.CODEX_TEST_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), "codex-settings-context-"));
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  try {
    for (const scenario of [{ width: 1280, height: 900 }, { width: 320, height: 844 }, { width: 900, height: 900, dark: true }, { width: 390, height: 844, dark: true }]) {
      const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => window.addEventListener("message", event => {
        if (event.data.type === "settings.snapshot") window.fixtureSnapshot = structuredClone(event.data.snapshot);
      }));
      await page.goto(pathToFileURL(path.join(__dirname, "settings-integrations-fixture.html")).href);
      if (scenario.dark) await page.evaluate(() => {
        const colors = { "editor-background": "#202020", "editor-foreground": "#ededed", foreground: "#ededed", descriptionForeground: "#aaa", "panel-border": "#424242", "sideBar-background": "#252525", "input-background": "#292929", "input-border": "#666", "input-foreground": "#ededed", "list-hoverBackground": "#343434", "list-inactiveSelectionBackground": "#393939", "list-inactiveSelectionForeground": "#ededed", "textLink-foreground": "#66b5ef", errorForeground: "#ff8980", "testing-iconPassed": "#64bc98" };
        for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty(`--vscode-${key}`, value);
      });
      const update = patch => page.evaluate(patch => {
        const snapshot = structuredClone(window.fixtureSnapshot);
        snapshot.experimentalContext = { ...snapshot.experimentalContext, ...patch };
        window.dispatchEvent(new MessageEvent("message", { data: { type: "settings.snapshot", snapshot } }));
      }, patch);
      const emit = (event, text, scope = "experimentalContext") => page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), { type: "event", event, payload: text, scope });
      const command = () => page.evaluate(() => window.fixtureMessages.at(-1));
      const input = page.locator("#experimental-context-enabled");
      assert(!(await page.evaluate(() => window.fixtureMessages.some(message => message.command?.startsWith("settings.experimentalContext")))), "opening other sections stays lazy");
      await update({ status: "idle", canChange: false });
      await page.locator('[data-settings-page="system"]').click();
      assert.equal((await command()).command, "settings.experimentalContext.refresh");
      assert(await input.isDisabled());
      await update({ status: "ready", canChange: true, scopeId: "scope-a", revision: "rev-a", eligible: true });
      await emit("settings.saved", "Проверка завершена.");
      assert(!(await input.isDisabled()));
      await input.check();
      assert.deepEqual((await command()).payload, { enabled: true, scopeId: "scope-a", revision: "rev-a" });
      assert(await input.isDisabled());
      assert(await input.isChecked());
      await emit("settings.saved", "Прокси сохранён.", "proxy");
      assert(await input.isDisabled(), "unrelated acknowledgement cannot complete context save");
      await emit("settings.error", "Дождитесь завершения всех ответов и повторите изменение настройки.");
      assert(!(await input.isChecked()), "failed save restores the confirmed preference");
      const feedback = page.locator('[data-feedback-scope="experimentalContext"]');
      assert.equal(await feedback.getAttribute("role"), "alert");
      assert.equal(await page.locator('[data-settings-page="system"] .settings-nav-error').count(), 1);
      await input.check();
      await update({ enabled: true, runtimeEnabled: true, revision: "rev-b", message: "Включено в настройках. Доступность для выбранной модели проверяет app-server при запуске диалога." });
      await emit("settings.saved", "Режим контекста сохранён и применён к app-server.");
      assert(await input.isChecked());
      assert(!(await input.isDisabled()));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const overflow = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Управление контекстом"] *')].filter(node => node.getClientRects().length && !node.matches("input, svg, svg *")).flatMap(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1 ? [node.id || node.className || node.tagName] : [];
      }));
      assert.deepEqual(overflow, [], "context controls and text fit");
      await page.screenshot({ path: path.join(artifacts, `context-${scenario.width}-${scenario.dark ? "dark" : "light"}.png`) });
      await update({ enabled: false, eligible: false, canChange: false, message: "Для этого режима нужен вход через ChatGPT с подпиской Plus, Pro или Pro Lite." });
      assert(await input.isDisabled());
      await update({ status: "unsupported", message: "Встроенный app-server не поддерживает экспериментальный контекст. Обновите плагин." });
      assert(await input.isDisabled());
      assert(!(await page.locator("#refresh-experimental-context").isDisabled()));
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`PASS: context settings lazy read, toggle/save/rollback, scoped errors and responsive light/dark UI. Screenshots: ${artifacts}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
