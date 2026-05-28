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
exports.ripgrepExecutableName = ripgrepExecutableName;
exports.normalizeRipgrepInput = normalizeRipgrepInput;
exports.resolveRipgrepExecutablePath = resolveRipgrepExecutablePath;
exports.probeRipgrepExecutable = probeRipgrepExecutable;
exports.discoverRipgrepCandidates = discoverRipgrepCandidates;
exports.buildRipgrepEnvPatch = buildRipgrepEnvPatch;
exports.buildRipgrepEnvPatchResult = buildRipgrepEnvPatchResult;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const WINDOWS_SAFE_PATH_LENGTH = 30000;
function ripgrepExecutableName() {
    return process.platform === "win32" ? "rg.exe" : "rg";
}
function normalizeRipgrepInput(input) {
    const trimmed = input.trim().replace(/^["']|["']$/g, "");
    if (!trimmed) {
        return "";
    }
    if (trimmed === "~") {
        return os.homedir();
    }
    if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return trimmed;
}
async function resolveRipgrepExecutablePath(input) {
    const normalized = normalizeRipgrepInput(input);
    if (!normalized) {
        return "";
    }
    try {
        const stat = await fs.promises.stat(normalized);
        if (stat.isDirectory()) {
            return path.join(normalized, ripgrepExecutableName());
        }
    }
    catch {
        // The caller will report a validation error after probing the candidate.
    }
    return normalized;
}
async function probeRipgrepExecutable(filePath, timeoutMs = 3000) {
    const resolved = normalizeRipgrepInput(filePath);
    if (!resolved) {
        return {
            ok: false,
            path: "",
            version: "",
            message: "Путь до rg не задан."
        };
    }
    try {
        const stat = await fs.promises.stat(resolved);
        if (!stat.isFile()) {
            return {
                ok: false,
                path: resolved,
                version: "",
                message: "Указанный путь не является файлом rg."
            };
        }
    }
    catch {
        return {
            ok: false,
            path: resolved,
            version: "",
            message: "Файл rg не найден."
        };
    }
    return new Promise((resolve) => {
        let settled = false;
        let output = "";
        const child = (0, child_process_1.spawn)(resolved, ["--version"], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish({
                ok: false,
                path: resolved,
                version: "",
                message: "Проверка rg --version превысила таймаут."
            });
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            output = `${output}${chunk}`.slice(0, 8000);
        });
        child.stderr.on("data", (chunk) => {
            output = `${output}${chunk}`.slice(0, 8000);
        });
        child.once("error", (error) => {
            finish({
                ok: false,
                path: resolved,
                version: "",
                message: error.message || "Не удалось запустить rg."
            });
        });
        child.once("close", (code) => {
            if (settled) {
                return;
            }
            const version = output.match(/ripgrep\s+([^\s]+)/i)?.[1] ?? "";
            if (code === 0 && version) {
                finish({
                    ok: true,
                    path: resolved,
                    version,
                    message: `rg найден, версия ${version}.`
                });
                return;
            }
            finish({
                ok: false,
                path: resolved,
                version: "",
                message: "Команда rg --version завершилась с ошибкой."
            });
        });
    });
}
function discoverRipgrepCandidates() {
    const candidates = [];
    const executable = ripgrepExecutableName();
    for (const dir of pathEnvEntries()) {
        candidates.push(path.join(dir, executable));
    }
    if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE || os.homedir();
        const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
        if (userProfile) {
            candidates.push(path.join(userProfile, ".cargo", "bin", "rg.exe"));
        }
        for (const root of programFiles) {
            candidates.push(path.join(root, "ripgrep", "rg.exe"), path.join(root, "Git", "usr", "bin", "rg.exe"));
        }
    }
    else {
        candidates.push(path.join(os.homedir(), ".cargo", "bin", "rg"), "/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg", "/bin/rg");
    }
    const seen = new Set();
    return candidates
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => {
        const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
        if (seen.has(key) || !fs.existsSync(candidate)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function buildRipgrepEnvPatch(ripgrepPath) {
    return buildRipgrepEnvPatchResult(ripgrepPath).env;
}
function buildRipgrepEnvPatchResult(ripgrepPath) {
    const resolved = normalizeRipgrepInput(ripgrepPath);
    if (!resolved) {
        return { env: {}, ripgrepPath: "", warning: "" };
    }
    const executable = resolveRipgrepExecutablePathSync(resolved);
    if (!executable) {
        return {
            env: {},
            ripgrepPath: resolved,
            warning: "Настроенный путь до rg пропущен при запуске runtime: файл не найден или путь не является файлом."
        };
    }
    if (!canExecuteRipgrep(executable)) {
        return {
            env: {},
            ripgrepPath: executable,
            warning: "Настроенный путь до rg пропущен при запуске runtime: файл не имеет права на выполнение."
        };
    }
    const dir = path.dirname(executable);
    const currentPath = process.env.Path || process.env.PATH || "";
    const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
    const normalizedDir = normalizePathForCompare(dir);
    const alreadyPresent = pathEntries.some((entry) => {
        return normalizePathForCompare(entry) === normalizedDir;
    });
    const env = {
        RIPGREP_PATH: executable
    };
    if (alreadyPresent) {
        return { env, ripgrepPath: executable, warning: "" };
    }
    const nextPath = [dir, ...pathEntries].join(path.delimiter);
    if (process.platform === "win32" && nextPath.length > WINDOWS_SAFE_PATH_LENGTH) {
        return {
            env,
            ripgrepPath: executable,
            warning: "Каталог rg не добавлен в PATH runtime: PATH слишком длинный. Авторизация и backend будут запущены без изменения PATH."
        };
    }
    const pathKey = runtimePathEnvKey();
    env[pathKey] = nextPath;
    return { env, ripgrepPath: executable, warning: "" };
}
function resolveRipgrepExecutablePathSync(input) {
    const normalized = normalizeRipgrepInput(input);
    if (!normalized) {
        return "";
    }
    try {
        const stat = fs.statSync(normalized);
        if (stat.isDirectory()) {
            const executable = path.join(normalized, ripgrepExecutableName());
            return fs.statSync(executable).isFile() ? executable : "";
        }
        return stat.isFile() ? normalized : "";
    }
    catch {
        return "";
    }
}
function canExecuteRipgrep(filePath) {
    if (process.platform === "win32") {
        return true;
    }
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function normalizePathForCompare(input) {
    const normalized = path.resolve(input);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function runtimePathEnvKey() {
    if (process.platform !== "win32") {
        return "PATH";
    }
    return Object.prototype.hasOwnProperty.call(process.env, "Path") ? "Path" : "PATH";
}
function pathEnvEntries() {
    const value = process.env.Path || process.env.PATH || "";
    return value
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
//# sourceMappingURL=ripgrepUtils.js.map