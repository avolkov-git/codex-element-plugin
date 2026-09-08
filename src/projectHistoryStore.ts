import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ElementIdentity, identityScopeRoot } from "./elementIdentityService";
import { PersistedChatHistory } from "./types";

const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
interface Envelope {
  schema: 2;
  scope: Pick<ElementIdentity, "userKey" | "projectKey" | "server" | "projectName" | "spaceId">;
  revision: number;
  updatedAt: string;
  workspacePath: string;
  imports: string[];
  history: PersistedChatHistory;
}
interface Baseline { history: PersistedChatHistory; imports: string[]; }
export interface LegacyHistoryCandidate { id: string; profileId: string; workspaceId: string; chatCount: number; updatedAt: string; }

/** Atomic per-project persistence with optimistic per-chat concurrency, never last-writer-wins. */
export class ProjectHistoryStore {
  private readonly baselines = new Map<string, Baseline>();
  private readonly blocked = new Set<string>();
  private readonly legacy = new Map<string, { file: string; fingerprint: string; scope: string }>();
  private readonly rawRevisions = new Map<string, string>();

  constructor(private readonly configRoot: string, private readonly normalize: (value: unknown) => PersistedChatHistory) {}

  file(identity: ElementIdentity): string { return path.join(identityScopeRoot(this.configRoot, identity), "chats.json"); }

  async load(identity: ElementIdentity, workspacePath: string): Promise<PersistedChatHistory | undefined> {
    const file = this.file(identity);
    this.baselines.clear();
    this.rawRevisions.clear();
    this.legacy.clear();
    try {
      const envelope = await this.read(file, identity);
      const history = envelope?.history ?? emptyHistory();
      this.baselines.set(file, { history: clone(history), imports: envelope?.imports ?? [] });
      this.blocked.delete(file);
      if (!envelope) { return undefined; }
      const loaded = clone(history);
      for (const chat of loaded.chats) {
        // A stored runtime thread can still point at the previous application's cwd.
        if ((chat.backendWorkspacePath ?? envelope.workspacePath) !== workspacePath) {
          chat.backendThreadId = null; chat.backendThreadAccessMode = null; chat.backendContextRestored = false;
        }
      }
      return loaded;
    } catch (error) {
      this.blocked.add(file);
      throw new Error(`История не открыта и защищена от перезаписи: ${errorMessage(error)} Файл: ${file}`);
    }
  }

  async save(identity: ElementIdentity, workspacePath: string, value: PersistedChatHistory): Promise<void> {
    const file = this.file(identity);
    const baseline = this.baselines.get(file);
    if (this.blocked.has(file) || !baseline) { throw new Error("Запись истории заблокирована: сначала необходимо успешно прочитать текущую историю проекта."); }
    const local = this.normalize(value);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const unlock = await acquireHistoryLock(file);
    try {
      let disk: Envelope | undefined;
      try { disk = await this.read(file, identity); }
      catch (error) { this.blocked.add(file); throw error; }
      if (!disk && baseline.history.chats.length) {
        this.blocked.add(file);
        throw new Error("Файл истории исчез после чтения. Автоматическое создание поверх пропавшей истории остановлено.");
      }
      let merged: PersistedChatHistory;
      try { merged = mergeHistory(baseline.history, local, disk?.history ?? emptyHistory()); }
      catch (error) {
        const conflict = `${file}.conflict-${crypto.randomUUID()}.json`;
        await atomicWrite(conflict, JSON.stringify({ schema: 2, scope: scope(identity), history: local, reason: "concurrent-edit" }));
        this.blocked.add(file);
        throw new Error(`Этот чат изменился в другой IDE. Текущая версия сохранена отдельно: ${conflict}. Перезагрузите историю перед продолжением.`);
      }
      const envelope: Envelope = {
        schema: 2, scope: scope(identity), revision: (disk?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(), workspacePath,
        imports: Array.from(new Set([...(disk?.imports ?? []), ...baseline.imports])), history: merged
      };
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) { throw new Error("История превысила лимит 128 МБ. Исходный файл сохранен без изменений."); }
      // Keep the last verified on-disk revision, not a possibly corrupt input.
      if (disk) { await atomicWrite(`${file}.bak`, this.rawRevisions.get(file)!); }
      await atomicWrite(file, serialized);
      // The baseline is the local view, not unseen changes from another IDE.
      this.baselines.set(file, { history: clone(local), imports: envelope.imports });
    } finally { await unlock(); }
  }

