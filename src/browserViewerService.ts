import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { BrowserViewerConnection, BrowserViewerFrame, BrowserViewerPage, BrowserViewerState, VIEWER_MAX_FRAME, VIEWER_MAX_MESSAGE } from "./browserViewerProtocol";

interface Peer { socket: net.Socket; page: BrowserViewerPage; streaming: boolean }

/** Private, read-only IPC. No CDP endpoint or browser input is exposed to the webview. */
export class BrowserViewerService {
  private readonly events = new EventEmitter();
  private server?: net.Server;
  private directory?: string;
  private connection?: BrowserViewerConnection;
  private scope?: string;
  private readonly sockets = new Set<net.Socket>();
  private readonly peers = new Map<string, Peer>();
  private selected = "";
  private visible = false;
  private paused = false;
  private failure = "";
  private sequence = 0;
  private pending?: { sequence: number; pageId: string; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly getScopeRoot: () => string | undefined) {}

  onState(listener: (state: BrowserViewerState) => void): { dispose(): void } {
    this.events.on("state", listener);
    return { dispose: () => { this.events.off("state", listener); } };
  }
  onFrame(listener: (frame: BrowserViewerFrame) => void): { dispose(): void } {
    this.events.on("frame", listener);
    return { dispose: () => { this.events.off("frame", listener); } };
  }

