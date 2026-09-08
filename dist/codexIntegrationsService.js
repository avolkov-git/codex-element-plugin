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
exports.CodexIntegrationsService = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const codexIntegrationConstants_1 = require("./codexIntegrationConstants");
const platform_1 = require("./platform");
class CodexIntegrationsService {
    constructor(context, settings, profiles, runtime, logger) {
        this.context = context;
        this.settings = settings;
        this.profiles = profiles;
        this.runtime = runtime;
        this.logger = logger;
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChange = this.changeEmitter.event;
        this.snapshot = {
            status: "idle",
            mcpStatus: "idle",
            skillsStatus: "idle",
            mcpServers: [],
            skills: [],
            message: "Интеграции загружаются только по запросу.",
            mcpMessage: "",
            skillsMessage: ""
        };
        this.runtimeSubscription = runtime.onDidChangeIntegrations(() => {
            if (this.snapshot.status !== "idle") {
                void this.refresh(true);
            }
        });
    }
    dispose() {
        this.runtimeSubscription.dispose();
        this.changeEmitter.dispose();
    }
    getSnapshot() {
        return {
            ...this.snapshot,
            mcpServers: this.withManagedBrowser(this.snapshot.mcpServers).map((server) => ({ ...server, args: server.args ? [...server.args] : undefined })),
            skills: this.snapshot.skills.map((skill) => ({ ...skill }))
        };
    }
    setManagedBrowserProvider(provider) {
        this.managedBrowserProvider = provider;
    }
    async refresh(forceSkills = false) {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        const refresh = this.performRefresh(forceSkills);
        this.refreshPromise = refresh;
        try {
            return await refresh;
        }
        finally {
            if (this.refreshPromise === refresh) {
                this.refreshPromise = undefined;
            }
        }
    }
    async performRefresh(forceSkills) {
        const previous = this.snapshot;
        this.snapshot = {
            ...this.snapshot,
            status: "loading",
            mcpStatus: "loading",
            skillsStatus: "loading",
            message: "Проверяем MCP-серверы и навыки...",
            mcpMessage: "",
            skillsMessage: ""
        };
        this.changeEmitter.fire();
        const mcpWarnings = [];
        const skillsWarnings = [];
        let configured = previous.mcpServers;
        let runtimeStatuses = [];
        let skills = previous.skills;
        let configuredLoaded = false;
        let runtimeLoaded = false;
        let skillsLoaded = false;
        try {
            configured = await this.listConfiguredMcpServers();
            configuredLoaded = true;
        }
        catch (error) {
            mcpWarnings.push(`Не удалось прочитать конфигурацию MCP: ${errorMessage(error)}`);
        }
        try {
            runtimeStatuses = await this.runtime.loadMcpRuntimeStatuses();
            runtimeLoaded = true;
        }
        catch (error) {
            mcpWarnings.push(`Runtime-статусы MCP недоступны: ${errorMessage(error)}`);
        }
        try {
            skills = await this.runtime.loadSkills(forceSkills);
            skillsLoaded = true;
        }
        catch (error) {
            skillsWarnings.push(`Не удалось обновить навыки: ${errorMessage(error)}`);
        }
        const statusesByName = new Map(runtimeStatuses.map((status) => [status.name, status]));
        const mcpServers = this.withManagedBrowser(configured).map((server) => {
            const runtimeStatus = statusesByName.get(server.name);
            return runtimeStatus ? {
                ...server,
                authStatus: runtimeStatus.authStatus,
                runtimeStatus: runtimeStatus.runtimeStatus,
                toolCount: runtimeStatus.toolCount,
                resourceCount: runtimeStatus.resourceCount,
                description: runtimeStatus.description,
                error: runtimeStatus.error
            } : server;
        });
        const mcpStatus = mcpWarnings.length
            ? (mcpServers.length || configuredLoaded || runtimeLoaded ? "partial" : "error")
            : "ready";
        const skillsStatus = skillsWarnings.length
            ? (skills.length ? "partial" : "error")
            : "ready";
        const warnings = [...mcpWarnings, ...skillsWarnings];
        this.snapshot = {
            status: mcpStatus === "error" && skillsStatus === "error" ? "error" : warnings.length ? "partial" : "ready",
            mcpStatus,
            skillsStatus,
            mcpServers,
            skills,
            message: warnings.join(" "),
            mcpMessage: mcpWarnings.join(" "),
            skillsMessage: skillsWarnings.join(" "),
            updatedAt: new Date().toISOString()
        };
        this.changeEmitter.fire();
        this.logger.info(`Integrations refreshed: mcp=${mcpServers.length}; mcpStatus=${mcpStatus}; skills=${skills.length}; skillsStatus=${skillsStatus}; warnings=${warnings.length}.`);
        return this.getSnapshot();
    }
    async saveMcpServer(input) {
        const normalized = normalizeMcpInput(input);
        if (isReservedBrowserName(normalized.name) || (normalized.originalName && isReservedBrowserName(normalized.originalName))) {
            throw new Error("Управляемый браузер настраивается в разделе браузерного тестирования, а не в общем MCP-профиле.");
        }
        const codexHome = await this.getCodexHome();
        await editMcpConfig(codexHome, async (stagedHome) => {
            if (normalized.originalName) {
                await this.runCli(["mcp", "remove", normalized.originalName], stagedHome);
            }
            const args = ["mcp", "add", normalized.name];
            if (normalized.transport === "http") {
                args.push("--url", normalized.url);
                if (normalized.bearerTokenEnvVar) {
                    args.push("--bearer-token-env-var", normalized.bearerTokenEnvVar);
                }
            }
            else {
                args.push("--", normalized.command, ...(normalized.args ?? []));
            }
            await this.runCli(args, stagedHome);
            if (normalized.enabled === false) {
                await setMcpEnabledInConfig(path.join(stagedHome, "config.toml"), normalized.name, false);
            }
        });
        await this.reloadRuntimeMcpIfRunning();
        await this.refresh(true);
        this.logger.info(`MCP server saved: name=${normalized.name}; transport=${normalized.transport}; enabled=${normalized.enabled !== false}.`);
        return normalized.name;
    }
    async getConfiguredMcpServer(name) {
        const normalizedName = validateMcpName(name);
        return (await this.listConfiguredMcpServers()).find((server) => server.name === normalizedName);
    }
    async removeMcpServer(name) {
        const normalizedName = validateMcpName(name);
        const codexHome = await this.getCodexHome();
        await editMcpConfig(codexHome, async (stagedHome) => {
            await this.runCli(["mcp", "remove", normalizedName], stagedHome);
        });
        await this.reloadRuntimeMcpIfRunning();
        await this.refresh(true);
        this.logger.info(`MCP server removed: name=${normalizedName}.`);
    }
    async setMcpEnabled(name, enabled) {
        const normalizedName = validateMcpName(name);
        if (isReservedBrowserName(normalizedName)) {
            throw new Error("Измените настройки браузерного тестирования текущего пользователя и проекта.");
        }
        const codexHome = await this.getCodexHome();
        await editMcpConfig(codexHome, async (stagedHome) => {
            await setMcpEnabledInConfig(path.join(stagedHome, "config.toml"), normalizedName, enabled);
        });
        await this.reloadRuntimeMcpIfRunning();
        await this.refresh(true);
        this.logger.info(`MCP server ${enabled ? "enabled" : "disabled"}: name=${normalizedName}.`);
    }
    async startMcpOAuth(name) {
        await this.runtime.startMcpOAuth(validateMcpName(name));
    }
    async testMcpServer(name) {
        const normalizedName = validateMcpName(name);
        let configured = this.snapshot.mcpServers.find((server) => server.name === normalizedName);
        if (!configured) {
            const servers = await this.listConfiguredMcpServers();
            configured = servers.find((server) => server.name === normalizedName);
        }
        if (!configured) {
            throw new Error(`MCP-сервер ${normalizedName} не найден в профиле Codex.`);
        }
        if (!configured.enabled) {
            return {
                name: normalizedName,
                status: "disabled",
                message: "Сервер выключен. Включите его перед проверкой.",
                runtimeStatus: "cancelled",
                authStatus: configured.authStatus,
                toolCount: 0,
                resourceCount: 0
            };
        }
        await this.reloadRuntimeMcpIfRunning();
        const statuses = await this.runtime.loadMcpRuntimeStatuses();
        const runtimeStatus = statuses.find((candidate) => candidate.name === normalizedName);
        const resolved = runtimeStatus ? {
            ...configured,
            authStatus: runtimeStatus.authStatus,
            runtimeStatus: runtimeStatus.runtimeStatus,
            toolCount: runtimeStatus.toolCount,
            resourceCount: runtimeStatus.resourceCount,
            description: runtimeStatus.description,
            error: runtimeStatus.error
        } : {
            ...configured,
            runtimeStatus: "failed",
            error: "App-server не вернул статус этого MCP-сервера."
        };
        this.snapshot = {
            ...this.snapshot,
            mcpStatus: resolved.runtimeStatus === "failed" ? "partial" : this.snapshot.mcpStatus,
            mcpServers: replaceMcpServer(this.snapshot.mcpServers, resolved),
            updatedAt: new Date().toISOString()
        };
        this.changeEmitter.fire();
        const status = resolved.authStatus === "notLoggedIn"
            ? "authRequired"
            : resolved.runtimeStatus === "ready"
                ? "ready"
                : "failed";
        const message = status === "ready"
            ? `Соединение установлено: ${resolved.toolCount} ${pluralRu(resolved.toolCount, "инструмент", "инструмента", "инструментов")}, ${resolved.resourceCount} ${pluralRu(resolved.resourceCount, "ресурс", "ресурса", "ресурсов")}.`
            : status === "authRequired"
                ? "Сервер доступен, но требует входа."
                : mcpFailureMessage(resolved.runtimeStatus, resolved.error);
        this.logger.info(`MCP server tested: name=${normalizedName}; status=${status}; runtime=${resolved.runtimeStatus}; auth=${resolved.authStatus}; tools=${resolved.toolCount}; resources=${resolved.resourceCount}.`);
        return {
            name: normalizedName,
            status,
            message,
            runtimeStatus: resolved.runtimeStatus,
            authStatus: resolved.authStatus,
            toolCount: resolved.toolCount,
            resourceCount: resolved.resourceCount,
            details: resolved.error
        };
    }
    async setSkillEnabled(skill, enabled) {
        if (!skill.name.trim() || !path.isAbsolute(skill.path)) {
            throw new Error("Навык не содержит корректный абсолютный путь.");
        }
        await this.runtime.setSkillEnabled(skill, enabled);
        await this.refresh(true);
        this.logger.info(`Skill ${enabled ? "enabled" : "disabled"}: name=${skill.name}; scope=profile/runtime.`);
    }
    async listEnabledSkills(forceReload = false) {
        const skills = await this.runtime.loadSkills(forceReload);
        if (this.snapshot.status !== "idle") {
            this.snapshot = {
                ...this.snapshot,
                skills,
                skillsStatus: "ready",
                skillsMessage: "",
                updatedAt: new Date().toISOString()
            };
            this.changeEmitter.fire();
        }
        return skills.filter((skill) => skill.enabled);
    }
    async listConfiguredMcpServers() {
        const result = await this.runCli(["mcp", "list", "--json"]);
        const records = JSON.parse(result.stdout || "[]");
        if (!Array.isArray(records)) {
            throw new Error("Codex CLI вернул некорректный список MCP-серверов.");
        }
        return this.withManagedBrowser(records.flatMap((candidate) => normalizeMcpCliRecord(candidate)))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    withManagedBrowser(configured) {
        const servers = configured.filter((server) => !isReservedBrowserName(server.name));
        const managed = this.managedBrowserProvider?.();
        if (managed) {
            const previous = configured.find((server) => server.name === managed.name);
            servers.push({
                authStatus: "unsupported", runtimeStatus: "unknown", toolCount: 0, resourceCount: 0,
                ...previous,
                name: managed.name, enabled: managed.enabled !== false, transport: "stdio", command: managed.command,
                args: [...managed.args ?? []], managed: "browser"
            });
        }
        return servers;
    }
    async reloadRuntimeMcpIfRunning() {
        if (this.runtime.isBackendRunning()) {
            await this.runtime.reloadMcpServers();
        }
    }
    async getCodexHome() {
        const profileId = await this.profiles.requireProfileId(this.settings.listExistingProfileIds());
        return this.settings.ensureUserCodexHome(profileId);
    }
    async runCli(args, home) {
        const resolution = (0, platform_1.resolveBundledRuntimeExecutable)(this.context.extensionUri.fsPath);
        const validation = (0, platform_1.validateRuntimeExecutable)(resolution);
        if (!validation.ok) {
            throw new Error(validation.message);
        }
        const codexHome = home ?? await this.getCodexHome();
        const env = {
            ...process.env,
            CODEX_HOME: codexHome
        };
        return runProcess(resolution.path, args, env, 20000);
    }
}
exports.CodexIntegrationsService = CodexIntegrationsService;
function replaceMcpServer(servers, replacement) {
    const next = servers.map((server) => server.name === replacement.name ? replacement : server);
    return next.some((server) => server.name === replacement.name)
        ? next
        : [...next, replacement].sort((left, right) => left.name.localeCompare(right.name));
}
function isReservedBrowserName(name) {
    return name === codexIntegrationConstants_1.MANAGED_BROWSER_MCP_NAME || name.startsWith(`${codexIntegrationConstants_1.MANAGED_BROWSER_MCP_NAME}-`);
}
function pluralRu(value, one, few, many) {
    const normalized = Math.abs(Math.trunc(value));
    const lastTwo = normalized % 100;
    const last = normalized % 10;
    if (lastTwo >= 11 && lastTwo <= 14) {
        return many;
    }
    if (last === 1) {
        return one;
    }
    return last >= 2 && last <= 4 ? few : many;
}
function mcpFailureMessage(status, details) {
    if (status === "starting") {
        return "Сервер не успел завершить запуск. Повторите проверку через несколько секунд.";
    }
    if (status === "cancelled") {
        return "Запуск сервера был отменен runtime.";
    }
    const normalized = (details ?? "").toLowerCase();
    if (normalized.includes("timed out") || normalized.includes("timeout")) {
        return "Сервер не ответил вовремя.";
    }
    if (normalized.includes("protocol") || normalized.includes("handshake") || normalized.includes("initialize")) {
        return "Сервер запущен, но не завершил MCP handshake.";
    }
    if (normalized.includes("refused") || normalized.includes("econnrefused")) {
        return "Подключение отклонено. Проверьте URL, порт и доступность сервера.";
    }
    if (normalized.includes("spawn") || normalized.includes("enoent") || normalized.includes("not found")) {
        return "Не удалось запустить команду MCP-сервера. Проверьте путь и аргументы.";
    }
    return "Не удалось подключиться к MCP-серверу.";
}
function normalizeMcpInput(input) {
    const name = validateMcpName(input.name);
    const originalName = input.originalName?.trim() ? validateMcpName(input.originalName) : undefined;
    if (input.transport === "http") {
        const rawUrl = input.url?.trim() ?? "";
        let parsed;
        try {
            parsed = new URL(rawUrl);
        }
        catch {
            throw new Error("Укажите корректный URL MCP-сервера.");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("MCP URL должен использовать http или https.");
        }
        const bearerTokenEnvVar = input.bearerTokenEnvVar?.trim() ?? "";
        if (bearerTokenEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar)) {
            throw new Error("Имя переменной bearer token содержит недопустимые символы.");
        }
        return { ...input, originalName, name, transport: "http", url: parsed.toString(), bearerTokenEnvVar, enabled: input.enabled !== false };
    }
    const command = input.command?.trim() ?? "";
    if (!command || /[\r\n\0]/.test(command)) {
        throw new Error("Укажите команду запуска MCP-сервера.");
    }
    const args = (input.args ?? []).map((arg) => arg.trim()).filter(Boolean).slice(0, 50);
    return { ...input, originalName, name, transport: "stdio", command, args, enabled: input.enabled !== false };
}
function validateMcpName(value) {
    const normalized = value.trim().replace(/\s+/g, "-");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
        throw new Error("Имя MCP-сервера: 1-64 символа, только латиница, цифры, _ и -.");
    }
    return normalized;
}
function normalizeMcpCliRecord(value) {
    if (!value || typeof value !== "object") {
        return [];
    }
    const record = value;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const transport = record.transport && typeof record.transport === "object" ? record.transport : {};
    const type = transport.type === "stdio" ? "stdio" : transport.type === "streamable_http" ? "http" : undefined;
    if (!name || !type) {
        return [];
    }
    return [{
            name,
            enabled: record.enabled !== false,
            transport: type,
            command: type === "stdio" && typeof transport.command === "string" ? transport.command : undefined,
            args: type === "stdio" && Array.isArray(transport.args) ? transport.args.filter((arg) => typeof arg === "string") : undefined,
            url: type === "http" && typeof transport.url === "string" ? transport.url : undefined,
            bearerTokenEnvVar: type === "http" && typeof transport.bearer_token_env_var === "string" ? transport.bearer_token_env_var : undefined,
            authStatus: normalizeCliAuthStatus(record.auth_status),
            runtimeStatus: "unknown",
            toolCount: 0,
            resourceCount: 0,
            error: record.disabled_reason || undefined,
            managed: name === codexIntegrationConstants_1.MANAGED_BROWSER_MCP_NAME ? "browser" : undefined
        }];
}
function normalizeCliAuthStatus(value) {
    if (value === "unsupported") {
        return "unsupported";
    }
    if (value === "not_logged_in") {
        return "notLoggedIn";
    }
    if (value === "bearer_token") {
        return "bearerToken";
    }
    if (value === "oauth" || value === "o_auth") {
        return "oAuth";
    }
    return "unknown";
}
async function setMcpEnabledInConfig(configPath, name, enabled) {
    const source = await readOptionalFile(configPath);
    if (source === undefined) {
        throw new Error("config.toml не найден: сначала добавьте MCP-сервер.");
    }
    const lines = source.split(/\r?\n/);
    const header = `[mcp_servers.${name}]`;
    const start = lines.findIndex((line) => line.trim() === header);
    if (start < 0) {
        throw new Error(`MCP-сервер ${name} не найден в config.toml.`);
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\s*\[.*\]\s*$/.test(lines[index])) {
            end = index;
            break;
        }
    }
    const enabledIndex = lines.slice(start + 1, end).findIndex((line) => /^\s*enabled\s*=/.test(line));
    const value = `enabled = ${enabled ? "true" : "false"}`;
    if (enabledIndex >= 0) {
        lines[start + 1 + enabledIndex] = value;
    }
    else {
        lines.splice(start + 1, 0, value);
    }
    await fs.promises.writeFile(configPath, lines.join("\n"), "utf8");
}
function runProcess(command, args, env, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { env, windowsHide: true, shell: false });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Codex CLI не ответил вовремя."));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout = limitOutput(stdout + chunk.toString("utf8"));
        });
        child.stderr.on("data", (chunk) => {
            stderr = limitOutput(stderr + chunk.toString("utf8"));
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            }
            else {
                reject(new Error(sanitizeCliError(stderr.trim()) || `Codex CLI завершился с кодом ${code ?? "-"}.`));
            }
        });
    });
}
function limitOutput(value) {
    return value.length <= 1000000 ? value : value.slice(value.length - 1000000);
}
function sanitizeCliError(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [скрыто]")
        .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/gi, "$1?[параметры скрыты]")
        .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[скрыто]");
}
async function readOptionalFile(filePath) {
    try {
        return await fs.promises.readFile(filePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
// CLI edits run against a private CODEX_HOME. Failure never restores an old live
// file over another IDE's edits. The lock coordinates extension hosts; the final
// comparison also detects writers that do not participate in our lock protocol.
async function editMcpConfig(home, edit) {
    await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
    const realHome = await fs.promises.realpath(home);
    const lockPath = path.join(realHome, ".codex-element-mcp.lock");
    const deadline = Date.now() + 25000;
    let lock;
    for (;;) {
        try {
            lock = await fs.promises.open(lockPath, "wx", 0o600);
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
            if (Date.now() >= deadline) {
                throw new Error("Конфигурация MCP занята другим сеансом. Повторите операцию после его завершения.");
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
    }
    let staging;
    try {
        const configPath = path.join(realHome, "config.toml");
        const before = readConfigRevision(configPath);
        staging = await fs.promises.mkdtemp(path.join(realHome, ".mcp-edit-"));
        const stagedConfig = path.join(staging, "config.toml");
        if (before.content !== undefined) {
            await fs.promises.writeFile(stagedConfig, before.content, { mode: 0o600, flag: "wx" });
        }
        await edit(staging);
        const next = await readOptionalFile(stagedConfig);
        if (next === undefined) {
            throw new Error("Codex CLI не создал конфигурацию MCP.");
        }
        const handle = await fs.promises.open(stagedConfig, "r+");
        try {
            await handle.chmod(0o600);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        // Keep comparison and rename in one event-loop turn. No async gap permits
        // another in-process config writer to slip in after the conflict check.
        const current = readConfigRevision(configPath);
        if (before.signature !== current.signature || before.content !== current.content) {
            throw new Error("Конфигурация MCP изменена другим процессом. Изменения сохранены; повторите операцию.");
        }
        fs.renameSync(stagedConfig, configPath);
    }
    finally {
        try {
            if (staging) {
                await fs.promises.rm(staging, { recursive: true, force: true });
            }
        }
        finally {
            await lock.close();
            await fs.promises.unlink(lockPath);
        }
    }
}
function readConfigRevision(filePath) {
    try {
        const stats = fs.lstatSync(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error("config.toml должен быть обычным файлом, не символической ссылкой.");
        }
        return {
            signature: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
            content: fs.readFileSync(filePath, "utf8")
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { signature: "missing", content: undefined };
        }
        throw error;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=codexIntegrationsService.js.map