  async listLegacy(identity: ElementIdentity): Promise<LegacyHistoryCandidate[]> {
    this.legacy.clear();
    const candidates: LegacyHistoryCandidate[] = [];
    const imported = new Set(this.baselines.get(this.file(identity))?.imports ?? []);
    const scopeRoot = identityScopeRoot(this.configRoot, identity);
    const root = path.join(scopeRoot, "imports");
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(scopeRoot, "import-target.json"), JSON.stringify({ schema: "codex-element-import-target-v1", scope: scope(identity), owner: { userId: identity.userId, userListId: identity.userListId, login: identity.login } }));
    const realRoot = await fs.promises.realpath(root);
    if (!realRoot.startsWith(`${await fs.promises.realpath(scopeRoot)}${path.sep}`)) { throw new Error("Каталог переноса находится вне области пользователя и проекта."); }
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    // Legacy username hashes have no server/realm ownership. Only operator-bound
    // exports placed in this authenticated scope are eligible for import.
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) { continue; }
      const file = path.join(root, entry.name);
      try {
        const raw = await readBounded(file);
        const fingerprint = digest(raw);
        const id = digest(`${identity.userKey}:${identity.projectKey}:${fingerprint}`);
        if (imported.has(id)) { continue; }
        const parsed: unknown = JSON.parse(raw);
        const history = this.readImport(parsed, identity);
        this.legacy.set(id, { file, fingerprint, scope: `${identity.userKey}/${identity.projectKey}` });
        candidates.push({ id, profileId: identity.userLabel, workspaceId: entry.name, chatCount: history.chats.length, updatedAt: (await fs.promises.stat(file)).mtime.toISOString() });
      } catch { /* Invalid/unowned exports remain untouched. */ }
    }
    return candidates;
  }

  async importLegacy(identity: ElementIdentity, workspacePath: string, id: string, current: PersistedChatHistory): Promise<PersistedChatHistory> {
    const candidate = this.legacy.get(id);
    const baseline = this.baselines.get(this.file(identity));
    if (!candidate || !baseline || candidate.scope !== `${identity.userKey}/${identity.projectKey}`) { throw new Error("Список переноса устарел. Обновите его и выберите историю повторно."); }
    if (baseline.imports.includes(id)) { return current; }
    const raw = await readBounded(candidate.file);
    if (digest(raw) !== candidate.fingerprint) { throw new Error("Старая история изменилась. Перенос отменен; обновите список."); }
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
    try { await this.save(identity, workspacePath, result); }
    catch (error) { baseline.imports = baseline.imports.filter((entry) => entry !== id); throw error; }
    // Pending snapshots still contain the pre-import local view. Keep new chats
    // unseen until the caller publishes them, so an older save cannot delete them.
    this.baselines.get(this.file(identity))!.history = clone(this.normalize(current));
    this.legacy.delete(id);
    return result;
  }

  private async read(file: string, identity: ElementIdentity): Promise<Envelope | undefined> {
    let raw: string;
    try { raw = await readBounded(file); } catch (error) { if (nodeCode(error) === "ENOENT") { return undefined; } throw error; }
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || value.schema !== 2 || !isObject(value.scope) || value.scope.userKey !== identity.userKey || value.scope.projectKey !== identity.projectKey || value.scope.server !== identity.server || value.scope.spaceId !== identity.spaceId || value.scope.projectName !== identity.projectName || !Number.isSafeInteger(value.revision) || typeof value.workspacePath !== "string") {
      throw new Error("Неверная версия или владелец файла истории.");
    }
    validateHistory(value.history);
    this.rawRevisions.set(file, raw);
    return { ...value, imports: Array.isArray(value.imports) ? value.imports.filter((id): id is string => typeof id === "string") : [], history: this.normalize(value.history) } as unknown as Envelope;
  }

  private readImport(value: unknown, identity: ElementIdentity): PersistedChatHistory {
    if (!isObject(value) || value.schema !== "codex-element-history-export-v1" || !isObject(value.scope) || !isObject(value.owner) || value.owner.userId !== identity.userId || value.owner.userListId !== identity.userListId
      || Object.entries(scope(identity)).some(([key, field]) => value.scope && (value.scope as Record<string, unknown>)[key] !== field)) {
      throw new Error("Владелец и проект архива не подтверждены.");
    }
    validateHistory(value.history);
    return this.normalize(value.history);
  }
}

