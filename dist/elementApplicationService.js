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
exports.ElementApplicationService = void 0;
const crypto_1 = require("crypto");
const vscode = __importStar(require("vscode"));
const elementConsoleClient_1 = require("./elementConsoleClient");
const CONFIG_KEYS = ["server", "clientId", "clientSecret", "projectId", "applicationId", "serverExternalUri"];
const emptyView = () => ({ status: "idle", url: "", name: "", message: "Адрес приложения ещё не получен из IDE." });
/** Application selection is independent of the persistent project/history namespace. */
class ElementApplicationService {
    constructor(logger, connection = readConnection, request, readPageLocation = () => vscode.commands.executeCommand("com.e1c.g5rt.getCurrentPageLocation")) {
        this.logger = logger;
        this.connection = connection;
        this.request = request;
        this.readPageLocation = readPageLocation;
        this.current = emptyView();
        this.fingerprint = "";
        this.checkedAt = 0;
        this.disposed = false;
        this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (CONFIG_KEYS.some((key) => event.affectsConfiguration(`1C.${key}`)))
                this.invalidate();
        });
    }
    getView() {
        if (this.fingerprint && this.fingerprint !== fingerprint(this.connection()))
            this.invalidate();
        return { ...this.current };
    }
    async resolve(force = false) {
        if (this.disposed)
            return { ...emptyView(), status: "error", message: "Проверка приложения IDE остановлена." };
        const connection = { ...this.connection() };
        const key = fingerprint(connection);
        if (this.fingerprint && this.fingerprint !== key)
            this.invalidate();
        if (this.pending)
            return this.pending;
        const cacheMs = this.current.status === "ready" ? 60000 : 5000;
        if (!force && this.checkedAt && Date.now() - this.checkedAt < cacheMs)
            return this.getView();
        this.fingerprint = key;
        this.current = { ...emptyView(), status: "loading", message: "Получаем адрес приложения из IDE..." };
        const abort = new AbortController();
        this.abort = abort;
        const pending = this.lookup(connection, abort.signal).then((application) => {
            if (abort.signal.aborted || this.disposed || key !== fingerprint(this.connection())) {
                return { ...emptyView(), status: "error", message: "Приложение или пользователь IDE изменился. Повторите действие." };
            }
            this.current = application;
            this.checkedAt = Date.now();
            this.logger.info("Element application URL resolved from Console for the current IDE; MCP is not required.");
            return this.getView();
        }).catch((error) => {
            const view = { ...emptyView(), status: "error", message: error instanceof Error ? error.message : "Не удалось получить адрес приложения из IDE." };
            if (!abort.signal.aborted && !this.disposed && key === fingerprint(this.connection())) {
                this.current = view;
                this.checkedAt = Date.now();
                this.logger.warn(`Element application lookup failed: ${error instanceof elementConsoleClient_1.ElementConsoleError ? error.diagnostic : "invalid_application"}.`);
            }
            return view;
        }).finally(() => {
            if (this.pending === pending)
                this.pending = undefined;
            if (this.abort === abort)
                this.abort = undefined;
        });
        this.pending = pending;
        return pending;
    }
    invalidate() {
        this.abort?.abort();
        this.abort = undefined;
        this.pending = undefined;
        this.fingerprint = "";
        this.checkedAt = 0;
        this.current = emptyView();
    }
    dispose() { this.disposed = true; this.invalidate(); this.subscription.dispose(); }
    async lookup(connection, signal) {
        if (!connection.applicationId)
            throw new Error("В IDE не выбрано приложение (1C.applicationId). Выберите приложение средствами IDE и повторите проверку.");
        let pageLocation;
        if (process.env.E1C_IDE_MODE === "advanced" || process.env.E1C_IDE_MODE === "testing") {
            pageLocation = connection.server;
        }
        else {
            let timer;
            try {
                pageLocation = await Promise.race([
                    this.readPageLocation(),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("IDE не вернула внешний адрес.")), 3000); })
                ]);
            }
            catch {
                // An explicit external address also supports hosts without the frontend command.
                pageLocation = connection.externalUri || connection.server;
            }
            finally {
                clearTimeout(timer);
            }
        }
        const pageUrl = httpUrl(pageLocation, "IDE вернула некорректный адрес страницы.");
        const application = await new elementConsoleClient_1.ElementConsoleClient(connection, this.request).readApplication(connection.applicationId, pageUrl, signal);
        if (!sameId(application.id, connection.applicationId)) {
            throw new Error("Console вернула другое приложение. Адрес браузера не изменён; повторите проверку в текущей IDE.");
        }
        if (application["project-id"] !== undefined && !sameId(application["project-id"], connection.projectId)) {
            throw new Error("Приложение Console не относится к проекту текущей IDE.");
        }
        const url = httpUrl(application.uri, "Console не вернула корректный HTTP(S) адрес приложения. Проверьте его публикацию в Element.");
        return { status: "ready", url: url.toString(), name: text(application["display-name"]) || text(application.name), message: "Приложение определено по текущей IDE." };
    }
}
exports.ElementApplicationService = ElementApplicationService;
function readConnection() {
    const config = vscode.workspace.getConfiguration("1C");
    return {
        server: config.get("server", "").trim(), clientId: config.get("clientId", "").trim(),
        clientSecret: config.get("clientSecret", ""), projectId: config.get("projectId", "").trim(),
        applicationId: config.get("applicationId", "").trim(), externalUri: config.get("serverExternalUri", "").trim()
    };
}
function fingerprint(connection) { return (0, crypto_1.createHash)("sha256").update(JSON.stringify(connection)).digest("hex"); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function sameId(left, right) {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    return typeof left === "string" && (left === right || (uuid.test(left) && uuid.test(right) && left.toLowerCase() === right.toLowerCase()));
}
function httpUrl(value, message) {
    const input = text(value);
    if (!input || input.length > 8192 || /[\x00-\x20\x7f]/.test(input))
        throw new Error(message);
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error(message);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error(message);
    return url;
}
//# sourceMappingURL=elementApplicationService.js.map