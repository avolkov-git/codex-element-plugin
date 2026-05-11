"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeProcessManager = void 0;
const child_process_1 = require("child_process");
class RuntimeProcessManager {
    constructor() {
        this.child = null;
    }
    get pid() {
        return this.child?.pid ?? null;
    }
    get isRunning() {
        return Boolean(this.child && !this.child.killed);
    }
    start(options) {
        if (this.child && !this.child.killed) {
            throw new Error("Codex backend уже запущен.");
        }
        const child = (0, child_process_1.spawn)(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            stdio: "pipe"
        });
        this.child = child;
        let exitHandled = false;
        const handleExit = (code, signal) => {
            if (exitHandled) {
                return;
            }
            exitHandled = true;
            this.child = null;
            options.onExit(code, signal);
        };
        wireLineStream(child.stdout, options.onStdout);
        wireLineStream(child.stderr, options.onStderr);
        child.once("error", (error) => {
            options.onStderr(error.message);
            handleExit(null, null);
        });
        child.once("exit", (code, signal) => {
            handleExit(code, signal);
        });
        return child.pid ?? 0;
    }
    writeLine(line) {
        const child = this.child;
        if (!child || child.killed || child.stdin.destroyed) {
            throw new Error("Codex backend не запущен.");
        }
        child.stdin.write(`${line}\n`);
    }
    async stop(timeoutMs = 5000) {
        const child = this.child;
        if (!child || child.killed) {
            this.child = null;
            return;
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (!child.killed) {
                    child.kill("SIGKILL");
                }
                resolve();
            }, timeoutMs);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill();
        });
    }
    dispose() {
        if (this.child && !this.child.killed) {
            this.child.kill();
        }
        this.child = null;
    }
}
exports.RuntimeProcessManager = RuntimeProcessManager;
function wireLineStream(stream, onLine) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim()) {
                onLine(line);
            }
        }
    });
    stream.on("end", () => {
        if (buffer.trim()) {
            onLine(buffer);
        }
    });
}
//# sourceMappingURL=runtimeProcessManager.js.map