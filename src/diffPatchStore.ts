import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import type { ChatDiffFileSummary } from "./types";

export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_DIFF_PREVIEW_CHARS = 2048;
const MAX_PREVIEW_TOTAL = 128 * 1024;
const MAX_FILES = 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_DISK_BYTES = 256 * 1024 * 1024;
const MAX_DISK_FILES = 128;
const HASH = /^[a-f0-9]{64}$/;
interface ParsedFile extends ChatDiffFileSummary { start: number; length: number }
interface PendingPatch { root: string; id: string; text: string; bytes: number }
const digest = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
const detached = (text: string): string => Buffer.from(text, "utf8").toString("utf8");

/** Scan once; retain bounded previews and ranges, never per-line copies of the complete patch. */
function parsePatch(text: string): ParsedFile[] {
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) throw new Error("Patch exceeds the 8 MiB recording limit.");
  const files: ParsedFile[] = [];
  let current: ParsedFile | undefined;
  let previewLeft = MAX_PREVIEW_TOTAL;
  let omitted = 0;
  const finish = (end: number): void => {
    if (!current) return;
    current.length = end - current.start;
    const chars = Math.min(MAX_DIFF_PREVIEW_CHARS, previewLeft, current.length);
    current.diff = detached(text.slice(current.start, current.start + chars));
    current.path = detached(current.path);
    if (current.oldPath) current.oldPath = detached(current.oldPath);
    if (current.newPath) current.newPath = detached(current.newPath);
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
      } else {
        if (!omitted) {
          finish(offset);
          current = { path: "[Additional files: preview limit reached]", status: "unknown", additions: 0, deletions: 0, start: offset, length: 0 };
        }
        omitted++;
      }
    } else {
      current ??= { path: "changes.patch", status: "unknown", additions: 0, deletions: 0, start: offset, length: 0 };
      if (!omitted) {
        if (line === "--- /dev/null" || line.startsWith("new file mode ")) current.status = "added";
        else if (line === "+++ /dev/null" || line.startsWith("deleted file mode ")) current.status = "deleted";
        else if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = line.slice(12, 4108); }
        else if (line.startsWith("rename to ")) { current.status = "renamed"; current.path = current.newPath = line.slice(10, 4106); }
        else if (line.startsWith("--- a/")) { current.oldPath = line.slice(6, 4102); if (current.path === "changes.patch") current.path = current.oldPath; }
        else if (line.startsWith("+++ b/")) current.path = current.newPath = line.slice(6, 4102);
      }
      if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
      if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
    }
    offset = end;
  }
  finish(text.length);
  return files;
}

export function summarizePatch(text: string): ChatDiffFileSummary[] {
  return parsePatch(text).map(({ start: _start, length: _length, ...file }) => file);
}

export function patchFromChanges(value: unknown): string {
  const changes = value && typeof value === "object" && "changes" in value ? (value as { changes: unknown }).changes : undefined;
  if (!Array.isArray(changes)) return "";
  const chunks: string[] = [];
  let bytes = 0;
  for (const change of changes) {
    if (!change || typeof change !== "object" || typeof change.diff !== "string") continue;
    const name = typeof change.path === "string" ? change.path.replace(/[\r\n]/g, "_").slice(0, 4096) : "changes.patch";
    const mode = change.status === "added" ? "new file mode 100644\n" : change.status === "deleted" ? "deleted file mode 100644\n" : "";
    const chunk = `${/^diff --git /m.test(change.diff) ? "" : `diff --git a/${name} b/${name}\n${mode}`}${change.diff}\n`;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_PATCH_BYTES) throw new Error("Patch exceeds the 8 MiB recording limit.");
    chunks.push(chunk);
  }
  return chunks.join("");
}

/** Private, scoped, evictable recordings; failures never prevent the runtime from completing a turn. */
export class DiffPatchStore {
  private readonly pending = new Map<string, PendingPatch>();
  private running: Promise<void> | undefined;
  private queuedBytes = 0;
  private closed = false;
  private lastWarning = 0;
  private readonly metrics = { updates: 0, maxPatchBytes: 0, maxParseMs: 0, written: 0, coalesced: 0, skipped: 0, failures: 0, evicted: 0 };

  constructor(private readonly getRoot: () => string | undefined, private readonly logger: { warn(message: string): void }) {}

