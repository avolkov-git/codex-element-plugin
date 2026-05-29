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
exports.Logger = void 0;
exports.redact = redact;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 5;
class Logger {
    constructor() {
        this.output = vscode.window.createOutputChannel("Codex");
        this.writeChain = Promise.resolve();
    }
    enableFileLogging(logDirectory) {
        this.logDirectory = logDirectory;
        this.pluginLogPath = path.join(logDirectory, "plugin.log");
        this.runtimeLogPath = path.join(logDirectory, "runtime.log");
        try {
            fs.mkdirSync(logDirectory, { recursive: true });
            this.info(`File logging enabled: ${logDirectory}.`);
        }
        catch (error) {
            this.warn(`File logging disabled: ${normalizeErrorMessage(error)}.`);
            this.logDirectory = undefined;
            this.pluginLogPath = undefined;
            this.runtimeLogPath = undefined;
        }
    }
    info(message) {
        this.append("info", message);
    }
    warn(message) {
        this.append("warn", message);
    }
    error(message) {
        this.append("error", message);
    }
    runtime(level, message) {
        const line = formatLine(level, message);
        this.output.appendLine(line);
        this.queueFileAppend(this.pluginLogPath, line);
        this.queueFileAppend(this.runtimeLogPath, line);
    }
    show() {
        this.output.show();
    }
    async openLogFolder() {
        const logDirectory = this.logDirectory;
        if (!logDirectory) {
            vscode.window.showWarningMessage("Файловые логи Codex пока не настроены.");
            return;
        }
        await fs.promises.mkdir(logDirectory, { recursive: true });
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(logDirectory));
    }
    async exportLogsToWorkspace() {
        const sourceDirectory = this.logDirectory;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!sourceDirectory || !workspaceRoot) {
            return undefined;
        }
        const targetDirectory = path.join(workspaceRoot, ".local-codex", "logs");
        await this.writeChain;
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
        const logFiles = entries
            .filter((entry) => entry.isFile() && /^(plugin|runtime)\.log(\.\d+)?$/.test(entry.name))
            .map((entry) => entry.name);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        for (const fileName of logFiles) {
            await fs.promises.copyFile(path.join(sourceDirectory, fileName), path.join(targetDirectory, `${stamp}-${fileName}`));
        }
        return targetDirectory;
    }
    dispose() {
        this.output.dispose();
    }
    append(level, message) {
        const line = formatLine(level, message);
        this.output.appendLine(line);
        this.queueFileAppend(this.pluginLogPath, line);
    }
    queueFileAppend(filePath, line) {
        if (!filePath) {
            return;
        }
        this.writeChain = this.writeChain
            .then(async () => {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await rotateIfNeeded(filePath);
            await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
        })
            .catch((error) => {
            this.output.appendLine(formatLine("warn", `File log write failed: ${normalizeErrorMessage(error)}.`));
        });
    }
}
exports.Logger = Logger;
function redact(value) {
    return value
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
        .replace(/(password|token|secret|api[_-]?key)=([^\s&]+)/gi, "$1=***")
        .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1***:***@");
}
function formatLine(level, message) {
    return `[${new Date().toISOString()}] [${level}] ${redact(message)}`;
}
async function rotateIfNeeded(filePath) {
    let stat;
    try {
        stat = await fs.promises.stat(filePath);
    }
    catch {
        return;
    }
    if (stat.size < MAX_LOG_BYTES) {
        return;
    }
    for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
        await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
    }
    await renameIfExists(filePath, `${filePath}.1`);
}
async function renameIfExists(source, target) {
    try {
        await fs.promises.rm(target, { force: true });
        await fs.promises.rename(source, target);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
}
function normalizeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=logger.js.map