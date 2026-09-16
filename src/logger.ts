import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 5;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_QUEUE_LINES = 512;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_BATCH_LINES = 128;
const MAX_LINE_BYTES = 8 * 1024;
const BATCH_INTERVAL_MS = 200;

type Level = "info" | "warn" | "error";
type Counts = Record<Level, number>;

interface LogFile {
  path: string;
  size?: number;
}

interface Destination {
  directory: string;
  ready: boolean;
  plugin: LogFile;
  runtime: LogFile;
}

interface QueuedLine {
  sequence: number;
  level: Level;
  text: string;
  bytes: number;
  destination?: Destination;
  runtime: boolean;
}

export interface LoggerMetrics {
  /** Records shared by the output/file sinks, not duplicated runtime deliveries. */
  queueBytes: number;
  queueLines: number;
  inflightBytes: number;
  inflightLines: number;
  /** At most one asynchronous batch, in addition to the bounded pending queue. */
  inflight: number;
  batches: number;
  outputBatches: number;
  fileWrites: number;
  /** Queue shedding/eviction only. Even error records can be dropped. */
  drops: Counts;
  oversizedLines: number;
  fileErrors: number;
  outputErrors: number;
  /** Failed deliveries; a runtime record has two file deliveries. */
  fileDroppedLines: number;
  outputDroppedLines: number;
}

export class Logger {
  private readonly output = vscode.window.createOutputChannel("Codex");
  private destination: Destination | undefined;
  private readonly queue: QueuedLine[] = [];
  private queueBytes = 0;
  private sequence = 0;
  private timer: NodeJS.Timeout | undefined;
  private writer: Promise<void> | undefined;
  private flushing: Promise<void> | undefined;
  private flushSequence = 0;
  private flushDrops = 0;
  private exporting: Promise<string | undefined> | undefined;
  private exportActive = false;
  private closing = false;
  private disposed: Promise<void> | undefined;
  private pendingDrops: Counts = { info: 0, warn: 0, error: 0 };
  private totalDrops = 0;
  private reportedDrops = 0;
  private pendingFileErrors = 0;
  private lastFileError = "";
  private unreportedFailure: string | undefined;
  private readonly metrics: LoggerMetrics = {
    queueBytes: 0, queueLines: 0, inflightBytes: 0, inflightLines: 0, inflight: 0,
    batches: 0, outputBatches: 0, fileWrites: 0,
    drops: { info: 0, warn: 0, error: 0 }, oversizedLines: 0,
    fileErrors: 0, outputErrors: 0, fileDroppedLines: 0, outputDroppedLines: 0
  };

  enableFileLogging(logDirectory: string): void {
    if (this.closing || this.destination?.directory === logDirectory) { return; }
    this.destination = {
      directory: logDirectory, ready: false,
      plugin: { path: path.join(logDirectory, "plugin.log") },
      runtime: { path: path.join(logDirectory, "runtime.log") }
    };
    // Directory creation and size discovery happen once, on the asynchronous writer.
    this.info("File logging enabled.");
  }

  info(message: string): void {
    this.append("info", message);
  }

  warn(message: string): void {
    this.append("warn", message);
  }

  error(message: string): void {
    this.append("error", message);
  }

  runtime(level: Level, message: string): void {
    this.append(level, message, true);
  }

  show(): void {
    if (!this.closing) { this.output.show(); }
  }

  getMetrics(): LoggerMetrics {
    return {
      ...this.metrics, queueBytes: this.queueBytes, queueLines: this.queue.length,
      drops: { ...this.metrics.drops }
    };
  }

  /**
   * Attempt all records accepted before this call (concurrent flushes coalesce).
   * Later traffic does not keep a flush alive. Shedding is reported in metrics;
   * sink failures since the previous explicit flush reject with sanitized errors.
   * Explicit flushes bypass normal batching delays; do not call per notification.
   * This is an append barrier, not fsync or a lossless-delivery guarantee.
   */
  flush(): Promise<void> {
    if (this.disposed) { return this.disposed; }
    if (this.exporting) {
      return this.exporting.then(() => this.flushPending(), () => this.flushPending());
    }
    return this.flushPending();
  }