  capture(text: string, slot: string): ChatDiffFileSummary[] {
    const started = performance.now();
    const parsed = parsePatch(text);
    const bytes = Buffer.byteLength(text);
    this.metrics.updates++;
    this.metrics.maxPatchBytes = Math.max(this.metrics.maxPatchBytes, bytes);
    this.metrics.maxParseMs = Math.max(this.metrics.maxParseMs, performance.now() - started);
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
    if (previous) { this.metrics.coalesced++; this.queuedBytes -= previous.bytes; }
    this.pending.set(key, { root, id, text, bytes });
    this.queuedBytes += bytes;
    this.startDrain();
    return parsed.map(({ start, length, ...file }) => ({ ...file, patchArtifact: { id, scope, start, length } }));
  }

  getMetrics(): object { return { ...this.metrics, queuedBytes: this.queuedBytes, queuedPatches: this.pending.size, writing: Boolean(this.running) }; }

  async flush(): Promise<void> { while (this.running) await this.running; }
  dispose(): void { this.closed = true; }

  private startDrain(): void {
    if (!this.running && this.pending.size) this.running = this.drain().finally(() => {
      this.running = undefined;
      this.startDrain();
    });
  }

  async read(file: ChatDiffFileSummary): Promise<{ text: string; truncated: boolean } | undefined> {
    const ref = file.patchArtifact;
    const root = this.getRoot();
    if (!root || !ref || !HASH.test(ref.id) || ref.scope !== digest(root)
      || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.length) || ref.start < 0 || ref.length < 0
      || ref.start + ref.length > MAX_PATCH_BYTES) return undefined;
    await this.flush();
    if (root !== this.getRoot()) throw new Error("IDE user or project changed while opening the patch.");
    try {
      const directory = await this.directory(root);
      const handle = await fs.promises.open(path.join(directory, `${ref.id}.patch`), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) return undefined;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== buffer.length || crypto.createHash("sha256").update(buffer).digest("hex") !== ref.id) return undefined;
        const text = buffer.toString("utf8");
        if (root !== this.getRoot()) throw new Error("IDE user or project changed while opening the patch.");
        if (ref.start + ref.length > text.length) return undefined;
        return { text: text.slice(ref.start, ref.start + Math.min(ref.length, 1_900_000)), truncated: ref.length > 1_900_000 };
      } finally { await handle.close(); }
    } catch {
      if (root !== this.getRoot()) throw new Error("IDE user or project changed while opening the patch.");
      return undefined;
    }
  }

  private async directory(root: string): Promise<string> {
    const directory = path.join(root, "patches");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const [realRoot, realDirectory, stat] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(directory), fs.promises.lstat(directory)]);
    if (stat.isSymbolicLink() || realDirectory !== path.join(realRoot, "patches")) throw new Error("Unsafe patch directory.");
    return directory;
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const [key, record] = this.pending.entries().next().value!;
      this.pending.delete(key);
      this.queuedBytes -= record.bytes;
      let temp: string | undefined;
      try {
        const directory = await this.directory(record.root);
        temp = path.join(directory, `${record.id}.${crypto.randomUUID()}.tmp`);
        await fs.promises.writeFile(temp, record.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.promises.rename(temp, path.join(directory, `${record.id}.patch`));
        temp = undefined;
        this.metrics.written++;
        await this.prune(directory, record.id);
      } catch {
        this.metrics.failures++;
        if (Date.now() - this.lastWarning > 60_000) {
          this.lastWarning = Date.now();
          this.logger.warn("A full patch could not be recorded; bounded transcript previews remain available.");
        }
      } finally { if (temp) await fs.promises.unlink(temp).catch(() => undefined); }
    }
  }

  private async prune(directory: string, keepId: string): Promise<void> {
    const entries: Array<{ name: string; size: number; time: number }> = [];
    const stream = await fs.promises.opendir(directory);
    let bytes = 0;
    for await (const entry of stream) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.patch$/.test(entry.name)) continue;
      const stat = await fs.promises.lstat(path.join(directory, entry.name));
      if (!stat.isFile()) continue;
      entries.push({ name: entry.name, size: stat.size, time: stat.mtimeMs });
      bytes += stat.size;
      // Only this private, content-addressed cache is pruned; never history or project files.
      if (entries.length >= 2048) break;
    }
    entries.sort((a, b) => a.time - b.time);
    let count = entries.length;
    for (const entry of entries) {
      if (bytes <= MAX_DISK_BYTES && count <= MAX_DISK_FILES) break;
      if (entry.name === `${keepId}.patch`) continue;
      await fs.promises.unlink(path.join(directory, entry.name));
      bytes -= entry.size; count--; this.metrics.evicted++;
    }
  }
}
