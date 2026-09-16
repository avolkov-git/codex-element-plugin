const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { chromium } = require("playwright");
const { compile, createFixture } = require("./chat-ui-fixture.cjs");

async function main() {
  const compiled = await compile();
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  const artifacts = process.env.CODEX_TEST_ARTIFACTS ? path.resolve(process.env.CODEX_TEST_ARTIFACTS) : await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-ui-"));
  await fs.mkdir(artifacts, { recursive: true });
  const metrics = [];
  try {
    for (const count of [1000, 10000]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      const f = await createFixture(page, compiled, { count, fallback: count === 10000 });
      try {
        assert.equal(await page.evaluate(() => window.acquireCount), 1, "late external bundle mounts once");
        assert.ok(await page.locator(".virtual-row").count() < 80, "DOM bounded independently of history length");
        await page.locator("[data-role=prompt-input]").fill("A draft that must survive updates");
        await page.evaluate(() => {
          window.originalScroller = document.querySelector("[data-role=transcript]");
          window.originalComposer = document.querySelector("[data-role=prompt-input]");
          window.originalScroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
          window.originalScroller.scrollTop -= 2200;
        });
        await page.waitForTimeout(350);
        const before = await page.evaluate(() => {
          const scroller = window.originalScroller;
          const node = Array.from(scroller.querySelectorAll(".message .markdown p")).find(node => node.getBoundingClientRect().top > scroller.getBoundingClientRect().top + 10);
          if (!node) throw new Error("No selectable paragraph");
          window.anchorNode = node; window.anchorY = node.getBoundingClientRect().top;
          const range = document.createRange(); range.selectNodeContents(node);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          return { selection: selection.toString(), y: window.anchorY, top: scroller.scrollTop };
        });
        const framesBefore = f.outbound.length;
        for (let index = 0; index < 25; index++) { f.data.items[count - 1].text += ` token-${index}`; await f.flush(); }
        f.data.items[count - 1].status = "complete"; f.data.meta.chat.status = "idle"; await f.flush();
        const after = await page.evaluate(() => ({
          sameScroller: window.originalScroller === document.querySelector("[data-role=transcript]"), sameComposer: window.originalComposer === document.querySelector("[data-role=prompt-input]"),
          selection: getSelection().toString(), y: window.anchorNode.getBoundingClientRect().top,
          draft: window.originalComposer.value, count: document.querySelectorAll(".virtual-row").length
        }));
        assert.equal(after.sameScroller, true); assert.equal(after.sameComposer, true);
        assert.equal(after.selection, before.selection, "selection preserved during offscreen streaming");
        assert.ok(Math.abs(after.y - before.y) <= 2, `anchor drift: ${after.y - before.y}px`);
        assert.equal(after.draft, "A draft that must survive updates");
        const patches = f.outbound.slice(framesBefore).filter(frame => frame.type === "chat.bridge");
        assert.ok(patches.some(frame => frame.appends.length), "text delta patches used");
        assert.ok(patches.filter(frame => frame.appends.length).every(frame => frame.meta === undefined), "no full metadata on token patches");
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.getByRole("button", { name: "К последнему сообщению", exact: true }).click();
        await page.waitForTimeout(300);
        assert.match(await page.locator(`[data-item-id='item-${count - 1}']`).innerText(), /token-24/, "tail is fresh after browsing history");
        const initial = f.outbound.filter(value => value.type === "chat.bridge").length;
        for (let index = 0; index < 50; index++) f.manager.postAllSnapshots();
        await page.waitForTimeout(120);
        assert.equal(f.outbound.filter(value => value.type === "chat.bridge").length, initial, "identical snapshots deduplicated");
        f.holdAcks(true); f.data.items[count - 1].text += " pending"; await f.flush();
        const held = f.outbound.length;
        for (let index = 0; index < 100; index++) { f.data.items[count - 1].text += "."; f.manager.postAllSnapshots(); }
        await page.waitForTimeout(180); assert.equal(f.outbound.length, held, "one unacked frame bounds backpressure");
        f.holdAcks(false);
        await f.manager.handleMessage(f.panel, { type: "chat.ack", chatId: "chat-a", epoch: f.manager.epoch, revision: f.manager.revision });
        await page.waitForTimeout(120);
        const epoch = f.manager.epoch;
        await f.manager.handleMessage(f.panel, { type: "chat.visibility", visible: false });
        const hiddenFrames = f.outbound.length; f.data.items[count - 1].text += " hidden"; await f.flush();
        assert.equal(f.outbound.length, hiddenFrames, "hidden panels do not consume patches");
        await f.manager.handleMessage(f.panel, { type: "chat.visibility", visible: true }); await page.waitForTimeout(150);
        assert.notEqual(f.manager.epoch, epoch, "resume starts fresh epoch");
        await f.manager.handleMessage(f.panel, { type: "command", chatId: "chat-b", command: "chat.send", payload: { prompt: "From other chat" } });
        assert.ok(f.calls.some(call => call[0] === "send" && call[1] === "chat-b"), "commands retain origin chat id");
        metrics.push({ count, renderedRows: after.count, anchorDriftPx: after.y - before.y, patchCount: patches.length, maxAppendBytes: Math.max(...patches.filter(frame => frame.appends.length).map(frame => JSON.stringify(frame).length)) });
        await page.screenshot({ path: path.join(artifacts, `history-${count}.png`) });
        assert.deepEqual(errors, []);
      } finally { f.dispose(); await page.close(); }
    }

    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const f = await createFixture(page, compiled, { count: 60 });
    try {
      const input = page.getByRole("textbox", { name: "Сообщение Codex" });
      await input.fill("Preserved draft"); await input.focus();
      f.data.meta.chat.pendingApproval = { id: "approve-1", title: "Run command?", description: "Review command", command: "pwd", payloadPreview: "", kind: "command", method: "exec" }; await f.flush();
      assert.equal(await page.evaluate(() => document.querySelector("dialog").contains(document.activeElement) && document.querySelector(".app").inert), true);
      for (let index = 0; index < 10; index++) await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.querySelector("dialog").contains(document.activeElement)), true);
      await page.getByRole("button", { name: "Разрешить", exact: true }).click(); await page.waitForTimeout(150);
      assert.equal(await input.evaluate(node => node === document.activeElement), true, "focus restored to composer");
      f.data.meta.pendingUserInput = { id: "native-1", requestId: 42, chatId: "chat-a", threadId: "thread-a", turnId: "turn-a", itemId: "native-item", isBlocking: true, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), questions: [
        { id: "choice", header: "Choice", question: "Which environment?", isOther: true, isSecret: false, options: [{ label: "Staging", description: "Test environment" }, { label: "Production", description: "Live" }] },
        { id: "secret", header: "Token", question: "Temporary token", isOther: false, isSecret: true, options: null }
      ] };
      f.data.meta.pendingUserInputs = [f.data.meta.pendingUserInput];
      await input.evaluate(node => { window.nativeQuestionComposer = node; });
      await f.flush();
      const nativeQuestions = page.locator('.inline-questions[data-request-id="native-1"]');
      await nativeQuestions.waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0, "native questions are inline, not modal");
      assert.equal(await page.evaluate(() => document.querySelector(".app").inert), false);
      assert.equal(await input.evaluate(node => node === window.nativeQuestionComposer && node === document.activeElement), true, "inline questions do not replace or steal focus from the composer");
      const staging = nativeQuestions.getByRole("button", { name: "Staging", exact: false });
      await staging.click();
      assert.equal(await staging.getAttribute("aria-pressed"), "true");
      assert.equal(f.calls.filter(call => call[0] === "userInput").length, 0, "a multi-question choice waits for the grouped submit");
      assert.equal(await nativeQuestions.getByRole("button", { name: "Ответить", exact: true }).isDisabled(), true);
      await nativeQuestions.getByLabel("Token: ответ", { exact: true }).fill("fixture-secret-value");
      assert.equal(await nativeQuestions.getByLabel("Token: ответ", { exact: true }).getAttribute("type"), "password");
      assert.ok(!(await page.evaluate(() => JSON.stringify(window.fixtureState))).includes("fixture-secret-value"), "native secrets never persisted");
      await nativeQuestions.getByRole("button", { name: "Ответить", exact: true }).click(); await page.waitForTimeout(150);
      const native = f.calls.find(call => call[0] === "userInput");
      assert.deepEqual(native.slice(1), ["chat-a", "native-1", { answers: { choice: { answers: ["Staging"] }, secret: { answers: ["fixture-secret-value"] } } }]);
      assert.equal(await input.inputValue(), "Preserved draft");
      await page.locator("input[type=file]").setInputFiles({ name: "large-upload.txt", mimeType: "text/plain", buffer: Buffer.alloc(1200000, 97) });
      await page.getByRole("button", { name: "Удалить upload.txt", exact: true }).waitFor();
      const chunks = f.inbound.filter(value => value.command === "chat.attachment.upload.chunk");
      assert.equal(chunks.length, 3, "upload is chunked with one ACK before next chunk");
      assert.deepEqual(chunks.map(value => value.payload.chunkIndex), [0, 1, 2]);
      await page.getByRole("button", { name: "Удалить upload.txt", exact: true }).click();
      await input.evaluate(node => {
        const transfer = new DataTransfer(); transfer.items.add(new File(["pasted"], "pasted.png", { type: "image/png" }));
        node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
      });
      await page.getByRole("button", { name: "Удалить upload.txt", exact: true }).waitFor();
      f.data.items[59].text += "\n\n[Open file](/workspace/src/test.xbsl:12) [Unsafe](javascript:alert(1))"; await f.flush(); await page.waitForTimeout(200);
      await page.getByRole("link", { name: "Open file" }).click();
      assert.ok(f.inbound.some(value => value.command === "markdown.openLink" && value.payload.target === "/workspace/src/test.xbsl:12"));
      assert.equal(await page.locator("a[href^='javascript:']").count(), 0);
      await page.locator("[data-item-id='item-59']").getByRole("button", { name: "Копировать сообщение" }).click();
      assert.ok(compiled.clipboard.some(text => text.includes("Open file")), "HTTP clipboard uses host API");
      await page.getByRole("button", { name: "Добавить в очередь", exact: true }).click();
      assert.ok(f.calls.some(call => call[0] === "queue" && call[2] === "Preserved draft"));
      await page.getByRole("button", { name: "Поиск по истории", exact: true }).click();
      await page.getByText("Found result", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Перейти к сообщению" }).click(); await page.waitForTimeout(180);
      assert.ok(f.calls.some(call => call[0] === "history.jump"));
      await page.getByRole("button", { name: "Перенос истории", exact: true }).click();
      await page.getByRole("button", { name: "Перенести историю", exact: true }).click();
      assert.ok(f.calls.some(call => call[0] === "history.migration.import" && call[1].id === "legacy-1"));
      await page.getByRole("button", { name: "Проверить изменения", exact: true }).click();
      await page.getByRole("button", { name: "Добавить в индекс", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Добавить в индекс", exact: true }).click(); await page.waitForTimeout(100);
      assert.ok(f.calls.some(call => call[0] === "review.stage" && call[1].revision === "hash-1" && call[1].confirmed));
      await page.getByRole("button", { name: "Действия проекта", exact: true }).click();
      await page.getByRole("button", { name: "Запустить: Проверить проект", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Проверить проект", exact: true }).click(); await page.waitForTimeout(100);
      assert.ok(f.calls.some(call => call[0] === "project.action.run" && call[1].confirmed));
      await page.getByRole("button", { name: "Артефакты браузера", exact: true }).click();
      await page.getByRole("button", { name: "Открыть артефакт" }).click(); await page.getByText("Console ready", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "desktop-actions.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(180);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(artifacts, "mobile-actions.png") });
    } finally { f.dispose(); await page.close(); }

    const operationsPage = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const operations = await createFixture(operationsPage, compiled, { count: 1000, dark: true });
    try {
      assert.deepEqual(await operationsPage.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, foreground: getComputedStyle(document.body).color })), { background: "rgb(32, 33, 36)", foreground: "rgb(230, 230, 230)" }, "body-scoped Element theme variables drive the full UI");
      const createdAt = new Date(Date.now() - 65000).toISOString();
      const parent = { kind: "turn-run", id: "parent-offpage", turnId: "operations-turn", status: "running", createdAt, activityIds: [], worklogIds: ["worklog-live"], diffIds: ["diff-live"], compactionIds: ["compact-live"], counts: { tool: 2000 } };
      operations.data.items[0] = parent;
      operations.data.items[997] = { kind: "worklog", id: "worklog-live", turnId: parent.turnId, status: "running", operationKind: "reasoning", title: "Проверка модели", createdAt, updatedAt: createdAt, children: Array.from({ length: 2000 }, (_, index) => ({ id: `child-${index}`, kind: "read", status: "completed", title: `Read child ${index}`, createdAt, completedAt: new Date(Date.parse(createdAt) + 2000).toISOString(), outputPreview: "heavy ".repeat(4000) })) };
      operations.data.items[998] = { kind: "diff", id: "diff-live", turnId: parent.turnId, title: "Изменения файлов", createdAt, additions: 1, deletions: 1, files: [{ path: "test.xbsl", additions: 1, deletions: 1, diff: "-before\n+after" }] };
      operations.data.items[996] = { kind: "compaction", id: "compact-live", turnId: parent.turnId, label: "Контекст сжат", createdAt };
      await operations.flush();
      await operationsPage.getByText(/Работает уже 1 мин/).waitFor();
      await operationsPage.getByText("Размышления: Проверка модели", { exact: true }).waitFor();
      await operationsPage.getByText("Размышления: Проверка модели", { exact: true }).click();
      await operationsPage.getByText("Read child 0", { exact: true }).waitFor();
      assert.equal(await operationsPage.locator(".operation-child").count(), 20, "one worklog has bounded paginated children");
      assert.ok(!JSON.stringify(operations.outbound.findLast(frame => frame.type === "chat.bridge")).includes("heavy heavy"), "tool output is absent from stream frames");
      operations.data.items[997].children[0].title = "Updated child"; operations.data.items[997].updatedAt = new Date().toISOString(); await operations.flush();
      await operationsPage.getByText("Updated child", { exact: true }).waitFor();
      parent.status = "completed"; parent.completedAt = new Date(Date.parse(createdAt) + 65000).toISOString(); operations.data.items[997].status = "completed"; operations.data.items[997].completedAt = parent.completedAt; await operations.flush();
      await operationsPage.getByText(/Работал на протяжении 1 мин 5 с/).waitFor();
      assert.equal(await operationsPage.locator(".worklog").count(), 0, "completed worklog collapsed under off-page turn");
      assert.equal(await operationsPage.locator(".compaction").count(), 0, "completed compaction collapsed");
      assert.equal(await operationsPage.locator(".diff-block").count(), 1, "diff card stays visible after completion");
      await operationsPage.getByText(/Работал на протяжении 1 мин 5 с/).click();
      await operationsPage.getByText("Размышления: Проверка модели", { exact: true }).waitFor();
      assert.ok(operations.inbound.some(value => value.command === "chat.turn.load"));
      await operationsPage.screenshot({ path: path.join(artifacts, "dark-worklog.png") });
      const state = await operationsPage.evaluate(() => window.fixtureState);
      assert.ok(state.activeChatId === "chat-a");
      await operationsPage.getByRole("textbox", { name: "Сообщение Codex" }).fill("Restore me");
      const persisted = await operationsPage.evaluate(() => window.fixtureState);
      const restorePage = await browser.newPage({ viewport: { width: 700, height: 750 } });
      const restored = await createFixture(restorePage, compiled, { count: 1000, persisted, fallback: true });
      try { assert.equal(await restorePage.getByRole("textbox", { name: "Сообщение Codex" }).inputValue(), "Restore me"); }
      finally { restored.dispose(); await restorePage.close(); }
    } finally { operations.dispose(); await operationsPage.close(); }
    const report = { ok: true, metrics, artifacts };
    await fs.writeFile(path.join(artifacts, "metrics.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