export function validateHistory(value: unknown): asserts value is PersistedChatHistory {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.chats) || !isObject(value.transcripts)) { throw new Error("Неверная структура истории."); }
  const ids = new Set<string>();
  for (const chat of value.chats) {
    if (!isObject(chat) || typeof chat.id !== "string" || !chat.id || ids.has(chat.id) || !Array.isArray(value.transcripts[chat.id])) { throw new Error("Поврежден список диалогов или сообщений."); }
    ids.add(chat.id);
    const itemIds = new Set<string>();
    for (const item of value.transcripts[chat.id] as unknown[]) {
      if (!isObject(item) || typeof item.id !== "string" || !item.id || itemIds.has(item.id) || typeof item.createdAt !== "string") { throw new Error("Повреждены идентификаторы сообщений."); }
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
      if (!valid) { throw new Error("Повреждено сообщение. Исходная история не будет перезаписана."); }
      if (item.kind === "worklog" && (item.children as unknown[]).some((child) => !isObject(child) || typeof child.id !== "string" || typeof child.title !== "string" || !child.title.trim())) { throw new Error("Повреждены детали операции."); }
      if (item.kind === "diff" && (item.files as unknown[]).some((file) => !isObject(file) || typeof file.path !== "string" || !file.path.trim())) { throw new Error("Повреждены сведения об измененном файле."); }
      if (item.kind === "clarification" && (item.options as unknown[]).some((option) => !isObject(option) || typeof option.title !== "string" || typeof option.answer !== "string")) { throw new Error("Повреждены варианты ответа."); }
    }
  }
  if (Object.keys(value.transcripts).some((id) => !ids.has(id))) { throw new Error("В истории найдены сообщения без диалога."); }
}

export function mergeHistory(base: PersistedChatHistory, local: PersistedChatHistory, disk: PersistedChatHistory): PersistedChatHistory {
  const baseEntries = entries(base), localEntries = entries(local), diskEntries = entries(disk);
  const result = new Map(diskEntries);
  for (const id of new Set([...baseEntries.keys(), ...localEntries.keys()])) {
    const previous = baseEntries.get(id), changed = localEntries.get(id), stored = diskEntries.get(id);
    if (JSON.stringify(previous) === JSON.stringify(changed)) { continue; }
    if (JSON.stringify(stored) !== JSON.stringify(previous) && JSON.stringify(stored) !== JSON.stringify(changed)) { throw new Error(`Concurrent chat edit: ${id}`); }
    if (changed) { result.set(id, changed); } else { result.delete(id); }
  }
  const chats = Array.from(result.values()).map((entry) => entry.chat);
  return { version: 1, activeChatId: result.has(local.activeChatId ?? "") ? local.activeChatId : chats[0]?.id, chats, transcripts: Object.fromEntries(Array.from(result, ([id, entry]) => [id, entry.transcript])) };
}

function entries(history: PersistedChatHistory) { return new Map(history.chats.map((chat) => [chat.id, { chat, transcript: history.transcripts[chat.id] ?? [] }])); }
function emptyHistory(): PersistedChatHistory { return { version: 1, chats: [], transcripts: {} }; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function scope(identity: ElementIdentity): Envelope["scope"] { const { userKey, projectKey, server, projectName, spaceId } = identity; return { userKey, projectKey, server, projectName, spaceId }; }
function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function nodeCode(error: unknown): string | undefined { return isObject(error) && typeof error.code === "string" ? error.code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Ошибка чтения"; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function readBounded(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) { throw new Error("История не является файлом допустимого размера."); }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) { break; } offset += bytesRead;
    }
    if (offset > stat.size) { throw new Error("Файл истории изменился во время чтения."); }
    return buffer.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

async function atomicWrite(file: string, value: string): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${value}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.promises.rename(temporary, file); }
  finally { await fs.promises.rm(temporary, { force: true }); }
}

async function acquireHistoryLock(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  const token = crypto.randomUUID();
  while (true) {
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      try { await fs.promises.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: "wx", mode: 0o600 }); }
      catch (error) { await fs.promises.rm(lock, { recursive: true, force: true }); throw error; }
      let released = false;
      return async () => {
        if (released) { return; }
        released = true;
        let owner: unknown;
        try { owner = JSON.parse(await fs.promises.readFile(path.join(lock, "owner.json"), "utf8")); }
        catch { return; }
        if (!isObject(owner) || owner.token !== token) { return; }
        await fs.promises.unlink(path.join(lock, "owner.json"));
        await fs.promises.rmdir(lock);
      };
    } catch (error) {
      if (nodeCode(error) !== "EEXIST") { throw error; }
      // Do not reclaim a stale pathname: another IDE can replace it between the
      // owner probe and removal. Recovery of an abandoned lock is operator-only.
      if (Date.now() >= deadline) { throw new Error(`История занята другой IDE. Если все IDE остановлены, администратору нужно проверить оставшуюся блокировку: ${lock}`); }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
