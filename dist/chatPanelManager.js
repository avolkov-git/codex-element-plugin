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
exports.ChatPanelManager = exports.CHAT_PANEL_VIEW_TYPE = void 0;
const vscode = __importStar(require("vscode"));
const perf_hooks_1 = require("perf_hooks");
const markdownFileLink_1 = require("./markdownFileLink");
const panelIcon_1 = require("./panelIcon");
const webviewHtml_1 = require("./webviewHtml");
exports.CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";
const FEATURE_COMMANDS = new Set([
    "history.search", "history.jump", "review.list", "review.open", "review.comment", "review.stage", "review.revert",
    "project.actions", "project.action.run", "browser.artifacts.list", "browser.artifacts.open", "chat.fork",
    "history.migration.list", "history.migration.import"
]);
class ChatPanelManager {
    constructor(context, state, logger, handlers) {
        this.context = context;
        this.state = state;
        this.logger = logger;
        this.handlers = handlers;
        this.skillOptions = [];
        this.panelChatId = "";
        this.epoch = "";
        this.revision = 0;
        this.ready = false;
        this.visible = true;
        this.dirty = false;
        this.viewportOffset = -1;
        this.inFlight = false;
        this.pendingPost = false;
        this.sentAt = 0;
        this.pressure = { frames: 0, bytes: 0, maxFrameBytes: 0, postFailures: 0, ackTimeouts: 0, ackMaxMs: 0, serializeMaxMs: 0, frontendLagMs: 0, frontendReceiveMs: 0 };
        this.lastMeta = "";
        this.lastTurns = "";
        this.lastTotal = -1;
        this.previousRows = new Map();
        this.featureRequests = new Set();
    }
    getMetrics() {
        return { ...this.pressure, pendingPosts: Number(this.pendingPost), pendingAck: Number(this.inFlight),
            ackAgeMs: this.inFlight ? Date.now() - this.sentAt : 0, visible: this.visible && this.panel?.visible !== false, ready: this.ready };
    }
    registerSerializer() {
        return vscode.window.registerWebviewPanelSerializer(exports.CHAT_PANEL_VIEW_TYPE, {
            deserializeWebviewPanel: async (panel, rawState) => {
                if (this.panel) {
                    panel.dispose();
                    return;
                }
                try {
                    await this.handlers.ensureHistoryLoaded?.();
                }
                catch (error) {
                    void vscode.window.showWarningMessage(`Не удалось загрузить историю: ${error instanceof Error ? error.message : "ошибка"}`);
                }
                const restoredState = parsePanelState(rawState);
                const restoredChatId = restoredState?.activeChatId ?? restoredState?.chatId;
                if (restoredChatId && this.state.getChat(restoredChatId)) {
                    this.state.setActiveChat(restoredChatId);
                }
                this.logger.info(`Restoring singleton chat panel${restoredChatId ? ` for ${restoredChatId}` : ""}.`);
                this.setupPanel(panel);
            }
        });
    }
    openChat(chatId) {
        void this.openLoadedChat(chatId).catch((error) => {
            void vscode.window.showWarningMessage(`Не удалось загрузить диалог: ${error instanceof Error ? error.message : "ошибка"}`);
        });
    }
    async openLoadedChat(chatId) {
        await this.handlers.ensureHistoryLoaded?.();
        const chat = this.state.getChat(chatId);
        if (!chat) {
            vscode.window.showWarningMessage("Чат не найден.");
            return;
        }
        this.state.setActiveChat(chatId);
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.postActiveSnapshot();
            return;
        }
        const panel = vscode.window.createWebviewPanel(exports.CHAT_PANEL_VIEW_TYPE, "Codex", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            enableFindWidget: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
                vscode.Uri.joinPath(this.context.extensionUri, "resources")
            ]
        });
        this.setupPanel(panel);
    }
    closeIfActiveChat(chatId) {
        if (this.state.getActiveChatId() !== chatId) {
            return;
        }
        this.panel?.dispose();
    }
    postSnapshot(chatId) {
        if (chatId && chatId !== this.state.getActiveChatId()) {
            return;
        }
        this.postActiveSnapshot();
    }
    postAllSnapshots() {
        this.postActiveSnapshot();
    }
    postActiveSnapshot() {
        this.dirty = true;
        if (this.flushTimer || this.inFlight || this.pendingPost || !this.ready || !this.visible || this.panel?.visible === false) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flushSnapshot();
        }, 48);
    }
    resetBridge() {
        clearTimeout(this.ackTimer);
        this.ackTimer = undefined;
        this.inFlight = false;
        this.epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        this.revision = 0;
        this.previousRows.clear();
        this.lastMeta = "";
        this.lastTurns = "";
        this.lastTotal = -1;
    }
    async flushSnapshot() {
        const panel = this.panel;
        if (!panel || !this.ready || !this.visible || panel.visible === false || this.inFlight || this.pendingPost || !this.dirty)
            return;
        const startedAt = perf_hooks_1.performance.now();
        this.dirty = false;
        const snapshot = this.state.getActiveChatSnapshot();
        const chatId = snapshot?.chat.id ?? "";
        if (chatId !== this.panelChatId) {
            this.panelChatId = chatId;
            this.viewportOffset = -1;
            this.resetBridge();
        }
        if (!this.epoch)
            this.resetBridge();
        const rows = new Map();
        const turns = new Map();
        let meta = null;
        if (snapshot) {
            const { transcriptWindow, ...rest } = snapshot;
            meta = rest;
            const windows = [transcriptWindow];
            if (this.viewportOffset >= 0 && this.viewportOffset < transcriptWindow.offset) {
                windows.push(this.state.getTranscriptBefore(chatId, "", 120, this.viewportOffset + 100));
            }
            for (const window of windows) {
                window.items.forEach((item, index) => rows.set(window.offset + index, projectTranscriptItem(item)));
                const parents = window.turns ?? [];
                for (const item of parents)
                    turns.set(item.id, item);
                for (const item of window.items)
                    if (item.kind === "turn-run")
                        turns.set(item.id, item);
            }
        }
        const metaJson = JSON.stringify(meta ? { ...meta, version: 0, chat: { ...meta.chat, updatedAt: "" } } : null);
        const turnValues = [...turns.values()].map(item => item.kind === "turn-run"
            ? { ...item, activityIds: [], worklogIds: [], diffIds: [], compactionIds: [] } : item);
        const turnsJson = JSON.stringify(turnValues);
        const frame = {
            type: "chat.bridge", kind: this.revision === 0 ? "snapshot" : "patch", chatId, epoch: this.epoch,
            revision: this.revision + 1, baseRevision: this.revision,
            rows: [], appends: [], totalCount: snapshot?.transcriptWindow.totalCount ?? 0,
            turns: turnsJson !== this.lastTurns ? turnValues : []
        };
        if (metaJson !== this.lastMeta)
            frame.meta = meta;
        const nextRows = new Map();
        for (const [index, item] of rows) {
            const json = JSON.stringify(item);
            const previous = this.previousRows.get(index);
            if (json !== previous?.json) {
                const old = previous?.item;
                if (old?.kind === "message" && item.kind === "message" && old.id === item.id
                    && item.text.startsWith(old.text) && item.text.length > old.text.length
                    && JSON.stringify({ ...old, text: "", status: item.status }) === JSON.stringify({ ...item, text: "" })) {
                    frame.appends.push({ index, id: item.id, text: item.text.slice(old.text.length), status: item.status });
                }
                else
                    frame.rows.push({ index, item });
            }
            // StateStore mutates entities in place. Keep only a bounded detached wire baseline.
            nextRows.set(index, previous?.json === json ? previous : { json, item: JSON.parse(json) });
        }
        if (this.revision && !frame.rows.length && !frame.appends.length && frame.meta === undefined
            && turnsJson === this.lastTurns && frame.totalCount === this.lastTotal)
            return;
        this.previousRows = nextRows;
        this.lastMeta = metaJson;
        this.lastTurns = turnsJson;
        this.lastTotal = frame.totalCount;
        this.revision = frame.revision;
        this.inFlight = true;
        this.pendingPost = true;
        this.sentAt = Date.now();
        const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
        this.pressure.frames++;
        this.pressure.bytes += frameBytes;
        this.pressure.maxFrameBytes = Math.max(this.pressure.maxFrameBytes, frameBytes);
        this.pressure.serializeMaxMs = Math.max(this.pressure.serializeMaxMs, perf_hooks_1.performance.now() - startedAt);
        const epoch = this.epoch;
        // Silence is not permission to enqueue another frame. Resume on ACK or an explicit resync.
        this.ackTimer = setTimeout(() => {
            if (this.panel !== panel || this.epoch !== epoch)
                return;
            this.pressure.ackTimeouts++;
            this.dirty = true;
        }, 3000);
        try {
            const delivered = await panel.webview.postMessage(frame);
            if (!delivered && this.epoch === epoch) {
                this.pressure.postFailures++;
                this.ready = false;
                this.resetBridge();
                this.dirty = true;
            }
        }
        catch {
            this.pressure.postFailures++;
            if (this.epoch === epoch) {
                this.ready = false;
                this.resetBridge();
                this.dirty = true;
            }
        }
        finally {
            this.pendingPost = false;
            if (this.dirty)
                this.postActiveSnapshot();
        }
    }
    setupPanel(panel) {
        panel.title = "Codex";
        panel.iconPath = (0, panelIcon_1.getCodexPanelIconPath)(this.context);
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
                vscode.Uri.joinPath(this.context.extensionUri, "resources")
            ]
        };
        panel.webview.html = (0, webviewHtml_1.renderWebviewHtml)({
            extensionUri: this.context.extensionUri,
            webview: panel.webview,
            scriptPath: "media/chat.js",
            preloadScriptPaths: ["media/xbsl-highlighter.js"],
            stylePath: "media/chat.css",
            title: panel.title,
            rootData: {
                "panel-kind": "active-chat"
            }
        });
        this.panel = panel;
        panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(panel, message).catch((error) => {
                const restore = message.type === "command" && ["chat.send", "chat.queue.add", "chat.steer"].includes(message.command) && isObject(message.payload)
                    ? { restorePrompt: message.payload.prompt, restoreAttachments: message.payload.attachments } : {};
                void panel.webview.postMessage({ type: "event", event: "chat.error", chatId: message.chatId,
                    payload: { message: error instanceof Error ? error.message : "Не удалось выполнить команду.", ...restore } });
            });
        });
        panel.onDidChangeViewState(() => {
            if (panel.visible) {
                this.resetBridge();
                this.postActiveSnapshot();
            }
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
                this.ready = false;
                clearTimeout(this.flushTimer);
                this.flushTimer = undefined;
                this.resetBridge();
                this.featureRequests.clear();
            }
            this.logger.info("Singleton chat panel disposed.");
        });
    }
    async handleMessage(panel, message) {
        if (panel !== this.panel || !message || typeof message !== "object") {
            return;
        }
        if (message.type === "ready") {
            try {
                await this.handlers.ensureHistoryLoaded?.();
            }
            catch (error) {
                await panel.webview.postMessage({ type: "event", event: "chat.error", payload: `Не удалось загрузить историю: ${error instanceof Error ? error.message : "ошибка"}` });
            }
            this.logger.info("Chat panel webview ready.");
            this.logger.info(`Chat panel webview assets: ${message.assetMode ?? "unknown"}.`);
            this.ready = true;
            this.visible = true;
            this.resetBridge();
            this.postActiveSnapshot();
            return;
        }
        if (message.type === "chat.ack") {
            if (message.epoch === this.epoch && message.revision === this.revision && message.chatId === this.panelChatId) {
                this.pressure.ackMaxMs = Math.max(this.pressure.ackMaxMs, Date.now() - this.sentAt);
                for (const [source, target] of [["eventLoopLagMs", "frontendLagMs"], ["receiveMs", "frontendReceiveMs"]]) {
                    const value = message.metrics?.[source];
                    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600000)
                        this.pressure[target] = Math.max(this.pressure[target], value);
                }
                clearTimeout(this.ackTimer);
                this.ackTimer = undefined;
                this.inFlight = false;
                if (this.dirty)
                    this.postActiveSnapshot();
            }
            return;
        }
        if (message.type === "chat.resync" || message.type === "chat.visibility") {
            if (message.type === "chat.visibility")
                this.visible = message.visible !== false;
            if (this.visible)
                this.ready = true;
            this.resetBridge();
            this.postActiveSnapshot();
            return;
        }
        if (message.type === "chat.viewport") {
            if (message.chatId === this.panelChatId && Number.isSafeInteger(message.offset) && message.offset >= 0) {
                this.viewportOffset = message.offset;
                this.postActiveSnapshot();
            }
            return;
        }
        const originChatId = message.chatId ?? this.panelChatId;
        if (message.type === "command" && message.command === "chat.question.respond") {
            const payload = isObject(message.payload) ? message.payload : {};
            const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
            const questionId = typeof payload.questionId === "string" ? payload.questionId : "";
            let result = { messageId, questionId, accepted: false };
            try {
                if (!message.chatId || message.chatId !== this.panelChatId || !this.state.getChat(message.chatId))
                    throw new Error("Вопрос относится к другому или закрытому диалогу.");
                if (!messageId || messageId.length > 1024 || !questionId || questionId.length > 1024 || typeof payload.answer !== "string")
                    throw new Error("Некорректные данные ответа на вопрос.");
                if (!this.handlers.respondToQuestion)
                    throw new Error("Отправка ответа на вопрос недоступна.");
                const response = await this.handlers.respondToQuestion(message.chatId, messageId, questionId, payload.answer);
                result = { ...result, accepted: response?.accepted === true, error: response?.accepted === true ? undefined : response?.error || "Сервер не подтвердил принятие ответа." };
            }
            catch (error) {
                result.error = error instanceof Error ? error.message : "Не удалось отправить ответ на вопрос.";
            }
            await panel.webview.postMessage({ type: "event", event: "chat.question.result", chatId: typeof originChatId === "string" ? originChatId : this.panelChatId, payload: result });
            return;
        }
        if ((!originChatId || !this.state.getChat(originChatId))
            && !(message.type === "features.request" && message.command?.startsWith("history.")))
            return;
        if (message.type === "features.request") {
            const requestId = message.requestId;
            if (!requestId || requestId.length > 128 || this.featureRequests.has(requestId))
                return;
            if (this.featureRequests.size >= 32) {
                await panel.webview.postMessage({ type: "features.result", requestId, error: "Слишком много запросов. Дождитесь завершения текущих." });
                return;
            }
            this.featureRequests.add(requestId);
            try {
                if (!message.command || !FEATURE_COMMANDS.has(message.command) || !this.handlers.featureRequest) {
                    throw new Error("Действие недоступно в этой версии сервера Codex.");
                }
                if (JSON.stringify(message.payload ?? null).length > 262144)
                    throw new Error("Запрос превышает допустимый размер.");
                const result = await this.handlers.featureRequest(message.command, message.payload, originChatId);
                if (message.command === "history.jump" && isObject(result) && typeof result.index === "number" && typeof result.chatId === "string") {
                    this.panelChatId = result.chatId;
                    this.viewportOffset = Math.max(0, result.index - 20);
                    this.resetBridge();
                    this.postActiveSnapshot();
                    await panel.webview.postMessage({ type: "event", event: "chat.jump", chatId: result.chatId, payload: { offset: result.index } });
                }
                await panel.webview.postMessage({ type: "features.result", requestId, chatId: originChatId, result });
            }
            catch (error) {
                await panel.webview.postMessage({ type: "features.result", requestId, chatId: originChatId,
                    error: error instanceof Error ? error.message : "Не удалось выполнить действие." });
            }
            finally {
                this.featureRequests.delete(requestId);
            }
            return;
        }
        if (message.type !== "command") {
            return;
        }
        if (message.command === "clipboard.write") {
            const payload = isObject(message.payload) ? message.payload : {};
            try {
                if (typeof payload.text !== "string" || payload.text.length > 2000000)
                    throw new Error("Текст для копирования слишком большой.");
                await vscode.env.clipboard.writeText(payload.text);
                await panel.webview.postMessage({ type: "event", event: "clipboard.result", chatId: originChatId, payload: { requestId: payload.requestId, ok: true } });
            }
            catch (error) {
                await panel.webview.postMessage({ type: "event", event: "chat.error", chatId: originChatId, payload: error instanceof Error ? error.message : "Не удалось скопировать текст." });
            }
            return;
        }
        if (message.command === "chat.userInput.respond") {
            const payload = isObject(message.payload) ? message.payload : {};
            try {
                if (typeof payload.id !== "string" || !this.handlers.resolveUserInput)
                    throw new Error("Обработка ответа на вопрос недоступна.");
                const response = payload.response === null ? null : payload.response;
                if (response !== null && (!isObject(response) || !isObject(response.answers)))
                    throw new Error("Некорректный ответ.");
                const accepted = await this.handlers.resolveUserInput(originChatId, payload.id, response);
                await panel.webview.postMessage({ type: "event", event: "chat.userInput.result", chatId: originChatId,
                    payload: { id: payload.id, accepted, error: accepted ? undefined : "Вопрос уже закрыт или относится к другому запросу." } });
            }
            catch (error) {
                await panel.webview.postMessage({ type: "event", event: "chat.userInput.result", chatId: originChatId,
                    payload: { id: payload.id, accepted: false, error: error instanceof Error ? error.message : "Некорректный ответ." } });
            }
            return;
        }
        if (message.command === "chat.queue.retry") {
            const id = isObject(message.payload) ? message.payload.messageId : undefined;
            if (typeof id === "string" && this.handlers.retryQueuedPrompt)
                await this.handlers.retryQueuedPrompt(originChatId, id);
            return;
        }
        if (message.command === "chat.turn.load") {
            const payload = isObject(message.payload) ? message.payload : {};
            const getter = this.state.getTurnTranscriptWindow;
            const window = typeof payload.turnId === "string" && getter
                ? getter.call(this.state, originChatId, payload.turnId, Math.max(0, Number(payload.offset) || 0), 40) : null;
            const projected = isObject(window) && Array.isArray(window.items)
                ? { ...window, turns: [], items: window.items.map(item => projectTranscriptItem(item)) } : null;
            await panel.webview.postMessage({ type: "event", event: "chat.turn.window", chatId: originChatId,
                payload: { requestId: payload.requestId, turnId: payload.turnId, window: projected } });
            return;
        }
        if (message.command === "chat.item.load") {
            const payload = isObject(message.payload) ? message.payload : {};
            const item = typeof payload.id === "string"
                ? this.state.exportChatHistory().transcripts[originChatId]?.find(value => value.id === payload.id) : undefined;
            const offset = Math.max(0, Math.floor(Number(payload.offset) || 0));
            await panel.webview.postMessage({ type: "event", event: "chat.item.detail", chatId: originChatId,
                payload: { requestId: payload.requestId, item: item ? projectTranscriptItem(item, offset) : null } });
            return;
        }
        if (message.command === "chat.attachments.pick") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            try {
                const attachments = await this.handlers.pickAttachments(isObject(message.payload) ? message.payload.attachments : []);
                await panel.webview.postMessage({ type: "event", event: "chat.attachments.selected", payload: { chatId, attachments } });
            }
            catch (error) {
                await panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.attachments.error",
                    payload: { chatId, message: error instanceof Error ? error.message : "Не удалось прикрепить файл." }
                });
            }
            return;
        }
        if (message.command === "chat.attachment.upload.start") {
            const payload = isObject(message.payload) ? message.payload : {};
            const chatId = originChatId;
            if (!chatId || !this.state.getChat(chatId)) {
                return;
            }
            try {
                const result = await this.handlers.startAttachmentUpload(chatId, payload);
                await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.ready", payload: { chatId, ...result } });
            }
            catch (error) {
                await this.postAttachmentUploadError(panel, chatId, payload, error);
            }
            return;
        }
        if (message.command === "chat.attachment.upload.chunk") {
            try {
                const result = await this.handlers.appendAttachmentUpload(message.payload);
                await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.chunkAccepted", payload: result });
            }
            catch (error) {
                await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
                await this.postAttachmentUploadError(panel, "", message.payload, error);
            }
            return;
        }
        if (message.command === "chat.attachment.upload.complete") {
            try {
                const result = await this.handlers.completeAttachmentUpload(message.payload);
                await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.completed", payload: result });
            }
            catch (error) {
                await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
                await this.postAttachmentUploadError(panel, "", message.payload, error);
            }
            return;
        }
        if (message.command === "chat.attachment.upload.cancel") {
            await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
            return;
        }
        if (message.command === "chat.attachment.discard") {
            await this.handlers.discardAttachment(isObject(message.payload) ? message.payload.attachment : undefined).catch((error) => {
                this.logger.warn(`Managed attachment cleanup failed: ${error instanceof Error ? error.message : "unknown error"}.`);
            });
            return;
        }
        if (message.command === "chat.attachment.open") {
            try {
                await this.handlers.openAttachment(isObject(message.payload) ? message.payload.attachment : undefined);
            }
            catch (error) {
                await panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.attachments.error",
                    payload: error instanceof Error ? error.message : "Вложение недоступно."
                });
            }
            return;
        }
        if (message.command === "chat.transcript.loadBefore") {
            const chatId = originChatId;
            const beforeItemId = isObject(message.payload) && typeof message.payload.beforeItemId === "string" ? message.payload.beforeItemId : "";
            const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
            const beforeOffset = isObject(message.payload) && typeof message.payload.beforeOffset === "number" ? message.payload.beforeOffset : undefined;
            if (!chatId || !beforeItemId) {
                return;
            }
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.transcript.window",
                payload: {
                    mode: "before",
                    chatId,
                    requestId,
                    window: this.state.getTranscriptBefore(chatId, beforeItemId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined, beforeOffset)
                }
            });
            return;
        }
        if (message.command === "chat.transcript.loadAfter") {
            const chatId = originChatId;
            const afterItemId = isObject(message.payload) && typeof message.payload.afterItemId === "string" ? message.payload.afterItemId : "";
            const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
            const afterOffset = isObject(message.payload) && typeof message.payload.afterOffset === "number" ? message.payload.afterOffset : undefined;
            if (!chatId || !afterItemId) {
                return;
            }
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.transcript.window",
                payload: {
                    mode: "after",
                    chatId,
                    requestId,
                    window: this.state.getTranscriptAfter(chatId, afterItemId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined, afterOffset)
                }
            });
            return;
        }
        if (message.command === "chat.transcript.tail") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.transcript.window",
                payload: {
                    mode: "tail",
                    window: this.state.getTranscriptTail(chatId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined)
                }
            });
            return;
        }
        if (message.command === "chat.readToBottom") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            this.handlers.markReadToBottom(chatId);
            return;
        }
        if (message.command === "chat.rules.toggle") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            await this.handlers.toggleRules(chatId);
            return;
        }
        if (message.command === "chat.rules.open") {
            await this.handlers.openRules();
            return;
        }
        if (message.command === "chat.restore") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            await this.handlers.restoreChat(chatId);
            return;
        }
        if (message.command === "chat.header.toggle") {
            await this.handlers.setChatHeaderMode(this.state.getChatHeaderMode() === "collapsed" ? "expanded" : "collapsed");
            return;
        }
        if (message.command === "chat.access.set") {
            const chatId = originChatId;
            const accessMode = isObject(message.payload) ? parseAccessMode(message.payload.accessMode) : undefined;
            if (!chatId || !accessMode) {
                return;
            }
            this.handlers.setAccessMode(chatId, accessMode);
            return;
        }
        if (message.command === "chat.model.set") {
            const chatId = originChatId;
            const model = isObject(message.payload) ? parseModelSelection(message.payload) : undefined;
            if (!chatId || !model) {
                return;
            }
            this.handlers.setModel(chatId, model.modelId, model.modelLabel);
            return;
        }
        if (message.command === "chat.effort.set") {
            const chatId = originChatId;
            const effort = isObject(message.payload) ? parseEffort(message.payload.effort) : undefined;
            if (!chatId || !effort) {
                return;
            }
            this.handlers.setEffort(chatId, effort);
            return;
        }
        if (message.command === "chat.speed.set") {
            const chatId = originChatId;
            const speed = isObject(message.payload) ? parseSpeed(message.payload.speed) : undefined;
            if (!chatId || !speed) {
                return;
            }
            this.handlers.setSpeed(chatId, speed);
            return;
        }
        if (message.command === "chat.models.load") {
            await this.handlers.loadModels(isObject(message.payload) && message.payload.forceReload === true);
            return;
        }
        if (message.command === "chat.skills.load") {
            try {
                this.skillOptions = await this.handlers.loadSkills(isObject(message.payload) && message.payload.forceReload === true);
                await panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.skills.options",
                    payload: this.skillOptions
                });
            }
            catch (error) {
                await panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.skills.error",
                    payload: error instanceof Error ? error.message : "Не удалось загрузить навыки."
                });
            }
            return;
        }
        if (message.command === "chat.context.projectDetails") {
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.context.details",
                payload: await this.handlers.getProjectContextDetails()
            });
            return;
        }
        if (message.command === "chat.context.docsDetails") {
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.context.details",
                payload: await this.handlers.getDocsContextDetails()
            });
            return;
        }
        if (message.command === "chat.plan.revise") {
            panel.webview.postMessage({
                chatId: originChatId,
                type: "event",
                event: "chat.plan.reviseDraft",
                payload: isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : ""
            });
            return;
        }
        if (message.command === "chat.plan.implement") {
            const chatId = originChatId;
            const planText = isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : "";
            if (!chatId || !planText.trim()) {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: "План не найден."
                });
                return;
            }
            await this.handlers.implementPlan(chatId, planText);
            return;
        }
        if (message.command === "diff.openNative") {
            const chatId = originChatId;
            const diffId = isObject(message.payload) && typeof message.payload.diffId === "string" ? message.payload.diffId : "";
            const fileIndex = isObject(message.payload) ? parseFileIndex(message.payload.fileIndex) : undefined;
            if (!chatId || !diffId || fileIndex === undefined) {
                return;
            }
            await this.handlers.openDiffInEditor(chatId, diffId, fileIndex);
            return;
        }
        if (message.command === "markdown.openLink") {
            const target = isObject(message.payload) && typeof message.payload.target === "string" ? message.payload.target : "";
            await openMarkdownTarget(target);
            return;
        }
        if (message.command === "approval.approve" || message.command === "approval.deny") {
            const chatId = originChatId;
            if (!chatId || !isObject(message.payload) || typeof message.payload.approvalId !== "string") {
                return;
            }
            await this.handlers.resolveApproval(chatId, message.payload.approvalId, message.command === "approval.approve");
            return;
        }
        this.logger.info(`Chat panel command: ${message.command}`);
        if (message.command === "chat.cancel") {
            const chatId = originChatId;
            if (!chatId) {
                return;
            }
            await this.handlers.cancelTurn(chatId);
            return;
        }
        if (message.command === "chat.queue.remove") {
            const chatId = originChatId;
            const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
            if (chatId && messageId) {
                this.handlers.removeQueuedPrompt(chatId, messageId);
            }
            return;
        }
        if (message.command === "chat.queue.move") {
            const chatId = originChatId;
            const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
            const direction = isObject(message.payload) && message.payload.direction === "up" ? "up" : "down";
            if (chatId && messageId) {
                this.handlers.moveQueuedPrompt(chatId, messageId, direction);
            }
            return;
        }
        if (message.command === "chat.queue.add" || message.command === "chat.steer") {
            const chatId = originChatId;
            const prompt = isObject(message.payload) && typeof message.payload.prompt === "string" ? message.payload.prompt.trim() : "";
            const attachments = await this.handlers.resolveAttachments(isObject(message.payload) ? message.payload.attachments : []);
            if (!chatId || (!prompt && !attachments.length)) {
                return;
            }
            try {
                if (message.command === "chat.steer") {
                    await this.handlers.steerTurn(chatId, prompt, attachments);
                }
                else if (!await this.handlers.queuePrompt(chatId, prompt, isObject(message.payload) ? parseRunMode(message.payload.mode) : "normal", this.parseSelectedSkills(message.payload), attachments)) {
                    throw new Error("Сообщение можно поставить в очередь только во время активного запроса.");
                }
            }
            catch (error) {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: {
                        message: error instanceof Error ? error.message : "Не удалось отправить сообщение.",
                        restorePrompt: prompt,
                        restoreAttachments: attachments
                    }
                });
            }
            return;
        }
        if (message.command === "chat.send") {
            const chatId = originChatId;
            if (!chatId) {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: "Выберите диалог в sidebar или создайте новый."
                });
                return;
            }
            const chat = this.state.getChat(chatId);
            if (chat?.archivedAt) {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: "Диалог в архиве. Восстановите его, чтобы продолжить."
                });
                return;
            }
            if (!isObject(message.payload) || typeof message.payload.prompt !== "string") {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: "Введите сообщение для Codex."
                });
                return;
            }
            const mode = parseRunMode(message.payload.mode);
            const attachments = await this.handlers.resolveAttachments(message.payload.attachments);
            if (!message.payload.prompt.trim() && !attachments.length) {
                panel.webview.postMessage({ chatId: originChatId, type: "event", event: "chat.error", payload: "Введите сообщение или прикрепите файл." });
                return;
            }
            try {
                await this.handlers.sendPrompt(chatId, message.payload.prompt, mode, undefined, this.parseSelectedSkills(message.payload), attachments);
            }
            catch (error) {
                panel.webview.postMessage({
                    chatId: originChatId,
                    type: "event",
                    event: "chat.error",
                    payload: {
                        message: error instanceof Error ? error.message : "Не удалось отправить сообщение.",
                        restorePrompt: message.payload.prompt,
                        restoreAttachments: attachments
                    }
                });
            }
            return;
        }
        panel.webview.postMessage({
            chatId: originChatId,
            type: "event",
            event: "chat.error",
            payload: `Команда ${message.command} пока не подключена.`
        });
    }
    async postAttachmentUploadError(panel, chatId, value, error) {
        const payload = isObject(value) ? value : {};
        await panel.webview.postMessage({
            type: "event",
            event: "chat.attachment.upload.error",
            payload: {
                chatId,
                uploadId: typeof payload.uploadId === "string" ? payload.uploadId : "",
                message: error instanceof Error ? error.message : "Не удалось загрузить файл."
            }
        });
    }
    parseSelectedSkills(payload) {
        if (!isObject(payload) || !Array.isArray(payload.skills) || !this.skillOptions.length) {
            return [];
        }
        const allowed = new Map(this.skillOptions
            .filter((skill) => skill.enabled)
            .map((skill) => [`${skill.name}\0${skill.path}`, skill]));
        const selected = new Map();
        for (const candidate of payload.skills.slice(0, 8)) {
            if (!isObject(candidate) || typeof candidate.name !== "string" || typeof candidate.path !== "string") {
                continue;
            }
            const skill = allowed.get(`${candidate.name}\0${candidate.path}`);
            if (skill) {
                selected.set(skill.path, { name: skill.name, path: skill.path });
            }
        }
        return [...selected.values()];
    }
}
exports.ChatPanelManager = ChatPanelManager;
function projectTranscriptItem(item, detailOffset) {
    const preview = (value) => value && value.length > 12000 ? `${value.slice(0, 12000)}\n[Превью ограничено]` : value;
    const start = detailOffset ?? 0;
    if (item.kind === "turn-run")
        return { ...item, activityIds: [], worklogIds: [], diffIds: [], compactionIds: [] };
    if (item.kind === "worklog")
        return Object.assign({ ...item,
            children: detailOffset === undefined ? [] : item.children.slice(start, start + 20).map(child => ({ ...child, outputPreview: preview(child.outputPreview), argumentsPreview: preview(child.argumentsPreview) }))
        }, { detailAvailable: true, detailCount: item.children.length });
    if (item.kind === "activity")
        return Object.assign({ ...item,
            outputPreview: detailOffset === undefined ? undefined : preview(item.outputPreview),
            details: detailOffset === undefined ? [] : item.details?.slice(start, start + 20).map(detail => ({ ...detail, outputPreview: preview(detail.outputPreview) }))
        }, { detailAvailable: true, detailCount: item.details?.length ?? 0 });
    if (item.kind === "diff")
        return Object.assign({ ...item,
            files: item.files.slice(start, start + 20).map(file => ({ ...file, diff: detailOffset === undefined ? undefined : preview(file.diff) }))
        }, { detailAvailable: true, detailCount: item.files.length });
    return item;
}
function parsePanelState(rawState) {
    if (!rawState || typeof rawState !== "object") {
        return {};
    }
    const value = rawState;
    const activeChatId = typeof value.activeChatId === "string" ? value.activeChatId : undefined;
    const chatId = typeof value.chatId === "string" ? value.chatId : undefined;
    return { activeChatId, chatId };
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function parseAccessMode(value) {
    if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
        return value;
    }
    return undefined;
}
function parseEffort(value) {
    if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra") {
        return value;
    }
    return undefined;
}
function parseSpeed(value) {
    if (value === "standard" || value === "fast") {
        return value;
    }
    return undefined;
}
function parseFileIndex(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
async function openMarkdownTarget(rawTarget) {
    const target = decodeMarkdownTarget(rawTarget.trim());
    if (!target) {
        return;
    }
    if (/^https?:\/\//i.test(target)) {
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return;
    }
    const parsedTarget = (0, markdownFileLink_1.parseMarkdownFileTarget)(target);
    const fileUri = await resolveMarkdownFileUri(parsedTarget.path);
    if (!fileUri) {
        vscode.window.showWarningMessage("Не удалось открыть ссылку из ответа Codex.");
        return;
    }
    try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const line = Math.min(Math.max(0, (parsedTarget.line ?? 1) - 1), Math.max(0, document.lineCount - 1));
        const column = Math.min(Math.max(0, (parsedTarget.column ?? 1) - 1), document.lineAt(line).range.end.character);
        const position = new vscode.Position(line, column);
        await vscode.window.showTextDocument(document, {
            preview: true,
            selection: new vscode.Range(position, position)
        });
    }
    catch {
        vscode.window.showWarningMessage(`Не удалось открыть файл: ${fileUri.fsPath || parsedTarget.path}`);
    }
}
async function resolveMarkdownFileUri(target) {
    const directUri = markdownTargetToFileUri(target);
    if (directUri && await isFile(directUri)) {
        return directUri;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const relativePath of (0, markdownFileLink_1.workspaceRelativePathCandidates)(target, folder.name)) {
            const candidate = vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
            if (await isFile(candidate)) {
                return candidate;
            }
        }
    }
    return directUri;
}
function markdownTargetToFileUri(target) {
    if (/^[a-zA-Z]:[\\/]/.test(target) || /^[a-zA-Z]:\//.test(target)) {
        return vscode.Uri.file(target);
    }
    if (target.startsWith("/") || target.startsWith("\\\\")) {
        return vscode.Uri.file(target);
    }
    if (/^file:\/\//i.test(target)) {
        const uri = vscode.Uri.parse(target);
        return uri.scheme === "file" ? uri : undefined;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
        return undefined;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    return workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, ...target.replace(/\\/g, "/").split("/").filter(Boolean)) : undefined;
}
async function isFile(uri) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.File) !== 0;
    }
    catch {
        return false;
    }
}
function decodeMarkdownTarget(value) {
    try {
        return decodeURI(value);
    }
    catch {
        return value;
    }
}
function parseRunMode(value) {
    return value === "planning" || value === "implementPlan" ? value : "normal";
}
function parseTranscriptCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(1, Math.min(40, Math.floor(value)));
}
function parseModelSelection(payload) {
    const rawModelId = payload.modelId;
    const modelId = typeof rawModelId === "string" && rawModelId.trim() ? rawModelId.trim() : null;
    const modelLabel = typeof payload.modelLabel === "string" && payload.modelLabel.trim() ? payload.modelLabel.trim() : "";
    if (!modelLabel) {
        return undefined;
    }
    return { modelId, modelLabel };
}
//# sourceMappingURL=chatPanelManager.js.map