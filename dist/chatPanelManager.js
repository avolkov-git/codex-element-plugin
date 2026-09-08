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
const markdownFileLink_1 = require("./markdownFileLink");
const panelIcon_1 = require("./panelIcon");
const webviewHtml_1 = require("./webviewHtml");
exports.CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";
class ChatPanelManager {
    constructor(context, state, logger, handlers) {
        this.context = context;
        this.state = state;
        this.logger = logger;
        this.handlers = handlers;
        this.skillOptions = [];
    }
    registerSerializer() {
        return vscode.window.registerWebviewPanelSerializer(exports.CHAT_PANEL_VIEW_TYPE, {
            deserializeWebviewPanel: async (panel, rawState) => {
                if (this.panel) {
                    panel.dispose();
                    return;
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
        this.panel?.webview.postMessage({
            type: "chat.snapshot",
            snapshot: this.state.getActiveChatSnapshot() ?? null
        });
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
            void this.handleMessage(panel, message);
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
            }
            this.logger.info("Singleton chat panel disposed.");
        });
    }
    async handleMessage(panel, message) {
        if (!message || typeof message !== "object") {
            return;
        }
        if (message.type === "ready") {
            this.logger.info("Chat panel webview ready.");
            this.logger.info(`Chat panel webview assets: ${message.assetMode ?? "unknown"}.`);
            this.postActiveSnapshot();
            return;
        }
        if (message.type !== "command") {
            return;
        }
        if (message.command === "chat.attachments.pick") {
            const chatId = this.state.getActiveChatId();
            if (!chatId) {
                return;
            }
            try {
                const attachments = await this.handlers.pickAttachments(isObject(message.payload) ? message.payload.attachments : []);
                await panel.webview.postMessage({ type: "event", event: "chat.attachments.selected", payload: { chatId, attachments } });
            }
            catch (error) {
                await panel.webview.postMessage({
                    type: "event",
                    event: "chat.attachments.error",
                    payload: { chatId, message: error instanceof Error ? error.message : "Не удалось прикрепить файл." }
                });
            }
            return;
        }
        if (message.command === "chat.attachment.upload.start") {
            const payload = isObject(message.payload) ? message.payload : {};
            const chatId = typeof payload.chatId === "string" ? payload.chatId : this.state.getActiveChatId();
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
                    type: "event",
                    event: "chat.attachments.error",
                    payload: error instanceof Error ? error.message : "Вложение недоступно."
                });
            }
            return;
        }
        if (message.command === "chat.transcript.loadBefore") {
            const chatId = this.state.getActiveChatId();
            const beforeItemId = isObject(message.payload) && typeof message.payload.beforeItemId === "string" ? message.payload.beforeItemId : "";
            const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
            const beforeOffset = isObject(message.payload) && typeof message.payload.beforeOffset === "number" ? message.payload.beforeOffset : undefined;
            if (!chatId || !beforeItemId) {
                return;
            }
            panel.webview.postMessage({
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
            const chatId = this.state.getActiveChatId();
            const afterItemId = isObject(message.payload) && typeof message.payload.afterItemId === "string" ? message.payload.afterItemId : "";
            const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
            const afterOffset = isObject(message.payload) && typeof message.payload.afterOffset === "number" ? message.payload.afterOffset : undefined;
            if (!chatId || !afterItemId) {
                return;
            }
            panel.webview.postMessage({
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
            const chatId = this.state.getActiveChatId();
            if (!chatId) {
                return;
            }
            panel.webview.postMessage({
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
            const chatId = this.state.getActiveChatId();
            if (!chatId) {
                return;
            }
            this.handlers.markReadToBottom(chatId);
            return;
        }
        if (message.command === "chat.rules.toggle") {
            const chatId = this.state.getActiveChatId();
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
            const chatId = this.state.getActiveChatId();
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
            const chatId = this.state.getActiveChatId();
            const accessMode = isObject(message.payload) ? parseAccessMode(message.payload.accessMode) : undefined;
            if (!chatId || !accessMode) {
                return;
            }
            this.handlers.setAccessMode(chatId, accessMode);
            return;
        }
        if (message.command === "chat.model.set") {
            const chatId = this.state.getActiveChatId();
            const model = isObject(message.payload) ? parseModelSelection(message.payload) : undefined;
            if (!chatId || !model) {
                return;
            }
            this.handlers.setModel(chatId, model.modelId, model.modelLabel);
            return;
        }
        if (message.command === "chat.effort.set") {
            const chatId = this.state.getActiveChatId();
            const effort = isObject(message.payload) ? parseEffort(message.payload.effort) : undefined;
            if (!chatId || !effort) {
                return;
            }
            this.handlers.setEffort(chatId, effort);
            return;
        }
        if (message.command === "chat.speed.set") {
            const chatId = this.state.getActiveChatId();
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
                    type: "event",
                    event: "chat.skills.options",
                    payload: this.skillOptions
                });
            }
            catch (error) {
                await panel.webview.postMessage({
                    type: "event",
                    event: "chat.skills.error",
                    payload: error instanceof Error ? error.message : "Не удалось загрузить навыки."
                });
            }
            return;
        }
        if (message.command === "chat.context.projectDetails") {
            panel.webview.postMessage({
                type: "event",
                event: "chat.context.details",
                payload: await this.handlers.getProjectContextDetails()
            });
            return;
        }
        if (message.command === "chat.context.docsDetails") {
            panel.webview.postMessage({
                type: "event",
                event: "chat.context.details",
                payload: await this.handlers.getDocsContextDetails()
            });
            return;
        }
        if (message.command === "chat.plan.revise") {
            panel.webview.postMessage({
                type: "event",
                event: "chat.plan.reviseDraft",
                payload: isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : ""
            });
            return;
        }
        if (message.command === "chat.plan.implement") {
            const chatId = this.state.getActiveChatId();
            const planText = isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : "";
            if (!chatId || !planText.trim()) {
                panel.webview.postMessage({
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
            const chatId = this.state.getActiveChatId();
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
            const chatId = this.state.getActiveChatId();
            if (!chatId || !isObject(message.payload) || typeof message.payload.approvalId !== "string") {
                return;
            }
            await this.handlers.resolveApproval(chatId, message.payload.approvalId, message.command === "approval.approve");
            return;
        }
        this.logger.info(`Chat panel command: ${message.command}`);
        if (message.command === "chat.cancel") {
            const chatId = this.state.getActiveChatId();
            if (!chatId) {
                return;
            }
            await this.handlers.cancelTurn(chatId);
            return;
        }
        if (message.command === "chat.queue.remove") {
            const chatId = this.state.getActiveChatId();
            const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
            if (chatId && messageId) {
                this.handlers.removeQueuedPrompt(chatId, messageId);
            }
            return;
        }
        if (message.command === "chat.queue.move") {
            const chatId = this.state.getActiveChatId();
            const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
            const direction = isObject(message.payload) && message.payload.direction === "up" ? "up" : "down";
            if (chatId && messageId) {
                this.handlers.moveQueuedPrompt(chatId, messageId, direction);
            }
            return;
        }
        if (message.command === "chat.queue.add" || message.command === "chat.steer") {
            const chatId = this.state.getActiveChatId();
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
            const chatId = this.state.getActiveChatId();
            if (!chatId) {
                panel.webview.postMessage({
                    type: "event",
                    event: "chat.error",
                    payload: "Выберите диалог в sidebar или создайте новый."
                });
                return;
            }
            const chat = this.state.getChat(chatId);
            if (chat?.archivedAt) {
                panel.webview.postMessage({
                    type: "event",
                    event: "chat.error",
                    payload: "Диалог в архиве. Восстановите его, чтобы продолжить."
                });
                return;
            }
            if (!isObject(message.payload) || typeof message.payload.prompt !== "string") {
                panel.webview.postMessage({
                    type: "event",
                    event: "chat.error",
                    payload: "Введите сообщение для Codex."
                });
                return;
            }
            const mode = parseRunMode(message.payload.mode);
            const attachments = await this.handlers.resolveAttachments(message.payload.attachments);
            if (!message.payload.prompt.trim() && !attachments.length) {
                panel.webview.postMessage({ type: "event", event: "chat.error", payload: "Введите сообщение или прикрепите файл." });
                return;
            }
            try {
                await this.handlers.sendPrompt(chatId, message.payload.prompt, mode, undefined, this.parseSelectedSkills(message.payload), attachments);
            }
            catch (error) {
                panel.webview.postMessage({
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