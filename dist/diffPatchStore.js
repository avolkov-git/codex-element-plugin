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
exports.DiffPatchStore = exports.MAX_DIFF_PREVIEW_CHARS = exports.MAX_PATCH_BYTES = void 0;
exports.summarizePatch = summarizePatch;
exports.patchFromChanges = patchFromChanges;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const perf_hooks_1 = require("perf_hooks");
exports.MAX_PATCH_BYTES = 8 * 1024 * 1024;
exports.MAX_DIFF_PREVIEW_CHARS = 2048;
const MAX_PREVIEW_TOTAL = 128 * 1024;
const MAX_FILES = 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_DISK_BYTES = 256 * 1024 * 1024;
const MAX_DISK_FILES = 128;
const HASH = /^[a-f0-9]{64}$/;
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const detached = (text) => Buffer.from(text, "utf8").toString("utf8");
/** Scan once; retain bounded previews and ranges, never per-line copies of the complete patch. */
function parsePatch(text) {
    if (Buffer.byteLength(text, "utf8") > exports.MAX_PATCH_BYTES)
        throw new Error("Patch exceeds the 8 MiB recording limit.");
    const files = [];
    let current;
    let previewLeft = MAX_PREVIEW_TOTAL;
    let omitted = 0;
    const finish = (end) => {
        if (!current)
            return;
        current.length = end - current.start;
        const chars = Math.min(exports.MAX_DIFF_PREVIEW_CHARS, previewLeft, current.length);
        current.diff = detached(text.slice(current.start, current.start + chars));
        current.path = detached(current.path);
        if (current.oldPath)
            current.oldPath = detached(current.oldPath);
        if (current.newPath)
            current.newPath = detached(current.newPath);
        previewLeft -= chars;
        current.truncated = chars < current.length;
        files.push(current);
    };
    for (let offset = 0; offset < text.length;) {
        const newline = text.indexOf("\n", offset);
        const end = newline < 0 ? text.length : newline + 1;
        const line = text.slice(offset, newline < 0 ? end : newline).replace(/\r$/, "");
        const header = line.length <= 8192 ? /^diff --git a\/(.+?) b\/(.+)$/.exec(line) : null;
        if (header) {
            if (files.length < MAX_FILES - 1) {
                finish(offset);
                current = { path: header[2], oldPath: header[1], newPath: header[2], status: "modified", additions: 0, deletions: 0, start: offset, length: 0 };
            }
            else {
                if (!omitted) {
                    finish(offset);
                    current = { path: "[Additional files: preview limit reached]", status: "unknown", additions: 0, deletions: 0, start: offset, length: 0 };
                }
                omitted++;
            }
        }
        else {
            current ?? (current = { path: "changes.patch", status: "unknown", additions: 0, deletions: 0, start: offset, length: 0 });
            if (!omitted) {
                if (line === "--- /dev/null" || line.startsWith("new file mode "))
                    current.status = "added";
                else if (line === "+++ /dev/null" || line.startsWith("deleted file mode "))
                    current.status = "deleted";
                else if (line.startsWith("rename from ")) {
                    current.status = "renamed";
                    current.oldPath = line.slice(12, 4108);
                }
                else if (line.startsWith("rename to ")) {
                    current.status = "renamed";
                    current.path = current.newPath = line.slice(10, 4106);
                }
                else if (line.startsWith("--- a/")) {
                    current.oldPath = line.slice(6, 4102);
                    if (current.path === "changes.patch")
                        current.path = current.oldPath;
                }
                else if (line.startsWith("+++ b/"))
                    current.path = current.newPath = line.slice(6, 4102);
            }
            if (line.startsWith("+") && !line.startsWith("+++"))
                current.additions++;
            if (line.startsWith("-") && !line.startsWith("---"))
                current.deletions++;
        }
        offset = end;
    }
    finish(text.length);
    return files;
}
function summarizePatch(text) {
    return parsePatch(text).map(({ start: _start, length: _length, ...file }) => file);
}
function patchFromChanges(value) {
    const changes = value && typeof value === "object" && "changes" in value ? value.changes : undefined;
    if (!Array.isArray(changes))
        return "";
    const chunks = [];
    let bytes = 0;
    for (const change of changes) {
        if (!change || typeof change !== "object" || typeof change.diff !== "string")
            continue;
        const name = typeof change.path === "string" ? change.path.replace(/[\r\n]/g, "_").slice(0, 4096) : "changes.patch";
        const mode = change.status === "added" ? "new file mode 100644\n" : change.status === "deleted" ? "deleted file mode 100644\n" : "";
        const chunk = `${/^diff --git /m.test(change.diff) ? "" : `diff --git a/${name} b/${name}\n${mode}`}${change.diff}\n`;
        bytes += Buffer.byteLength(chunk);
        if (bytes > exports.MAX_PATCH_BYTES)
            throw new Error("Patch exceeds the 8 MiB recording limit.");
        chunks.push(chunk);
    }
    return chunks.join("");
}
/** Private, scoped, evictable recordings; failures never prevent the runtime from completing a turn. */
class DiffPatchStore {
    constructor(getRoot, logger) {
        this.getRoot = getRoot;
        this.logger = logger;
        this.pending = new Map();
        this.queuedBytes = 0;
        this.closed = false;
        this.lastWarning = 0;
        this.metrics = { updates: 0, maxPatchBytes: 0, maxParseMs: 0, written: 0, coalesced: 0, skipped: 0, failures: 0, evicted: 0 };
    }
    capture(text, slot) {
        const started = perf_hooks_1.performance.now();
        const parsed = parsePatch(text);
        const bytes = Buffer.byteLength(text);
        this.metrics.updates++;
        this.metrics.maxPatchBytes = Math.max(this.metrics.maxPatchBytes, bytes);
        this.metrics.maxParseMs = Math.max(this.metrics.maxParseMs, perf_hooks_1.performance.now() - started);
        const root = this.getRoot();
        const scope = root ? digest(root) : "";
        const key = `${scope}:${digest(slot)}`;
        const previous = this.pending.get(key);
        const canRecord = root && !this.closed && (previous || this.pending.size < 4)
            && this.queuedBytes - (previous?.bytes ?? 0) + bytes <= MAX_QUEUED_BYTES;
        if (!canRecord) {
            this.metrics.skipped++;
            return parsed.map(({ start: _start, length: _length, ...file }) => file);
        }
        const id = digest(text);
        if (previous) {
            this.metrics.coalesced++;
            this.queuedBytes -= previous.bytes;
        }
        this.pending.set(key, { root, id, text, bytes });
        this.queuedBytes += bytes;
        this.startDrain();
        return parsed.map(({ start, length, ...file }) => ({ ...file, patchArtifact: { id, scope, start, length } }));
    }
    getMetrics() { return { ...this.metrics, queuedBytes: this.queuedBytes, queuedPatches: this.pending.size, writing: Boolean(this.running) }; }
    async flush() { while (this.running)
        await this.running; }
    dispose() { this.closed = true; }
    startDrain() {
        if (!this.running && this.pending.size)
            this.running = this.drain().finally(() => {
                this.running = undefined;
                this.startDrain();
            });
    }
    async read(file) {
        const ref = file.patchArtifact;
        const root = this.getRoot();
        if (!root || !ref || !HASH.test(ref.id) || ref.scope !== digest(root)
            || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.length) || ref.start < 0 || ref.length < 0
            || ref.start + ref.length > exports.MAX_PATCH_BYTES)
            return undefined;
        await this.flush();
        if (root !== this.getRoot())
            throw new Error("IDE user or project changed while opening the patch.");
        try {
            const directory = await this.directory(root);
            const handle = await fs.promises.open(path.join(directory, `${ref.id}.patch`), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > exports.MAX_PATCH_BYTES)
                    return undefined;
                const buffer = Buffer.alloc(stat.size);
                let offset = 0;
                while (offset < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
                    if (!bytesRead)
                        break;
                    offset += bytesRead;
                }
                if (offset !== buffer.length || crypto.createHash("sha256").update(buffer).digest("hex") !== ref.id)
                    return undefined;
                const text = buffer.toString("utf8");
                if (root !== this.getRoot())
                    throw new Error("IDE user or project changed while opening the patch.");
                if (ref.start + ref.length > text.length)
                    return undefined;
                return { text: text.slice(ref.start, ref.start + Math.min(ref.length, 1900000)), truncated: ref.length > 1900000 };
            }
            finally {
                await handle.close();
            }
        }
        catch {
            if (root !== this.getRoot())
                throw new Error("IDE user or project changed while opening the patch.");
            return undefined;
        }
    }
    async directory(root) {
        const directory = path.join(root, "patches");
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const [realRoot, realDirectory, stat] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(directory), fs.promises.lstat(directory)]);
        if (stat.isSymbolicLink() || realDirectory !== path.join(realRoot, "patches"))
            throw new Error("Unsafe patch directory.");
        return directory;
    }
    async drain() {
        while (this.pending.size) {
            const [key, record] = this.pending.entries().next().value;
            this.pending.delete(key);
            this.queuedBytes -= record.bytes;
            let temp;
            try {
                const directory = await this.directory(record.root);
                temp = path.join(directory, `${record.id}.${crypto.randomUUID()}.tmp`);
                await fs.promises.writeFile(temp, record.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
                await fs.promises.rename(temp, path.join(directory, `${record.id}.patch`));
                temp = undefined;
                this.metrics.written++;
                await this.prune(directory, record.id);
            }
            catch {
                this.metrics.failures++;
                if (Date.now() - this.lastWarning > 60000) {
                    this.lastWarning = Date.now();
                    this.logger.warn("A full patch could not be recorded; bounded transcript previews remain available.");
                }
            }
            finally {
                if (temp)
                    await fs.promises.unlink(temp).catch(() => undefined);
            }
        }
    }
    async prune(directory, keepId) {
        const entries = [];
        const stream = await fs.promises.opendir(directory);
        let bytes = 0;
        for await (const entry of stream) {
            if (!entry.isFile() || !/^[a-f0-9]{64}\.patch$/.test(entry.name))
                continue;
            const stat = await fs.promises.lstat(path.join(directory, entry.name));
            if (!stat.isFile())
                continue;
            entries.push({ name: entry.name, size: stat.size, time: stat.mtimeMs });
            bytes += stat.size;
            // Only this private, content-addressed cache is pruned; never history or project files.
            if (entries.length >= 2048)
                break;
        }
        entries.sort((a, b) => a.time - b.time);
        let count = entries.length;
        for (const entry of entries) {
            if (bytes <= MAX_DISK_BYTES && count <= MAX_DISK_FILES)
                break;
            if (entry.name === `${keepId}.patch`)
                continue;
            await fs.promises.unlink(path.join(directory, entry.name));
            bytes -= entry.size;
            count--;
            this.metrics.evicted++;
        }
    }
}
exports.DiffPatchStore = DiffPatchStore;
//# sourceMappingURL=diffPatchStore.js.map