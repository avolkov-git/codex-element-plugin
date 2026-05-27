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
exports.RipgrepInstallerService = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const tls = __importStar(require("tls"));
const ripgrepUtils_1 = require("./ripgrepUtils");
const RIPGREP_RELEASE_URL = "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest";
const DOWNLOAD_LIMIT_BYTES = 120 * 1024 * 1024;
class RipgrepInstallerService {
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
    }
    async install(options) {
        const progress = (percent, stage, message) => {
            options.onProgress?.({ status: "running", percent, stage, message });
        };
        progress(5, "release", "Получаем информацию о последней версии ripgrep");
        const proxy = await this.settings.getRuntimeProxySettings();
        const release = await downloadJson(RIPGREP_RELEASE_URL, proxy);
        const version = normalizeReleaseVersion(release);
        const asset = selectAsset(release);
        if (!asset.browser_download_url || !asset.name) {
            throw new Error("Не удалось выбрать release asset ripgrep для текущей платформы.");
        }
        const toolsRoot = path.join(this.settings.getConfigRoot(), "server", "tools", "ripgrep");
        const platformRoot = path.join(toolsRoot, version, platformKey());
        const tempRoot = path.join(toolsRoot, `.tmp-${process.pid}-${Date.now()}`);
        const archivePath = path.join(tempRoot, asset.name);
        const extractRoot = path.join(tempRoot, "extract");
        await fs.promises.mkdir(extractRoot, { recursive: true });
        try {
            progress(20, "download", `Скачиваем ripgrep ${version}`);
            const archive = await downloadBuffer(asset.browser_download_url, proxy, DOWNLOAD_LIMIT_BYTES, {
                Accept: "application/octet-stream"
            });
            validateArchivePayload(archive, asset.name);
            await fs.promises.writeFile(archivePath, archive);
            progress(55, "extract", "Распаковываем ripgrep");
            await extractArchive(archivePath, extractRoot, asset.name);
            const executable = await findRipgrepExecutable(extractRoot);
            if (!executable) {
                throw new Error("В архиве ripgrep не найден исполняемый файл rg.");
            }
            progress(75, "install", "Устанавливаем ripgrep в каталог Codex Element");
            await fs.promises.rm(platformRoot, { recursive: true, force: true });
            await fs.promises.mkdir(platformRoot, { recursive: true });
            const finalPath = path.join(platformRoot, (0, ripgrepUtils_1.ripgrepExecutableName)());
            await fs.promises.copyFile(executable, finalPath);
            if (process.platform !== "win32") {
                await fs.promises.chmod(finalPath, 0o755);
            }
            progress(88, "verify", "Проверяем rg --version");
            const probe = await (0, ripgrepUtils_1.probeRipgrepExecutable)(finalPath);
            if (!probe.ok) {
                throw new Error(probe.message || "Установленный rg не прошел проверку.");
            }
            this.settings.saveInstalledRipgrepPath(finalPath, probe.version || version);
            options.onProgress?.({
                status: "completed",
                percent: 100,
                stage: "completed",
                message: `ripgrep установлен, версия ${probe.version || version}.`
            });
            this.logger.info(`ripgrep installed: version=${probe.version || version}; path=${finalPath}.`);
            return { path: finalPath, version: probe.version || version };
        }
        catch (error) {
            options.onProgress?.({
                status: "error",
                percent: 0,
                stage: "error",
                message: error instanceof Error ? error.message : "Не удалось установить ripgrep."
            });
            throw error;
        }
        finally {
            await fs.promises.rm(tempRoot, { recursive: true, force: true });
        }
    }
}
exports.RipgrepInstallerService = RipgrepInstallerService;
function normalizeReleaseVersion(release) {
    const raw = (release.tag_name || release.name || "latest").trim();
    return raw.replace(/^v/i, "") || "latest";
}
function selectAsset(release) {
    const assets = release.assets ?? [];
    const candidates = assetNamePatterns();
    for (const pattern of candidates) {
        const asset = assets.find((item) => item.name ? pattern.test(item.name) : false);
        if (asset) {
            return asset;
        }
    }
    return {};
}
function assetNamePatterns() {
    if (process.platform === "win32" && process.arch === "x64") {
        return [/x86_64-pc-windows-msvc\.zip$/i];
    }
    if (process.platform === "darwin" && process.arch === "arm64") {
        return [/aarch64-apple-darwin\.tar\.gz$/i];
    }
    if (process.platform === "darwin" && process.arch === "x64") {
        return [/x86_64-apple-darwin\.tar\.gz$/i];
    }
    if (process.platform === "linux" && process.arch === "x64") {
        return [/x86_64-unknown-linux-musl\.tar\.gz$/i, /x86_64-unknown-linux-gnu\.tar\.gz$/i];
    }
    if (process.platform === "linux" && process.arch === "arm64") {
        return [/aarch64-unknown-linux-musl\.tar\.gz$/i, /aarch64-unknown-linux-gnu\.tar\.gz$/i];
    }
    return [new RegExp(`${process.arch}.*${process.platform}.*\\.(zip|tar\\.gz)$`, "i")];
}
function platformKey() {
    return `${process.platform}-${process.arch}`;
}
async function extractArchive(archivePath, extractRoot, assetName) {
    if (assetName.toLowerCase().endsWith(".zip")) {
        await extractZipArchive(archivePath, extractRoot);
        return;
    }
    await runProcess("tar", ["-xzf", archivePath, "-C", extractRoot]);
}
async function extractZipArchive(archivePath, extractRoot) {
    await runProcess("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
            "& {",
            "param([string]$ArchivePath, [string]$ExtractRoot)",
            "$ErrorActionPreference = 'Stop';",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
            "if ([string]::IsNullOrWhiteSpace($ArchivePath)) { throw 'ArchivePath is empty.' }",
            "if ([string]::IsNullOrWhiteSpace($ExtractRoot)) { throw 'ExtractRoot is empty.' }",
            "if (!(Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw \"Archive not found: $ArchivePath\" }",
            "New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null;",
            "Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force",
            "}"
        ].join(" "),
        archivePath,
        extractRoot
    ]);
}
function validateArchivePayload(buffer, assetName) {
    const lower = assetName.toLowerCase();
    if (lower.endsWith(".zip") && isZipPayload(buffer)) {
        return;
    }
    if (lower.endsWith(".tar.gz") && isGzipPayload(buffer)) {
        return;
    }
    const expected = lower.endsWith(".zip") ? "zip" : lower.endsWith(".tar.gz") ? "tar.gz" : "архив";
    throw new Error(`Скачанный файл ripgrep не похож на ${expected}. Проверьте доступ к GitHub через proxy.${payloadPreview(buffer)}`);
}
function isZipPayload(buffer) {
    if (buffer.length < 4) {
        return false;
    }
    return buffer[0] === 0x50
        && buffer[1] === 0x4b
        && ((buffer[2] === 0x03 && buffer[3] === 0x04)
            || (buffer[2] === 0x05 && buffer[3] === 0x06)
            || (buffer[2] === 0x07 && buffer[3] === 0x08));
}
function isGzipPayload(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}
function payloadPreview(buffer) {
    const preview = buffer
        .subarray(0, 160)
        .toString("utf8")
        .replace(/[^\x20-\x7eа-яА-ЯёЁ]+/g, " ")
        .trim();
    return preview ? ` Начало ответа: ${preview}` : "";
}
function runProcess(command, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let output = "";
        const child = (0, child_process_1.spawn)(command, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${command} превысил таймаут.`));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            output = `${output}${chunk}`.slice(-4000);
        });
        child.stderr.on("data", (chunk) => {
            output = `${output}${chunk}`.slice(-4000);
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} завершился с кодом ${code ?? "-"}. ${output}`.trim()));
        });
    });
}
async function findRipgrepExecutable(root) {
    const executable = (0, ripgrepUtils_1.ripgrepExecutableName)();
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
        const current = stack.pop();
        if (!current || current.depth > 6) {
            continue;
        }
        let entries;
        try {
            entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(current.dir, entry.name);
            if (entry.isDirectory()) {
                stack.push({ dir: entryPath, depth: current.depth + 1 });
            }
            else if (entry.isFile() && entry.name === executable) {
                return entryPath;
            }
        }
    }
    return undefined;
}
async function downloadJson(url, proxy) {
    const body = await downloadBuffer(url, proxy, 10 * 1024 * 1024, {
        Accept: "application/vnd.github+json"
    });
    return JSON.parse(body.toString("utf8"));
}
function downloadBuffer(url, proxy, maxBytes, headers = {}, redirects = 0) {
    if (redirects > 5) {
        return Promise.reject(new Error("Слишком много redirect при скачивании ripgrep."));
    }
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const requestHeaders = {
            "User-Agent": "codex-element-plugin",
            ...headers
        };
        const handleResponse = (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
                response.resume();
                const redirected = new URL(location, target).toString();
                downloadBuffer(redirected, proxy, maxBytes, headers, redirects + 1).then(resolve, reject);
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`Скачивание ripgrep завершилось HTTP ${status}.`));
                return;
            }
            const chunks = [];
            let total = 0;
            response.on("data", (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    response.destroy(new Error("Скачанный файл ripgrep слишком большой."));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => resolve(Buffer.concat(chunks)));
            response.on("error", reject);
        };
        requestThroughProxyOrDirect(target, proxy, requestHeaders, handleResponse, reject);
    });
}
function requestThroughProxyOrDirect(target, proxy, headers, onResponse, onError) {
    if (!proxy.url) {
        const transport = target.protocol === "http:" ? http : https;
        const request = transport.request(target, { headers }, onResponse);
        request.once("error", onError);
        request.end();
        return;
    }
    const proxyUrl = new URL(proxy.url);
    if (target.protocol === "http:") {
        const request = http.request({
            hostname: proxyUrl.hostname,
            port: Number(proxyUrl.port),
            method: "GET",
            path: target.toString(),
            headers: {
                ...headers,
                Host: target.host,
                ...proxyAuthorizationHeader(proxy)
            }
        }, onResponse);
        request.once("error", onError);
        request.end();
        return;
    }
    const connect = http.request({
        hostname: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        method: "CONNECT",
        path: `${target.hostname}:${target.port || 443}`,
        headers: proxyAuthorizationHeader(proxy)
    });
    connect.once("connect", (response, socket) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            socket.destroy();
            onError(new Error(`Proxy CONNECT вернул HTTP ${response.statusCode ?? "-"}.`));
            return;
        }
        const tlsSocket = tls.connect({
            socket,
            servername: target.hostname
        }, () => {
            const request = https.request({
                hostname: target.hostname,
                port: Number(target.port || 443),
                method: "GET",
                path: `${target.pathname}${target.search}`,
                headers: {
                    ...headers,
                    Host: target.host
                },
                agent: false,
                createConnection: () => tlsSocket
            }, onResponse);
            request.once("error", onError);
            request.end();
        });
        tlsSocket.once("error", onError);
    });
    connect.once("error", onError);
    connect.end();
}
function proxyAuthorizationHeader(proxy) {
    if (!proxy.username) {
        return {};
    }
    const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
    return { "Proxy-Authorization": `Basic ${token}` };
}
//# sourceMappingURL=ripgrepInstallerService.js.map