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
exports.RuntimeAuthController = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const jsonRpcClient_1 = require("./jsonRpcClient");
const logger_1 = require("./logger");
const runtimeProcessManager_1 = require("./runtimeProcessManager");
class RuntimeAuthController {
    constructor(options) {
        this.options = options;
        this.processManager = new runtimeProcessManager_1.RuntimeProcessManager();
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
        const profileId = await this.options.profiles.requireProfileId();
        const codexHome = await this.options.settings.ensureUserCodexHome(profileId);
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
        }
    }
    handleServerRequest(request) {
        this.options.logger.warn(`Unsupported app-server request during auth: ${request.method}.`);
        return {};
    }
    handleExit(code, signal) {
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
}
exports.RuntimeAuthController = RuntimeAuthController;
function resolveBundledRuntimePath(context) {
    return path.join(context.extensionUri.fsPath, "bin", "windows-x86_64", "codex.exe");
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
function normalizeErrorMessage(error) {
    return (0, logger_1.redact)(error instanceof Error ? error.message : "Неизвестная ошибка Codex runtime.");
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
//# sourceMappingURL=runtimeAuthController.js.map