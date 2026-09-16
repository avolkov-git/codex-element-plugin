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
exports.RuntimeProcessManager = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const DEFAULT_BUFFER_LIMIT = 8 * 1024 * 1024;
const FORCE_EXIT_TIMEOUT_MS = 3000;
class RuntimeProcessManager {
    constructor() {
        this.generation = 0;
        this.disposed = false;
    }
    get pid() {
        return this.current?.child.pid ?? null;
    }
    get isRunning() {
        return Boolean(this.current && !this.current.exited);
    }
    start(options) {
        if (this.disposed) {
            throw new Error("Codex backend process manager disposed.");
        }
        if (this.current) {
            throw new Error("Codex backend is running or its process tree is still stopping.");
        }
        const child = (0, child_process_1.spawn)(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            // A private POSIX process group limits cleanup to descendants we own.
            detached: process.platform !== "win32",
            stdio: "pipe"
        });
        const record = {
            child,
            options,
            generation: ++this.generation,
            exited: false,
            closed: new Promise((resolve) => child.once("close", () => resolve()))
        };
        this.current = record;
        let exitReported = false;
        let failureReported = false;
        const fail = (error) => {
            if (failureReported || this.current !== record) {
                return;
            }
            failureReported = true;
            options.onError?.(error);
            void this.stopRecord(record, 0).catch((stopError) => options.onError?.(stopError));
        };
        const handleExit = (code, signal) => {
            if (exitReported) {
                return;
            }
            exitReported = true;
            record.exited = true;
            if (this.current === record && this.generation === record.generation) {
                options.onExit(code, signal);
            }
            // Unexpected root exits must not leave inherited MCP/browser children.
            void this.stopRecord(record, 0).catch((error) => options.onError?.(error));
        };
        const lineLimit = positiveLimit(options.maxLineBytes, DEFAULT_BUFFER_LIMIT);
        wireLineStream(child.stdout, options.onStdout, fail, lineLimit);
        wireLineStream(child.stderr, options.onStderr, fail, lineLimit);
        child.stdin.on("error", fail);
        child.on("error", (error) => {
            fail(error);
            // A failed kill is not an exit. Only a spawn failure has no PID.
            if (!child.pid) {
                handleExit(null, null);
            }
        });
        child.once("exit", handleExit);
        return child.pid ?? 0;
    }
    writeLine(line) {
        const record = this.current;
        if (!record || record.exited || record.stopPromise || record.child.stdin.destroyed || record.child.stdin.writableEnded) {
            throw new Error("Codex backend is not accepting input.");
        }
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        if (bytes > positiveLimit(record.options.maxLineBytes, DEFAULT_BUFFER_LIMIT) || line.includes("\n")) {
            throw new Error("Codex backend input exceeds the protocol line limit.");
        }
        // write(false) still queues data in Node. Bound it; never drop accepted RPCs.
        if (record.child.stdin.writableLength + bytes > positiveLimit(record.options.maxPendingWriteBytes, DEFAULT_BUFFER_LIMIT)) {
            throw new Error("Codex backend input backpressure limit reached; request was not sent.");
        }
        record.child.stdin.write(`${line}\n`);
    }
    stop(timeoutMs = 5000) {
        return this.current ? this.stopRecord(this.current, timeoutMs) : Promise.resolve();
    }
    dispose() {
        this.disposed = true;
        const record = this.current;
        if (record) {
            void this.stopRecord(record, 0).catch((error) => record.options.onError?.(error));
        }
    }
    stopRecord(record, timeoutMs) {
        if (record.stopPromise) {
            return record.stopPromise;
        }
        const stopping = Promise.resolve().then(async () => {
            const pid = record.child.pid;
            if (pid) {
                if (process.platform === "win32") {
                    await killWindowsTree(pid, record);
                }
                else {
                    signalOwnedGroup(pid, "SIGTERM");
                    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 60000)) : 5000);
                    while (Date.now() < deadline && await isOwnedGroupAlive(pid)) {
                        await delay(25);
                    }
                    if (await isOwnedGroupAlive(pid)) {
                        signalOwnedGroup(pid, "SIGKILL");
                    }
                    const forceDeadline = Date.now() + FORCE_EXIT_TIMEOUT_MS;
                    while (await isOwnedGroupAlive(pid)) {
                        if (Date.now() >= forceDeadline) {
                            throw new Error(`Codex process group ${pid} did not exit after SIGKILL.`);
                        }
                        await delay(25);
                    }
                }
            }
            await withTimeout(record.closed, FORCE_EXIT_TIMEOUT_MS, "Codex subprocess did not close after tree termination.");
            if (this.current === record && this.generation === record.generation) {
                this.current = undefined;
            }
        });
        record.stopPromise = stopping;
        // A failure retains ownership and allows an explicit termination retry.
        void stopping.catch(() => {
            if (record.stopPromise === stopping) {
                record.stopPromise = undefined;
            }
        });
        return stopping;
    }
}
exports.RuntimeProcessManager = RuntimeProcessManager;
function signalOwnedGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    }
    catch (error) {
        if (error.code !== "ESRCH") {
            throw error;
        }
    }
}
async function isOwnedGroupAlive(pid) {
    try {
        process.kill(-pid, 0);
    }
    catch (error) {
        if (error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
    // Orphaned zombies cannot run, but can await the host's init reaper.
    return new Promise((resolve) => {
        (0, child_process_1.execFile)("ps", ["-eo", "pgid=,stat="], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                resolve(true);
                return;
            }
            resolve(stdout.split("\n").some((line) => {
                const [group, status] = line.trim().split(/\s+/);
                return Number(group) === pid && Boolean(status) && !status.startsWith("Z");
            }));
        });
    });
}
function killWindowsTree(pid, record) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    return new Promise((resolve, reject) => {
        // No executable-name/global kill: /T is rooted at this exact owned PID.
        (0, child_process_1.execFile)(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            timeout: FORCE_EXIT_TIMEOUT_MS,
            maxBuffer: 64 * 1024
        }, (error) => {
            if (error && !record.exited) {
                reject(new Error(`Could not terminate owned Codex process tree ${pid}: ${error.message}`));
            }
            else {
                resolve();
            }
        });
    });
}
function positiveLimit(value, fallback) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withTimeout(promise, ms, message) {
    let timer;
    try {
        await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            })]);
    }
    finally {
        clearTimeout(timer);
    }
}
function wireLineStream(stream, onLine, onError, maxLineBytes) {
    let buffer = "";
    let bufferBytes = 0;
    let failed = false;
    let pending = Promise.resolve();
    const fail = (error) => {
        if (!failed) {
            failed = true;
            buffer = "";
            bufferBytes = 0;
            // An unread paused pipe can prevent child.close even after tree termination.
            stream.destroy();
            onError(error instanceof Error ? error : new Error(String(error)));
        }
    };
    stream.setEncoding("utf8");
    stream.on("error", fail);
    stream.on("data", (chunk) => {
        stream.pause();
        pending = pending.then(async () => {
            let offset = 0;
            let lines = 0;
            while (!failed && offset < chunk.length) {
                const newline = chunk.indexOf("\n", offset);
                const fragment = chunk.slice(offset, newline < 0 ? chunk.length : newline);
                const fragmentBytes = Buffer.byteLength(fragment, "utf8");
                if (bufferBytes + fragmentBytes > maxLineBytes) {
                    throw new Error(`Codex backend output exceeds ${maxLineBytes} bytes per line.`);
                }
                buffer += fragment;
                bufferBytes += fragmentBytes;
                if (newline < 0) {
                    break;
                }
                const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
                buffer = "";
                bufferBytes = 0;
                if (line.trim()) {
                    await onLine(line);
                }
                offset = newline + 1;
                if (++lines % 128 === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
            if (!failed) {
                stream.resume();
            }
        }).catch(fail);
    });
    stream.on("end", () => {
        void pending.then(async () => {
            if (!failed && buffer.trim()) {
                const line = buffer;
                buffer = "";
                await onLine(line);
            }
        }).catch(fail);
    });
}
//# sourceMappingURL=runtimeProcessManager.js.map