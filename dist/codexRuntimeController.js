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
exports.CodexRuntimeController = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const jsonRpcClient_1 = require("./jsonRpcClient");
const logger_1 = require("./logger");
const runtimeProcessManager_1 = require("./runtimeProcessManager");
class CodexRuntimeController {
    constructor(options) {
        this.options = options;
        this.processManager = new runtimeProcessManager_1.RuntimeProcessManager();
        this.activeTurnChatId = new Map();
        this.activeThreadChatId = new Map();
        this.itemPayloads = new Map();
        this.pendingApprovals = new Map();
        this.restoreAttempted = false;
    }
    async restoreAccountIfAvailable() {
        if (this.restoreAttempted || this.options.state.getSidebarSnapshot().auth.status === "authenticated") {
            return;
        }
        this.restoreAttempted = true;
        const profileId = await this.options.profiles.getKnownProfileId(this.options.settings.listExistingProfileIds());
        if (!profileId) {
            this.options.logger.info("Auth restore skipped: no known Codex profile.");
            return;
        }
        try {
            this.updateAuth({
                status: "checking",
                profileLabel: profileId,
                message: "Проверяем сохраненную авторизацию Codex..."
            });
            await this.ensureBackendProcess();
        }
        catch (error) {
            const message = normalizeAuthError(error);
            this.updateAuth({
                status: "error",
                message
            });
            this.options.logger.warn(`Auth restore failed: ${message}`);
        }
    }
    async startDeviceCodeLogin() {
        try {
            await this.ensureBackendProcess();
            const rpcClient = this.requireRpcClient();
            this.updateAuth({
                status: "checking",
                message: "Запрашиваем Device Code у Codex runtime...",
                deviceCode: {
                    status: "starting",
                    loginId: "",
                    verificationUrl: "",
                    userCode: ""
                }
            });
            const result = await rpcClient.request("account/login/start", {
                type: "chatgptDeviceCode"
            });
            const challenge = normalizeDeviceCodeChallenge(result);
            this.updateAuth({
                status: "checking",
                message: "Откройте URL в браузере, введите код и дождитесь завершения login на сервере Element.",
                deviceCode: {
                    status: "awaiting",
                    loginId: challenge.loginId,
                    verificationUrl: challenge.verificationUrl,
                    userCode: challenge.userCode
                }
            });
            this.options.logger.info(`Device Code login started: loginId=${challenge.loginId || "-"}; verificationUrl=${challenge.verificationUrl ? "set" : "-"}.`);
            await this.openDeviceCodeUrl();
        }
        catch (error) {
            const message = normalizeAuthError(error);
            this.updateAuth({
                status: "error",
                message,
                deviceCode: { status: "error" }
            });
            this.options.logger.warn(`Device Code login failed: ${message}`);
        }
    }
    async loginWithApiKey(apiKey) {
        const trimmed = apiKey.trim();
        if (!trimmed) {
            this.updateAuth({
                status: "error",
                message: "Введите API key.",
                apiKey: { status: "error" }
            });
            return;
        }
        try {
            await this.ensureBackendProcess();
            const rpcClient = this.requireRpcClient();
            this.updateAuth({
                status: "checking",
                message: "Передаем API key в Codex runtime. Ключ не пишется в логи.",
                apiKey: { status: "starting" }
            });
            await rpcClient.request("account/login/start", {
                type: "apiKey",
                apiKey: trimmed
            });
            this.options.logger.info("account/login/start apiKey accepted.");
            this.updateAuth({
                status: "checking",
                message: "API key передан. Читаем account state...",
                apiKey: { status: "awaiting" }
            });
            await this.readAccount();
        }
        catch (error) {
            const message = normalizeAuthError(error);
            this.updateAuth({
                status: "error",
                message,
                apiKey: { status: "error" }
            });
            this.options.logger.warn(`API key login failed: ${message}`);
        }
    }
    async openDeviceCodeUrl() {
        const url = this.options.state.getSidebarSnapshot().auth.deviceCode.verificationUrl;
        if (!url) {
            this.updateAuth({ message: "Device Code URL еще не получен." });
            return;
        }
        try {
            await vscode.env.openExternal(vscode.Uri.parse(url));
            this.options.logger.info("Device Code URL openExternal requested.");
        }
        catch (error) {
            this.options.logger.warn(`Device Code openExternal failed: ${normalizeErrorMessage(error)}`);
        }
    }
    async copyDeviceCode() {
        const code = this.options.state.getSidebarSnapshot().auth.deviceCode.userCode;
        if (!code) {
            this.updateAuth({ message: "Device Code еще не получен." });
            return;
        }
        await vscode.env.clipboard.writeText(code);
        this.updateAuth({ message: "Device Code скопирован." });
    }
    async sendPrompt(chatId, prompt) {
        const trimmed = prompt.trim();
        if (!trimmed) {
            return;
        }
        const chat = this.options.state.getChat(chatId);
        if (!chat) {
            throw new Error("Чат не найден.");
        }
        this.latestChatId = chatId;
        this.options.state.addTranscriptItem(chatId, "user", trimmed);
        this.options.state.updateChat(chatId, { status: "running" });
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        try {
            await this.ensureBackendProcess();
            await this.ensureAuthenticatedForTurn();
            if (!this.options.state.getChat(chatId)?.backendThreadId) {
                await this.startBackendThread(chatId);
            }
            const existingThreadId = this.options.state.getChat(chatId)?.backendThreadId;
            if (existingThreadId) {
                this.activeThreadChatId.set(existingThreadId, chatId);
            }
            let turnResult;
            try {
                turnResult = await this.startTurn(chatId, trimmed);
            }
            catch (error) {
                if (!isThreadNotFoundError(error) || !this.options.state.getChat(chatId)?.backendThreadId) {
                    throw error;
                }
                const staleThreadId = this.options.state.getChat(chatId)?.backendThreadId;
                this.options.logger.warn(`Backend thread was not found by runtime, recreating: ${staleThreadId ?? "-"}.`);
                if (staleThreadId) {
                    this.activeThreadChatId.delete(staleThreadId);
                }
                this.options.state.updateChat(chatId, {
                    backendThreadId: null,
                    activeTurnId: null
                });
                await this.startBackendThread(chatId);
                turnResult = await this.startTurn(chatId, trimmed);
            }
            const turnId = extractTurnId(turnResult);
            if (turnId) {
                this.activeTurnChatId.set(turnId, chatId);
            }
            this.options.state.updateChat(chatId, {
                activeTurnId: turnId || null,
                status: "running"
            });
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            this.options.logger.info(`turn/start accepted: turn=${turnId || "-"}.`);
        }
        catch (error) {
            const message = normalizeErrorMessage(error);
            this.options.state.updateChat(chatId, {
                status: "error",
                activeTurnId: null
            });
            this.options.state.addTranscriptItem(chatId, "system", message);
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            this.options.logger.error(`sendPrompt failed: ${message}`);
        }
    }
    resolveApproval(chatId, approvalId, approved) {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending || pending.chatId !== chatId) {
            this.options.logger.warn(`Approval decision ignored: pending request not found (${approvalId}).`);
            return;
        }
        this.pendingApprovals.delete(approvalId);
        this.options.state.setPendingApproval(chatId, null);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        pending.resolve(approved);
        this.options.logger.info(`Approval ${approved ? "accepted" : "declined"}: request=${approvalId}.`);
    }
    async readAccount() {
        if (!this.processManager.isRunning) {
            await this.ensureBackendProcess();
            return;
        }
        const rpcClient = this.requireRpcClient();
        this.updateAuth({
            status: "checking",
            message: "Выполняем account/read..."
        });
        try {
            const result = await rpcClient.request("account/read", { refreshToken: false });
            const account = normalizeAccountReadResult(result);
            this.updateAuth({
                status: account.accountType === "apiKey" || account.accountType === "chatgpt" ? "authenticated" : "notAuthenticated",
                accountType: account.accountType,
                accountLabel: account.label,
                message: account.message,
                apiKey: {
                    status: account.accountType === "apiKey" ? "success" : this.options.state.getSidebarSnapshot().auth.apiKey.status
                },
                deviceCode: {
                    status: account.accountType === "chatgpt" ? "success" : this.options.state.getSidebarSnapshot().auth.deviceCode.status
                }
            });
            this.options.logger.info(`account/read completed: account=${account.accountType}.`);
        }
        catch (error) {
            const message = normalizeAuthError(error);
            this.updateAuth({
                status: "error",
                message
            });
            this.options.logger.warn(`account/read failed: ${message}`);
        }
    }
    async ensureAuthenticatedForTurn() {
        if (this.options.state.getSidebarSnapshot().auth.status !== "authenticated") {
            await this.readAccount();
        }
        if (this.options.state.getSidebarSnapshot().auth.status !== "authenticated") {
            throw new Error("Codex не авторизован. Сначала выполните DEVICE CODE или API KEY login.");
        }
    }
    async startBackendThread(chatId) {
        const rpcClient = this.requireRpcClient();
        const cwd = resolveWorkspaceCwd(this.options.context);
        const chat = this.options.state.getChat(chatId);
        const accessMode = chat?.accessMode ?? (chat?.kind === "project" ? "workspace-write" : "read-only");
        const result = await rpcClient.request("thread/start", {
            cwd,
            approvalPolicy: getApprovalPolicy(accessMode),
            approvalsReviewer: "user",
            sandbox: getThreadSandbox(accessMode),
            sessionStartSource: "startup",
            serviceName: "codex_element_v1",
            model: null
        });
        const threadId = extractThreadId(result);
        if (!threadId) {
            throw new Error("thread/start не вернул thread.id.");
        }
        this.options.state.updateChat(chatId, { backendThreadId: threadId });
        this.activeThreadChatId.set(threadId, chatId);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        this.options.logger.info(`thread/start completed: thread=${threadId}.`);
    }
    async startTurn(chatId, prompt) {
        const chat = this.options.state.getChat(chatId);
        if (!chat?.backendThreadId) {
            throw new Error("Backend thread не готов.");
        }
        const cwd = resolveWorkspaceCwd(this.options.context);
        const routing = this.options.contextRouter.decide(prompt, chat.kind);
        const contextBlocks = [];
        let projectRoute = "skip";
        let docsRoute = "skip";
        let rulesRoute = "skip";
        if (routing.shouldUseProjectContext) {
            this.options.state.setProjectContext({
                status: "indexing",
                label: "Проектный контекст индексируется"
            });
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            const project = await this.options.projectContext.buildContext(prompt, this.options.profiles.getCurrentProfileId());
            this.options.state.setProjectContext(project.status);
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            if (project.text) {
                projectRoute = project.mode === "fallback" ? "fallback" : "added";
                contextBlocks.push({
                    source: "project",
                    text: project.text,
                    matchCount: project.matchCount,
                    mode: project.mode === "fallback" ? "fallback" : "matched"
                });
            }
        }
        else if (chat.kind === "general") {
            this.options.state.setProjectContext({
                status: "disabled",
                label: "Обычный чат не использует проектный контекст"
            });
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
        }
        if (routing.shouldUseDocsContext) {
            const docs = await this.options.docsContext.buildContext(prompt);
            if (docs?.text) {
                docsRoute = "added";
                contextBlocks.push({
                    source: "docs",
                    text: docs.text,
                    matchCount: docs.matchCount,
                    mode: "matched"
                });
            }
        }
        else {
            this.options.logger.info(`Docs context skipped by router: ${routing.reason}.`);
        }
        if (routing.shouldUseProjectContext && chat.kind === "project") {
            const rules = await this.options.rulesContext.buildContext(chat.kind, chat.rulesEnabled);
            this.options.state.setRulesContext(rules.status);
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            rulesRoute = rules.status.status === "active" && rules.text
                ? "added"
                : rules.status.status;
            if (rules.text) {
                contextBlocks.push({
                    source: "rules",
                    text: rules.text,
                    matchCount: rules.matchCount,
                    mode: "matched"
                });
            }
        }
        else if (chat.kind === "general") {
            this.options.state.setRulesContext({
                status: "disabled",
                label: "Обычный чат не использует правила проекта"
            });
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
        }
        else {
            this.options.logger.info(`Rules context skipped by router: ${routing.reason}.`);
        }
        const input = contextBlocks.length
            ? [{ type: "text", text: this.options.contextRouter.buildServiceEnvelope({ userPrompt: prompt, blocks: contextBlocks }) }]
            : [{ type: "text", text: prompt }];
        this.options.logger.info(`context routed: project=${projectRoute}, docs=${docsRoute}, rules=${rulesRoute}, reason=${routing.reason}, blocks=${contextBlocks.length}.`);
        this.options.logger.info(`turn/start requested for thread ${chat.backendThreadId}.`);
        return this.requireRpcClient().request("turn/start", {
            threadId: chat.backendThreadId,
            input,
            cwd,
            approvalPolicy: getApprovalPolicy(chat.accessMode),
            approvalsReviewer: "user",
            sandboxPolicy: getTurnSandboxPolicy(chat.accessMode, cwd),
            model: null,
            effort: "medium"
        }, 30000);
    }
    async stop() {
        this.rpcClient?.dispose();
        this.rpcClient = undefined;
        await this.processManager.stop();
        this.options.state.setRuntime({
            status: "notStarted",
            label: "Backend остановлен"
        });
        this.options.onDidChange();
    }
    dispose() {
        this.rpcClient?.dispose();
        this.processManager.dispose();
    }
    async ensureBackendProcess() {
        if (this.processManager.isRunning) {
            return;
        }
        const profileId = await this.options.profiles.requireProfileId(this.options.settings.listExistingProfileIds());
        const codexHome = await this.options.settings.ensureUserCodexHome(profileId);
        await this.options.onDidResolveProfile?.(profileId);
        const runtimePath = resolveBundledRuntimePath(this.options.context);
        if (!fs.existsSync(runtimePath)) {
            this.options.state.setRuntime({
                status: "error",
                label: "Bundled codex.exe не найден"
            });
            this.options.onDidChange();
            throw new Error(`Bundled codex.exe не найден: ${runtimePath}`);
        }
        const proxy = await this.options.settings.getRuntimeProxySettings();
        const env = buildRuntimeEnv(codexHome, proxy);
        const cwd = resolveWorkspaceCwd(this.options.context);
        const args = ["app-server"];
        this.options.state.setRuntime({
            status: "starting",
            label: "Backend запускается"
        });
        this.updateAuth({
            profileLabel: profileId,
            message: "Запускаем Codex runtime на сервере Element..."
        });
        const rpcClient = new jsonRpcClient_1.JsonRpcClient((line) => this.processManager.writeLine(line), (notification) => this.handleNotification(notification), (request) => this.handleServerRequest(request));
        this.rpcClient?.dispose();
        this.rpcClient = rpcClient;
        const pid = this.processManager.start({
            command: runtimePath,
            args,
            cwd,
            env,
            onStdout: (line) => {
                const handled = rpcClient.handleLine(line);
                if (!handled) {
                    this.options.logger.info(`stdout: ${line}`);
                }
            },
            onStderr: (line) => {
                this.options.logger.warn(`stderr: ${line}`);
            },
            onExit: (code, signal) => this.handleExit(code, signal)
        });
        this.options.state.setRuntime({
            status: "running",
            label: `Backend запущен, PID ${pid || "-"}`
        });
        this.options.onDidChange();
        this.options.logger.info(`Spawned bundled codex.exe app-server with pid ${pid || "-"}.`);
        await this.initializeBackendSession();
    }
    async initializeBackendSession() {
        const rpcClient = this.requireRpcClient();
        this.updateAuth({ message: "Инициализируем Codex app-server..." });
        const result = await rpcClient.request("initialize", {
            clientInfo: {
                name: "codex_element_v1",
                title: "Codex for 1C: Element",
                version: String(this.options.context.extension.packageJSON.version ?? "0.0.0")
            }
        });
        rpcClient.notify("initialized");
        this.options.logger.info(`initialize completed: ${summarizeInitializeResult(result)}.`);
        await this.readAccount();
    }
    handleNotification(notification) {
        this.options.logger.info(`notification ${notification.method}`);
        if (notification.method === "account/login/completed") {
            const completed = normalizeLoginCompletedNotification(notification.params);
            this.updateAuth({
                status: completed.success ? "checking" : "error",
                message: completed.message,
                deviceCode: {
                    status: completed.success ? "success" : "error"
                }
            });
            if (completed.success) {
                void this.readAccount();
            }
            return;
        }
        if (notification.method === "account/updated") {
            void this.readAccount();
            return;
        }
        if (notification.method === "thread/started") {
            const threadId = extractThreadId(notification.params);
            if (threadId) {
                this.options.logger.info(`thread/started notification: ${threadId}.`);
            }
            return;
        }
        if (notification.method === "turn/started") {
            const turnId = extractTurnId(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            if (turnId && chatId) {
                this.activeTurnChatId.set(turnId, chatId);
                this.options.state.updateChat(chatId, {
                    activeTurnId: turnId,
                    status: "running"
                });
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/started") {
            const itemId = extractItemId(notification.params);
            if (itemId) {
                this.itemPayloads.set(itemId, notification.params);
            }
            return;
        }
        if (notification.method === "item/agentMessage/delta") {
            const delta = extractDelta(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            if (chatId && delta) {
                this.options.state.appendAssistantDelta(chatId, delta);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/completed") {
            const itemId = extractItemId(notification.params);
            if (itemId) {
                this.itemPayloads.delete(itemId);
            }
            const agentText = extractCompletedAgentMessage(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            if (chatId && agentText) {
                this.options.state.setLastAssistantText(chatId, agentText);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "turn/completed") {
            const turnId = extractTurnId(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            const status = extractTurnStatus(notification.params);
            const errorMessage = extractTurnErrorMessage(notification.params);
            if (turnId) {
                this.activeTurnChatId.delete(turnId);
            }
            if (chatId) {
                this.options.state.updateChat(chatId, {
                    activeTurnId: null,
                    status: status === "completed" || !errorMessage ? "idle" : "error",
                    pendingApproval: null
                }, "immediate");
                if (errorMessage) {
                    this.options.state.addTranscriptItem(chatId, "system", errorMessage, "immediate");
                }
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "serverRequest/resolved") {
            const requestId = extractRequestId(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            if (requestId) {
                this.pendingApprovals.delete(requestId);
            }
            if (chatId) {
                this.options.state.setPendingApproval(chatId, null);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "error") {
            const message = extractErrorNotificationMessage(notification.params);
            const chatId = this.findChatIdForNotification(notification.params) ?? this.latestChatId;
            if (chatId) {
                this.options.state.updateChat(chatId, {
                    status: "error",
                    activeTurnId: null
                });
                this.options.state.addTranscriptItem(chatId, "system", message);
                this.options.onDidChangeChat(chatId);
            }
            this.options.onDidChange();
            this.options.logger.error(`App-server error: ${message}`);
        }
    }
    async handleServerRequest(request) {
        const normalized = normalizeApprovalRequest(request, this.itemPayloads);
        if (!normalized) {
            this.options.logger.warn(`Unsupported app-server request: ${request.method}; payload=${sanitizePayload(request.params)}.`);
            return {};
        }
        const approval = normalized.approval;
        const chatId = this.findChatIdForNotification(request.params) ?? this.latestChatId;
        if (!chatId) {
            this.options.logger.warn(`Approval request has no matching chat: ${request.method}; payload=${sanitizePayload(request.params)}.`);
            return { decision: "decline" };
        }
        this.options.logger.info(`Approval requested: method=${request.method}; chat=${chatId}; kind=${approval.kind}; payload=${approval.payloadPreview}.`);
        this.options.state.setPendingApproval(chatId, approval);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        return new Promise((resolve) => {
            this.pendingApprovals.set(approval.id, {
                chatId,
                requestId: approval.id,
                resolve: (approved) => resolve(normalized.resolvePayload(approved))
            });
        });
    }
    handleExit(code, signal) {
        for (const pending of this.pendingApprovals.values()) {
            pending.resolve(false);
            this.options.state.setPendingApproval(pending.chatId, null);
        }
        this.pendingApprovals.clear();
        this.rpcClient?.dispose();
        this.rpcClient = undefined;
        this.options.state.setRuntime({
            status: "error",
            label: `Backend остановлен${code === null ? "" : `, код ${code}`}${signal ? `, ${signal}` : ""}`
        });
        this.options.onDidChange();
        this.options.logger.warn(`codex app-server exited: code=${code ?? "-"} signal=${signal ?? "-"}.`);
    }
    requireRpcClient() {
        if (!this.rpcClient) {
            throw new Error("JSON-RPC client не готов. Запустите backend.");
        }
        return this.rpcClient;
    }
    updateAuth(auth) {
        this.options.state.setAuth(auth);
        this.options.onDidChange();
    }
    findChatIdForNotification(params) {
        const turnId = extractTurnId(params);
        if (turnId) {
            const mapped = this.activeTurnChatId.get(turnId);
            if (mapped) {
                return mapped;
            }
            const chat = this.options.state.findChatByTurnId(turnId);
            if (chat) {
                return chat.id;
            }
        }
        const threadId = extractThreadId(params);
        if (threadId) {
            const mapped = this.activeThreadChatId.get(threadId);
            if (mapped) {
                return mapped;
            }
        }
        return this.latestChatId;
    }
}
exports.CodexRuntimeController = CodexRuntimeController;
function resolveBundledRuntimePath(context) {
    return path.join(context.extensionUri.fsPath, "bin", "windows-x86_64", "codex.exe");
}
function getApprovalPolicy(accessMode) {
    return accessMode === "read-only" ? "never" : "unlessTrusted";
}
function getThreadSandbox(accessMode) {
    if (accessMode === "workspace-write") {
        return "workspaceWrite";
    }
    if (accessMode === "danger-full-access") {
        return "dangerFullAccess";
    }
    return "read-only";
}
function getTurnSandboxPolicy(accessMode, cwd) {
    if (accessMode === "workspace-write") {
        return {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: true
        };
    }
    if (accessMode === "danger-full-access") {
        return { type: "dangerFullAccess" };
    }
    return { type: "readOnly", networkAccess: true };
}
function resolveWorkspaceCwd(context) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
        return workspaceFolder;
    }
    if (vscode.workspace.workspaceFile?.fsPath) {
        return path.dirname(vscode.workspace.workspaceFile.fsPath);
    }
    return context.globalStorageUri.fsPath;
}
function buildRuntimeEnv(codexHome, proxy) {
    const env = {
        ...process.env,
        CODEX_HOME: codexHome
    };
    const proxyUrl = buildProxyUrl(proxy);
    if (!proxyUrl) {
        return env;
    }
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "WS_PROXY", "WSS_PROXY", "ALL_PROXY"]) {
        env[key] = proxyUrl;
        env[key.toLowerCase()] = proxyUrl;
    }
    env.NO_PROXY = "localhost,127.0.0.1,::1,.local";
    env.no_proxy = env.NO_PROXY;
    return env;
}
function buildProxyUrl(proxy) {
    if (!proxy.url) {
        return "";
    }
    const parsed = new URL(proxy.url);
    if (proxy.username) {
        parsed.username = proxy.username;
        parsed.password = proxy.password;
    }
    return parsed.toString();
}
function normalizeAccountReadResult(result) {
    const root = isRecord(result) ? result : {};
    const account = isRecord(root.account) ? root.account : null;
    if (!account) {
        return {
            accountType: "none",
            label: "Не авторизованы",
            message: "OpenAI auth требуется, account еще не подключен."
        };
    }
    const type = getString(account.type).toLowerCase();
    const email = getString(account.email);
    const planType = getString(account.planType);
    if (type === "apikey" || type === "api_key") {
        return {
            accountType: "apiKey",
            label: "API key",
            message: "API key принят Codex runtime."
        };
    }
    if (type === "chatgpt") {
        return {
            accountType: "chatgpt",
            label: email || "ChatGPT",
            message: `ChatGPT account подключен${email ? `: ${email}` : ""}${planType ? `, plan ${planType}` : ""}.`
        };
    }
    return {
        accountType: "unknown",
        label: "Account неизвестен",
        message: `Codex runtime вернул неизвестный account type: ${type || "empty"}.`
    };
}
function normalizeDeviceCodeChallenge(result) {
    const root = isRecord(result) ? result : {};
    const type = getString(root.type);
    const verificationUrl = getString(root.verificationUrl) || getString(root.verification_uri);
    const userCode = getString(root.userCode) || getString(root.user_code);
    if (type !== "chatgptDeviceCode") {
        throw new Error(`Codex runtime вернул неожиданный тип login response: ${type || "empty"}.`);
    }
    if (!verificationUrl || !userCode) {
        throw new Error("Codex runtime не вернул verificationUrl/userCode для Device Code.");
    }
    return {
        loginId: getString(root.loginId),
        verificationUrl,
        userCode
    };
}
function extractThreadId(value) {
    const root = isRecord(value) ? value : {};
    const direct = getString(root.threadId);
    if (direct) {
        return direct;
    }
    const thread = isRecord(root.thread) ? root.thread : null;
    return thread ? getString(thread.id) : "";
}
function extractItemId(value) {
    const root = isRecord(value) ? value : {};
    const direct = getString(root.itemId);
    if (direct) {
        return direct;
    }
    const item = isRecord(root.item) ? root.item : null;
    return item ? getString(item.id) : "";
}
function extractRequestId(value) {
    const root = isRecord(value) ? value : {};
    return getString(root.requestId) || getString(root.serverRequestId) || getString(root.id);
}
function extractTurnId(value) {
    const root = isRecord(value) ? value : {};
    const direct = getString(root.turnId);
    if (direct) {
        return direct;
    }
    const turn = isRecord(root.turn) ? root.turn : null;
    return turn ? getString(turn.id) : "";
}
function extractTurnStatus(value) {
    const root = isRecord(value) ? value : {};
    const turn = isRecord(root.turn) ? root.turn : null;
    return turn ? getString(turn.status) : "";
}
function extractTurnErrorMessage(value) {
    const root = isRecord(value) ? value : {};
    const turn = isRecord(root.turn) ? root.turn : null;
    const error = turn && isRecord(turn.error) ? turn.error : null;
    if (!error) {
        return "";
    }
    return getString(error.message) || getString(error.additionalDetails);
}
function extractDelta(value) {
    const root = isRecord(value) ? value : {};
    return getString(root.delta);
}
function extractErrorNotificationMessage(value) {
    const root = isRecord(value) ? value : {};
    const error = isRecord(root.error) ? root.error : root;
    return getString(error.message) || getString(error.additionalDetails) || "Codex runtime сообщил об ошибке turn.";
}
function extractCompletedAgentMessage(value) {
    const root = isRecord(value) ? value : {};
    const item = isRecord(root.item) ? root.item : null;
    if (!item || getString(item.type) !== "agentMessage") {
        return "";
    }
    return getString(item.text);
}
function normalizeLoginCompletedNotification(params) {
    const root = isRecord(params) ? params : {};
    const success = getBoolean(root.success, false);
    const error = getString(root.error);
    return {
        success,
        message: success
            ? "Login завершен успешно. Читаем account state..."
            : `Login завершился ошибкой: ${error || "неизвестная ошибка"}.`
    };
}
function summarizeInitializeResult(result) {
    const root = isRecord(result) ? result : {};
    const userAgent = getString(root.userAgent);
    const codexHome = getString(root.codexHome);
    const platform = [getString(root.platformFamily), getString(root.platformOs)].filter(Boolean).join("/");
    return `userAgent=${userAgent || "-"}; codexHome=${codexHome ? "set" : "-"}; platform=${platform || "-"}`;
}
function normalizeAuthError(error) {
    const message = normalizeErrorMessage(error);
    if (message.toLowerCase().includes("unauthorized") || message.includes("401")) {
        return "OpenAI вернул 401: проверьте API key.";
    }
    if (message.toLowerCase().includes("proxy")) {
        return `Проблема proxy при auth/account запросе: ${message}`;
    }
    return message;
}
function isThreadNotFoundError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return message.includes("turn/start") && message.includes("thread not found");
}
function normalizeErrorMessage(error) {
    return (0, logger_1.redact)(error instanceof Error ? error.message : "Неизвестная ошибка Codex runtime.");
}
function normalizeApprovalRequest(request, itemPayloads) {
    const method = request.method;
    if (!method.includes("requestApproval") && !method.toLowerCase().includes("approval")) {
        return undefined;
    }
    const params = isRecord(request.params) ? request.params : {};
    const targetItemId = getString(params.itemId) || getString(params.targetItemId);
    const itemPayload = targetItemId ? itemPayloads.get(targetItemId) : undefined;
    const merged = mergeRecords(params, extractItemRecord(itemPayload));
    const kind = inferApprovalKind(method, merged);
    const command = extractFirstString(merged, ["command", "cmd", "shellCommand", "argv", "commandLine"]);
    const filePath = extractFirstString(merged, ["path", "filePath", "absolutePath", "targetPath"]);
    const cwd = extractFirstString(merged, ["cwd", "workingDirectory"]);
    const reason = extractFirstString(merged, ["reason", "description", "summary", "message"]);
    const diff = limitText(extractDiffText(merged), 12000);
    const approval = {
        id: String(request.id),
        method,
        kind,
        title: approvalTitle(kind),
        description: reason || approvalDescription(kind),
        command,
        path: filePath,
        cwd,
        diff,
        payloadPreview: sanitizePayload(request.params)
    };
    if (method === "item/permissions/requestApproval") {
        const requestedPermissions = extractRequestedPermissions(params);
        return {
            approval,
            resolvePayload: (approved) => ({
                permissions: approved ? requestedPermissions : {},
                scope: "turn"
            })
        };
    }
    return {
        approval,
        resolvePayload: (approved) => ({ decision: approved ? "accept" : "decline" })
    };
}
function approvalTitle(kind) {
    if (kind === "command") {
        return "Разрешить выполнение команды";
    }
    if (kind === "file" || kind === "diff") {
        return "Разрешить изменение файлов";
    }
    if (kind === "network") {
        return "Разрешить сетевой доступ";
    }
    return "Разрешить действие Codex";
}
function approvalDescription(kind) {
    if (kind === "command") {
        return "Codex хочет выполнить команду в workspace.";
    }
    if (kind === "file" || kind === "diff") {
        return "Codex хочет применить изменение в файлах проекта.";
    }
    if (kind === "network") {
        return "Codex запрашивает сетевой доступ для действия.";
    }
    return "Codex запрашивает разрешение на действие.";
}
function inferApprovalKind(method, value) {
    const text = `${method} ${JSON.stringify(value)}`.toLowerCase();
    if (text.includes("command") || text.includes("exec") || text.includes("shell")) {
        return "command";
    }
    if (text.includes("patch") || text.includes("diff")) {
        return "diff";
    }
    if (text.includes("file") || text.includes("write")) {
        return "file";
    }
    if (text.includes("network")) {
        return "network";
    }
    return "unknown";
}
function mergeRecords(left, right) {
    return { ...right, ...left };
}
function extractItemRecord(value) {
    const root = isRecord(value) ? value : {};
    const item = isRecord(root.item) ? root.item : root;
    return item;
}
function extractFirstString(value, keys) {
    for (const key of keys) {
        const found = findStringByKey(value, key);
        if (found) {
            return found;
        }
    }
    return "";
}
function findStringByKey(value, key) {
    if (!isRecord(value)) {
        if (Array.isArray(value) && (key === "argv" || key === "command")) {
            return value.map((part) => typeof part === "string" ? part : "").filter(Boolean).join(" ");
        }
        return "";
    }
    if (typeof value[key] === "string") {
        return value[key];
    }
    if (Array.isArray(value[key]) && (key === "argv" || key === "command")) {
        return value[key].map((part) => typeof part === "string" ? part : "").filter(Boolean).join(" ");
    }
    for (const nested of Object.values(value)) {
        const found = findStringByKey(nested, key);
        if (found) {
            return found;
        }
    }
    return "";
}
function extractDiffText(value) {
    return extractFirstString(value, [
        "diff",
        "patch",
        "unifiedDiff",
        "applyPatch",
        "patchText",
        "summary"
    ]);
}
function extractRequestedPermissions(value) {
    const permissions = value.permissions ?? value.permissionProfile ?? value.requestedPermissions;
    return isRecord(permissions) ? permissions : {};
}
function sanitizePayload(value) {
    return limitText((0, logger_1.redact)(JSON.stringify(value, null, 2)), 2000);
}
function limitText(value, maxLength) {
    if (!value || value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}\n... [обрезано: ${value.length - maxLength} символов]`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function getString(value) {
    return typeof value === "string" ? value : "";
}
function getBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
//# sourceMappingURL=codexRuntimeController.js.map