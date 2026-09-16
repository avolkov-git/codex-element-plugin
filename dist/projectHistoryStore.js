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
exports.ProjectHistoryStore = void 0;
exports.validateHistory = validateHistory;
exports.mergeHistory = mergeHistory;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const perf_hooks_1 = require("perf_hooks");
const util_1 = require("util");
const elementIdentityService_1 = require("./elementIdentityService");
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
/** Atomic per-project persistence with optimistic per-chat concurrency, never last-writer-wins. */
class ProjectHistoryStore {
    constructor(configRoot, normalize) {
        this.configRoot = configRoot;
        this.normalize = normalize;
        this.baselines = new Map();
        this.blocked = new Set();
        this.legacy = new Map();
        this.verifiedRevisions = new Map();
        this.metrics = {
            saveAttempts: 0, savesCompleted: 0, saveFailures: 0, skippedWrites: 0,
            historyWrites: 0, backupWrites: 0, writtenBytes: 0, readBytes: 0, readCacheHits: 0,
            persistedBytes: 0,
            serializations: 0, serializedBytes: 0, serializationMs: 0, serializationMaxMs: 0,
            comparisonMs: 0, normalizationMs: 0, readMs: 0, lockWaitMs: 0, writeMs: 0, saveMs: 0, saveMaxMs: 0
        };
    }
    getMetrics() { return { ...this.metrics }; }
    file(identity) { return path.join((0, elementIdentityService_1.identityScopeRoot)(this.configRoot, identity), "chats.json"); }
    async load(identity, workspacePath) {
        const file = this.file(identity);
        this.baselines.clear();
        this.verifiedRevisions.clear();
        this.legacy.clear();
        this.metrics.persistedBytes = 0;
        try {
            const envelope = await this.read(file, identity);
            const history = envelope?.history ?? emptyHistory();
            this.baselines.set(file, { signatures: this.verifiedRevisions.get(file)?.compared.signatures ?? new Map(), imports: envelope?.imports ?? [] });
            this.blocked.delete(file);
            if (!envelope) {
                return undefined;
            }
            const loaded = this.clone(history);
            for (const chat of loaded.chats) {
                // Identity was verified by read(): the same project keeps its native history.
                // Keep the old cwd until thread/resume confirms the new application's directory.
                if (chat.backendThreadId && !chat.backendWorkspacePath && envelope.workspacePath !== workspacePath) {
                    chat.backendWorkspacePath = envelope.workspacePath;
                }
            }
            return loaded;
        }
        catch (error) {
            this.blocked.add(file);
            throw new Error(`История не открыта и защищена от перезаписи: ${errorMessage(error)} Файл: ${file}`);
        }
    }
    async save(identity, workspacePath, value) {
        const start = perf_hooks_1.performance.now();
        this.metrics.saveAttempts++;
        try {
            await this.saveCurrent(identity, workspacePath, value);
            this.metrics.savesCompleted++;
        }
        catch (error) {
            this.metrics.saveFailures++;
            throw error;
        }
        finally {
            const elapsed = perf_hooks_1.performance.now() - start;
            this.metrics.saveMs += elapsed;
            this.metrics.saveMaxMs = Math.max(this.metrics.saveMaxMs, elapsed);
        }
    }
    async saveCurrent(identity, workspacePath, value) {
        const file = this.file(identity);
        const baseline = this.baselines.get(file);
        if (this.blocked.has(file) || !baseline) {
            throw new Error("Запись истории заблокирована: сначала необходимо успешно прочитать текущую историю проекта.");
        }
        const local = this.compare(this.normalizeValue(value));
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const lockStart = perf_hooks_1.performance.now();
        const unlock = await acquireHistoryLock(file).finally(() => { this.metrics.lockWaitMs += perf_hooks_1.performance.now() - lockStart; });
        try {
            let disk;
            try {
                disk = await this.read(file, identity);
            }
            catch (error) {
                this.blocked.add(file);
                throw error;
            }
            if (!disk && baseline.signatures.size) {
                this.blocked.add(file);
                throw new Error("Файл истории исчез после чтения. Автоматическое создание поверх пропавшей истории остановлено.");
            }
            const verified = this.verifiedRevisions.get(file);
            const stored = disk ? verified.compared : this.compare(emptyHistory());
            let merged;
            try {
                merged = mergeCompared(baseline.signatures, local, stored);
            }
            catch (error) {
                const conflict = `${file}.conflict-${crypto.randomUUID()}.json`;
                await this.write(conflict, this.serialize({ schema: 2, scope: scope(identity), history: local.history, reason: "concurrent-edit" }));
                this.blocked.add(file);
                throw new Error(`Этот чат изменился в другой IDE. Текущая версия сохранена отдельно: ${conflict}. Перезагрузите историю перед продолжением.`);
            }
            const envelope = {
                schema: 2, scope: scope(identity), revision: (disk?.revision ?? 0) + 1,
                updatedAt: new Date().toISOString(), workspacePath,
                imports: Array.from(new Set([...(disk?.imports ?? []), ...baseline.imports])), history: merged.history
            };
            // Still read under the lock: unchanged local state must not conceal disk corruption or edits.
            if (disk && disk.workspacePath === workspacePath && envelope.imports.length === disk.imports.length
                && sameHistory(merged, stored)) {
                this.baselines.set(file, { signatures: local.signatures, imports: envelope.imports });
                this.metrics.skippedWrites++;
                return;
            }
            if (!Number.isSafeInteger(envelope.revision)) {
                throw new Error("Достигнуто ограничение числа версий истории. Исходный файл не изменён.");
            }
            const serialized = this.serialize(envelope);
            const persistedBytes = Buffer.byteLength(serialized) + 1;
            if (persistedBytes > MAX_HISTORY_BYTES) {
                throw new Error("История превысила лимит 128 МБ. Исходный файл сохранен без изменений.");
            }
            // Keep the last verified on-disk revision, not a possibly corrupt input.
            if (disk) {
                await this.write(`${file}.bak`, verified.raw, false);
                this.metrics.backupWrites++;
            }
            await this.write(file, serialized);
            this.metrics.historyWrites++;
            this.metrics.persistedBytes = persistedBytes;
            this.verifiedRevisions.set(file, { raw: `${serialized}\n`, envelope, compared: merged });
            // The baseline is the local view, not unseen changes from another IDE.
            this.baselines.set(file, { signatures: local.signatures, imports: envelope.imports });
        }
        finally {
            await unlock();
        }
    }
    async listLegacy(identity) {
        this.legacy.clear();
        const candidates = [];
        const imported = new Set(this.baselines.get(this.file(identity))?.imports ?? []);
        const scopeRoot = (0, elementIdentityService_1.identityScopeRoot)(this.configRoot, identity);
        const root = path.join(scopeRoot, "imports");
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await this.write(path.join(scopeRoot, "import-target.json"), this.serialize({ schema: "codex-element-import-target-v1", scope: scope(identity), owner: { userId: identity.userId, userListId: identity.userListId, login: identity.login } }));
        const realRoot = await fs.promises.realpath(root);
        if (!realRoot.startsWith(`${await fs.promises.realpath(scopeRoot)}${path.sep}`)) {
            throw new Error("Каталог переноса находится вне области пользователя и проекта.");
        }
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        // Legacy username hashes have no server/realm ownership. Only operator-bound
        // exports placed in this authenticated scope are eligible for import.
        for (const entry of entries.slice(0, 200)) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) {
                continue;
            }
            const file = path.join(root, entry.name);
            try {
                const raw = await readBounded(file);
                const fingerprint = digest(raw);
                const id = digest(`${identity.userKey}:${identity.projectKey}:${fingerprint}`);
                if (imported.has(id)) {
                    continue;
                }
                const parsed = JSON.parse(raw);
                const history = this.readImport(parsed, identity);
                this.legacy.set(id, { file, fingerprint, scope: `${identity.userKey}/${identity.projectKey}` });
                candidates.push({ id, profileId: identity.userLabel, workspaceId: entry.name, chatCount: history.chats.length, updatedAt: (await fs.promises.stat(file)).mtime.toISOString() });
            }
            catch { /* Invalid/unowned exports remain untouched. */ }
        }
        return candidates;
    }
    async importLegacy(identity, workspacePath, id, current) {
        const candidate = this.legacy.get(id);
        const baseline = this.baselines.get(this.file(identity));
        if (!candidate || !baseline || candidate.scope !== `${identity.userKey}/${identity.projectKey}`) {
            throw new Error("Список переноса устарел. Обновите его и выберите историю повторно.");
        }
        if (baseline.imports.includes(id)) {
            return current;
        }
        const raw = await readBounded(candidate.file);
        if (digest(raw) !== candidate.fingerprint) {
            throw new Error("Старая история изменилась. Перенос отменен; обновите список.");
        }
        const legacy = this.readImport(JSON.parse(raw), identity);
        const result = this.clone(current);
        const occupied = new Set(result.chats.map((chat) => chat.id));
        for (const chat of legacy.chats) {
            const oldId = chat.id;
            const newId = occupied.has(oldId) ? `migrated-${crypto.randomUUID()}` : oldId;
            occupied.add(newId);
            result.chats.push({ ...chat, id: newId, backendThreadId: null, backendThreadAccessMode: null, activeTurnId: null, activeRunMode: null, status: "idle", pendingApproval: null, queuedMessages: [] });
            result.transcripts[newId] = legacy.transcripts[oldId] ?? [];
        }
        // Backup is a copy next to the source; the old version of the plugin still reads the original.
        await this.write(`${candidate.file}.pre-1.0.0-${candidate.fingerprint.slice(0, 12)}.bak`, raw, false);
        baseline.imports.push(id);
        try {
            await this.save(identity, workspacePath, result);
        }
        catch (error) {
            baseline.imports = baseline.imports.filter((entry) => entry !== id);
            throw error;
        }
        // Pending snapshots still contain the pre-import local view. Keep new chats
        // unseen until the caller publishes them, so an older save cannot delete them.
        this.baselines.get(this.file(identity)).signatures = this.compare(this.normalizeValue(current)).signatures;
        this.legacy.delete(id);
        return result;
    }
    async read(file, identity) {
        let raw;
        let bytes = 0;
        const started = perf_hooks_1.performance.now();
        try {
            raw = await readBounded(file, count => { bytes = count; });
        }
        catch (error) {
            if (nodeCode(error) === "ENOENT") {
                this.verifiedRevisions.delete(file);
                this.metrics.persistedBytes = 0;
                return undefined;
            }
            throw error;
        }
        finally {
            this.metrics.readMs += perf_hooks_1.performance.now() - started;
        }
        this.metrics.readBytes += bytes;
        const cached = this.verifiedRevisions.get(file);
        // Exact raw equality, never mtime/revision alone. Scope is checked even on cache hits.
        if (cached?.raw === raw && Object.entries(scope(identity)).every(([key, field]) => cached.envelope.scope[key] === field)) {
            this.metrics.readCacheHits++;
            this.metrics.persistedBytes = bytes;
            return cached.envelope;
        }
        const value = JSON.parse(raw);
        if (!isObject(value) || value.schema !== 2 || !isObject(value.scope) || value.scope.userKey !== identity.userKey || value.scope.projectKey !== identity.projectKey || value.scope.server !== identity.server || value.scope.spaceId !== identity.spaceId || value.scope.projectName !== identity.projectName || !Number.isSafeInteger(value.revision) || typeof value.workspacePath !== "string") {
            throw new Error("Неверная версия или владелец файла истории.");
        }
        validateHistory(value.history);
        const envelope = { ...value, imports: Array.isArray(value.imports) ? value.imports.filter((id) => typeof id === "string") : [], history: this.normalizeValue(value.history) };
        this.verifiedRevisions.set(file, { raw, envelope, compared: this.compare(envelope.history) });
        this.metrics.persistedBytes = bytes;
        return envelope;
    }
    readImport(value, identity) {
        if (!isObject(value) || value.schema !== "codex-element-history-export-v1" || !isObject(value.scope) || !isObject(value.owner) || value.owner.userId !== identity.userId || value.owner.userListId !== identity.userListId
            || Object.entries(scope(identity)).some(([key, field]) => value.scope && value.scope[key] !== field)) {
            throw new Error("Владелец и проект архива не подтверждены.");
        }
        validateHistory(value.history);
        return this.normalizeValue(value.history);
    }
    normalizeValue(value) {
        const started = perf_hooks_1.performance.now();
        try {
            return this.normalize(value);
        }
        finally {
            this.metrics.normalizationMs += perf_hooks_1.performance.now() - started;
        }
    }
    compare(history) {
        const started = perf_hooks_1.performance.now();
        try {
            return compareHistory(history, value => this.serialize(value));
        }
        finally {
            this.metrics.comparisonMs += perf_hooks_1.performance.now() - started;
        }
    }
    serialize(value) {
        const started = perf_hooks_1.performance.now();
        try {
            const serialized = JSON.stringify(value);
            this.metrics.serializations++;
            this.metrics.serializedBytes += Buffer.byteLength(serialized);
            return serialized;
        }
        finally {
            const elapsed = perf_hooks_1.performance.now() - started;
            this.metrics.serializationMs += elapsed;
            this.metrics.serializationMaxMs = Math.max(this.metrics.serializationMaxMs, elapsed);
        }
    }
    clone(value) { return JSON.parse(this.serialize(value)); }
    async write(file, value, appendNewline = true) {
        const started = perf_hooks_1.performance.now();
        try {
            await atomicWrite(file, value, appendNewline);
            this.metrics.writtenBytes += Buffer.byteLength(value) + (appendNewline ? 1 : 0);
        }
        finally {
            this.metrics.writeMs += perf_hooks_1.performance.now() - started;
        }
    }
}
exports.ProjectHistoryStore = ProjectHistoryStore;
function validateHistory(value) {
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.chats) || !isObject(value.transcripts)) {
        throw new Error("Неверная структура истории.");
    }
    const ids = new Set();
    for (const chat of value.chats) {
        if (!isObject(chat) || typeof chat.id !== "string" || !chat.id || ids.has(chat.id) || !Array.isArray(value.transcripts[chat.id])) {
            throw new Error("Поврежден список диалогов или сообщений.");
        }
        ids.add(chat.id);
        const itemIds = new Set();
        for (const item of value.transcripts[chat.id]) {
            if (!isObject(item) || typeof item.id !== "string" || !item.id || itemIds.has(item.id) || typeof item.createdAt !== "string") {
                throw new Error("Повреждены идентификаторы сообщений.");
            }
            itemIds.add(item.id);
            const valid = item.kind === "message" ? typeof item.text === "string" && ["user", "assistant", "system"].includes(String(item.role))
                : item.kind === "activity" ? typeof item.label === "string" && Boolean(item.label.trim())
                    : item.kind === "worklog" ? typeof item.title === "string" && Boolean(item.title.trim()) && Array.isArray(item.children)
                        : item.kind === "diff" ? Array.isArray(item.files)
                            : item.kind === "turn-run" ? typeof item.turnId === "string" && Boolean(item.turnId)
                                : item.kind === "compaction" ? typeof item.label === "string"
                                    : item.kind === "plan" ? typeof item.markdown === "string"
                                        : item.kind === "clarification" ? typeof item.question === "string" && Array.isArray(item.options)
                                            : item.kind === "connection" || item.kind === "error" ? typeof item.message === "string" : false;
            if (!valid) {
                throw new Error("Повреждено сообщение. Исходная история не будет перезаписана.");
            }
            if (item.kind === "message" || item.kind === "clarification") {
                if ([item.backendThreadId, item.backendItemId].some(value => value !== undefined && (typeof value !== "string" || !value || value.length > 1024))) {
                    throw new Error("Повреждена привязка вопроса к серверному диалогу.");
                }
                if (item.kind === "clarification" && item.answer !== undefined
                    && (typeof item.answer !== "string" || !item.answer.trim() || Buffer.byteLength(item.answer, "utf8") > 16 * 1024)) {
                    throw new Error("Поврежден сохраненный ответ на вопрос.");
                }
                if (item.kind === "message" && item.questions !== undefined) {
                    if (item.role !== "assistant" || !Array.isArray(item.questions) || !item.questions.length || item.questions.length > 32
                        || Buffer.byteLength(JSON.stringify(item.questions), "utf8") > 1024 * 1024)
                        throw new Error("Повреждены вопросы в сообщении.");
                    const questionIds = new Set();
                    for (const question of item.questions) {
                        if (!isObject(question) || typeof question.id !== "string" || !question.id || question.id.length > 1024 || questionIds.has(question.id)
                            || typeof question.title !== "string" || !question.title.trim() || Buffer.byteLength(question.title, "utf8") > 16 * 1024
                            || (question.options !== null && (!Array.isArray(question.options) || question.options.length > 64 || question.options.some(option => typeof option !== "string" || Buffer.byteLength(option, "utf8") > 16 * 1024)))
                            || (question.answer !== undefined && (typeof question.answer !== "string" || !question.answer.trim() || Buffer.byteLength(question.answer, "utf8") > 16 * 1024))) {
                            throw new Error("Поврежден вопрос или сохраненный ответ.");
                        }
                        questionIds.add(question.id);
                    }
                }
            }
            if (item.kind === "worklog" && item.children.some((child) => !isObject(child) || typeof child.id !== "string" || typeof child.title !== "string" || !child.title.trim())) {
                throw new Error("Повреждены детали операции.");
            }
            if (item.kind === "diff" && item.files.some((file) => !isObject(file) || typeof file.path !== "string" || !file.path.trim())) {
                throw new Error("Повреждены сведения об измененном файле.");
            }
            if (item.kind === "clarification" && item.options.some((option) => !isObject(option) || typeof option.title !== "string" || typeof option.answer !== "string")) {
                throw new Error("Повреждены варианты ответа.");
            }
        }
    }
    if (Object.keys(value.transcripts).some((id) => !ids.has(id))) {
        throw new Error("В истории найдены сообщения без диалога.");
    }
}
function mergeHistory(base, local, disk) {
    return mergeCompared(compareHistory(base).signatures, compareHistory(local), compareHistory(disk)).history;
}
function compareHistory(history, serialize = JSON.stringify) {
    const items = entries(history);
    return { history, entries: items, signatures: new Map(Array.from(items, ([id, entry]) => [id, digest(serialize(entry))])) };
}
function mergeCompared(base, local, disk) {
    const result = new Map(disk.entries), signatures = new Map(disk.signatures);
    for (const id of new Set([...base.keys(), ...local.entries.keys()])) {
        const previous = base.get(id), changed = local.signatures.get(id), stored = disk.signatures.get(id);
        if (previous === changed) {
            continue;
        }
        if (stored !== previous && stored !== changed) {
            throw new Error(`Диалог был одновременно изменён: ${id}`);
        }
        if (changed !== undefined) {
            result.set(id, local.entries.get(id));
            signatures.set(id, changed);
        }
        else {
            result.delete(id);
            signatures.delete(id);
        }
    }
    const chats = Array.from(result.values()).map((entry) => entry.chat);
    const history = { version: 1, activeChatId: result.has(local.history.activeChatId ?? "") ? local.history.activeChatId : chats[0]?.id, chats, transcripts: Object.fromEntries(Array.from(result, ([id, entry]) => [id, entry.transcript])) };
    return { history, entries: result, signatures };
}
function sameHistory(left, right) {
    return left.history.activeChatId === right.history.activeChatId && left.signatures.size === right.signatures.size
        && Array.from(left.signatures).every(([id, signature]) => right.signatures.get(id) === signature);
}
function entries(history) { return new Map(history.chats.map((chat) => [chat.id, { chat, transcript: history.transcripts[chat.id] ?? [] }])); }
function emptyHistory() { return { version: 1, chats: [], transcripts: {} }; }
function scope(identity) { const { userKey, projectKey, server, projectName, spaceId } = identity; return { userKey, projectKey, server, projectName, spaceId }; }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nodeCode(error) { return isObject(error) && typeof error.code === "string" ? error.code : undefined; }
function errorMessage(error) { return error instanceof Error ? error.message : "Ошибка чтения"; }
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function readBounded(file, onBytesRead) {
    const handle = await fs.promises.open(file, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) {
            throw new Error("История не является файлом допустимого размера.");
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) {
                break;
            }
            offset += bytesRead;
        }
        if (offset > stat.size) {
            throw new Error("Файл истории изменился во время чтения.");
        }
        // Replacement decoding would silently change the bytes later written to the raw backup.
        const raw = new util_1.TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
        onBytesRead?.(offset);
        return raw;
    }
    finally {
        await handle.close();
    }
}
async function atomicWrite(file, value, appendNewline = true) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(appendNewline ? `${value}\n` : value, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await fs.promises.rename(temporary, file);
    }
    finally {
        await fs.promises.rm(temporary, { force: true });
    }
}
async function acquireHistoryLock(file) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + 3000;
    const token = crypto.randomUUID();
    while (true) {
        try {
            await fs.promises.mkdir(lock, { mode: 0o700 });
            try {
                await fs.promises.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: "wx", mode: 0o600 });
            }
            catch (error) {
                await fs.promises.rm(lock, { recursive: true, force: true });
                throw error;
            }
            let released = false;
            return async () => {
                if (released) {
                    return;
                }
                released = true;
                let owner;
                try {
                    owner = JSON.parse(await fs.promises.readFile(path.join(lock, "owner.json"), "utf8"));
                }
                catch {
                    return;
                }
                if (!isObject(owner) || owner.token !== token) {
                    return;
                }
                await fs.promises.unlink(path.join(lock, "owner.json"));
                await fs.promises.rmdir(lock);
            };
        }
        catch (error) {
            if (nodeCode(error) !== "EEXIST") {
                throw error;
            }
            // Do not reclaim a stale pathname: another IDE can replace it between the
            // owner probe and removal. Recovery of an abandoned lock is operator-only.
            if (Date.now() >= deadline) {
                throw new Error(`История занята другой IDE. Если все IDE остановлены, администратору нужно проверить оставшуюся блокировку: ${lock}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}
//# sourceMappingURL=projectHistoryStore.js.map