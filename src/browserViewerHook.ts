import * as net from "net";
import { randomUUID } from "crypto";
import type { Page, CDPSession } from "playwright";
import { BrowserViewerConnection, VIEWER_MAX_FRAME } from "./browserViewerProtocol";

const attached = new WeakSet<Page>();

/** Runs inside the existing MCP process. Only observation CDP methods are used. */
export function attachBrowserViewer(page: Page, connection: BrowserViewerConnection): void {
  if (attached.has(page)) return;
  attached.add(page);
  let socket: net.Socket | undefined, cdp: CDPSession | undefined;
  let closed = false, active = false, awaitingAck = false, lastFrameAt = 0, attempt = 0, generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined, metadataTimer: ReturnType<typeof setInterval> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  let titlePending = false, lastTitle = "Страница";
  let latest: { data: string; width: number; height: number } | undefined;
  let transition = Promise.resolve();
  const pageId = randomUUID();
  const send = (message: object): void => {
    if (socket && !socket.destroyed && socket.writableLength < VIEWER_MAX_FRAME) socket.write(`${JSON.stringify(message)}\n`);
  };
  const metadata = async (): Promise<void> => {
    // A modal dialog can suspend page.title(); do not accumulate evaluations.
    if (!titlePending) {
      titlePending = true;
      const lookup = Promise.resolve().then(() => page.title()).then(title => {
        lastTitle = title.slice(0, 256); titlePending = false;
      }, () => { titlePending = false; });
      await Promise.race([lookup, new Promise<void>(resolve => { titleTimer = setTimeout(resolve, 1000); titleTimer.unref(); })]);
      clearTimeout(titleTimer);
    }
    if (!closed) send({ type: "page", title: lastTitle, url: page.url().slice(0, 4096) });
  };
  const flush = (): void => {
    clearTimeout(frameTimer); frameTimer = undefined;
    if (!active || closed || awaitingAck || !latest || !socket || socket.destroyed) return;
    const delay = Math.max(0, 200 - (Date.now() - lastFrameAt));
    if (delay || socket.writableLength) {
      frameTimer = setTimeout(flush, Math.max(delay, 50)); frameTimer.unref(); return;
    }
    const frame = latest; latest = undefined;
    awaitingAck = true; lastFrameAt = Date.now();
    send({ type: "frame", ...frame });
  };
  const setStreaming = (next: boolean): void => {
    active = next; awaitingAck = false; latest = undefined; lastFrameAt = 0;
    clearTimeout(frameTimer);
    const current = ++generation;
    transition = transition.then(async () => {
      if (closed || current !== generation) return;
      try {
        if (next && !cdp) {
          const session = await page.context().newCDPSession(page);
          if (closed) { await session.detach().catch(() => {}); return; }
          cdp = session;
          cdp.on("Page.screencastFrame", (frame: { sessionId: number; data: string; metadata: { deviceWidth: number; deviceHeight: number } }) => {
            void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
            if (!active || closed || frame.data.length > VIEWER_MAX_FRAME) return;
            latest = { data: frame.data, width: Math.round(frame.metadata.deviceWidth), height: Math.round(frame.metadata.deviceHeight) };
            flush();
          });
        }
        if (closed || current !== generation) return;
        if (next) await cdp?.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
        else await cdp?.send("Page.stopScreencast");
      } catch { if (!closed) send({ type: "error" }); }
    }).catch(() => {});
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true; active = false; generation++;
    clearTimeout(retry); clearInterval(metadataTimer); clearTimeout(frameTimer); clearTimeout(titleTimer); latest = undefined;
    page.off("close", cleanup);
    socket?.destroy();
    void cdp?.detach().catch(() => {});
  };
  const connect = (): void => {
    if (closed || page.isClosed()) { cleanup(); return; }
    const client = net.createConnection(connection.socketPath);
    socket = client; client.unref();
    let input = "", connected = false;
    client.setEncoding("utf8");
    client.on("connect", () => {
      connected = true;
      send({ type: "hello", token: connection.token, pageId, title: "Страница", url: page.url().slice(0, 4096) });
      void metadata();
      metadataTimer = setInterval(() => { void metadata(); }, 1500); metadataTimer.unref();
    });
    client.on("error", () => {});
    client.on("close", () => {
      if (closed) return;
      if (!connected && ++attempt < 20) { retry = setTimeout(connect, 250); retry.unref(); }
      else cleanup();
    });
    client.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 8192) { cleanup(); return; }
      let end: number;
      while ((end = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === "stream" && typeof value.active === "boolean") setStreaming(value.active);
          else if (value.type === "ack") { awaitingAck = false; flush(); }
        } catch { cleanup(); return; }
      }
    });
  };
  page.on("close", cleanup);
  connect();
}
