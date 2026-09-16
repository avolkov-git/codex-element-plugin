const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { compile, createFixture } = require("./chat-ui-fixture.cjs");

async function main() {
  const compiled = await compile();
  const artifacts = process.env.CODEX_TEST_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-design-"));
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  const results = [];
  try {
    for (const scenario of [{ width: 1440, height: 1000, dark: false }, { width: 900, height: 800, dark: false }, { width: 390, height: 844, dark: false }, { width: 1200, height: 900, dark: true }]) {
      const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      const f = await createFixture(page, compiled, { count: 4, dark: scenario.dark });
      const name = `${scenario.dark ? "dark" : "light"}-${scenario.width}`;
      try {
        Object.assign(f.data.meta.chat, { title: "Проверка MCP", status: "idle", accessMode: "danger-full-access", modelId: "gpt-6-astra", modelLabel: "GPT-6-Astra", effort: "max" });
        f.data.meta.modelOptions = [{ id: "gpt-6-astra", label: "GPT-6-Astra", supportedEfforts: [{ value: "high" }, { value: "max" }] }, { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", supportedEfforts: [{ value: "high" }] }];
        const createdAt = "2026-09-09T10:00:00.000Z";
        const complete = { kind: "message", status: "complete", createdAt };
        f.data.items.splice(0, 4,
          { ...complete, id: "item-0", role: "user", text: "Проверь подключение MCP и покажи пример на языке 1С:Элемент." },
          { kind: "turn-run", id: "item-1", turnId: "turn-example", status: "completed", createdAt, completedAt: "2026-09-09T10:00:17.000Z", counts: {}, activityIds: [], worklogIds: [], diffIds: [], compactionIds: [] },
          { ...complete, id: "item-2", role: "assistant", text: "Подключение проверено. Сервер доступен, инструменты загружены.\n\n```xbsl\nметод ПолучитьПриветствие(Имя: Строка): Строка\n    возврат \"Привет, \" + Имя\n;\n```\n\nНастройки проекта и документация доступны в правой панели." },
          { ...complete, id: "item-3", role: "assistant", text: "Следующий шаг: проверить вызов инструмента на тестовом приложении." });
        await f.flush();
        await page.waitForTimeout(150);
        const geometry = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          const style = selector => getComputedStyle(document.querySelector(selector));
          const h = rect(".header"), n = rect(".chat-navigation"), c = rect(".composer"), options = rect(".composer-options"), tools = rect(".composer-tools"), bubble = rect(".user-bubble"), user = rect(".message-user");
          return { header: h, nav: n, composer: c, options, tools, bubble, user, toggle: rect(".header-toggle"), send: rect(".composer-send"),
            titleFont: style(".compact-title-line").fontSize, assistantFont: style(".message-assistant").fontSize,
            userBackground: style(".user-bubble").backgroundColor, scrollbar: style(".body").scrollbarWidth,
            overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.equal(geometry.titleFont, "11px", "master compact title retained");
        assert.equal(geometry.assistantFont, "15px", "master assistant type retained");
        assert.equal(geometry.scrollbar, "none", "incumbent hidden scrollbar retained");
        assert.equal(geometry.overflow, false);
        for (const key of ["header", "composer", "toggle", "send", "bubble"]) assert.ok(geometry[key].left >= 0 && geometry[key].right <= scenario.width, `${key} is not clipped by the webview`);
        assert.ok(geometry.nav.top >= geometry.header.top && geometry.nav.bottom <= geometry.header.bottom, "all new actions are inside the old header");
        assert.ok(geometry.nav.left >= 12 && geometry.nav.right <= scenario.width - 12);
        assert.ok(geometry.options.top >= geometry.composer.top && geometry.options.bottom <= geometry.composer.bottom, "model/options remain inside composer");
        assert.ok(geometry.tools.top >= geometry.composer.top && geometry.tools.bottom <= geometry.composer.bottom);
        assert.ok(Math.abs(geometry.bubble.right - geometry.user.right) <= 1, "user bubble aligned right");
        assert.ok(geometry.bubble.width <= geometry.user.width * .82 + 1, "master bubble width retained");
        if (!scenario.dark) assert.equal(geometry.userBackground, "rgb(243, 243, 245)");
        assert.equal(await page.locator(".message-meta").count(), 0, "no new role/time row above each reply");
        assert.equal(await page.locator(".header .chat-navigation button").count(), 6);
        await page.screenshot({ path: path.join(artifacts, `${name}-chat.png`) });

        for (const label of ["Модель", "Режим доступа", "Интеллект", "Скорость"]) {
          const trigger = page.getByRole("combobox", { name: label, exact: true });
          await trigger.click();
          const popup = page.getByRole("dialog", { name: label, exact: true });
          await popup.waitFor();
          const bounds = await popup.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= scenario.width && bounds.y + bounds.height <= scenario.height, `${label} fits viewport`);
          if (label === "Модель") {
            await page.screenshot({ path: path.join(artifacts, `${name}-models.png`) });
            await page.keyboard.press("ArrowDown");
            assert.match(await page.evaluate(() => document.activeElement.textContent), /Spark/);
          }
          await page.keyboard.press("Escape");
          assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "menu returns keyboard focus");
        }
        await page.getByRole("button", { name: "Навыки", exact: true }).click();
        await page.getByRole("dialog", { name: "Навыки", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Прикрепить файл", exact: true }).click();
        await page.getByRole("button", { name: "С компьютера", exact: true }).waitFor();
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Контекст проекта", exact: true }).click();
        await page.getByRole("complementary", { name: "Контекст", exact: true }).waitFor();
        if (scenario.width > 680) {
          const transcript = await page.locator(".transcript-region").boundingBox();
          const panel = await page.locator(".feature-panel").boundingBox();
          assert.ok(Math.abs(transcript.x + transcript.width - panel.x) <= 1, "feature panel stays on the right");
        }
        await page.screenshot({ path: path.join(artifacts, `${name}-context.png`) });
        await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
        f.data.meta.chat.status = "running"; await f.flush();
        assert.equal(await page.getByRole("button", { name: "Добавить в очередь", exact: true }).count(), 0, "empty running composer shows stop only");
        await page.getByRole("textbox", { name: "Сообщение Codex" }).fill("Уточнение для текущего запроса");
        await page.getByRole("button", { name: "Выбрать способ отправки", exact: true }).click();
        await page.getByRole("button", { name: "Направить текущий запрос", exact: true }).click();
        assert.ok(f.calls.some(call => call[0] === "steer"), "recommendation still uses React bridge");
        await page.getByRole("textbox", { name: "Сообщение Codex" }).fill("Следующая задача");
        await page.getByRole("button", { name: "Добавить в очередь", exact: true }).click();
        assert.ok(f.calls.some(call => call[0] === "queue"), "queue still uses React bridge");
        await page.getByRole("button", { name: "Развернуть заголовок", exact: true }).click();
        await page.locator(".header-expanded").waitFor();
        assert.match(await page.locator(".header .meta").innerText(), /Учётная запись/);
        await page.screenshot({ path: path.join(artifacts, `${name}-expanded.png`) });
        assert.deepEqual(errors, []);
        results.push({ name, headerHeight: geometry.header.height, ok: true });
      } finally { f.dispose(); await page.close(); }
    }
    console.log(JSON.stringify({ ok: true, results, artifacts }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