  startSession(scopeRoot: string): BrowserViewerConnection | undefined {
    this.stop();
    if (!scopeRoot || this.getScopeRoot() !== scopeRoot) return undefined;
    const sessionId = randomUUID();
    this.scope = scopeRoot;
    try {
      const directory = process.platform === "win32" ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "codex-view-"));
      if (directory) fs.chmodSync(directory, 0o700);
      this.directory = directory;
      const socketPath = directory ? path.join(directory, "view.sock") : `\\\\.\\pipe\\codex-view-${sessionId}`;
      this.connection = { socketPath, token: randomBytes(32).toString("hex"), sessionId };
      const server = net.createServer(socket => this.accept(socket, sessionId));
      this.server = server;
      server.maxConnections = 32;
      server.on("error", () => { if (this.server === server) this.stop("Не удалось подключить просмотр браузера."); });
      server.listen(socketPath);
      server.unref();
      this.emitState();
      return { ...this.connection };
    } catch {
      this.stop("Не удалось подготовить просмотр браузера.");
      return undefined;
    }
  }

  private authorized(): boolean { return !!this.scope && this.getScopeRoot() === this.scope; }
  getState(): BrowserViewerState {
    if (this.scope && !this.authorized()) this.stop();
    const status = this.failure ? "error" : !this.connection ? "idle" : !this.peers.size ? "waiting" : this.paused || !this.visible ? "paused" : "live";
    const messages = { idle: "Браузер агента ещё не запущен.", waiting: "Ожидание страницы браузера агента.", paused: "Просмотр приостановлен.", live: "Прямой просмотр", error: this.failure };
    return { type: "browser.viewer.state", sessionId: this.connection?.sessionId ?? "", status, message: messages[status], pages: [...this.peers.values()].map(p => ({ ...p.page })), selectedPageId: this.selected };
  }
  setVisible(visible: boolean): void { this.visible = visible; this.sync(); }
  setPaused(paused: boolean): void {
    if (!paused) {
      this.clearPending();
      for (const peer of this.peers.values()) {
        if (peer.streaming) { peer.streaming = false; this.write(peer.socket, { type: "stream", active: false }); }
      }
      this.failure = "";
    }
    this.paused = paused; this.sync();
  }
  selectPage(sessionId: string, pageId: string): void {
    if (sessionId !== this.connection?.sessionId || !this.peers.has(pageId) || this.selected === pageId) return;
    this.selected = pageId;
    this.clearPending();
    this.sync();
  }
  acknowledge(sessionId: string, pageId: string, sequence: number): void {
    if (this.scope && !this.authorized()) { this.stop(); return; }
    if (sessionId !== this.connection?.sessionId || this.pending?.pageId !== pageId || this.pending?.sequence !== sequence) return;
    this.clearPending();
    this.write(this.peers.get(pageId)?.socket, { type: "ack" });
  }
  private clearPending(): void { if (this.pending) clearTimeout(this.pending.timer); this.pending = undefined; }
  private emitState(): void { this.events.emit("state", this.getState()); }
  private write(socket: net.Socket | undefined, value: object): void {
    if (socket && !socket.destroyed && socket.writableLength < VIEWER_MAX_MESSAGE) socket.write(`${JSON.stringify(value)}\n`);
  }
  private sync(): void {
    if (this.scope && !this.authorized()) { this.stop(); return; }
    if (!this.visible || this.paused) this.clearPending();
    for (const [id, peer] of this.peers) {
      const active = this.visible && !this.paused && id === this.selected;
      if (peer.streaming !== active) {
        peer.streaming = active;
        this.write(peer.socket, { type: "stream", active });
      }
    }
    this.emitState();
  }
  private accept(socket: net.Socket, sessionId: string): void {
    if (sessionId !== this.connection?.sessionId || !this.authorized() || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.unref();
    let text = "", peerId = "";
    const timeout = setTimeout(() => { if (!peerId) socket.destroy(); }, 3000);
    timeout.unref();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timeout);
      this.sockets.delete(socket);
      if (this.peers.get(peerId)?.socket !== socket) return;
      this.peers.delete(peerId);
      if (this.pending?.pageId === peerId) this.clearPending();
      if (this.selected === peerId) this.selected = this.peers.keys().next().value ?? "";
      this.sync();
    });
    socket.on("data", chunk => {
      if (sessionId !== this.connection?.sessionId || !this.authorized()) { socket.destroy(); this.sync(); return; }
      text += chunk;
      if (Buffer.byteLength(text, "utf8") > VIEWER_MAX_MESSAGE * 2) { socket.destroy(); return; }
      let end: number;
      while ((end = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, end); text = text.slice(end + 1);
        if (Buffer.byteLength(line, "utf8") > VIEWER_MAX_MESSAGE) { socket.destroy(); return; }
        try {
          const message = JSON.parse(line);
          if (!peerId) {
            const token = this.connection?.token ?? "";
            if (message.type !== "hello" || typeof message.token !== "string" || message.token.length !== token.length || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token)) || typeof message.pageId !== "string" || !/^[a-z0-9-]{1,64}$/i.test(message.pageId) || this.peers.has(message.pageId)) { socket.destroy(); return; }
            peerId = message.pageId;
            clearTimeout(timeout);
            this.peers.set(peerId, { socket, page: { id: peerId, title: "", url: "" }, streaming: false });
            this.selected ||= peerId;
            this.updatePage(peerId, message);
            this.sync();
          } else if (message.type === "page") this.updatePage(peerId, message);
          else if (message.type === "frame") this.frame(peerId, message);
          else if (message.type === "error") { this.failure = "Не удалось получить изображение страницы. Переключите страницу или возобновите просмотр."; this.emitState(); }
        } catch { socket.destroy(); return; }
      }
      if (Buffer.byteLength(text, "utf8") > VIEWER_MAX_MESSAGE) socket.destroy();
    });
  }
  private updatePage(id: string, message: { title?: unknown; url?: unknown }): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    const title = typeof message.title === "string" ? message.title.slice(0, 256) : "Страница";
    const url = typeof message.url === "string" ? message.url.slice(0, 4096) : "";
    if (title === peer.page.title && url === peer.page.url) return;
    peer.page = { id, title, url };
    this.emitState();
  }
  private frame(pageId: string, value: { data?: unknown; width?: unknown; height?: unknown }): void {
    const peer = this.peers.get(pageId);
    if (!peer?.streaming || pageId !== this.selected || this.pending || !this.authorized()) return;
    if (typeof value.data !== "string" || value.data.length > VIEWER_MAX_FRAME || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || !value.data.startsWith("/9j/") || !Number.isInteger(value.width) || !Number.isInteger(value.height) || Number(value.width) < 1 || Number(value.width) > 4096 || Number(value.height) < 1 || Number(value.height) > 4096) {
      this.write(peer.socket, { type: "ack" }); return;
    }
    if (this.failure) { this.failure = ""; this.emitState(); }
    const sequence = ++this.sequence;
    const timer = setTimeout(() => { if (this.pending?.sequence === sequence) { this.clearPending(); this.setVisible(false); } }, 3000);
    timer.unref();
    this.pending = { sequence, pageId, timer };
    this.events.emit("frame", { type: "browser.viewer.frame", sessionId: this.connection!.sessionId, pageId, sequence, data: value.data, width: Number(value.width), height: Number(value.height) } satisfies BrowserViewerFrame);
  }
  stop(message = ""): void {
    this.clearPending();
    this.scope = undefined;
    this.connection = undefined;
    this.selected = "";
    this.failure = message;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.peers.clear();
    const server = this.server, directory = this.directory;
    this.server = undefined; this.directory = undefined;
    const cleanup = (): void => { if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} } };
    if (server) server.close(cleanup); else cleanup();
    this.emitState();
  }
  dispose(): void { this.stop(); this.events.removeAllListeners(); }
}
