"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserViewerService = void 0;
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const events_1 = require("events");
const browserViewerProtocol_1 = require("./browserViewerProtocol");
/** Private, read-only IPC. No CDP endpoint or browser input is exposed to the webview. */
class BrowserViewerService {
    constructor(getScopeRoot) {
        this.getScopeRoot = getScopeRoot;
        this.events = new events_1.EventEmitter();
        this.sockets = new Set();
        this.peers = new Map();
        this.selected = "";
        this.visible = false;
        this.paused = false;
        this.failure = "";
        this.sequence = 0;
    }
    onState(listener) {
        this.events.on("state", listener);
        return { dispose: () => { this.events.off("state", listener); } };
    }
    onFrame(listener) {
        this.events.on("frame", listener);
        return { dispose: () => { this.events.off("frame", listener); } };
    }
    startSession(scopeRoot) {
        this.stop();
        if (!scopeRoot || this.getScopeRoot() !== scopeRoot)
            return undefined;
        const sessionId = (0, crypto_1.randomUUID)();
        this.scope = scopeRoot;
        try {
            const directory = process.platform === "win32" ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "codex-view-"));
            if (directory)
                fs.chmodSync(directory, 0o700);
            this.directory = directory;
            const socketPath = directory ? path.join(directory, "view.sock") : `\\\\.\\pipe\\codex-view-${sessionId}`;
            this.connection = { socketPath, token: (0, crypto_1.randomBytes)(32).toString("hex"), sessionId };
            const server = net.createServer(socket => this.accept(socket, sessionId));
            this.server = server;
            server.maxConnections = 32;
            server.on("error", () => { if (this.server === server)
                this.stop("Не удалось подключить просмотр браузера."); });
            server.listen(socketPath);
            server.unref();
            this.emitState();
            return { ...this.connection };
        }
        catch {
            this.stop("Не удалось подготовить просмотр браузера.");
            return undefined;
        }
    }
    authorized() { return !!this.scope && this.getScopeRoot() === this.scope; }
    getState() {
        if (this.scope && !this.authorized())
            this.stop();
        const status = this.failure ? "error" : !this.connection ? "idle" : !this.peers.size ? "waiting" : this.paused || !this.visible ? "paused" : "live";
        const messages = { idle: "Браузер агента ещё не запущен.", waiting: "Ожидание страницы браузера агента.", paused: "Просмотр приостановлен.", live: "Прямой просмотр", error: this.failure };
        return { type: "browser.viewer.state", sessionId: this.connection?.sessionId ?? "", status, message: messages[status], pages: [...this.peers.values()].map(p => ({ ...p.page })), selectedPageId: this.selected };
    }
    setVisible(visible) { this.visible = visible; this.sync(); }
    setPaused(paused) {
        if (!paused) {
            this.clearPending();
            for (const peer of this.peers.values()) {
                if (peer.streaming) {
                    peer.streaming = false;
                    this.write(peer.socket, { type: "stream", active: false });
                }
            }
            this.failure = "";
        }
        this.paused = paused;
        this.sync();
    }
    selectPage(sessionId, pageId) {
        if (sessionId !== this.connection?.sessionId || !this.peers.has(pageId) || this.selected === pageId)
            return;
        this.selected = pageId;
        this.clearPending();
        this.sync();
    }
    acknowledge(sessionId, pageId, sequence) {
        if (this.scope && !this.authorized()) {
            this.stop();
            return;
        }
        if (sessionId !== this.connection?.sessionId || this.pending?.pageId !== pageId || this.pending?.sequence !== sequence)
            return;
        this.clearPending();
        this.write(this.peers.get(pageId)?.socket, { type: "ack" });
    }
    clearPending() { if (this.pending)
        clearTimeout(this.pending.timer); this.pending = undefined; }
    emitState() { this.events.emit("state", this.getState()); }
    write(socket, value) {
        if (socket && !socket.destroyed && socket.writableLength < browserViewerProtocol_1.VIEWER_MAX_MESSAGE)
            socket.write(`${JSON.stringify(value)}\n`);
    }
    sync() {
        if (this.scope && !this.authorized()) {
            this.stop();
            return;
        }
        if (!this.visible || this.paused)
            this.clearPending();
        for (const [id, peer] of this.peers) {
            const active = this.visible && !this.paused && id === this.selected;
            if (peer.streaming !== active) {
                peer.streaming = active;
                this.write(peer.socket, { type: "stream", active });
            }
        }
        this.emitState();
    }
    accept(socket, sessionId) {
        if (sessionId !== this.connection?.sessionId || !this.authorized() || this.sockets.size >= 32) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        socket.unref();
        let text = "", peerId = "";
        const timeout = setTimeout(() => { if (!peerId)
            socket.destroy(); }, 3000);
        timeout.unref();
        socket.setEncoding("utf8");
        socket.on("error", () => { });
        socket.on("close", () => {
            clearTimeout(timeout);
            this.sockets.delete(socket);
            if (this.peers.get(peerId)?.socket !== socket)
                return;
            this.peers.delete(peerId);
            if (this.pending?.pageId === peerId)
                this.clearPending();
            if (this.selected === peerId)
                this.selected = this.peers.keys().next().value ?? "";
            this.sync();
        });
        socket.on("data", chunk => {
            if (sessionId !== this.connection?.sessionId || !this.authorized()) {
                socket.destroy();
                this.sync();
                return;
            }
            text += chunk;
            if (Buffer.byteLength(text, "utf8") > browserViewerProtocol_1.VIEWER_MAX_MESSAGE * 2) {
                socket.destroy();
                return;
            }
            let end;
            while ((end = text.indexOf("\n")) !== -1) {
                const line = text.slice(0, end);
                text = text.slice(end + 1);
                if (Buffer.byteLength(line, "utf8") > browserViewerProtocol_1.VIEWER_MAX_MESSAGE) {
                    socket.destroy();
                    return;
                }
                try {
                    const message = JSON.parse(line);
                    if (!peerId) {
                        const token = this.connection?.token ?? "";
                        if (message.type !== "hello" || typeof message.token !== "string" || message.token.length !== token.length || !(0, crypto_1.timingSafeEqual)(Buffer.from(message.token), Buffer.from(token)) || typeof message.pageId !== "string" || !/^[a-z0-9-]{1,64}$/i.test(message.pageId) || this.peers.has(message.pageId)) {
                            socket.destroy();
                            return;
                        }
                        peerId = message.pageId;
                        clearTimeout(timeout);
                        this.peers.set(peerId, { socket, page: { id: peerId, title: "", url: "" }, streaming: false });
                        this.selected || (this.selected = peerId);
                        this.updatePage(peerId, message);
                        this.sync();
                    }
                    else if (message.type === "page")
                        this.updatePage(peerId, message);
                    else if (message.type === "frame")
                        this.frame(peerId, message);
                    else if (message.type === "error") {
                        this.failure = "Не удалось получить изображение страницы. Переключите страницу или возобновите просмотр.";
                        this.emitState();
                    }
                }
                catch {
                    socket.destroy();
                    return;
                }
            }
            if (Buffer.byteLength(text, "utf8") > browserViewerProtocol_1.VIEWER_MAX_MESSAGE)
                socket.destroy();
        });
    }
    updatePage(id, message) {
        const peer = this.peers.get(id);
        if (!peer)
            return;
        const title = typeof message.title === "string" ? message.title.slice(0, 256) : "Страница";
        const url = typeof message.url === "string" ? message.url.slice(0, 4096) : "";
        if (title === peer.page.title && url === peer.page.url)
            return;
        peer.page = { id, title, url };
        this.emitState();
    }
    frame(pageId, value) {
        const peer = this.peers.get(pageId);
        if (!peer?.streaming || pageId !== this.selected || this.pending || !this.authorized())
            return;
        if (typeof value.data !== "string" || value.data.length > browserViewerProtocol_1.VIEWER_MAX_FRAME || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || !value.data.startsWith("/9j/") || !Number.isInteger(value.width) || !Number.isInteger(value.height) || Number(value.width) < 1 || Number(value.width) > 4096 || Number(value.height) < 1 || Number(value.height) > 4096) {
            this.write(peer.socket, { type: "ack" });
            return;
        }
        if (this.failure) {
            this.failure = "";
            this.emitState();
        }
        const sequence = ++this.sequence;
        const timer = setTimeout(() => { if (this.pending?.sequence === sequence) {
            this.clearPending();
            this.setVisible(false);
        } }, 3000);
        timer.unref();
        this.pending = { sequence, pageId, timer };
        this.events.emit("frame", { type: "browser.viewer.frame", sessionId: this.connection.sessionId, pageId, sequence, data: value.data, width: Number(value.width), height: Number(value.height) });
    }
    stop(message = "") {
        this.clearPending();
        this.scope = undefined;
        this.connection = undefined;
        this.selected = "";
        this.failure = message;
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        this.peers.clear();
        const server = this.server, directory = this.directory;
        this.server = undefined;
        this.directory = undefined;
        const cleanup = () => { if (directory) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            }
            catch { }
        } };
        if (server)
            server.close(cleanup);
        else
            cleanup();
        this.emitState();
    }
    dispose() { this.stop(); this.events.removeAllListeners(); }
}
exports.BrowserViewerService = BrowserViewerService;
//# sourceMappingURL=browserViewerService.js.map