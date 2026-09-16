const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { compile, createFixture } = require("./chat-ui-fixture.cjs");

async function resetSelection(input, start = 2, end = 5) {
  await input.evaluate((node, { start, end }) => {
    node.focus();
    window.getSelection().removeAllRanges();
    node.setSelectionRange(start, end);
    window.hostKeys = [];
    window.hostSelectAll = 0;
  }, { start, end });
}

async function selectionState(input) {
  return input.evaluate(node => ({
    start: node.selectionStart, end: node.selectionEnd, value: node.value,
    focused: document.activeElement === node, hostSelectAll: window.hostSelectAll,
    transcriptSelected: window.getSelection().containsNode(document.querySelector("[data-role=transcript]"), true)
  }));
}

async function dispatchKey(input, init) {
  return input.evaluate((node, init) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    node.dispatchEvent(event);
    return { prevented: event.defaultPrevented, hostKeys: window.hostKeys };
  }, init);
}

async function main() {
  // compile() uses write:false: exercise current TSX without updating media/dist.
  const compiled = await compile();
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  const checks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.hostKeys = [];
      window.hostSelectAll = 0;
      // Model a webview bridge forwarding unhandled shortcuts to its host.
      document.addEventListener("keydown", event => {
        window.hostKeys.push({ key: event.key, prevented: event.defaultPrevented });
        if ((event.key.toLowerCase() !== "a" && event.code !== "KeyA") || !(event.metaKey || event.ctrlKey)
          || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
        window.hostSelectAll++;
        event.preventDefault();
        window.getSelection().selectAllChildren(document.body);
      });
    });
    const f = await createFixture(page, compiled, { count: 6 });
    try {
      const input = page.locator("[data-role=prompt-input]");
      const commands = () => f.inbound.filter(value => ["chat.send", "chat.queue.add", "chat.steer"].includes(value.command));
      const draft = "First line\nSecond line: \u043f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80";
      for (const modifier of ["Meta", "Control"]) {
        for (const value of [draft, "", "Long draft ".repeat(1000)]) {
          await input.fill(value);
          await resetSelection(input);
          const persisted = await page.evaluate(() => window.fixtureState);
          await page.keyboard.press(`${modifier}+a`);
          assert.deepEqual(await selectionState(input), {
            start: 0, end: value.length, value, focused: true, hostSelectAll: 0, transcriptSelected: false
          }, `${modifier}+A selects only the focused composer (${value.length} characters)`);
          assert.deepEqual(await page.evaluate(() => window.fixtureState), persisted, "selection does not mutate the saved draft");
          assert.equal(await page.evaluate(() => window.hostKeys.some(event => event.key.toLowerCase() === "a")), false, "select-all does not reach the host");
        }
        checks.push(`${modifier}+A: multiline, empty and long drafts`);

        await input.fill(draft);
        for (const init of [{ key: "A" }, { key: "a", repeat: true }, { key: "\u0444" }, { key: "\u0424" }]) {
          await resetSelection(input);
          const result = await dispatchKey(input, { ...init, code: "KeyA", [modifier === "Meta" ? "metaKey" : "ctrlKey"]: true });
          assert.deepEqual(result, { prevented: true, hostKeys: [] }, "Caps Lock, key repeat and Russian layout are handled locally");
          assert.equal((await selectionState(input)).end, draft.length);
        }

        await resetSelection(input);
        await page.locator("[data-role=transcript]").evaluate(node => {
          node.tabIndex = -1;
          node.focus();
        });
        await page.keyboard.press(`${modifier}+a`);
        const outside = await selectionState(input);
        assert.equal(outside.focused, false);
        assert.equal(outside.hostSelectAll, 1, "select-all outside the composer still reaches the host");
        assert.equal(outside.transcriptSelected, true, "document selection outside the composer is not blocked");
        assert.equal(outside.start, 2);
        assert.equal(outside.end, 5);
        assert.equal(outside.value, draft);
        checks.push(`${modifier}+A outside composer`);
      }

      for (const modifier of ["metaKey", "ctrlKey"]) {
        for (const init of [
          { key: "a", shiftKey: true }, { key: "a", altKey: true },
          { key: "a", isComposing: true }, { key: "a", keyCode: 229 },
          ...["c", "v", "x", "z", "ArrowLeft"].map(key => ({ key }))
        ]) {
          await resetSelection(input);
          const before = await selectionState(input);
          const result = await dispatchKey(input, { ...init, [modifier]: true });
          assert.deepEqual(result, { prevented: false, hostKeys: [{ key: init.key, prevented: false }] }, `unrelated/IME key is untouched: ${JSON.stringify({ modifier, ...init })}`);
          assert.deepEqual(await selectionState(input), before, "ignored shortcuts leave the selection and draft unchanged");
        }
        await resetSelection(input);
        const remapped = await dispatchKey(input, { key: "q", code: "KeyA", [modifier]: true });
        assert.equal(remapped.hostKeys.length, 1, "a Latin remapped shortcut still reaches the host");
      }
      checks.push("Shift/Alt, IME, copy/paste/cut/undo/navigation pass through");

      await input.fill("Typing");
      await resetSelection(input, 6, 6);
      await page.keyboard.press("a");
      assert.equal(await input.inputValue(), "Typinga", "plain A still types text");
      assert.equal(commands().length, 0, "select-all and unrelated shortcuts never send a message");

      for (const status of ["idle", "running"]) {
        f.data.meta.chat.status = status;
        await f.flush();
        await input.fill("Line one");
        await resetSelection(input, 8, 8);
        const before = commands().length;
        await page.keyboard.press("Shift+Enter");
        assert.equal(await input.inputValue(), "Line one\n", "Shift+Enter inserts a newline");
        assert.equal(commands().length, before, "Shift+Enter never submits");

        await resetSelection(input);
        const ime = await dispatchKey(input, { key: "Enter", code: "Enter", isComposing: true });
        assert.equal(ime.prevented, false, "IME Enter is left to the input method");
        assert.equal(commands().length, before, "IME Enter never submits");
        assert.equal(await input.inputValue(), "Line one\n");

        for (const shortcut of ["Enter", "Meta+Enter", "Control+Enter"]) {
          const prompt = `${status}: ${shortcut}`;
          await input.fill(prompt);
          const count = commands().length;
          await page.keyboard.press(shortcut);
          await page.waitForFunction(() => document.querySelector("[data-role=prompt-input]").value === "");
          const sent = commands();
          assert.equal(sent.length, count + 1, "Enter submits exactly once");
          assert.equal(sent.at(-1).command, status === "idle" ? "chat.send" : shortcut === "Enter" ? "chat.queue.add" : "chat.steer");
          assert.equal(sent.at(-1).payload.prompt, prompt);
          assert.equal(await input.evaluate(node => node === document.activeElement), true, "submission keeps composer focused");
        }
        checks.push(`${status}: Enter, Meta/Control+Enter, Shift+Enter and IME Enter`);
      }
      assert.deepEqual(errors, [], "no browser errors");
      console.log(JSON.stringify({ ok: true, browser: browser.version(), checks }, null, 2));
    } finally { f.dispose(); await page.close(); }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