  async openLogFolder(): Promise<void> {
    const logDirectory = this.destination?.directory;
    if (!logDirectory) {
      vscode.window.showWarningMessage("Файловые логи Codex пока не настроены.");
      return;
    }
    try {
      await fs.promises.mkdir(logDirectory, { recursive: true });
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(logDirectory));
    } catch (error) {
      throw new Error(describeFailure("open log folder", error));
    }
  }

  exportLogsToWorkspace(): Promise<string | undefined> {
    if (this.exporting) { return this.exporting; }
    const sourceDirectory = this.destination?.directory;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!sourceDirectory || !workspaceRoot) {
      return Promise.resolve(undefined);
    }
    this.exportActive = true;
    this.clearTimer();
    this.exporting = this.copyLogs(sourceDirectory, workspaceRoot).finally(() => {
      this.exporting = undefined;
      this.exportActive = false;
      this.schedule();
    });
    return this.exporting;
  }

  dispose(): void {
    if (this.closing) { return; }
    this.closing = true;
    this.clearTimer();
    const drained = this.flush();
    this.disposed = drained.finally(() => {
      try {
        this.output.dispose();
      } catch (error) {
        this.metrics.outputErrors += 1;
        throw new Error(describeFailure("dispose output channel", error));
      }
    });
    // VS Code's Disposable API is synchronous. Shutdown can await flush() instead.
    void this.disposed.catch(() => undefined);
  }

  private append(level: Level, message: string, runtime = false): void {
    if (this.closing) { return; }
    // Reserve a quarter of the queue for warnings/errors. Do not even format a
    // repetitive info flood once under pressure, or retain samples of dropped text.
    if (level === "info" && (this.queueBytes >= MAX_QUEUE_BYTES * 0.75 || this.queue.length >= MAX_QUEUE_LINES * 0.75)) {
      this.drop(level);
      this.schedule();
      return;
    }
    const formatted = boundedLine(level, message);
    if (formatted.oversized) { this.metrics.oversizedLines += 1; }
    const entry: QueuedLine = {
      sequence: ++this.sequence, level, text: formatted.text,
      bytes: Buffer.byteLength(formatted.text), destination: this.destination, runtime
    };
    while (this.queue.length >= MAX_QUEUE_LINES || this.queueBytes + entry.bytes > MAX_QUEUE_BYTES) {
      let victim = this.queue.findIndex((line) => line.level === "info");
      if (victim < 0 && level === "error") {
        victim = this.queue.findIndex((line) => line.level === "warn");
        // Under an error-only flood, retain recent errors, not an unbounded backlog.
        if (victim < 0) { victim = 0; }
      }
      if (victim < 0 || level === "info") {
        this.drop(level);
        this.schedule();
        return;
      }
      const [removed] = this.queue.splice(victim, 1);
      this.queueBytes -= removed.bytes;
      this.drop(removed.level);
    }
    this.queue.push(entry);
    this.queueBytes += entry.bytes;
    this.schedule();
  }

  private drop(level: Level): void {
    this.metrics.drops[level] += 1;
    this.pendingDrops[level] += 1;
    this.totalDrops += 1;
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private schedule(): void {
    if (this.closing || this.timer || this.writer || this.flushing || this.exportActive) { return; }
    if (!this.queue.length && !this.pendingFileErrors && this.reportedDrops === this.totalDrops) { return; }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.startBatch();
    }, BATCH_INTERVAL_MS);
    this.timer.unref();
  }

  private flushPending(): Promise<void> {
    this.flushSequence = this.sequence;
    this.flushDrops = this.totalDrops;
    this.clearTimer();
    if (!this.flushing) { this.flushing = this.drain(); }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    try {
      // Wait for an existing batch too, even when it already emptied the queue.
      do {
        await this.startBatch(this.flushSequence);
      } while ((this.queue[0]?.sequence ?? Infinity) <= this.flushSequence ||
        this.reportedDrops < this.flushDrops || this.pendingFileErrors > 0);
      const failure = this.unreportedFailure;
      this.unreportedFailure = undefined;
      if (failure) { throw new Error(failure); }
    } finally {
      // Release synchronously with the final boundary check, not in a later
      // promise callback that could swallow a newly extended flush boundary.
      this.flushing = undefined;
      this.schedule();
    }
  }

  private startBatch(through = Infinity): Promise<void> {
    if (this.writer) { return this.writer; }
    this.writer = this.writeBatch(through).finally(() => {
      this.writer = undefined;
      this.schedule();
    });
    return this.writer;
  }

  private async writeBatch(through: number): Promise<void> {
    const output: string[] = [];
    const plugin: string[] = [];
    const runtime: string[] = [];
    const destination = this.queue[0]?.sequence <= through ? this.queue[0].destination : this.destination;
    let bytes = 0;
    const include = (text: string, file: boolean, isRuntime: boolean): void => {
      output.push(text);
      bytes += Buffer.byteLength(text);
      if (file && destination) {
        plugin.push(text);
        if (isRuntime) { runtime.push(text); }
      }
    };
    if (this.pendingFileErrors) {
      // Diagnostics go ONLY to output, never back into a failing file sink.
      include(formatLine("warn", `${this.lastFileError} Failed file operations: ${this.pendingFileErrors}.`), false, false);
      this.pendingFileErrors = 0;
    }
    if (this.reportedDrops < (through === Infinity ? this.totalDrops : this.flushDrops)) {
      const drops = this.pendingDrops;
      include(formatLine("warn", `Logger queue dropped records: info=${drops.info}, warn=${drops.warn}, error=${drops.error}.`), true, true);
      this.pendingDrops = { info: 0, warn: 0, error: 0 };
      this.reportedDrops = this.totalDrops;
    }
    while (this.queue.length && output.length < MAX_BATCH_LINES) {
      const entry = this.queue[0];
      if (entry.sequence > through || entry.destination !== destination || bytes + entry.bytes > MAX_BATCH_BYTES) { break; }
      this.queue.shift();
      this.queueBytes -= entry.bytes;
      include(entry.text, true, entry.runtime);
    }
    if (!output.length) { return; }
    this.metrics.inflight = 1;
    this.metrics.inflightBytes = bytes;
    this.metrics.inflightLines = output.length;
    this.metrics.batches += 1;
    this.metrics.outputBatches += 1;
    try {
      try {
        this.output.append(output.join(""));
      } catch (error) {
        this.metrics.outputErrors += 1;
        this.metrics.outputDroppedLines += output.length;
        this.unreportedFailure ??= describeFailure("append output channel", error);
      }
      if (!destination || !plugin.length) { return; }
      if (!destination.ready) {
        try {
          await fs.promises.mkdir(destination.directory, { recursive: true });
          destination.ready = true;
        } catch (error) {
          this.fileFailure("create log directory", error, plugin.length + runtime.length);
          return;
        }
      }
      await this.writeFile(destination, "plugin", plugin);
      if (runtime.length) { await this.writeFile(destination, "runtime", runtime); }
    } finally {
      this.metrics.inflight = 0;
      this.metrics.inflightBytes = 0;
      this.metrics.inflightLines = 0;
    }
  }

  private async writeFile(destination: Destination, name: "plugin" | "runtime", lines: string[]): Promise<void> {
    const file = destination[name];
    const data = lines.join("");
    const bytes = Buffer.byteLength(data);
    let operation = `stat ${name}.log`;
    try {
      if (file.size === undefined) {
        try {
          file.size = (await fs.promises.stat(file.path)).size;
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") { throw error; }
          file.size = 0;
        }
      }
      if (file.size + bytes > MAX_LOG_BYTES) {
        operation = `rotate ${name}.log`;
        await rotate(file.path);
        file.size = 0;
      }
      operation = `append ${name}.log`;
      this.metrics.fileWrites += 1;
      await fs.promises.appendFile(file.path, data, "utf8");
      file.size += bytes;
    } catch (error) {
      file.size = undefined;
      if (isNodeError(error) && error.code === "ENOENT") { destination.ready = false; }
      this.fileFailure(operation, error, lines.length);
    }
  }

  private fileFailure(operation: string, error: unknown, lines: number): void {
    this.metrics.fileErrors += 1;
    this.metrics.fileDroppedLines += lines;
    this.pendingFileErrors += 1;
    this.lastFileError = describeFailure(operation, error);
    this.unreportedFailure ??= this.lastFileError;
  }

  private async copyLogs(sourceDirectory: string, workspaceRoot: string): Promise<string> {
    await this.flushPending();
    const targetDirectory = path.join(workspaceRoot, ".local-codex", "logs");
    try {
      // The writer stays paused throughout enumeration/copy, including rotation.
      // New traffic remains in the same bounded queue until export finishes.
      await fs.promises.mkdir(targetDirectory, { recursive: true });
      const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
      const logFiles = entries
        .filter((entry) => entry.isFile() && /^(plugin|runtime)\.log(\.\d+)?$/.test(entry.name))
        .map((entry) => entry.name);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const fileName of logFiles) {
        await fs.promises.copyFile(
          path.join(sourceDirectory, fileName),
          path.join(targetDirectory, `${stamp}-${fileName}`)
        );
      }
      return targetDirectory;
    } catch (error) {
      throw new Error(describeFailure("export logs", error));
    }
  }
}

