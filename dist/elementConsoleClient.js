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
exports.ElementConsoleClient = exports.ElementConsoleError = void 0;
exports.normalizeConsoleServer = normalizeConsoleServer;
exports.consoleObject = consoleObject;
exports.requestConsoleJson = requestConsoleJson;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
/** Diagnostics contain only our field names/status codes, never Console response bodies. */
class ElementConsoleError extends Error {
    constructor(stage, code, message, detail = "", statusCode) {
        super(message);
        this.stage = stage;
        this.code = code;
        this.detail = detail;
        this.statusCode = statusCode;
        this.name = "ElementConsoleError";
    }
    get diagnostic() {
        return `stage=${this.stage}; code=${this.code}${this.statusCode === undefined ? "" : `; http=${this.statusCode}`}${this.detail ? `; ${this.detail}` : ""}`;
    }
}
exports.ElementConsoleError = ElementConsoleError;
/** A per-lookup Console session using only the credentials of this IDE, not an MCP session. */
class ElementConsoleClient {
    constructor(connection, request = requestConsoleJson) {
        this.request = request;
        this.connection = { ...connection };
    }
    async readIdentity(signal) {
        const { server, get } = await this.session(signal);
        const user = await get("/api/v2/me", "user");
        const project = await get(`/api/v2/projects/${encodeURIComponent(this.connection.projectId)}`, "project");
        return { server, user, project };
    }
    async readApplication(applicationId, pageUrl, signal) {
        if (!applicationId.trim()) {
            throw new ElementConsoleError("configuration", "configuration_missing", "В IDE не выбрано приложение (1C.applicationId). Выберите приложение средствами IDE и повторите проверку.");
        }
        const { get } = await this.session(signal);
        // Match the bundle's PaasClient.getApplicationInfo, including reverse-proxy headers.
        return get(`/api/v2/applications/${encodeURIComponent(applicationId)}`, "application", {
            "X-Forwarded-Host": pageUrl.host,
            "X-Forwarded-Proto": pageUrl.protocol.slice(0, -1)
        });
    }
    async session(signal) {
        const missing = ["server", "clientId", "clientSecret", "projectId"].filter((key) => !this.connection[key]?.trim());
        if (missing.length) {
            throw new ElementConsoleError("configuration", "configuration_missing", "Не удалось определить подключение IDE. Откройте IDE из проекта Element. Не заполнены настройки: " + missing.map((key) => `1C.${key}`).join(", ") + ".", `missing=${missing.join(",")}`);
        }
        const server = normalizeConsoleServer(this.connection.server);
        const getToken = async () => {
            const result = consoleObject(await this.call(new URL(`${server}/sys/token`), "POST", {
                Authorization: `Basic ${Buffer.from(`${this.connection.clientId}:${this.connection.clientSecret}`, "utf8").toString("base64")}`,
                "Content-Type": "application/x-www-form-urlencoded"
            }, "grant_type=CLIENT_CREDENTIALS", signal), "token");
            // Element normally supplies id_token. Some Console versions use access_token.
            const token = text(result.id_token) || text(result.access_token);
            if (!token || token === "Not implemented") {
                throw new ElementConsoleError("token", "token_missing", "Console не вернула id_token/access_token для проверки пользователя IDE.");
            }
            return token;
        };
        let token = await getToken();
        let refreshed = false;
        const get = async (endpoint, stage, headers = {}) => {
            try {
                return consoleObject(await this.call(new URL(`${server}${endpoint}`), "GET", { ...headers, Authorization: `Bearer ${token}` }, undefined, signal), stage);
            }
            catch (error) {
                // Only an expired credential can be retried, once per lookup. Never retry 403 or guess another user.
                if (!(error instanceof ElementConsoleError) || error.statusCode !== 401 || refreshed) {
                    throw error;
                }
                refreshed = true;
                token = await getToken();
                return consoleObject(await this.call(new URL(`${server}${endpoint}`), "GET", { ...headers, Authorization: `Bearer ${token}` }, undefined, signal), stage);
            }
        };
        return { server, get };
    }
    async call(url, method, headers, body, signal) {
        const stage = requestStage(url, method);
        if (signal?.aborted) {
            throw cancelled(stage);
        }
        try {
            return await this.request(url, method, headers, body, signal);
        }
        catch (error) {
            if (signal?.aborted) {
                throw cancelled(stage);
            }
            if (error instanceof ElementConsoleError) {
                throw error;
            }
            throw new ElementConsoleError(stage, "network", `Не удалось подключиться к Console (${stageLabel(stage)}). Проверьте доступность сервера Element.`);
        }
    }
}
exports.ElementConsoleClient = ElementConsoleClient;
function normalizeConsoleServer(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new ElementConsoleError("configuration", "configuration_invalid", "В настройках 1C указан некорректный адрес сервера.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new ElementConsoleError("configuration", "configuration_invalid", "Адрес сервера 1C должен быть HTTP(S) URL без учетных данных и параметров.");
    }
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/console(?:\/.*)?$/, "");
    return `${url.origin}${pathname}/console`;
}
function consoleObject(value, stage) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    throw new ElementConsoleError(stage, "response_shape", `Console вернула неожиданный формат ответа (${stageLabel(stage)}).`, `shape=${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
}
function requestConsoleJson(url, method, headers, body, signal) {
    const stage = requestStage(url, method);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(cancelled(stage));
            return;
        }
        let settled = false;
        let timeout;
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); };
        const fail = (code, message, statusCode) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new ElementConsoleError(stage, code, message, "", statusCode));
        };
        const transport = url.protocol === "https:" ? https : http;
        // No redirects, shared cookies, global proxy, or raw error/response text with credentials.
        const request = transport.request(url, { method, headers: { ...headers, Accept: "application/json", ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
            if (response.statusCode !== 200) {
                const status = response.statusCode ?? 0;
                fail("http_status", status === 401 || status === 403
                    ? `Console отклонила проверку (${stageLabel(stage)}, HTTP ${status}). Повторно откройте IDE из проекта Element.`
                    : `Не удалось проверить подключение IDE (${stageLabel(stage)}, Console HTTP ${status}).`, status);
                response.destroy();
                return;
            }
            const chunks = [];
            let bytes = 0;
            response.on("data", (chunk) => {
                if (settled) {
                    return;
                }
                bytes += chunk.length;
                if (bytes > 1024 * 1024) {
                    fail("response_size", `Ответ Console превышает допустимый размер (${stageLabel(stage)}).`);
                    response.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            const interrupted = () => fail("network", `Соединение с Console прервано (${stageLabel(stage)}). Повторите проверку.`);
            response.on("error", interrupted);
            response.on("aborted", interrupted);
            response.on("close", () => { if (!response.complete) {
                interrupted();
            } });
            response.on("end", () => {
                if (settled) {
                    return;
                }
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    settled = true;
                    cleanup();
                    resolve(parsed);
                }
                catch {
                    fail("response_json", `Console вернула некорректный JSON (${stageLabel(stage)}).`);
                }
            });
        });
        const abort = () => { fail("cancelled", "Проверка пользователя IDE отменена. Повторите действие."); request.destroy(); };
        signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => { fail("timeout", `Console не ответила за 8 секунд (${stageLabel(stage)}). Проверьте доступность сервера Element.`); request.destroy(); }, 8000);
        request.on("error", () => fail("network", `Не удалось подключиться к Console (${stageLabel(stage)}). Проверьте доступность сервера Element.`));
        request.end(body);
    });
}
function cancelled(stage) { return new ElementConsoleError(stage, "cancelled", "Пользователь или проект IDE изменился. Повторите действие."); }
function requestStage(url, method) { return method === "POST" ? "token" : url.pathname.endsWith("/me") ? "user" : url.pathname.includes("/api/v2/applications/") ? "application" : "project"; }
function stageLabel(stage) { return { configuration: "настройки 1C", token: "получение токена", user: "пользователь /me", project: "проект", identity: "пользователь и проект", application: "приложение IDE" }[stage]; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
//# sourceMappingURL=elementConsoleClient.js.map