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
/** Private IPC: the webview sends bounded input actions, never arbitrary CDP commands. */
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
        this.decodedPage = "";
        this.pageRevision = 0;
        this.controlId = "";
        this.inputError = "";
        this.tabErrors = new Map();
        this.closing = new Map();
        this.lastInputId = 0;
    }
    onState(listener) {
        this.events.on("state", listener);
        return { dispose: () => { this.events.off("state", listener); } };
    }
    onFrame(listener) {
        this.events.on("frame", listener);
        return { dispose: () => { this.events.off("frame", listener); } };
    }
    onPointer(listener) {
        this.events.on("pointer", listener);
        return { dispose: () => { this.events.off("pointer", listener); } };
    }
    onInputResult(listener) {
        this.events.on("inputResult", listener);
        return { dispose: () => { this.events.off("inputResult", listener); } };
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
        const tabError = this.tabErrors.values().next().value;
        return { type: "browser.viewer.state", sessionId: this.connection?.sessionId ?? "", status, message: messages[status], pages: [...this.peers.values()].map(p => ({ ...p.page })), selectedPageId: this.selected, controlId: this.controlId, pageRevision: this.pageRevision, closingPageIds: [...this.closing.keys()], ...(tabError ? { tabError } : {}), ...(this.inputError ? { inputError: this.inputError } : {}) };
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
        this.revokeControl();
        this.decodedPage = "";
        this.inputError = "";
        this.failure = "";
        this.selected = pageId;
        this.clearPending();
        this.sync();
    }
    closePages(sessionId, pageId, mode) {
        if (!this.authorized()) {
            this.stop();
            return;
        }
        if (sessionId !== this.connection?.sessionId || !this.visible || pageId !== this.selected || !this.peers.has(pageId) || this.closing.size || (mode !== "selected" && mode !== "others"))
            return;
        // Snapshot the owned pages: tabs opened after this action are never closed.
        const targets = [...this.peers.keys()].filter(id => mode === "selected" ? id === pageId : id !== pageId);
        if (!targets.length)
            return;
        this.tabErrors.clear();
        if (targets.includes(this.selected)) {
            this.revokeControl();
            this.decodedPage = "";
            this.clearPending();
        }
        for (const id of targets) {
            const requestId = (0, crypto_1.randomUUID)();
            const timer = setTimeout(() => this.closeFailed(id, requestId, "Браузер не подтвердил закрытие вкладки. Проверьте её состояние; команда не будет повторена автоматически."), 10000);
            timer.unref();
            this.closing.set(id, { requestId, timer });
        }
        this.sync();
        for (const id of targets) {
            const pending = this.closing.get(id);
            if (!pending)
                continue;
            const requestId = pending.requestId;
            if (!this.write(this.peers.get(id)?.socket, { type: "page.close", requestId }))
                this.closeFailed(id, requestId);
        }
    }
    clearClosing(pageId) {
        const pending = this.closing.get(pageId);
        if (pending)
            clearTimeout(pending.timer);
        this.closing.delete(pageId);
    }
    closeFailed(pageId, requestId, message = "Не удалось закрыть вкладку. Повторите попытку.") {
        if (!this.closing.has(pageId) || this.closing.get(pageId).requestId !== requestId)
            return;
        this.clearClosing(pageId);
        this.tabErrors.set(pageId, message);
        this.sync();
    }
    acknowledge(sessionId, pageId, sequence) {
        if (this.scope && !this.authorized()) {
            this.stop();
            return;
        }
        if (sessionId !== this.connection?.sessionId || this.pending?.pageId !== pageId || this.pending?.sequence !== sequence)
            return;
        this.decodedPage = pageId;
        this.clearPending();
        this.write(this.peers.get(pageId)?.socket, { type: "ack" });
    }
    setControl(sessionId, pageId, enabled) {
        if (!this.authorized()) {
            this.stop();
            return;
        }
        if (sessionId !== this.connection?.sessionId || pageId !== this.selected)
            return;
        this.revokeControl();
        this.inputError = "";
        const peer = this.peers.get(pageId);
        if (enabled && !this.closing.has(pageId) && this.visible && !this.paused && !this.failure && peer?.streaming && this.decodedPage === pageId) {
            this.controlId = (0, crypto_1.randomUUID)();
            if (!this.write(peer.socket, { type: "control", controlId: this.controlId }))
                this.failInput("Не удалось включить управление. Повторите подключение.");
        }
        this.emitState();
    }
    sendInput(sessionId, pageId, controlId, inputId, input) {
        if (!this.authorized()) {
            this.stop();
            return;
        }
        const peer = this.peers.get(pageId);
        if (sessionId !== this.connection?.sessionId || pageId !== this.selected || this.closing.has(pageId) || !controlId || controlId !== this.controlId || !this.visible || this.paused || this.failure || !peer?.streaming)
            return;
        if (!Number.isSafeInteger(inputId) || inputId <= this.lastInputId || !(0, browserViewerProtocol_1.isViewerInput)(input))
            return;
        if (this.inputPending) {
            this.failInput("Ввод остановлен: предыдущая команда ещё выполняется. Включите управление снова.");
            return;
        }
        this.lastInputId = inputId;
        const timer = setTimeout(() => {
            if (this.inputPending?.inputId === inputId && this.controlId === controlId)
                this.failInput("Браузер не подтвердил ввод. Команда не будет повторена; проверьте страницу и включите управление снова.");
        }, 8000);
        timer.unref();
        this.inputPending = { pageId, inputId, controlId, timer };
        if (!this.write(peer.socket, { type: "input", controlId, inputId, input }))
            this.failInput("Не удалось передать ввод. Включите управление снова.");
    }
    revokeControl() {
        if (this.inputPending)
            clearTimeout(this.inputPending.timer);
        this.inputPending = undefined;
        if (this.controlId)
            this.write(this.peers.get(this.selected)?.socket, { type: "control", controlId: "" });
        this.controlId = "";
        this.lastInputId = 0;
    }
    failInput(message) {
        this.inputError = message;
        const pending = this.inputPending;
        if (pending)
            this.events.emit("inputResult", { type: "browser.viewer.inputResult", sessionId: this.connection?.sessionId ?? "", pageId: pending.pageId, controlId: pending.controlId, inputId: pending.inputId, ok: false, message });
        this.revokeControl();
        this.emitState();
    }
    inputResult(pageId, message) {
        const pending = this.inputPending;
        if (!pending || pending.pageId !== pageId || pending.controlId !== message.controlId || pending.inputId !== message.inputId || typeof message.ok !== "boolean")
            return;
        if (!message.ok) {
            this.failInput("Не удалось выполнить ввод. Проверьте страницу и включите управление снова.");
            return;
        }
        clearTimeout(pending.timer);
        this.inputPending = undefined;
        this.events.emit("inputResult", { type: "browser.viewer.inputResult", sessionId: this.connection.sessionId, pageId, controlId: pending.controlId, inputId: pending.inputId, ok: true });
    }
    pointer(pageId, value) {
        if (pageId !== this.selected || !this.visible || this.paused || !this.peers.get(pageId)?.streaming)
            return;
        const unit = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
        if (typeof value.kind !== "string" || !["move", "click", "focus", "clear"].includes(value.kind) || !unit(value.x) || !unit(value.y))
            return;
        const bounds = value.bounds;
        if (bounds && (!unit(bounds.x) || !unit(bounds.y) || !unit(bounds.width) || !unit(bounds.height)))
            return;
        this.events.emit("pointer", { type: "browser.viewer.pointer", sessionId: this.connection.sessionId, pageId, kind: value.kind, x: value.x, y: value.y, ...(bounds ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}) });
    }
    clearPending() { if (this.pending)
        clearTimeout(this.pending.timer); this.pending = undefined; }
    emitState() { this.events.emit("state", this.getState()); }
    write(socket, value) {
        if (!socket || socket.destroyed || socket.writableLength >= browserViewerProtocol_1.VIEWER_MAX_MESSAGE)
            return false;
        try {
            socket.write(`${JSON.stringify(value)}\n`);
            return true;
        }
        catch {
            return false;
        }
    }
    sync() {
        if (this.scope && !this.authorized()) {
            this.stop();
            return;
        }
        if (!this.visible || this.paused || this.failure) {
            this.clearPending();
            this.revokeControl();
            this.decodedPage = "";
        }
        for (const [id, peer] of this.peers) {
            const active = this.visible && !this.paused && id === this.selected && !this.closing.has(id);
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
            this.clearClosing(peerId);
            this.tabErrors.delete(peerId);
            if (this.selected === peerId) {
                this.revokeControl();
                this.decodedPage = "";
                this.inputError = "";
                this.failure = "";
            }
            if (this.pending?.pageId === peerId)
                this.clearPending();
            if (this.selected === peerId)
                this.selected = [...this.peers.keys()].find(id => !this.closing.has(id)) ?? this.peers.keys().next().value ?? "";
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
                    else if (message.type === "pointer")
                        this.pointer(peerId, message);
                    else if (message.type === "input.result")
                        this.inputResult(peerId, message);
                    else if (message.type === "page.closeFailed")
                        this.closeFailed(peerId, message.requestId);
                    else if (message.type === "navigation" && peerId === this.selected) {
                        this.revokeControl();
                        this.decodedPage = "";
                        this.inputError = "";
                        this.pageRevision++;
                        this.clearPending();
                        this.write(socket, { type: "ack" });
                        this.pointer(peerId, { kind: "clear", x: 0, y: 0 });
                        this.emitState();
                    }
                    else if (message.type === "error" && peerId === this.selected && !this.closing.has(peerId)) {
                        this.failure = "Не удалось получить изображение страницы. Переключите страницу или возобновите просмотр.";
                        this.revokeControl();
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
        if (peer.page.url && peer.page.url !== url && id === this.selected) {
            this.revokeControl();
            this.decodedPage = "";
        }
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
        this.events.emit("frame", { type: "browser.viewer.frame", sessionId: this.connection.sessionId, pageId, sequence, pageRevision: this.pageRevision, data: value.data, width: Number(value.width), height: Number(value.height) });
    }
    stop(message = "") {
        this.revokeControl();
        this.decodedPage = "";
        this.inputError = "";
        for (const id of this.closing.keys())
            this.clearClosing(id);
        this.tabErrors.clear();
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