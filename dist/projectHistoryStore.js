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
        this.rawRevisions = new Map();
    }
    file(identity) { return path.join((0, elementIdentityService_1.identityScopeRoot)(this.configRoot, identity), "chats.json"); }
    async load(identity, workspacePath) {
        const file = this.file(identity);
        this.baselines.clear();
        this.rawRevisions.clear();
        this.legacy.clear();
        try {
            const envelope = await this.read(file, identity);
            const history = envelope?.history ?? emptyHistory();
            this.baselines.set(file, { history: clone(history), imports: envelope?.imports ?? [] });
            this.blocked.delete(file);
            if (!envelope) {
                return undefined;
            }
            const loaded = clone(history);
            for (const chat of loaded.chats) {
                // A stored runtime thread can still point at the previous application's cwd.
                if ((chat.backendWorkspacePath ?? envelope.workspacePath) !== workspacePath) {
                    chat.backendThreadId = null;
                    chat.backendThreadAccessMode = null;
                    chat.backendContextRestored = false;
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
        const file = this.file(identity);
        const baseline = this.baselines.get(file);
        if (this.blocked.has(file) || !baseline) {
            throw new Error("Запись истории заблокирована: сначала необходимо успешно прочитать текущую историю проекта.");
        }
        const local = this.normalize(value);
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const unlock = await acquireHistoryLock(file);
        try {
            let disk;
            try {
                disk = await this.read(file, identity);
            }
            catch (error) {
                this.blocked.add(file);
                throw error;
            }
            if (!disk && baseline.history.chats.length) {
                this.blocked.add(file);
                throw new Error("Файл истории исчез после чтения. Автоматическое создание поверх пропавшей истории остановлено.");
            }
            let merged;
            try {
                merged = mergeHistory(baseline.history, local, disk?.history ?? emptyHistory());
            }
            catch (error) {
                const conflict = `${file}.conflict-${crypto.randomUUID()}.json`;
                await atomicWrite(conflict, JSON.stringify({ schema: 2, scope: scope(identity), history: local, reason: "concurrent-edit" }));
                this.blocked.add(file);
                throw new Error(`Этот чат изменился в другой IDE. Текущая версия сохранена отдельно: ${conflict}. Перезагрузите историю перед продолжением.`);
            }
            const envelope = {
                schema: 2, scope: scope(identity), revision: (disk?.revision ?? 0) + 1,
                updatedAt: new Date().toISOString(), workspacePath,
                imports: Array.from(new Set([...(disk?.imports ?? []), ...baseline.imports])), history: merged
            };
            const serialized = JSON.stringify(envelope);
            if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) {
                throw new Error("История превысила лимит 128 МБ. Исходный файл сохранен без изменений.");
            }
            // Keep the last verified on-disk revision, not a possibly corrupt input.
            if (disk) {
                await atomicWrite(`${file}.bak`, this.rawRevisions.get(file));
            }
            await atomicWrite(file, serialized);
            // The baseline is the local view, not unseen changes from another IDE.
            this.baselines.set(file, { history: clone(local), imports: envelope.imports });
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
        await atomicWrite(path.join(scopeRoot, "import-target.json"), JSON.stringify({ schema: "codex-element-import-target-v1", scope: scope(identity), owner: { userId: identity.userId, userListId: identity.userListId, login: identity.login } }));
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
        const result = clone(current);
        const occupied = new Set(result.chats.map((chat) => chat.id));
        for (const chat of legacy.chats) {
            const oldId = chat.id;
            const newId = occupied.has(oldId) ? `migrated-${crypto.randomUUID()}` : oldId;
            occupied.add(newId);
            result.chats.push({ ...chat, id: newId, backendThreadId: null, backendThreadAccessMode: null, activeTurnId: null, activeRunMode: null, status: "idle", pendingApproval: null, queuedMessages: [] });
            result.transcripts[newId] = legacy.transcripts[oldId] ?? [];
        }
        // Backup is a copy next to the source; the old version of the plugin still reads the original.
        await atomicWrite(`${candidate.file}.pre-1.0.0-${candidate.fingerprint.slice(0, 12)}.bak`, raw);
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
        this.baselines.get(this.file(identity)).history = clone(this.normalize(current));
        this.legacy.delete(id);
        return result;
    }
    async read(file, identity) {
        let raw;
        try {
            raw = await readBounded(file);
        }
        catch (error) {
            if (nodeCode(error) === "ENOENT") {
                return undefined;
            }
            throw error;
        }
        const value = JSON.parse(raw);
        if (!isObject(value) || value.schema !== 2 || !isObject(value.scope) || value.scope.userKey !== identity.userKey || value.scope.projectKey !== identity.projectKey || value.scope.server !== identity.server || value.scope.spaceId !== identity.spaceId || value.scope.projectName !== identity.projectName || !Number.isSafeInteger(value.revision) || typeof value.workspacePath !== "string") {
            throw new Error("Неверная версия или владелец файла истории.");
        }
        validateHistory(value.history);
        this.rawRevisions.set(file, raw);
        return { ...value, imports: Array.isArray(value.imports) ? value.imports.filter((id) => typeof id === "string") : [], history: this.normalize(value.history) };
    }
    readImport(value, identity) {
        if (!isObject(value) || value.schema !== "codex-element-history-export-v1" || !isObject(value.scope) || !isObject(value.owner) || value.owner.userId !== identity.userId || value.owner.userListId !== identity.userListId
            || Object.entries(scope(identity)).some(([key, field]) => value.scope && value.scope[key] !== field)) {
            throw new Error("Владелец и проект архива не подтверждены.");
        }
        validateHistory(value.history);
        return this.normalize(value.history);
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
    const baseEntries = entries(base), localEntries = entries(local), diskEntries = entries(disk);
    const result = new Map(diskEntries);
    for (const id of new Set([...baseEntries.keys(), ...localEntries.keys()])) {
        const previous = baseEntries.get(id), changed = localEntries.get(id), stored = diskEntries.get(id);
        if (JSON.stringify(previous) === JSON.stringify(changed)) {
            continue;
        }
        if (JSON.stringify(stored) !== JSON.stringify(previous) && JSON.stringify(stored) !== JSON.stringify(changed)) {
            throw new Error(`Concurrent chat edit: ${id}`);
        }
        if (changed) {
            result.set(id, changed);
        }
        else {
            result.delete(id);
        }
    }
    const chats = Array.from(result.values()).map((entry) => entry.chat);
    return { version: 1, activeChatId: result.has(local.activeChatId ?? "") ? local.activeChatId : chats[0]?.id, chats, transcripts: Object.fromEntries(Array.from(result, ([id, entry]) => [id, entry.transcript])) };
}
function entries(history) { return new Map(history.chats.map((chat) => [chat.id, { chat, transcript: history.transcripts[chat.id] ?? [] }])); }
function emptyHistory() { return { version: 1, chats: [], transcripts: {} }; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function scope(identity) { const { userKey, projectKey, server, projectName, spaceId } = identity; return { userKey, projectKey, server, projectName, spaceId }; }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nodeCode(error) { return isObject(error) && typeof error.code === "string" ? error.code : undefined; }
function errorMessage(error) { return error instanceof Error ? error.message : "Ошибка чтения"; }
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function readBounded(file) {
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
        return buffer.subarray(0, offset).toString("utf8");
    }
    finally {
        await handle.close();
    }
}
async function atomicWrite(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${value}\n`, "utf8");
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