export function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(https?:\/\/)[^\s/]*@/gi, "$1***:***@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 ***")
    .replace(/((?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&]+)/gi, "$1***");
}

function formatLine(level: Level, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}\n`;
}

function boundedLine(level: Level, message: string): { text: string; oversized: boolean } {
  // Omit oversized input wholesale: slicing before redaction could expose a
  // credential crossing the cutoff, and scanning a giant input blocks the host.
  if (message.length <= MAX_LINE_BYTES) {
    const text = formatLine(level, redact(message).replace(/[\r\n\u2028\u2029]/g, "\\n"));
    if (Buffer.byteLength(text) <= MAX_LINE_BYTES) { return { text, oversized: false }; }
  }
  return { text: formatLine(level, `[oversized message omitted: ${message.length} UTF-16 units]`), oversized: true };
}

async function rotate(filePath: string): Promise<void> {
  for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
    await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
  }
  await renameIfExists(filePath, `${filePath}.1`);
}

async function renameIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(source, target);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function describeFailure(operation: string, error: unknown): string {
  // Never include error.message, paths, causes or arbitrary error codes here.
  const hints: Record<string, string> = {
    EACCES: "Check log folder permissions.", EPERM: "Check permissions or file locks.",
    ENOSPC: "Free disk space.", EDQUOT: "Check the disk quota.", EROFS: "Choose a writable log folder.",
    ENOENT: "Check that the log folder still exists.", ENOTDIR: "Check the log folder configuration.",
    EISDIR: "A log file path is a directory.", EMFILE: "Too many open files.",
    ENFILE: "The system file limit was reached.", EIO: "Check storage availability."
  };
  const code = isNodeError(error) && error.code && Object.prototype.hasOwnProperty.call(hints, error.code) ? error.code : "UNKNOWN";
  return `Logger ${operation} failed (${code}). ${hints[code] ?? "Check log storage and output channel availability."}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
