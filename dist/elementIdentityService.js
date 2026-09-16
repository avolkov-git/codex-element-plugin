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
exports.ElementIdentityService = exports.requestConsoleJson = exports.normalizeConsoleServer = void 0;
exports.resolveElementIdentity = resolveElementIdentity;
exports.identityFromConsole = identityFromConsole;
exports.identityScopeRoot = identityScopeRoot;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const elementConsoleClient_1 = require("./elementConsoleClient");
var elementConsoleClient_2 = require("./elementConsoleClient");
Object.defineProperty(exports, "normalizeConsoleServer", { enumerable: true, get: function () { return elementConsoleClient_2.normalizeConsoleServer; } });
Object.defineProperty(exports, "requestConsoleJson", { enumerable: true, get: function () { return elementConsoleClient_2.requestConsoleJson; } });
/** Use this IDE's credentials, never the shared MCP server's active session. */
class ElementIdentityService {
    constructor(connection = readElementConnection, request, logger) {
        this.connection = connection;
        this.request = request;
        this.logger = logger;
        this.fingerprint = "";
        this.verifiedAt = 0;
        this.generation = 0;
        this.disposed = false;
        this.invalidated = new vscode.EventEmitter();
        this.onDidInvalidate = this.invalidated.event;
        this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (["1C.server", "1C.clientId", "1C.clientSecret", "1C.projectId"].some((key) => event.affectsConfiguration(key))) {
                this.invalidate();
            }
        });
    }
    getCurrent() {
        if (this.disposed) {
            return undefined;
        }
        if (this.fingerprint && this.fingerprint !== connectionFingerprint(this.connection())) {
            this.invalidate();
        }
        return this.current;
    }
    async resolve(force = false) {
        if (this.disposed) {
            throw new Error("Проверка пользователя IDE остановлена.");
        }
        const connection = { ...this.connection() };
        const fingerprint = connectionFingerprint(connection);
        if (this.current && this.fingerprint === fingerprint && !force && Date.now() - this.verifiedAt < 60000) {
            return this.current;
        }
        if (this.fingerprint && fingerprint !== this.fingerprint) {
            this.invalidate();
        }
        if (this.pending) {
            return this.pending;
        }
        const generation = this.generation;
        this.fingerprint = fingerprint;
        const abort = new AbortController();
        this.abort = abort;
        this.logger?.info("Element Console identity: checking this IDE directly; MCP is not required.");
        const pending = resolveElementIdentity(connection, this.request, abort.signal).then((identity) => {
            if (generation !== this.generation || fingerprint !== connectionFingerprint(this.connection())) {
                throw new Error("Пользователь или проект IDE изменился. Повторите действие.");
            }
            this.current = identity;
            this.fingerprint = fingerprint;
            this.verifiedAt = Date.now();
            this.logger?.info("Element Console identity verified: user and project confirmed; history scope ready.");
            return identity;
        }).catch((error) => {
            if (generation === this.generation) {
                this.current = undefined;
                this.verifiedAt = 0;
                const diagnostic = error instanceof elementConsoleClient_1.ElementConsoleError ? error.diagnostic : "stage=identity; code=unexpected";
                this.logger?.warn(`Element Console identity rejected: ${diagnostic}. History remains closed.`);
            }
            throw error;
        }).finally(() => {
            if (this.pending === pending) {
                this.pending = undefined;
            }
            if (this.abort === abort) {
                this.abort = undefined;
            }
        });
        this.pending = pending;
        return pending;
    }
    invalidate() {
        this.generation += 1;
        this.abort?.abort();
        this.abort = undefined;
        this.current = undefined;
        this.pending = undefined;
        this.fingerprint = "";
        this.verifiedAt = 0;
        this.invalidated.fire();
    }
    dispose() {
        this.disposed = true;
        this.generation += 1;
        this.abort?.abort();
        this.abort = undefined;
        this.subscription.dispose();
        this.invalidated.dispose();
        this.current = undefined;
        this.pending = undefined;
    }
}
exports.ElementIdentityService = ElementIdentityService;
async function resolveElementIdentity(connection, request, signal) {
    const { server, user, project } = await new elementConsoleClient_1.ElementConsoleClient(connection, request).readIdentity(signal);
    return identityFromConsole(server, connection.projectId, user, project);
}
function identityFromConsole(server, projectId, user, project) {
    const issues = [];
    const userId = requiredText(user.id, "user.id", issues);
    const userListId = requiredText(aliased(user, "user-list-id", "userListId", "user.user-list-id", issues), "user.user-list-id", issues);
    const projectName = requiredText(project.name, "project.name", issues).normalize("NFC");
    const projectSpace = aliased(project, "space-id", "spaceId", "project.space-id", issues);
    // Preserve existing explicit-null scopes; absence is never interpreted as a server-root project.
    const serverRootProject = projectSpace === null;
    const spaceId = serverRootProject ? "" : requiredText(projectSpace, "project.space-id", issues);
    const confirmedProjectId = requiredText(project.id, "project.id", issues);
    if (confirmedProjectId && !sameProjectId(confirmedProjectId, projectId)) {
        issues.push({ field: "project.id", state: "mismatch" });
    }
    const active = aliased(user, "is-active", "isActive", "user.is-active", issues);
    // Element 9.2 maps status == ACTIVE to this flag; NEW also yields false.
    // Console authorizes token, /me and project requests. This flag is not an access decision.
    if (active !== undefined && typeof active !== "boolean") {
        issues.push({ field: "user.is-active", state: "invalid-type" });
    }
    if (project.deleted === true) {
        issues.push({ field: "project.deleted", state: "deleted" });
    }
    else if (project.deleted !== undefined && typeof project.deleted !== "boolean") {
        issues.push({ field: "project.deleted", state: "invalid-type" });
    }
    if (issues.length) {
        const fields = [...new Set(issues.map((issue) => issue.field))];
        const details = issues.map(({ field, state }) => `${field}:${state}`).join(",");
        throw new elementConsoleClient_1.ElementConsoleError("identity", "identity_fields", "Console не подтвердила данные IDE: " + fields.map((field) => FIELD_LABELS[field]).join(", ") + ". История не открыта, чтобы не смешать диалоги. Подробности проверки записаны в логи Codex.", `fields=${details}`);
    }
    const normalizedServer = (0, elementConsoleClient_1.normalizeConsoleServer)(server);
    const login = string(user.login);
    return {
        server: normalizedServer, userId, userListId, login,
        userLabel: string(user.presentation) || login || userId,
        userKey: `ide-${hash([normalizedServer, userListId, userId])}`,
        projectId, projectName, spaceId,
        // Deployment/application/workspace must not change the history namespace.
        projectKey: `project-${hash(serverRootProject ? [normalizedServer, "server-root", projectName] : [normalizedServer, "space", spaceId, projectName])}`
    };
}
function identityScopeRoot(configRoot, identity) {
    return path.join(configRoot, "users", identity.userKey, "projects", identity.projectKey);
}
function readElementConnection() {
    const config = vscode.workspace.getConfiguration("1C");
    return { server: config.get("server", "").trim(), clientId: config.get("clientId", "").trim(), clientSecret: config.get("clientSecret", ""), projectId: config.get("projectId", "").trim() };
}
function connectionFingerprint(connection) { return hash([connection.server, connection.clientId, connection.clientSecret, connection.projectId]); }
function hash(parts) { return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32); }
function string(value) { return typeof value === "string" ? value.trim() : ""; }
const FIELD_LABELS = {
    "user.id": "идентификатор пользователя (user.id)",
    "user.user-list-id": "список пользователей (user.user-list-id)",
    "user.is-active": "активность пользователя (user.is-active)",
    "project.id": "принадлежность проекта текущей IDE (project.id)",
    "project.name": "имя проекта (project.name)",
    "project.space-id": "пространство проекта (project.space-id)",
    "project.deleted": "доступность проекта (project.deleted)"
};
function requiredText(value, field, issues) {
    const result = string(value);
    if (!result) {
        issues.push({ field, state: value === undefined ? "missing" : value === null ? "null" : typeof value === "string" ? "empty" : "invalid-type" });
    }
    return result;
}
function aliased(record, canonical, alias, field, issues) {
    const hasCanonical = Object.prototype.hasOwnProperty.call(record, canonical);
    const hasAlias = Object.prototype.hasOwnProperty.call(record, alias);
    const value = hasCanonical ? record[canonical] : record[alias];
    if (hasCanonical && hasAlias && record[canonical] !== record[alias]) {
        issues.push({ field, state: "conflict" });
    }
    return value;
}
function sameProjectId(left, right) {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    return left === right || (uuid.test(left) && uuid.test(right) && left.toLowerCase() === right.toLowerCase());
}
//# sourceMappingURL=elementIdentityService.js.map