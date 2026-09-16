// Synthetic bridge/UI stress, not a reproduction of the production Theia transport.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { chromium } = require("playwright");
const { compile, createFixture } = require("./chat-ui-fixture.cjs");
const { loadSource, logger } = require("../tests/service-test-utils.cjs");
const { DiffPatchStore } = loadSource("src/diffPatchStore.ts");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const compiled = await compile();
  const artifacts = process.env.CODEX_TEST_ARTIFACTS ? path.resolve(process.env.CODEX_TEST_ARTIFACTS)
    : await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-pressure-"));
  await fs.mkdir(artifacts, { recursive: true });
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pressure-patches-"));
  const patches = new DiffPatchStore(() => scope, logger);
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const f = await createFixture(page, compiled, { count: 10000 });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  let maxPending = 0; let maxRss = process.memoryUsage().rss;
  let sample;
  try {
    await page.locator("[data-role=prompt-input]").fill("Draft preserved under load");
    await page.evaluate(() => {
      window.pressureLongTaskMs = 0;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.pressureLongTaskMs = Math.max(window.pressureLongTaskMs, entry.duration); }).observe({ type: "longtask", buffered: false });
      const scroller = document.querySelector("[data-role=transcript]");
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000 })); scroller.scrollTop -= 2400;
    });
    await page.waitForTimeout(200);
    const anchor = await page.evaluate(() => {
      const top = document.querySelector("[data-role=transcript]").getBoundingClientRect().top;
      window.pressureAnchor = [...document.querySelectorAll(".message .markdown p")].find(node => node.getBoundingClientRect().top > top + 20);
      const range = document.createRange(); range.selectNodeContents(window.pressureAnchor); getSelection().removeAllRanges(); getSelection().addRange(range);
      return { y: window.pressureAnchor.getBoundingClientRect().top, selection: getSelection().toString() };
    });
    const post = f.panel.webview.postMessage;
    f.panel.webview.postMessage = async value => { await sleep(90); return post(value); };
    sample = setInterval(() => {
      maxPending = Math.max(maxPending, f.manager.getMetrics().pendingPosts);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
    }, 20);
    lag.enable();
    const start = performance.now();
    const prefix = Array.from({ length: 120 }, (_, index) => `diff --git a/docs/${index}.md b/docs/${index}.md\n--- a/docs/${index}.md\n+++ b/docs/${index}.md\n@@ -1,200 +1,200 @@\n${"-Old documentation line\n+New documentation line\n".repeat(200)}`).join("");
    for (let index = 0; index < 1200; index++) {
      f.data.items[9999].text += ` fragment-${index}`;
      if (index % 50 === 0) {
        const files = patches.capture(`${prefix}+revision ${index}\n`, "stress-turn");
        f.data.items[9998] = { kind: "diff", id: "stress-diff", title: "Changes", files,
          additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          createdAt: "2026-09-08T10:00:00Z", updatedAt: String(index) };
      }
      f.manager.postAllSnapshots();
      await sleep(5);
    }
    f.data.items[9999].status = "complete"; f.data.meta.chat.status = "idle"; await f.flush();
    await page.waitForTimeout(500); await patches.flush();
    const ui = await page.evaluate(() => ({ anchorY: window.pressureAnchor.getBoundingClientRect().top, selected: getSelection().toString(),
      sameAnchor: window.pressureAnchor.isConnected, rows: document.querySelectorAll(".virtual-row").length,
      draft: document.querySelector("[data-role=prompt-input]").value, longTaskMs: window.pressureLongTaskMs }));
    assert.equal(ui.sameAnchor, true); assert.equal(ui.selected, anchor.selection);
    assert(Math.abs(ui.anchorY - anchor.y) <= 2, `reading anchor drifted ${ui.anchorY - anchor.y}px`);
    assert.equal(ui.draft, "Draft preserved under load"); assert(ui.rows < 80); assert.equal(maxPending, 1);
    assert.deepEqual(errors, []);
    const frames = f.outbound.filter(frame => frame.type === "chat.bridge");
    assert(frames.length < 250, "updates must be coalesced under a slow bridge");
    assert(!JSON.stringify(frames).includes("Old documentation line"), "full patches never cross the baseline bridge");
    const result = { scenario: "synthetic 10000-row history / 1200 deltas / 24 bulk diffs / 90ms bridge delay", elapsedMs: Math.round(performance.now() - start),
      inputDiffBytes: Buffer.byteLength(prefix), frames: frames.length, totalFrameBytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0),
      maxPendingPosts: maxPending, pluginFixtureMaxRssBytes: maxRss, eventLoopMaxMs: lag.max / 1e6, eventLoopP95Ms: lag.percentile(95) / 1e6,
      renderedRows: ui.rows, anchorDriftPx: ui.anchorY - anchor.y, frontendLongTaskMs: ui.longTaskMs,
      bridge: f.manager.getMetrics(), patchStore: patches.getMetrics() };
    await page.screenshot({ path: path.join(artifacts, "streaming-scroll.png") });
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.getByRole("button", { name: "К последнему сообщению", exact: true }).click();
    await page.waitForTimeout(300);
    assert.match(await page.locator("[data-item-id='item-9999']").innerText(), /fragment-1199/);
    await fs.writeFile(path.join(artifacts, "pressure-metrics.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
  } finally {
    clearInterval(sample); lag.disable(); patches.dispose(); await patches.flush();
    f.dispose(); await browser.close(); await fs.rm(scope, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
