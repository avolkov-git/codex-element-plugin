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
class UserCancelledTurnError extends Error {
    constructor() {
        super("Turn cancelled by user.");
        this.name = "UserCancelledTurnError";
    }
}
const FALLBACK_MODEL_OPTIONS = [
    { id: null, label: "5.5" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
    { id: "gpt-5.2", label: "GPT-5.2" }
];
class CodexRuntimeController {
    constructor(options) {
        this.options = options;
        this.processManager = new runtimeProcessManager_1.RuntimeProcessManager();
        this.activeTurnChatId = new Map();
        this.activeThreadChatId = new Map();
        this.itemPayloads = new Map();
        this.pendingApprovals = new Map();
        this.loadedThreadIds = new Set();
        this.hiddenPlannerRunsByThread = new Map();
        this.hiddenPlannerRunsByTurn = new Map();
        this.hiddenPlannerRunsByItem = new Map();
        this.contextCompactionItemThreads = new Map();
        this.contextCompactionActivityIds = new Map();
        this.compactionWaiters = new Map();
        this.cancellingChatIds = new Set();
        this.cancelledTurnIds = new Set();
        this.diagnosticsRetryAttemptedTurnIds = new Set();
        this.diagnosticsRetryTurnIds = new Set();
        this.fileChangingTurnIds = new Set();
        this.cancelEpochByChat = new Map();
        this.suppressNextExitAsCancel = false;
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
    async sendPrompt(chatId, prompt, mode = "normal", transcriptText, explicitContextBlocks = []) {
        return this.sendPromptCore(chatId, prompt, mode, transcriptText, explicitContextBlocks, {
            addUserMessage: true
        });
    }
    async sendPromptCore(chatId, prompt, mode, transcriptText, explicitContextBlocks, options) {
        const trimmed = prompt.trim();
        if (!trimmed) {
            return;
        }
        const visiblePrompt = (transcriptText ?? trimmed).trim() || trimmed;
        const chat = this.options.state.getChat(chatId);
        if (!chat) {
            throw new Error("Чат не найден.");
        }
        if (chat.archivedAt) {
            this.options.logger.warn(`sendPrompt ignored for archived chat: ${chatId}.`);
            return;
        }
        this.latestChatId = chatId;
        const cancelEpoch = this.cancelEpoch(chatId);
        if (options.addUserMessage) {
            this.options.state.addTranscriptItem(chatId, "user", visiblePrompt);
        }
        this.options.state.updateChat(chatId, { status: "running", activeRunMode: mode });
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        try {
            await this.ensureBackendProcess();
            this.throwIfCancelled(chatId, cancelEpoch);
            await this.ensureAuthenticatedForTurn();
            this.throwIfCancelled(chatId, cancelEpoch);
            const requestedAccessMode = getRunAccessMode(this.options.state.getChat(chatId)?.accessMode ?? chat.accessMode, mode);
            await this.ensureBackendThreadReady(chatId, requestedAccessMode);
            this.throwIfCancelled(chatId, cancelEpoch);
            let turnResult;
            try {
                turnResult = await this.startTurnWithFallback(chatId, trimmed, mode, explicitContextBlocks, {
                    skipAutoDiagnostics: options.isDiagnosticsRetry
                });
            }
            catch (error) {
                if (isContextWindowError(error) && this.options.state.getChat(chatId)?.backendThreadId) {
                    this.options.logger.warn(`Context window exhausted, requesting app-server compaction before retry: ${normalizeErrorMessage(error)}`);
                    await this.compactBackendThread(chatId);
                    this.throwIfCancelled(chatId, cancelEpoch);
                    turnResult = await this.startTurnWithFallback(chatId, trimmed, mode, explicitContextBlocks, {
                        skipAutoDiagnostics: options.isDiagnosticsRetry
                    });
                }
                else if (isThreadNotFoundError(error) && this.options.state.getChat(chatId)?.backendThreadId) {
                    const staleThreadId = this.options.state.getChat(chatId)?.backendThreadId;
                    this.options.logger.warn(`Backend thread was not loaded by runtime, trying thread/resume: ${staleThreadId ?? "-"}.`);
                    const resumed = await this.tryResumeBackendThread(chatId, requestedAccessMode);
                    this.throwIfCancelled(chatId, cancelEpoch);
                    if (resumed) {
                        turnResult = await this.startTurnWithFallback(chatId, trimmed, mode, explicitContextBlocks, {
                            skipAutoDiagnostics: options.isDiagnosticsRetry
                        });
                    }
                    else {
                        this.options.logger.warn(`thread/resume failed, recreating backend thread: ${staleThreadId ?? "-"}.`);
                        if (staleThreadId) {
                            this.activeThreadChatId.delete(staleThreadId);
                            this.loadedThreadIds.delete(staleThreadId);
                        }
                        this.options.state.updateChat(chatId, {
                            backendThreadId: null,
                            backendThreadAccessMode: null,
                            activeTurnId: null
                        });
                        await this.startBackendThreadWithFallback(chatId, requestedAccessMode);
                        this.throwIfCancelled(chatId, cancelEpoch);
                        turnResult = await this.startTurnWithFallback(chatId, trimmed, mode, explicitContextBlocks, {
                            skipAutoDiagnostics: options.isDiagnosticsRetry
                        });
                    }
                }
                else {
                    throw error;
                }
            }
            this.throwIfCancelled(chatId, cancelEpoch);
            const turnId = extractTurnId(turnResult);
            if (turnId) {
                this.activeTurnChatId.set(turnId, chatId);
                if (options.isDiagnosticsRetry) {
                    this.diagnosticsRetryTurnIds.add(turnId);
                }
            }
            this.options.state.updateChat(chatId, {
                activeTurnId: turnId || null,
                status: "running",
                activeRunMode: mode
            });
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            this.options.logger.info(`turn/start accepted: turn=${turnId || "-"}.`);
        }
        catch (error) {
            if (error instanceof UserCancelledTurnError || this.cancelEpoch(chatId) !== cancelEpoch) {
                this.cleanupCancelledChat(chatId, this.options.state.getChat(chatId)?.activeTurnId ?? null);
                this.options.logger.info(`sendPrompt cancelled: chat=${chatId}.`);
                return;
            }
            const message = normalizeErrorMessage(error);
            if (options.isDiagnosticsRetry) {
                this.options.state.updateChat(chatId, {
                    status: "idle",
                    activeTurnId: null,
                    activeRunMode: null
                });
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
                this.options.logger.warn(`Diagnostics auto-fix retry failed without transcript error: ${message}`);
                return;
            }
            this.options.state.updateChat(chatId, {
                status: "error",
                activeTurnId: null,
                activeRunMode: null
            });
            this.options.state.addErrorItem(chatId, message);
            this.options.onDidChange();
            this.options.onDidChangeChat(chatId);
            this.options.logger.error(`sendPrompt failed: ${message}`);
        }
    }
    async loadModelOptions() {
        try {
            await this.ensureBackendProcess();
            const result = await this.requireRpcClient().request("model/list", undefined, 10000);
            const options = normalizeModelOptions(result);
            if (!options.length) {
                this.options.logger.warn("model/list returned no usable models; using fallback model list.");
                return { options: FALLBACK_MODEL_OPTIONS, status: "error" };
            }
            this.options.logger.info(`model/list completed: ${options.length} model options.`);
            return { options, status: "ready" };
        }
        catch (error) {
            this.options.logger.warn(`model/list failed; using fallback model list: ${normalizeErrorMessage(error)}`);
            return { options: FALLBACK_MODEL_OPTIONS, status: "error" };
        }
    }
    async probeCapabilities() {
        const rows = [];
        const startedAt = Date.now();
        const record = (row) => {
            rows.push(row);
        };
        const probe = async (capability, run, summarize = (result) => `result=${describePayloadShape(result)}`) => {
            const probeStartedAt = Date.now();
            try {
                const result = await run();
                record({
                    capability,
                    status: "supported",
                    observation: summarize(result),
                    evidence: "live rpc",
                    elapsedMs: Date.now() - probeStartedAt
                });
                return result;
            }
            catch (error) {
                record({
                    capability,
                    status: isUnsupportedCapabilityError(error) ? "unsupported" : "unstable",
                    observation: normalizeErrorMessage(error),
                    evidence: "live rpc",
                    elapsedMs: Date.now() - probeStartedAt
                });
                return undefined;
            }
        };
        this.options.logger.info("Capability probe started. This explicit command may start codex app-server but does not run user turns.");
        try {
            const startupStartedAt = Date.now();
            await this.ensureBackendProcess();
            record({
                capability: "app-server startup + initialize",
                status: "supported",
                observation: "backend process is running; initialize completed through normal runtime startup",
                evidence: "live startup",
                elapsedMs: Date.now() - startupStartedAt
            });
        }
        catch (error) {
            record({
                capability: "app-server startup + initialize",
                status: "unstable",
                observation: normalizeErrorMessage(error),
                evidence: "live startup"
            });
            this.options.logger.info(formatCapabilityProbeReport(rows, Date.now() - startedAt));
            throw error;
        }
        const rpcClient = this.requireRpcClient();
        await probe("account/read", () => rpcClient.request("account/read", { refreshToken: false }, 10000), (result) => {
            const account = normalizeAccountReadResult(result);
            return `account=${account.accountType}; label=${account.label ? "set" : "-"}`;
        });
        await probe("model/list", () => rpcClient.request("model/list", undefined, 10000), (result) => {
            const models = normalizeModelOptions(result);
            return `models=${models.length}`;
        });
        if (this.options.state.getSidebarSnapshot().auth.accountType === "chatgpt") {
            await probe("account/rateLimits/read", () => rpcClient.request("account/rateLimits/read", undefined, 10000), (result) => {
                const rateLimits = normalizeRateLimitsResult(result);
                return `rows=${rateLimits.rows.length}; status=${rateLimits.status}`;
            });
        }
        else {
            record({
                capability: "account/rateLimits/read",
                status: "skipped",
                observation: "requires ChatGPT account; current account is not chatgpt",
                evidence: "local account state"
            });
        }
        const cwd = resolveWorkspaceCwd(this.options.context);
        const startedThreads = new Map();
        for (const accessMode of ["read-only", "workspace-write", "danger-full-access"]) {
            const result = await probe(`thread/start sandbox=${getThreadSandbox(accessMode)}`, () => rpcClient.request("thread/start", {
                cwd,
                approvalPolicy: getApprovalPolicy(accessMode),
                approvalsReviewer: "user",
                sandbox: getThreadSandbox(accessMode),
                sessionStartSource: "startup",
                serviceName: "codex_element_capability_probe",
                model: null
            }, 10000), (value) => {
                const threadId = extractThreadId(value);
                return `thread=${threadId ? "set" : "-"}; payload=${describePayloadShape(value)}`;
            });
            const threadId = extractThreadId(result);
            if (threadId) {
                this.loadedThreadIds.add(threadId);
                startedThreads.set(accessMode, threadId);
            }
        }
        const readOnlyThreadId = startedThreads.get("read-only");
        if (readOnlyThreadId) {
            await probe("thread/resume full payload", () => rpcClient.request("thread/resume", {
                threadId: readOnlyThreadId,
                cwd,
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: "read-only",
                model: null
            }, 10000), (value) => `thread=${extractThreadId(value) || readOnlyThreadId}; payload=${describePayloadShape(value)}`);
            await probe("thread/resume threadId-only payload", () => rpcClient.request("thread/resume", {
                threadId: readOnlyThreadId
            }, 10000), (value) => `thread=${extractThreadId(value) || readOnlyThreadId}; payload=${describePayloadShape(value)}`);
        }
        else {
            record({
                capability: "thread/resume",
                status: "skipped",
                observation: "read-only thread/start did not return a thread id",
                evidence: "live rpc"
            });
        }
        record({
            capability: "server-side approval requests",
            status: "supported",
            observation: "JsonRpcClient handles server requests and CodexRuntimeController normalizes approval payloads",
            evidence: "static code path"
        });
        record({
            capability: "turn/cancel",
            status: "unknown",
            observation: "implemented with {threadId, turnId} and turnId-only retry; live probe is intentionally skipped because it requires a running turn",
            evidence: "static code path"
        });
        record({
            capability: "hidden internal planner turn",
            status: "unstable",
            observation: "implemented through isolated read-only thread/turn; recent runtime observations include 15s planner timeout fallback",
            evidence: "static code path + observed Output"
        });
        record({
            capability: "turn/start sandboxPolicy variants",
            status: "supported",
            observation: "current client uses readOnly/workspaceWrite/dangerFullAccess camelCase variants required by app-server",
            evidence: "known protocol errors + static code path"
        });
        const toolProbeResult = await probeNativeToolListCandidates(rpcClient);
        record(toolProbeResult);
        const resultTransportProbe = {
            capability: "tool result transport",
            status: "unknown",
            observation: toolProbeResult.status === "supported"
                ? "tool listing candidate responded, but request/result round-trip still needs a dedicated native tool fixture"
                : "no confirmed native tool registration/listing method yet; fallback loop remains required",
            evidence: toolProbeResult.evidence
        };
        record(resultTransportProbe);
        const nativeToolLoop = this.options.nativeContextTools.recordProbe({
            listingStatus: toolProbeResult.status,
            listingEvidence: toolProbeResult.evidence,
            listingObservation: toolProbeResult.observation,
            resultTransportStatus: resultTransportProbe.status,
            resultTransportEvidence: resultTransportProbe.evidence,
            resultTransportObservation: resultTransportProbe.observation
        });
        record({
            capability: "native context tool-loop gate",
            status: nativeToolLoop.status === "available" ? "supported" : nativeToolLoop.status === "unknown" ? "unknown" : "unsupported",
            observation: nativeToolLoop.reason,
            evidence: "capability gate"
        });
        this.options.logger.info(formatCapabilityProbeReport(rows, Date.now() - startedAt));
    }
    async planDocsRetrieval(request) {
        await this.ensureBackendProcess();
        const rpcClient = this.requireRpcClient();
        const cwd = resolveWorkspaceCwd(this.options.context);
        const plannerPrompt = buildDocsPlannerPrompt(request);
        const threadResult = await rpcClient.request("thread/start", {
            cwd,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: getThreadSandbox("read-only"),
            sessionStartSource: "startup",
            serviceName: "codex_element_docs_planner",
            model: null
        }, request.timeoutMs);
        const threadId = extractThreadId(threadResult);
        if (!threadId) {
            throw new Error("docs planner thread/start не вернул thread.id.");
        }
        this.loadedThreadIds.add(threadId);
        return new Promise((resolve, reject) => {
            const run = {
                threadId,
                text: "",
                settled: false,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.rejectHiddenPlannerRun(run, new Error(`docs planner timeout after ${request.timeoutMs}ms.`));
                }, request.timeoutMs)
            };
            this.hiddenPlannerRunsByThread.set(threadId, run);
            void (async () => {
                try {
                    const turnResult = await rpcClient.request("turn/start", {
                        threadId,
                        input: [{ type: "text", text: plannerPrompt }],
                        cwd,
                        approvalPolicy: "never",
                        approvalsReviewer: "user",
                        sandboxPolicy: getTurnSandboxPolicy("read-only", cwd),
                        model: null,
                        effort: "low"
                    }, request.timeoutMs);
                    const turnId = extractTurnId(turnResult);
                    if (turnId) {
                        run.turnId = turnId;
                        this.hiddenPlannerRunsByTurn.set(turnId, run);
                    }
                }
                catch (error) {
                    this.rejectHiddenPlannerRun(run, new Error(normalizeErrorMessage(error)));
                }
            })();
        });
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
    async cancelTurn(chatId) {
        const chat = this.options.state.getChat(chatId);
        if (!chat || !["running", "waitingApproval", "cancelling"].includes(chat.status)) {
            return;
        }
        if (this.cancellingChatIds.has(chatId)) {
            return;
        }
        this.cancellingChatIds.add(chatId);
        this.bumpCancelEpoch(chatId);
        this.latestChatId = chatId;
        const threadId = chat.backendThreadId;
        const turnId = chat.activeTurnId;
        if (turnId) {
            this.cancelledTurnIds.add(turnId);
            this.activeTurnChatId.delete(turnId);
        }
        this.declinePendingApprovalsForChat(chatId);
        this.options.state.updateChat(chatId, {
            status: "cancelling",
            activeTurnId: null,
            pendingApproval: null,
            activeRunMode: null
        }, "immediate");
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        try {
            if (!this.rpcClient || !threadId || !turnId) {
                throw new Error("turn/cancel недоступен: нет активного backend thread/turn.");
            }
            await this.requestTurnCancel(threadId, turnId);
            this.options.logger.info(`turn/cancel accepted: chat=${chatId}; turn=${turnId}.`);
        }
        catch (error) {
            this.options.logger.warn(`turn/cancel failed, stopping backend fallback: ${normalizeErrorMessage(error)}`);
            await this.stopBackendAfterCancel();
        }
        finally {
            this.cancellingChatIds.delete(chatId);
            const current = this.options.state.getChat(chatId);
            if (current?.status === "cancelling") {
                this.options.state.updateChat(chatId, {
                    status: "idle",
                    activeTurnId: null,
                    pendingApproval: null,
                    activeRunMode: null
                }, "immediate");
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
        }
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
            if (account.accountType === "chatgpt") {
                void this.readRateLimits();
            }
            else {
                this.updateRateLimits({ status: "unknown", rows: [] });
            }
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
    async readRateLimits() {
        if (!this.processManager.isRunning || !this.rpcClient) {
            return;
        }
        try {
            const result = await this.rpcClient.request("account/rateLimits/read", undefined, 10000);
            const rateLimits = normalizeRateLimitsResult(result);
            this.updateRateLimits(rateLimits);
            this.options.logger.info(`account/rateLimits/read completed: rows=${rateLimits.rows.length}${rateLimits.rateLimitReachedType ? `, reached=${rateLimits.rateLimitReachedType}` : ""}.`);
        }
        catch (error) {
            const message = normalizeErrorMessage(error);
            this.updateRateLimits({
                status: "error",
                rows: [],
                message,
                updatedAt: new Date().toISOString()
            });
            this.options.logger.warn(`account/rateLimits/read failed: ${message}`);
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
    async ensureBackendThreadReady(chatId, requestedAccessMode) {
        const chat = this.options.state.getChat(chatId);
        if (!chat?.backendThreadId) {
            await this.startBackendThreadWithFallback(chatId, requestedAccessMode);
            return;
        }
        this.activeThreadChatId.set(chat.backendThreadId, chatId);
        if (!this.loadedThreadIds.has(chat.backendThreadId)) {
            await this.tryResumeBackendThread(chatId, requestedAccessMode);
        }
    }
    async tryResumeBackendThread(chatId, accessOverride) {
        try {
            await this.resumeBackendThread(chatId, accessOverride);
            return true;
        }
        catch (error) {
            this.options.logger.warn(`thread/resume failed: ${normalizeErrorMessage(error)}`);
            return false;
        }
    }
    async resumeBackendThread(chatId, accessOverride) {
        const rpcClient = this.requireRpcClient();
        const chat = this.options.state.getChat(chatId);
        if (!chat?.backendThreadId) {
            throw new Error("thread/resume skipped: chat has no backend thread.");
        }
        const cwd = resolveWorkspaceCwd(this.options.context);
        const accessMode = accessOverride ?? chat.accessMode;
        const model = chat.modelId ?? null;
        const fullPayload = {
            threadId: chat.backendThreadId,
            cwd,
            approvalPolicy: getApprovalPolicy(accessMode),
            approvalsReviewer: "user",
            sandbox: getThreadSandbox(accessMode),
            model
        };
        let result;
        try {
            result = await rpcClient.request("thread/resume", fullPayload, 10000);
        }
        catch (error) {
            if (!isInvalidRequestError(error)) {
                throw error;
            }
            this.options.logger.warn(`thread/resume full payload rejected; retrying with threadId only: ${normalizeErrorMessage(error)}`);
            result = await rpcClient.request("thread/resume", { threadId: chat.backendThreadId }, 10000);
        }
        const threadId = extractThreadId(result) || chat.backendThreadId;
        this.options.state.updateChat(chatId, { backendThreadId: threadId, backendThreadAccessMode: accessMode });
        this.activeThreadChatId.set(threadId, chatId);
        this.loadedThreadIds.add(threadId);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        this.options.logger.info(`thread/resume completed: thread=${threadId}.`);
    }
    async startBackendThread(chatId, accessOverride) {
        const rpcClient = this.requireRpcClient();
        const cwd = resolveWorkspaceCwd(this.options.context);
        const chat = this.options.state.getChat(chatId);
        const accessMode = accessOverride ?? chat?.accessMode ?? (chat?.kind === "project" ? "workspace-write" : "read-only");
        const model = chat?.modelId ?? null;
        const result = await rpcClient.request("thread/start", {
            cwd,
            approvalPolicy: getApprovalPolicy(accessMode),
            approvalsReviewer: "user",
            sandbox: getThreadSandbox(accessMode),
            sessionStartSource: "startup",
            serviceName: "codex_element_v1",
            model
        });
        const threadId = extractThreadId(result);
        if (!threadId) {
            throw new Error("thread/start не вернул thread.id.");
        }
        this.options.state.updateChat(chatId, { backendThreadId: threadId, backendThreadAccessMode: accessMode });
        this.activeThreadChatId.set(threadId, chatId);
        this.loadedThreadIds.add(threadId);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        this.options.logger.info(`thread/start completed: thread=${threadId}.`);
    }
    async startBackendThreadWithFallback(chatId, accessOverride) {
        try {
            await this.startBackendThread(chatId, accessOverride);
        }
        catch (error) {
            if (!isModelOrEffortError(error)) {
                throw error;
            }
            this.options.logger.warn(`thread/start model rejected; retrying with default model: ${normalizeErrorMessage(error)}`);
            this.options.state.setChatModel(chatId, null, "5.5");
            await this.startBackendThread(chatId, accessOverride);
        }
    }
    async startTurn(chatId, prompt, mode, explicitContextBlocks = [], options = {}) {
        const chat = this.options.state.getChat(chatId);
        if (!chat?.backendThreadId) {
            throw new Error("Backend thread не готов.");
        }
        const cwd = resolveWorkspaceCwd(this.options.context);
        const turnContext = await this.options.contextOrchestrator.buildTurnContext({
            chatId,
            chatKind: chat.kind,
            prompt,
            runMode: mode,
            cwd,
            rulesEnabled: chat.rulesEnabled,
            explicitContextBlocks,
            skipAutoDiagnostics: options.skipAutoDiagnostics,
            forceDiagnosticsContext: options.forceDiagnosticsContext,
            diagnosticsPriority: options.diagnosticsPriority
        });
        const turnAccessMode = getRunAccessMode(chat.accessMode, mode);
        this.options.logger.info(`turn/start requested for thread ${chat.backendThreadId}; mode=${mode}; model=${chat.modelId || "<default>"}; effort=${chat.effort}; speed=${options.omitSpeed ? "<omitted>" : chat.speed}.`);
        const result = await this.requireRpcClient().request("turn/start", {
            threadId: chat.backendThreadId,
            input: turnContext.input,
            cwd,
            approvalPolicy: getApprovalPolicy(turnAccessMode),
            approvalsReviewer: "user",
            sandboxPolicy: getTurnSandboxPolicy(turnAccessMode, cwd),
            model: chat.modelId ?? null,
            effort: chat.effort,
            ...(!options.omitSpeed ? { speed: chat.speed } : {})
        }, 30000);
        this.addContextWorklogActivity(chatId, turnContext);
        return result;
    }
    addContextWorklogActivity(chatId, turnContext) {
        if (!turnContext.worklog.entries.length || !turnContext.worklog.label.trim()) {
            return;
        }
        const hasError = turnContext.worklog.entries.some((entry) => entry.status === "error");
        this.options.state.addOrUpdateActivityItem(chatId, {
            id: `context-worklog-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
            activityKind: "context",
            label: turnContext.worklog.label,
            summary: turnContext.worklog.label,
            status: hasError ? "error" : "completed"
        }, "immediate");
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
    }
    async startTurnWithFallback(chatId, prompt, mode, explicitContextBlocks = [], options = {}) {
        try {
            return await this.startTurn(chatId, prompt, mode, explicitContextBlocks, options);
        }
        catch (error) {
            if (isSpeedError(error)) {
                this.options.logger.warn(`turn/start speed unsupported by runtime; retrying without speed: ${normalizeErrorMessage(error)}`);
                try {
                    return await this.startTurn(chatId, prompt, mode, explicitContextBlocks, { ...options, omitSpeed: true });
                }
                catch (retryError) {
                    if (!isModelOrEffortError(retryError)) {
                        throw retryError;
                    }
                    this.options.logger.warn(`turn/start model/effort rejected after speed fallback; retrying with defaults: ${normalizeErrorMessage(retryError)}`);
                    this.options.state.setChatModel(chatId, null, "5.5");
                    this.options.state.setChatEffort(chatId, "medium");
                    return this.startTurn(chatId, prompt, mode, explicitContextBlocks, { ...options, omitSpeed: true });
                }
            }
            if (!isModelOrEffortError(error)) {
                throw error;
            }
            this.options.logger.warn(`turn/start model/effort rejected; retrying with defaults: ${normalizeErrorMessage(error)}`);
            this.options.state.setChatModel(chatId, null, "5.5");
            this.options.state.setChatEffort(chatId, "medium");
            return this.startTurn(chatId, prompt, mode, explicitContextBlocks, options);
        }
    }
    async maybeStartDiagnosticsAutoFix(chatId, originalTurnId, accessMode, runMode, mayHaveChangedFiles) {
        if (this.diagnosticsRetryTurnIds.has(originalTurnId)) {
            return;
        }
        if (this.diagnosticsRetryAttemptedTurnIds.has(originalTurnId)) {
            return;
        }
        if (accessMode === "read-only" || runMode === "planning" || !mayHaveChangedFiles) {
            this.options.logger.info(`Diagnostics auto-fix skipped: chat=${chatId}; turn=${originalTurnId}; access=${accessMode}; mode=${runMode}; fileChanges=${mayHaveChangedFiles}.`);
            return;
        }
        this.diagnosticsRetryAttemptedTurnIds.add(originalTurnId);
        await sleep(1500);
        let diagnostics = await this.options.diagnosticsContext.collectErrorContext(120);
        if (!diagnostics.block) {
            this.options.logger.info(`Diagnostics auto-fix skipped: chat=${chatId}; turn=${originalTurnId}; reason=${diagnostics.reason}; errors=${diagnostics.totalErrorsCount}.`);
            return;
        }
        await sleep(800);
        const refreshedDiagnostics = await this.options.diagnosticsContext.collectErrorContext(120);
        if (refreshedDiagnostics.block || refreshedDiagnostics.reason === "no-errors") {
            diagnostics = refreshedDiagnostics;
        }
        if (!diagnostics.block) {
            this.options.logger.info(`Diagnostics auto-fix skipped after refresh: chat=${chatId}; turn=${originalTurnId}; reason=${diagnostics.reason}; errors=${diagnostics.totalErrorsCount}.`);
            return;
        }
        const chat = this.options.state.getChat(chatId);
        if (!chat || chat.kind !== "project" || chat.archivedAt || chat.status !== "idle" || chat.pendingApproval) {
            this.options.logger.info(`Diagnostics auto-fix skipped: chat unavailable or busy; chat=${chatId}; turn=${originalTurnId}; status=${chat?.status ?? "missing"}.`);
            return;
        }
        this.options.logger.info(`Diagnostics auto-fix retry started: chat=${chatId}; sourceTurn=${originalTurnId}; ` +
            `files=${diagnostics.filesCount}; errors=${diagnostics.errorsCount}; totalErrors=${diagnostics.totalErrorsCount}; fingerprint=${diagnostics.fingerprint}.`);
        await this.sendPromptCore(chatId, [
            "Исправь оставшиеся ошибки IDE после предыдущего изменения.",
            "Используй скрытый блок IDE diagnostics и текущий проектный контекст.",
            "Исправляй минимально необходимые ошибки. Предупреждения не трогай.",
            "Не перечисляй diagnostics пользователю, если это не нужно для результата."
        ].join("\n"), "normal", undefined, [diagnostics.block], {
            addUserMessage: false,
            isDiagnosticsRetry: true
        });
    }
    async logDiagnosticsRetryResult(chatId, retryTurnId) {
        await sleep(1500);
        const diagnostics = await this.options.diagnosticsContext.collectErrorContext(120);
        if (diagnostics.block) {
            this.options.logger.info(`Diagnostics auto-fix retry completed with remaining errors: chat=${chatId}; turn=${retryTurnId}; ` +
                `files=${diagnostics.filesCount}; errors=${diagnostics.errorsCount}; totalErrors=${diagnostics.totalErrorsCount}; fingerprint=${diagnostics.fingerprint}.`);
            return;
        }
        this.options.logger.info(`Diagnostics auto-fix retry completed: chat=${chatId}; turn=${retryTurnId}; remainingErrors=${diagnostics.totalErrorsCount}; reason=${diagnostics.reason}.`);
    }
    async compactBackendThread(chatId) {
        const chat = this.options.state.getChat(chatId);
        const threadId = chat?.backendThreadId;
        if (!threadId) {
            return;
        }
        this.setContextWindow(chatId, {
            ...this.options.state.getChatContextWindow(chatId),
            status: "compacting",
            message: "Codex сжимает контекст..."
        });
        this.startCompactionActivity(chatId, threadId);
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
        try {
            await this.requireRpcClient().request("thread/compact/start", { threadId }, 10000);
            this.options.logger.info(`thread/compact/start requested: thread=${threadId}.`);
            await this.waitForCompaction(threadId, 60000);
        }
        catch (error) {
            this.setContextWindow(chatId, {
                ...this.options.state.getChatContextWindow(chatId),
                status: "error",
                message: normalizeErrorMessage(error)
            });
            throw error;
        }
    }
    waitForCompaction(threadId, timeoutMs) {
        return new Promise((resolve) => {
            const waiters = this.compactionWaiters.get(threadId) ?? [];
            waiters.push(resolve);
            this.compactionWaiters.set(threadId, waiters);
            setTimeout(() => {
                const current = this.compactionWaiters.get(threadId);
                if (!current?.includes(resolve)) {
                    return;
                }
                this.compactionWaiters.set(threadId, current.filter((candidate) => candidate !== resolve));
                this.options.logger.warn(`thread/compact/start wait timed out, continuing turn retry: thread=${threadId}.`);
                resolve();
            }, timeoutMs);
        });
    }
    resolveCompactionWaiters(threadId) {
        const waiters = this.compactionWaiters.get(threadId);
        if (!waiters?.length) {
            return;
        }
        this.compactionWaiters.delete(threadId);
        for (const resolve of waiters) {
            resolve();
        }
    }
    resolveAllCompactionWaiters() {
        for (const threadId of this.compactionWaiters.keys()) {
            this.resolveCompactionWaiters(threadId);
        }
    }
    setContextWindow(chatId, contextWindow) {
        this.options.state.setChatContextWindow(chatId, contextWindow);
        this.options.onDidChangeChat(chatId);
    }
    startCompactionActivity(chatId, threadId, itemId) {
        const activityId = this.compactionActivityId(chatId, threadId, itemId);
        this.rememberCompactionActivity(activityId, threadId, itemId);
        this.options.state.addOrUpdateActivityItem(chatId, {
            id: activityId,
            activityKind: "context",
            label: "Выполняется автоматическое сжатие контекста",
            summary: "Выполняется автоматическое сжатие контекста",
            status: "running",
            itemId
        }, "immediate");
    }
    completeCompactionActivity(chatId, threadId, itemId) {
        const activityId = this.lookupCompactionActivityId(chatId, threadId, itemId);
        if (activityId) {
            this.options.state.addOrUpdateActivityItem(chatId, {
                id: activityId,
                activityKind: "context",
                label: "Выполняется автоматическое сжатие контекста",
                summary: "Выполняется автоматическое сжатие контекста",
                status: "completed",
                itemId
            }, "immediate");
        }
        this.options.state.addCompactionItem(chatId);
        if (threadId) {
            this.contextCompactionActivityIds.delete(`thread:${threadId}`);
        }
        if (itemId) {
            this.contextCompactionActivityIds.delete(`item:${itemId}`);
        }
    }
    compactionActivityId(chatId, threadId, itemId) {
        const existing = this.lookupCompactionActivityId(chatId, threadId, itemId);
        return existing || `compaction-activity-${threadId || itemId || chatId}`;
    }
    lookupCompactionActivityId(chatId, threadId, itemId) {
        return (threadId ? this.contextCompactionActivityIds.get(`thread:${threadId}`) : undefined)
            ?? (itemId ? this.contextCompactionActivityIds.get(`item:${itemId}`) : undefined)
            ?? this.contextCompactionActivityIds.get(`chat:${chatId}`);
    }
    rememberCompactionActivity(activityId, threadId, itemId) {
        if (threadId) {
            this.contextCompactionActivityIds.set(`thread:${threadId}`, activityId);
        }
        if (itemId) {
            this.contextCompactionActivityIds.set(`item:${itemId}`, activityId);
        }
    }
    async stop() {
        this.rejectAllHiddenPlannerRuns(new Error("Codex runtime stopped before docs planner completed."));
        this.rpcClient?.dispose();
        this.rpcClient = undefined;
        await this.processManager.stop();
        this.options.state.setRuntime({
            status: "notStarted",
            label: "Backend остановлен"
        });
        this.options.onDidChange();
    }
    cancelEpoch(chatId) {
        return this.cancelEpochByChat.get(chatId) ?? 0;
    }
    bumpCancelEpoch(chatId) {
        this.cancelEpochByChat.set(chatId, this.cancelEpoch(chatId) + 1);
    }
    throwIfCancelled(chatId, epoch) {
        if (this.cancelEpoch(chatId) !== epoch || this.cancellingChatIds.has(chatId)) {
            throw new UserCancelledTurnError();
        }
    }
    cleanupCancelledChat(chatId, turnId) {
        if (turnId) {
            this.cancelledTurnIds.add(turnId);
            this.activeTurnChatId.delete(turnId);
        }
        this.declinePendingApprovalsForChat(chatId);
        this.options.state.updateChat(chatId, {
            status: "idle",
            activeTurnId: null,
            pendingApproval: null,
            activeRunMode: null
        }, "immediate");
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
    }
    declinePendingApprovalsForChat(chatId) {
        for (const [approvalId, pending] of this.pendingApprovals.entries()) {
            if (pending.chatId !== chatId) {
                continue;
            }
            this.pendingApprovals.delete(approvalId);
            pending.resolve(false);
        }
        this.options.state.setPendingApproval(chatId, null);
    }
    async requestTurnCancel(threadId, turnId) {
        const rpcClient = this.requireRpcClient();
        try {
            await rpcClient.request("turn/cancel", { threadId, turnId }, 5000);
            return;
        }
        catch (error) {
            this.options.logger.warn(`turn/cancel with threadId failed, retrying turn-only payload: ${normalizeErrorMessage(error)}`);
        }
        await rpcClient.request("turn/cancel", { turnId }, 5000);
    }
    async stopBackendAfterCancel() {
        this.suppressNextExitAsCancel = true;
        this.rejectAllHiddenPlannerRuns(new Error("Codex runtime stopped after cancel fallback."));
        this.rpcClient?.dispose();
        this.rpcClient = undefined;
        await this.processManager.stop();
        this.options.state.setRuntime({
            status: "notStarted",
            label: "Backend остановлен после отмены запроса"
        });
        this.options.onDidChange();
    }
    dispose() {
        this.rejectAllHiddenPlannerRuns(new Error("Codex runtime disposed before docs planner completed."));
        this.rpcClient?.dispose();
        this.processManager.dispose();
    }
    async ensureBackendProcess() {
        if (this.processManager.isRunning) {
            return;
        }
        this.loadedThreadIds.clear();
        this.contextCompactionItemThreads.clear();
        this.contextCompactionActivityIds.clear();
        this.diagnosticsRetryAttemptedTurnIds.clear();
        this.diagnosticsRetryTurnIds.clear();
        this.fileChangingTurnIds.clear();
        this.resolveAllCompactionWaiters();
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
    handleHiddenPlannerNotification(notification) {
        const turnId = extractTurnId(notification.params);
        const threadId = extractThreadId(notification.params);
        const itemId = extractItemId(notification.params);
        const run = (turnId ? this.hiddenPlannerRunsByTurn.get(turnId) : undefined)
            ?? (threadId ? this.hiddenPlannerRunsByThread.get(threadId) : undefined)
            ?? (itemId ? this.hiddenPlannerRunsByItem.get(itemId) : undefined);
        if (!run) {
            return false;
        }
        if (turnId && !run.turnId) {
            run.turnId = turnId;
            this.hiddenPlannerRunsByTurn.set(turnId, run);
        }
        if (itemId) {
            this.hiddenPlannerRunsByItem.set(itemId, run);
        }
        if (notification.method === "item/agentMessage/delta") {
            const delta = extractDelta(notification.params);
            if (delta) {
                run.text += delta;
            }
            return true;
        }
        if (notification.method === "item/completed") {
            const text = extractCompletedAgentMessage(notification.params);
            if (text) {
                run.text = text;
            }
            return true;
        }
        if (notification.method === "turn/completed") {
            this.resolveHiddenPlannerRun(run);
            return true;
        }
        if (notification.method === "error" || notification.method === "turn/error") {
            this.rejectHiddenPlannerRun(run, new Error(extractErrorNotificationMessage(notification.params)));
            return true;
        }
        return true;
    }
    resolveHiddenPlannerRun(run) {
        if (run.settled) {
            return;
        }
        const text = run.text.trim();
        this.cleanupHiddenPlannerRun(run);
        if (!text) {
            run.reject(new Error("docs planner returned empty response."));
            return;
        }
        run.resolve(text);
    }
    rejectHiddenPlannerRun(run, error) {
        if (run.settled) {
            return;
        }
        this.cleanupHiddenPlannerRun(run);
        run.reject(error);
    }
    cleanupHiddenPlannerRun(run) {
        run.settled = true;
        clearTimeout(run.timer);
        this.hiddenPlannerRunsByThread.delete(run.threadId);
        if (run.turnId) {
            this.hiddenPlannerRunsByTurn.delete(run.turnId);
        }
        for (const [itemId, candidate] of this.hiddenPlannerRunsByItem.entries()) {
            if (candidate === run) {
                this.hiddenPlannerRunsByItem.delete(itemId);
            }
        }
    }
    rejectAllHiddenPlannerRuns(error) {
        for (const run of new Set(this.hiddenPlannerRunsByThread.values())) {
            this.rejectHiddenPlannerRun(run, error);
        }
        this.hiddenPlannerRunsByThread.clear();
        this.hiddenPlannerRunsByTurn.clear();
        this.hiddenPlannerRunsByItem.clear();
    }
    handleNotification(notification) {
        if (this.handleHiddenPlannerNotification(notification)) {
            return;
        }
        this.options.logger.info(`notification ${notification.method}`);
        const notificationTurnId = extractTurnId(notification.params);
        if (notificationTurnId && this.cancelledTurnIds.has(notificationTurnId)) {
            if (notification.method === "turn/completed" || notification.method === "error") {
                this.cancelledTurnIds.delete(notificationTurnId);
            }
            this.options.logger.info(`Ignored notification for cancelled turn ${notificationTurnId}: ${notification.method}.`);
            return;
        }
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
        if (notification.method === "account/rateLimits/updated") {
            try {
                const rateLimits = normalizeRateLimitsNotification(notification.params);
                this.updateRateLimits(rateLimits);
                this.options.logger.info(`Rate limits updated: rows=${rateLimits.rows.length}${rateLimits.rateLimitReachedType ? `, reached=${rateLimits.rateLimitReachedType}` : ""}.`);
            }
            catch (error) {
                const message = normalizeErrorMessage(error);
                this.updateRateLimits({
                    status: "error",
                    rows: [],
                    message,
                    updatedAt: new Date().toISOString()
                });
                this.options.logger.warn(`Rate limits update ignored: ${message}`);
            }
            return;
        }
        if (notification.method === "thread/tokenUsage/updated") {
            const usage = normalizeThreadTokenUsage(notification.params);
            const chatId = usage ? this.findChatIdForNotification(notification.params) : undefined;
            if (usage && chatId) {
                this.setContextWindow(chatId, usage.contextWindow);
                this.options.logger.info(`Thread token usage updated: thread=${usage.threadId || "-"}; contextInputTokens=${usage.contextWindow.usedTokens ?? "-"}; modelContextWindow=${usage.contextWindow.maxTokens ?? "-"}; contextPercent=${usage.contextWindow.usedPercent ?? "-"}; threadTotalTokens=${usage.threadTotalTokens ?? "-"}.`);
            }
            else if (!usage) {
                this.options.logger.warn(`Thread token usage ignored: unsupported payload shape ${describePayloadShape(notification.params)}.`);
            }
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
                if (this.cancellingChatIds.has(chatId)) {
                    this.cancelledTurnIds.add(turnId);
                    this.activeTurnChatId.delete(turnId);
                    return;
                }
                this.activeTurnChatId.set(turnId, chatId);
                this.options.state.updateChat(chatId, {
                    activeTurnId: turnId,
                    status: "running"
                });
                this.options.state.addOrUpdateActivityItem(chatId, {
                    id: `turn-${turnId}`,
                    activityKind: "turn",
                    label: "Работает",
                    status: "running",
                    turnId
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
            if (notificationTurnId && extractItemType(notification.params) === "fileChange") {
                this.fileChangingTurnIds.add(notificationTurnId);
            }
            const chatId = this.findChatIdForNotification(notification.params);
            if (itemId && chatId) {
                const activity = normalizeItemActivity(notification.params);
                if (activity) {
                    this.options.state.addOrUpdateActivityItem(chatId, {
                        id: `item-${itemId}`,
                        itemId,
                        turnId: notificationTurnId || undefined,
                        ...activity,
                        status: "running"
                    });
                    this.options.onDidChange();
                    this.options.onDidChangeChat(chatId);
                }
            }
            if (itemId && extractItemType(notification.params) === "contextCompaction") {
                const threadId = extractThreadId(notification.params);
                if (threadId) {
                    this.contextCompactionItemThreads.set(itemId, threadId);
                }
                if (chatId) {
                    this.setContextWindow(chatId, {
                        ...this.options.state.getChatContextWindow(chatId),
                        status: "compacting",
                        message: "Codex сжимает контекст..."
                    });
                    this.startCompactionActivity(chatId, threadId, itemId);
                    this.options.onDidChange();
                    this.options.onDidChangeChat(chatId);
                }
            }
            return;
        }
        if (notification.method === "turn/diff/updated") {
            const chatId = this.findChatIdForNotification(notification.params);
            const turnId = extractTurnId(notification.params);
            const diff = extractDiffText(extractItemRecord(notification.params));
            if (chatId && diff) {
                if (turnId) {
                    this.fileChangingTurnIds.add(turnId);
                }
                this.options.state.addOrUpdateDiffItem(chatId, turnId, "Изменения", parseUnifiedDiffFiles(diff));
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "turn/plan/updated") {
            const chatId = this.findChatIdForNotification(notification.params);
            const turnId = extractTurnId(notification.params);
            const markdown = normalizePlanMarkdown(notification.params);
            if (chatId && markdown) {
                this.options.state.addOrUpdatePlanItem(chatId, turnId, markdown);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/fileChange/patchUpdated") {
            const chatId = this.findChatIdForNotification(notification.params);
            const turnId = extractTurnId(notification.params);
            const files = normalizePatchUpdatedFiles(notification.params);
            if (chatId && files.length) {
                if (turnId) {
                    this.fileChangingTurnIds.add(turnId);
                }
                this.options.state.addOrUpdateDiffItem(chatId, turnId, "Изменения", files);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/commandExecution/outputDelta" || notification.method === "item/fileChange/outputDelta" || notification.method === "item/reasoning/summaryTextDelta" || notification.method === "item/reasoning/textDelta") {
            const chatId = this.findChatIdForNotification(notification.params);
            const itemId = extractItemId(notification.params);
            const delta = extractDelta(notification.params);
            if (chatId && itemId && delta) {
                this.options.state.appendActivityOutput(chatId, `item-${itemId}`, delta);
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "thread/compacted") {
            const chatId = this.findChatIdForNotification(notification.params) ?? this.latestChatId;
            if (chatId) {
                this.completeCompactionActivity(chatId, extractThreadId(notification.params));
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/agentMessage/delta") {
            const delta = extractDelta(notification.params);
            const chatId = this.findChatIdForNotification(notification.params);
            if (chatId && delta) {
                this.options.state.appendAssistantDelta(chatId, delta);
                this.options.onDidChangeChat(chatId);
            }
            return;
        }
        if (notification.method === "item/completed") {
            const itemId = extractItemId(notification.params);
            const itemType = extractItemType(notification.params);
            if (itemId && (itemType === "contextCompaction" || this.contextCompactionItemThreads.has(itemId))) {
                const threadId = extractThreadId(notification.params) || this.contextCompactionItemThreads.get(itemId) || "";
                const chatId = this.findChatIdForNotification(notification.params);
                if (itemId) {
                    this.itemPayloads.delete(itemId);
                    this.contextCompactionItemThreads.delete(itemId);
                }
                if (chatId) {
                    this.setContextWindow(chatId, {
                        ...this.options.state.getChatContextWindow(chatId),
                        status: "ready",
                        message: undefined
                    });
                    this.completeCompactionActivity(chatId, threadId, itemId);
                    this.options.onDidChange();
                    this.options.onDidChangeChat(chatId);
                }
                if (threadId) {
                    this.resolveCompactionWaiters(threadId);
                }
                return;
            }
            if (itemId) {
                this.itemPayloads.delete(itemId);
            }
            const chatId = this.findChatIdForNotification(notification.params);
            if (itemId && chatId) {
                const activity = normalizeItemActivity(notification.params);
                if (activity) {
                    this.options.state.addOrUpdateActivityItem(chatId, {
                        id: `item-${itemId}`,
                        itemId,
                        turnId: notificationTurnId || undefined,
                        ...activity,
                        status: "completed"
                    }, "immediate");
                }
            }
            const agentText = extractCompletedAgentMessage(notification.params);
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
            const chatBeforeComplete = chatId ? this.options.state.getChat(chatId) : undefined;
            const completedRunMode = chatBeforeComplete?.activeRunMode ?? "normal";
            const completedAccessMode = chatBeforeComplete
                ? getRunAccessMode(chatBeforeComplete.accessMode, completedRunMode)
                : "read-only";
            const isDiagnosticsRetryTurn = Boolean(turnId && this.diagnosticsRetryTurnIds.has(turnId));
            const mayHaveChangedFiles = Boolean(turnId && this.fileChangingTurnIds.has(turnId));
            if (turnId) {
                this.activeTurnChatId.delete(turnId);
            }
            if (chatId) {
                if (turnId) {
                    this.options.state.addOrUpdateActivityItem(chatId, {
                        id: `turn-${turnId}`,
                        activityKind: "turn",
                        label: status === "completed" || !errorMessage ? "Работал" : "Завершено с ошибкой",
                        status: status === "completed" || !errorMessage ? "completed" : "error",
                        turnId
                    }, "immediate");
                }
                this.options.state.updateChat(chatId, {
                    activeTurnId: null,
                    status: status === "completed" || !errorMessage ? "idle" : "error",
                    pendingApproval: null,
                    activeRunMode: null
                }, "immediate");
                if (errorMessage) {
                    this.options.state.addErrorItem(chatId, errorMessage, undefined, "immediate");
                }
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
            }
            if (turnId) {
                this.fileChangingTurnIds.delete(turnId);
            }
            if (chatId && turnId && isDiagnosticsRetryTurn) {
                this.diagnosticsRetryTurnIds.delete(turnId);
                void this.logDiagnosticsRetryResult(chatId, turnId);
            }
            else if (chatId && turnId && (status === "completed" || !errorMessage)) {
                void this.maybeStartDiagnosticsAutoFix(chatId, turnId, completedAccessMode, completedRunMode, mayHaveChangedFiles);
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
            const reconnect = parseReconnectMessage(message);
            if (chatId && reconnect) {
                this.options.state.addConnectionItem(chatId, message, "reconnecting", reconnect.attempt, reconnect.maxAttempts);
                this.options.onDidChange();
                this.options.onDidChangeChat(chatId);
                this.options.logger.warn(`App-server reconnecting: ${message}`);
                return;
            }
            if (chatId && (this.cancellingChatIds.has(chatId) || this.options.state.getChat(chatId)?.status === "cancelling")) {
                this.options.logger.info(`Ignored app-server error while cancelling chat ${chatId}: ${message}`);
                return;
            }
            if (chatId) {
                this.options.state.updateChat(chatId, {
                    status: "error",
                    activeTurnId: null,
                    activeRunMode: null
                });
                this.options.state.addErrorItem(chatId, message);
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
        const wasCancelFallback = this.suppressNextExitAsCancel;
        this.suppressNextExitAsCancel = false;
        for (const pending of this.pendingApprovals.values()) {
            pending.resolve(false);
            this.options.state.setPendingApproval(pending.chatId, null);
        }
        this.pendingApprovals.clear();
        this.rejectAllHiddenPlannerRuns(new Error("Codex app-server exited before docs planner completed."));
        this.loadedThreadIds.clear();
        this.contextCompactionItemThreads.clear();
        this.contextCompactionActivityIds.clear();
        this.diagnosticsRetryAttemptedTurnIds.clear();
        this.diagnosticsRetryTurnIds.clear();
        this.fileChangingTurnIds.clear();
        this.resolveAllCompactionWaiters();
        this.rpcClient?.dispose();
        this.rpcClient = undefined;
        this.options.state.setRuntime({
            status: wasCancelFallback ? "notStarted" : "error",
            label: wasCancelFallback
                ? "Backend остановлен после отмены запроса"
                : `Backend остановлен${code === null ? "" : `, код ${code}`}${signal ? `, ${signal}` : ""}`
        });
        this.options.onDidChange();
        if (wasCancelFallback) {
            this.options.logger.info(`codex app-server stopped after cancel fallback: code=${code ?? "-"} signal=${signal ?? "-"}.`);
        }
        else {
            this.options.logger.warn(`codex app-server exited: code=${code ?? "-"} signal=${signal ?? "-"}.`);
        }
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
    updateRateLimits(rateLimits) {
        this.options.state.setRateLimits(rateLimits);
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
function buildDocsPlannerPrompt(request) {
    const roots = request.input.roots.map((root) => ({
        root: root.root,
        fingerprint: root.fingerprint,
        fileCount: root.fileCount,
        latestMtimeMs: root.latestMtimeMs,
        corpusCount: root.corpusCount,
        fragmentCount: root.fragmentCount
    }));
    const corpora = request.input.corpora
        .slice()
        .sort((left, right) => right.priority - left.priority || left.corpus.localeCompare(right.corpus))
        .map((corpus) => ({
        corpus: corpus.corpus,
        label: corpus.label,
        root: corpus.root,
        priority: corpus.priority,
        format: corpus.format,
        fragmentCount: corpus.fragmentCount,
        titles: corpus.titles.slice(0, 32),
        keywords: corpus.keywords.slice(0, 48),
        excerpts: corpus.excerpts.slice(0, 6)
    }));
    return [
        "Ты скрытый planner поиска по документации для Codex for 1C: Element.",
        "Твоя задача: по запросу пользователя выбрать поисковые формулировки и предпочтительные корпуса документации.",
        "Не отвечай на вопрос пользователя. Верни только JSON без markdown и без пояснений.",
        "Схема JSON:",
        "{\"queries\":[\"...\"],\"preferredCorpora\":[\"lang\"],\"targetTitles\":[\"...\"],\"needOverview\":false,\"reason\":\"short\"}",
        "Правила:",
        "- максимум 10 queries;",
        "- preferredCorpora выбирай из corpus id карты ниже;",
        "- для вопросов по языку, API, типам, методам, свойствам, структурам, формам и синтаксису предпочитай lang/ai-docs-lang;",
        "- bundle выбирай только для вопросов про server bundle, runtime, плагины и поставку;",
        "- console выбирай только для вопросов про IDE, панели, команды и console;",
        "- если пользователь просит ознакомиться/изучить документацию целиком, выставь needOverview=true;",
        "- не указывай локальные пути, которых нет в карте корпусов.",
        "",
        "Запрос пользователя:",
        request.prompt,
        "",
        "Карта документации:",
        truncateForPrompt(JSON.stringify({ roots, corpora }, null, 2), 32000)
    ].join("\n");
}
function truncateForPrompt(value, maxChars) {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}\n...<truncated>`;
}
function resolveBundledRuntimePath(context) {
    return path.join(context.extensionUri.fsPath, "bin", "windows-x86_64", "codex.exe");
}
function getApprovalPolicy(accessMode) {
    return accessMode === "read-only" ? "never" : "on-request";
}
function getRunAccessMode(accessMode, mode) {
    return mode === "planning" ? "read-only" : accessMode;
}
function getThreadSandbox(accessMode) {
    if (accessMode === "workspace-write") {
        return "workspace-write";
    }
    if (accessMode === "danger-full-access") {
        return "danger-full-access";
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
function normalizeRateLimitsResult(result) {
    const root = isRecord(result) ? result : {};
    return normalizeRateLimits(root.rateLimits ?? root);
}
function normalizeRateLimitsNotification(params) {
    const root = isRecord(params) ? params : {};
    return normalizeRateLimits(root.rateLimits ?? root);
}
function normalizeRateLimits(value) {
    const root = isRecord(value) ? value : {};
    const rows = [
        normalizeRateLimitRow("primary", root.primary),
        normalizeRateLimitRow("secondary", root.secondary)
    ].filter((row) => Boolean(row));
    return {
        status: "ready",
        rows,
        updatedAt: new Date().toISOString(),
        rateLimitReachedType: getString(root.rateLimitReachedType) || undefined
    };
}
function normalizeRateLimitRow(kind, value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const usedPercent = clampPercent(getNumber(value.usedPercent, 0));
    const windowDurationMins = getOptionalNumber(value.windowDurationMins);
    const resetsAt = getOptionalNumber(value.resetsAt);
    return {
        kind,
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        windowDurationMins,
        resetsAt
    };
}
function normalizeThreadTokenUsage(params) {
    const root = isRecord(params) ? params : {};
    const threadId = extractThreadId(root);
    const tokenUsage = isRecord(root.tokenUsage) ? root.tokenUsage : null;
    const totalUsage = tokenUsage && isRecord(tokenUsage.total) ? tokenUsage.total : null;
    const lastUsage = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : null;
    const fallbackUsedTokens = findFirstNumber(root, [
        "contextUsedTokens",
        "usedTokens",
        "tokensUsed",
        "inputTokens",
        "totalInputTokens"
    ]);
    const contextInputTokens = getOptionalNumber(lastUsage?.inputTokens) ?? fallbackUsedTokens;
    const threadTotalTokens = getOptionalNumber(totalUsage?.totalTokens);
    const maxTokens = getOptionalNumber(tokenUsage?.modelContextWindow) ?? findFirstNumber(root, [
        "maxTokens",
        "tokenLimit",
        "modelContextWindow",
        "contextWindow",
        "contextWindowTokens",
        "contextWindowSize",
        "maxContextTokens"
    ]);
    const rawPercent = findFirstNumber(root, ["usedPercent", "percentUsed", "contextWindowPercent"]);
    const derivedPercent = contextInputTokens !== null && maxTokens && maxTokens > 0
        ? contextInputTokens / maxTokens * 100
        : rawPercent !== null
            ? normalizePercentValue(rawPercent)
            : null;
    if (!threadId && contextInputTokens === null && maxTokens === null && derivedPercent === null && threadTotalTokens === null) {
        return undefined;
    }
    return {
        threadId,
        contextWindow: {
            status: "ready",
            usedTokens: contextInputTokens,
            maxTokens,
            usedPercent: derivedPercent === null ? null : clampPercent(derivedPercent),
            updatedAt: new Date().toISOString()
        },
        threadTotalTokens
    };
}
function describePayloadShape(value) {
    if (!isRecord(value)) {
        return Array.isArray(value) ? "array" : typeof value;
    }
    const keys = Object.keys(value).slice(0, 12);
    const nested = keys
        .map((key) => {
        const nestedValue = value[key];
        return isRecord(nestedValue) ? `${key}{${Object.keys(nestedValue).slice(0, 8).join(",")}}` : key;
    })
        .join(",");
    return nested || "empty-object";
}
async function probeNativeToolListCandidates(rpcClient) {
    const candidates = [
        "tools/list",
        "tool/list",
        "mcp/list",
        "mcpServer/list",
        "mcpServer/listTools",
        "capabilities/read"
    ];
    const observations = [];
    const startedAt = Date.now();
    for (const method of candidates) {
        try {
            const result = await rpcClient.request(method, undefined, 3000);
            return {
                capability: "native MCP/custom tools listing",
                status: "supported",
                observation: `${method} responded with ${describePayloadShape(result)}`,
                evidence: "live rpc candidate probe",
                elapsedMs: Date.now() - startedAt
            };
        }
        catch (error) {
            observations.push(`${method}: ${shorten(normalizeErrorMessage(error), 140)}`);
        }
    }
    return {
        capability: "native MCP/custom tools listing",
        status: "unknown",
        observation: `no known candidate listing method responded; ${observations.join(" | ")}`,
        evidence: "live rpc candidate probe",
        elapsedMs: Date.now() - startedAt
    };
}
function formatCapabilityProbeReport(rows, elapsedMs) {
    const lines = [
        `Capability probe completed in ${elapsedMs}ms.`,
        "Capability probe matrix:",
        "| Capability | Status | Evidence | Observation |",
        "| --- | --- | --- | --- |"
    ];
    for (const row of rows) {
        lines.push(`| ${escapeProbeCell(row.capability)} | ${row.status} | ${escapeProbeCell(row.evidence)}${row.elapsedMs === undefined ? "" : ` (${row.elapsedMs}ms)`} | ${escapeProbeCell(row.observation)} |`);
    }
    return lines.join("\n");
}
function escapeProbeCell(value) {
    return (0, logger_1.redact)(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function shorten(value, maxLength) {
    const redacted = (0, logger_1.redact)(value);
    return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}...`;
}
function isUnsupportedCapabilityError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return (message.includes("method not found") ||
        message.includes("not found") && message.includes("method") ||
        message.includes("unknown method") ||
        message.includes("unsupported") ||
        message.includes("unknown field") ||
        message.includes("unknown variant"));
}
function normalizePercentValue(value) {
    return value > 0 && value <= 1 ? value * 100 : value;
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
function extractItemType(value) {
    const root = isRecord(value) ? value : {};
    const direct = getString(root.type);
    if (direct) {
        return direct;
    }
    const item = isRecord(root.item) ? root.item : null;
    return item ? getString(item.type) : "";
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
function isContextWindowError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return (message.includes("context") && (message.includes("exceed") || message.includes("full") || message.includes("too large")) ||
        message.includes("token") && (message.includes("exceed") || message.includes("too many") || message.includes("maximum")));
}
function isInvalidRequestError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return message.includes("invalid request") || message.includes("unknown field") || message.includes("unknown variant");
}
function isModelOrEffortError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return (message.includes("unknown model") ||
        message.includes("invalid model") ||
        message.includes("model") && message.includes("invalid request") ||
        message.includes("unknown variant") && message.includes("effort") ||
        message.includes("invalid effort"));
}
function isSpeedError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    return (message.includes("speed") && message.includes("invalid request") ||
        message.includes("unknown field") && message.includes("speed") ||
        message.includes("unknown variant") && message.includes("speed") ||
        message.includes("invalid speed"));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeErrorMessage(error) {
    return (0, logger_1.redact)(error instanceof Error ? error.message : "Неизвестная ошибка Codex runtime.");
}
function normalizeModelOptions(value) {
    const items = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value.models)
            ? value.models
            : isRecord(value) && Array.isArray(value.items)
                ? value.items
                : [];
    const normalized = [];
    const seen = new Set();
    for (const item of items) {
        const record = isRecord(item) ? item : {};
        const id = getString(record.id) || getString(record.model) || getString(record.name);
        const label = getString(record.label) || getString(record.displayName) || getString(record.title) || prettifyModelLabel(id);
        if (!id && !label) {
            continue;
        }
        const option = { id: id || null, label: label || id };
        const key = `${option.id ?? "<default>"}:${option.label}`;
        if (!seen.has(key)) {
            seen.add(key);
            normalized.push(option);
        }
    }
    return normalized.length ? normalized : FALLBACK_MODEL_OPTIONS;
}
function normalizeItemActivity(value) {
    const root = isRecord(value) ? value : {};
    const item = extractItemRecord(value);
    const type = extractItemType(value);
    const command = extractFirstString(item, ["command", "cmd", "shellCommand", "argv", "commandLine"]);
    const filePath = extractFirstString(item, ["path", "filePath", "absolutePath", "targetPath"]);
    const summary = extractFirstString(item, ["summary", "message", "description", "title"]);
    if (type === "agentMessage"
        || type === "userMessage"
        || type === "hookPrompt"
        || type === "contextCompaction"
        || type === "plan") {
        return undefined;
    }
    if (type === "commandExecution") {
        return {
            activityKind: "command",
            label: command ? `Выполняется ${command}` : "Выполняется команда",
            command,
            summary
        };
    }
    if (type === "fileChange") {
        return {
            activityKind: "file",
            label: filePath ? `Изменяется ${filePath}` : "Изменяются файлы",
            path: filePath,
            summary
        };
    }
    if (type === "webSearch") {
        return {
            activityKind: "search",
            label: summary || "Выполняется поиск",
            summary
        };
    }
    if (type === "reasoning") {
        return {
            activityKind: "reasoning",
            label: summary || "Думаю",
            summary
        };
    }
    const method = getString(root.method);
    if (!type && !method) {
        return undefined;
    }
    return {
        activityKind: "unknown",
        label: summary || type || method || "Действие Codex",
        summary
    };
}
function normalizePlanMarkdown(value) {
    const root = isRecord(value) ? value : {};
    const lines = [];
    const explanation = getString(root.explanation);
    if (explanation.trim()) {
        lines.push(explanation.trim());
    }
    const plan = Array.isArray(root.plan) ? root.plan : [];
    for (const step of plan) {
        const record = isRecord(step) ? step : {};
        const text = getString(record.step) || getString(record.text) || getString(record.title);
        if (!text.trim()) {
            continue;
        }
        const status = getString(record.status);
        const marker = status === "completed" ? "x" : " ";
        lines.push(`- [${marker}] ${text.trim()}`);
    }
    return lines.join("\n\n").trim();
}
function normalizePatchUpdatedFiles(value) {
    const root = isRecord(value) ? value : {};
    const changes = Array.isArray(root.changes) ? root.changes : [];
    const files = [];
    for (const change of changes) {
        const record = isRecord(change) ? change : {};
        const diff = getString(record.diff);
        const parsed = diff ? parseUnifiedDiffFiles(diff) : [];
        const pathValue = getString(record.path) || parsed[0]?.path || "unknown";
        const stats = parsed[0] ?? countDiffStats(pathValue, diff);
        files.push({
            path: pathValue,
            additions: stats.additions,
            deletions: stats.deletions,
            diff: diff || undefined
        });
    }
    return mergeDiffFiles(files);
}
function parseUnifiedDiffFiles(diff) {
    const lines = diff.split(/\r?\n/);
    const files = [];
    let current;
    for (const line of lines) {
        const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (header) {
            if (current) {
                files.push(current);
            }
            current = { path: header[2] || header[1], additions: 0, deletions: 0, diff: "" };
            continue;
        }
        const plusFile = line.match(/^\+\+\+ b\/(.+)$/);
        if (!current && plusFile) {
            current = { path: plusFile[1], additions: 0, deletions: 0, diff: "" };
        }
        if (!current) {
            current = { path: "changes.patch", additions: 0, deletions: 0, diff: "" };
        }
        current.diff = `${current.diff || ""}${line}\n`;
        if (line.startsWith("+") && !line.startsWith("+++")) {
            current.additions += 1;
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            current.deletions += 1;
        }
    }
    if (current) {
        files.push(current);
    }
    return mergeDiffFiles(files);
}
function mergeDiffFiles(files) {
    const byPath = new Map();
    for (const file of files) {
        const key = file.path || "unknown";
        const existing = byPath.get(key);
        if (!existing) {
            byPath.set(key, { ...file, path: key });
            continue;
        }
        existing.additions += file.additions;
        existing.deletions += file.deletions;
        existing.diff = [existing.diff, file.diff].filter(Boolean).join("\n");
    }
    return [...byPath.values()];
}
function countDiffStats(pathValue, diff) {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            additions += 1;
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            deletions += 1;
        }
    }
    return { path: pathValue, additions, deletions, diff: diff || undefined };
}
function parseReconnectMessage(message) {
    const match = message.match(/(?:reconnecting|повтор).*?(\d+)\s*\/\s*(\d+)/i) || message.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) {
        return undefined;
    }
    const attempt = Number(match[1]);
    const maxAttempts = Number(match[2]);
    return Number.isFinite(attempt) && Number.isFinite(maxAttempts) ? { attempt, maxAttempts } : undefined;
}
function prettifyModelLabel(modelId) {
    if (!modelId) {
        return "";
    }
    return modelId
        .replace(/^gpt-/i, "GPT-")
        .replace(/-codex/i, " Codex")
        .replace(/-spark/i, " Spark")
        .replace(/-/g, ".");
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
function getNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function getOptionalNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function findFirstNumber(value, keys) {
    if (!isRecord(value)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = findFirstNumber(item, keys);
                if (found !== null) {
                    return found;
                }
            }
        }
        return null;
    }
    for (const key of keys) {
        const direct = value[key];
        if (typeof direct === "number" && Number.isFinite(direct)) {
            return direct;
        }
    }
    for (const nested of Object.values(value)) {
        const found = findFirstNumber(nested, keys);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
}
function getBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
//# sourceMappingURL=codexRuntimeController.js.map