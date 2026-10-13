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
exports.ElementLanguageService = void 0;
const crypto_1 = require("crypto");
const vscode = __importStar(require("vscode"));
const NATIVE_EXTENSION = "1c-soft.1c-appengine-plugin";
const NATIVE_BRIDGE = "com.e1c.g5rt.lsp.request";
const SYMBOLS = "vscode.executeDocumentSymbolProvider";
const DEFINITION = "vscode.executeDefinitionProvider";
const HOVER = "vscode.executeHoverProvider";
const CALL_TIMEOUT_MS = 1200;
const INSPECT_TIMEOUT_MS = 6000;
const COOLDOWN_MS = 30000;
const CACHE_MS = 5000;
const MAX_CACHE_ENTRIES = 32;
const MAX_POSITIONS = 4;
const MAX_SYMBOLS = 500;
const MAX_DEFINITIONS = 20;
const MAX_HOVER_CHARS = 6000;
/** Read-only access to providers already registered by the running Element IDE. */
class ElementLanguageService {
    constructor(logger) {
        this.logger = logger;
        this.disposed = false;
        this.observing = false;
        this.revision = 0;
        this.subscriptions = [];
        this.cache = new Map();
        this.inflight = new Map();
        this.pendingOperations = new Set();
        this.cooldowns = new Map();
        this.waits = new Set();
    }
    observe() {
        if (this.observing) {
            return;
        }
        this.observing = true;
        // Any changed dependency can invalidate definitions/hover for another document.
        const invalidate = () => { this.revision += 1; this.cache.clear(); };
        this.subscriptions.push(vscode.workspace.onDidChangeTextDocument(invalidate), vscode.workspace.onDidCloseTextDocument(invalidate), vscode.workspace.onDidChangeWorkspaceFolders(invalidate), vscode.extensions.onDidChange(invalidate));
        const watcher = vscode.workspace.createFileSystemWatcher("**/*.{xbsl,yaml,yml}");
        this.subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
    }
    inspect(uri, positions = []) {
        const id = uri.toString();
        if (this.disposed) {
            return Promise.resolve(unavailable(id, "Адаптер Language Server остановлен."));
        }
        if (uri.scheme !== "file" || !/\.(?:xbsl|ya?ml)$/i.test(uri.path)) {
            return Promise.resolve(unavailable(id, "Штатный анализ доступен только для файлов XBSL и YAML."));
        }
        this.observe();
        const selected = normalizePositions(positions);
        const key = JSON.stringify(selected);
        const active = this.inflight.get(id);
        if (active) {
            return active.key === key
                ? active.promise.then(copyResult)
                : Promise.resolve(unavailable(id, "Предыдущий анализ этого документа ещё выполняется."));
        }
        const promise = this.inspectDocument(uri, selected, positions.length > selected.length)
            .catch(() => unavailable(id, "Не удалось получить данные штатного Language Server."))
            .finally(() => { this.inflight.delete(id); });
        this.inflight.set(id, { key, promise });
        return promise.then(copyResult);
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const cancel of [...this.waits]) {
            cancel();
        }
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.cache.clear();
        this.cooldowns.clear();
    }
    async inspectDocument(uri, positions, truncated) {
        const id = uri.toString();
        const result = unavailable(id, "Готовность штатного Language Server пока не подтверждена.");
        const extension = vscode.extensions.getExtension(NATIVE_EXTENSION);
        if (!extension?.isActive || extension.packageJSON?.name !== "1c-appengine-plugin" || extension.packageJSON?.publisher !== "1c-soft") {
            result.reason = "Штатное расширение языка 1С:Элемент не активно. Автоматический запуск не выполняется.";
            return result;
        }
        result.capabilities.nativeExtensionActive = true;
        result.nativeExtensionVersion = typeof extension.packageJSON.version === "string" ? extension.packageJSON.version : undefined;
        const deadline = Date.now() + INSPECT_TIMEOUT_MS;
        const commands = await this.call("commands", () => vscode.commands.getCommands(true), deadline);
        if (commands.state !== "responded") {
            result.reason = failureReason(commands.state);
            return result;
        }
        const registered = new Set(commands.value);
        result.capabilities.nativeBridgeRegistered = registered.has(NATIVE_BRIDGE);
        const capabilities = result.capabilities.commandsRegistered;
        capabilities.documentSymbols = registered.has(SYMBOLS);
        capabilities.definition = registered.has(DEFINITION);
        capabilities.hover = registered.has(HOVER);
        if (!result.capabilities.nativeBridgeRegistered) {
            result.reason = "Команды штатного Language Server не зарегистрированы; сторонние провайдеры не запрашивались.";
            return result;
        }
        if (!capabilities.documentSymbols && (!positions.length || (!capabilities.definition && !capabilities.hover))) {
            result.reason = "IDE не предоставляет команды анализа символов, определений или подсказок.";
            return result;
        }
        const existing = vscode.workspace.textDocuments.find((item) => item.uri.toString() === id && !item.isClosed);
        const opened = existing ? { state: "responded", value: existing }
            : await this.call("open-document", () => vscode.workspace.openTextDocument(uri), deadline);
        if (opened.state !== "responded") {
            result.reason = failureReason(opened.state);
            return result;
        }
        const document = opened.value;
        if (document.isClosed || !["xbsl", "yaml"].includes(document.languageId)) {
            result.reason = "Файл не распознан IDE как документ XBSL или YAML.";
            return result;
        }
        const version = document.version;
        const text = document.getText();
        const hash = (0, crypto_1.createHash)("sha256").update(text).digest("hex");
        const revision = this.revision;
        result.sourceDocumentVersion = version;
        result.sourceHash = hash;
        const validPositions = positions.filter((position) => position.line < document.lineCount && position.character <= document.lineAt(position.line).text.length);
        result.truncated = truncated || validPositions.length !== positions.length;
        const cacheKey = JSON.stringify([version, hash, revision, validPositions, result.nativeExtensionVersion, capabilities, result.truncated]);
        const cached = this.cache.get(id);
        if (cached?.key === cacheKey && cached.expires > Date.now()) {
            return cached.result;
        }
        if (capabilities.documentSymbols) {
            const response = await this.call(SYMBOLS, () => vscode.commands.executeCommand(SYMBOLS, uri), deadline);
            result.capabilities.documentSymbols = response.state;
            if (response.state === "responded") {
                const symbols = flattenSymbols(response.value, id);
                result.symbols = symbols.items;
                result.truncated || (result.truncated = symbols.truncated);
                result.capabilities.documentSymbols = result.symbols.length ? "responded" : "empty";
            }
            if (response.state === "timeout" || response.state === "cooldown") {
                result.reason = failureReason(response.state);
                return result;
            }
        }
        else {
            result.capabilities.documentSymbols = "unavailable";
        }
        for (const position of validPositions) {
            const query = { position, definitions: [], hover: "", definitionState: "unavailable", hoverState: "unavailable" };
            const point = new vscode.Position(position.line, position.character);
            if (capabilities.definition) {
                const response = await this.call(DEFINITION, () => vscode.commands.executeCommand(DEFINITION, uri, point), deadline);
                query.definitionState = response.state;
                if (response.state === "responded") {
                    const definitions = normalizeDefinitions(response.value);
                    query.definitions = definitions.items;
                    result.truncated || (result.truncated = definitions.truncated);
                    query.definitionState = query.definitions.length ? "responded" : "empty";
                }
            }
            if (capabilities.hover) {
                const response = await this.call(HOVER, () => vscode.commands.executeCommand(HOVER, uri, point), deadline);
                query.hoverState = response.state;
                if (response.state === "responded") {
                    const hover = normalizeHover(response.value);
                    query.hover = hover.text;
                    result.truncated || (result.truncated = hover.truncated);
                    query.hoverState = query.hover ? "responded" : "empty";
                }
            }
            result.queries.push(query);
        }
        // Never attach results for an earlier unsaved revision to the current prompt.
        if (this.disposed || document.isClosed || document.version !== version || document.getText() !== text || revision !== this.revision) {
            const changed = unavailable(id, "Документ или его зависимости изменились во время анализа. Требуется повторный запрос.");
            changed.sourceDocumentVersion = document.version;
            return changed;
        }
        const states = [result.capabilities.documentSymbols, ...result.queries.flatMap((query) => [query.definitionState, query.hoverState])];
        const hasEvidence = result.symbols.length > 0 || result.queries.some((query) => query.definitions.length > 0 || query.hover.length > 0);
        result.status = hasEvidence && states.every((state) => state === "responded") && !result.truncated ? "ready"
            : hasEvidence || states.includes("empty") ? "partial" : "unavailable";
        result.reason = result.status === "ready" ? undefined
            : states.includes("timeout") || states.includes("cooldown") ? failureReason("timeout")
                : "Получены неполные данные. Пустой ответ не подтверждает отсутствие символа или готовность индекса Language Server.";
        // Empty/failed responses are retried: initialization can complete without a document edit.
        if (result.status === "ready") {
            this.cache.delete(id);
            this.cache.set(id, { key: cacheKey, expires: Date.now() + CACHE_MS, result });
            while (this.cache.size > MAX_CACHE_ENTRIES) {
                this.cache.delete(this.cache.keys().next().value);
            }
        }
        return result;
    }
    call(operation, start, deadline) {
        if (this.disposed) {
            return Promise.resolve({ state: "unavailable" });
        }
        // executeCommand has no cancellation token. Retain a timed-out operation until
        // it actually settles, and gate it across documents to prevent unbounded work.
        if (this.pendingOperations.has(operation) || (this.cooldowns.get(operation) ?? 0) > Date.now()) {
            return Promise.resolve({ state: "cooldown" });
        }
        const timeout = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
        if (timeout <= 0) {
            return Promise.resolve({ state: "timeout" });
        }
        this.pendingOperations.add(operation);
        const pending = Promise.resolve().then(start);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                this.waits.delete(cancel);
                resolve(value);
            };
            const cancel = () => finish({ state: "unavailable" });
            const timer = setTimeout(() => {
                this.cooldowns.set(operation, Date.now() + COOLDOWN_MS);
                this.logger.warn(`Element language provider timeout: ${operation}. Further calls are paused.`);
                finish({ state: "timeout" });
            }, timeout);
            this.waits.add(cancel);
            void pending.then((value) => {
                this.pendingOperations.delete(operation);
                finish({ state: "responded", value });
            }, () => {
                this.pendingOperations.delete(operation);
                if (!this.disposed) {
                    this.cooldowns.set(operation, Date.now() + COOLDOWN_MS);
                }
                finish({ state: "unavailable" });
            });
        });
    }
}
exports.ElementLanguageService = ElementLanguageService;
function unavailable(uri, reason) {
    return {
        status: "unavailable", reason, uri, symbols: [], queries: [], truncated: false,
        source: "vscode-language-api", absenceConfirmed: false,
        capabilities: { nativeExtensionActive: false, nativeBridgeRegistered: false,
            commandsRegistered: { documentSymbols: false, definition: false, hover: false }, documentSymbols: "not-requested" }
    };
}
function failureReason(state) {
    return state === "unavailable" ? "Провайдер Language Server недоступен; его готовность не подтверждена."
        : "Language Server не ответил вовремя или ещё выполняет предыдущий запрос. Повторные вызовы временно приостановлены.";
}
function normalizePositions(positions) {
    const selected = [];
    const seen = new Set();
    for (const position of positions) {
        if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
            continue;
        }
        const key = `${position.line}:${position.character}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        selected.push({ line: position.line, character: position.character });
        if (selected.length === MAX_POSITIONS) {
            break;
        }
    }
    return selected;
}
function record(value) {
    return value !== null && typeof value === "object" ? value : undefined;
}
function rangeOf(value) {
    const range = record(value);
    const start = record(range?.start);
    const end = record(range?.end);
    if (!start || !end || ![start.line, start.character, end.line, end.character].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) {
        return undefined;
    }
    const a = start;
    const b = end;
    if (b.line < a.line || (b.line === a.line && b.character < a.character)) {
        return undefined;
    }
    return { startLine: a.line + 1, startCharacter: a.character, endLine: b.line + 1, endCharacter: b.character };
}
function uriOf(value) {
    const uri = record(value);
    if (!uri || typeof uri.scheme !== "string" || !["file", "vscode-remote"].includes(uri.scheme)) {
        return undefined;
    }
    const text = String(value);
    return text.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}
function flattenSymbols(value, documentUri) {
    const items = [];
    if (!Array.isArray(value)) {
        return { items, truncated: false };
    }
    const queue = value.slice(0, MAX_SYMBOLS + 1).map((entry) => ({ value: entry }));
    const seen = new Set();
    let visited = 0;
    let truncated = value.length > MAX_SYMBOLS;
    while (queue.length && visited < MAX_SYMBOLS * 4 && items.length < MAX_SYMBOLS) {
        const entry = queue.shift();
        const symbol = record(entry.value);
        if (!symbol || seen.has(symbol)) {
            continue;
        }
        seen.add(symbol);
        visited += 1;
        const location = record(symbol.location);
        const range = rangeOf(location ? location.range : symbol.range);
        const name = typeof symbol.name === "string" ? cleanText(symbol.name).slice(0, 500) : "";
        if (range && name && typeof symbol.kind === "number" && Number.isInteger(symbol.kind)
            && symbol.kind >= 0 && symbol.kind <= 25 && (!location || uriOf(location.uri) === documentUri)) {
            items.push({ ...range, name, kind: symbol.kind, containerName: typeof symbol.containerName === "string"
                    ? cleanText(symbol.containerName).slice(0, 500) : entry.container, selectionRange: rangeOf(symbol.selectionRange) });
        }
        if (Array.isArray(symbol.children)) {
            const capacity = Math.max(0, MAX_SYMBOLS * 4 - visited - queue.length);
            truncated || (truncated = symbol.children.length > capacity);
            queue.unshift(...symbol.children.slice(0, capacity).map((child) => ({ value: child, container: name || entry.container })));
        }
    }
    return { items, truncated: truncated || queue.length > 0 };
}
function normalizeDefinitions(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const items = [];
    const seen = new Set();
    for (const entry of values.slice(0, MAX_DEFINITIONS)) {
        const location = record(entry);
        const uri = uriOf(location?.targetUri ?? location?.uri);
        const range = rangeOf(location?.targetRange ?? location?.range);
        if (!location || !uri || !range) {
            continue;
        }
        const key = JSON.stringify([uri, range]);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        items.push({ uri, ...range, selectionRange: rangeOf(location.targetSelectionRange) });
    }
    return { items, truncated: values.length > MAX_DEFINITIONS };
}
function normalizeHover(value) {
    const parts = [];
    let truncated = false;
    for (const hover of (Array.isArray(value) ? value : []).slice(0, 10)) {
        const contents = record(hover)?.contents;
        const entries = Array.isArray(contents) ? contents : [contents];
        truncated || (truncated = entries.length > 10);
        for (const item of entries.slice(0, 10)) {
            const raw = typeof item === "string" ? item : record(item)?.value;
            if (typeof raw !== "string") {
                continue;
            }
            truncated || (truncated = raw.length > MAX_HOVER_CHARS);
            const plain = cleanText(raw.slice(0, MAX_HOVER_CHARS))
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
                .replace(/<\/?(?:a|abbr|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|span|strong|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi, "")
                .replace(/!?\[([^\]]*)\]\([^\n]*?\)/g, "$1")
                .replace(/^\s*```[^\n]*$/gm, "")
                .replace(/`|\*\*/g, "")
                .trim();
            if (plain) {
                parts.push(plain);
            }
        }
    }
    const text = [...new Set(parts)].join("\n\n");
    return { text: text.slice(0, MAX_HOVER_CHARS), truncated: truncated || text.length > MAX_HOVER_CHARS || (Array.isArray(value) && value.length > 10) };
}
function cleanText(text) {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}
function copyResult(result) {
    return JSON.parse(JSON.stringify(result));
}
//# sourceMappingURL=elementLanguageService.js.map