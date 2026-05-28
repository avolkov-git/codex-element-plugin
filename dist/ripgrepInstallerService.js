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
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const tls = __importStar(require("tls"));
const zlib = __importStar(require("zlib"));
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
    if (assetName.toLowerCase().endsWith(".tar.gz")) {
        await extractTarGzArchive(archivePath, extractRoot);
        return;
    }
    throw new Error(`Неподдерживаемый формат архива ripgrep: ${assetName}.`);
}
async function extractZipArchive(archivePath, extractRoot) {
    const buffer = await fs.promises.readFile(archivePath);
    await extractZipBuffer(buffer, extractRoot);
}
async function extractTarGzArchive(archivePath, extractRoot) {
    const buffer = await fs.promises.readFile(archivePath);
    const tarBuffer = zlib.gunzipSync(buffer);
    await extractTarBuffer(tarBuffer, extractRoot);
}
async function extractZipBuffer(buffer, extractRoot) {
    const entries = readZipCentralDirectory(buffer);
    for (const entry of entries) {
        const safePath = safeExtractPath(extractRoot, entry.name);
        if (!safePath) {
            continue;
        }
        if (entry.directory) {
            await fs.promises.mkdir(safePath, { recursive: true });
            continue;
        }
        const compressed = readZipEntryPayload(buffer, entry);
        const payload = inflateZipEntry(compressed, entry.compressionMethod, entry.name);
        await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
        await fs.promises.writeFile(safePath, payload);
    }
}
async function extractTarBuffer(buffer, extractRoot) {
    let offset = 0;
    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (isEmptyTarBlock(header)) {
            break;
        }
        const name = tarEntryName(header);
        const size = parseTarOctal(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 0);
        const safePath = safeExtractPath(extractRoot, name);
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        if (dataEnd > buffer.length) {
            throw new Error("Архив ripgrep поврежден: tar entry выходит за пределы файла.");
        }
        if (safePath) {
            if (type === "5") {
                await fs.promises.mkdir(safePath, { recursive: true });
            }
            else if (type === "0" || type === "\0" || type === "") {
                await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
                await fs.promises.writeFile(safePath, buffer.subarray(dataStart, dataEnd));
            }
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
}
function readZipCentralDirectory(buffer) {
    const endOffset = findEndOfCentralDirectory(buffer);
    if (endOffset < 0) {
        throw new Error("Архив ripgrep поврежден: не найден ZIP central directory.");
    }
    const totalEntries = buffer.readUInt16LE(endOffset + 10);
    const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
    if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
        throw new Error("Архив ripgrep поврежден: ZIP central directory выходит за пределы файла.");
    }
    const entries = [];
    let offset = centralDirectoryOffset;
    for (let index = 0; index < totalEntries; index += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error("Архив ripgrep поврежден: некорректная ZIP file header запись.");
        }
        const flags = buffer.readUInt16LE(offset + 8);
        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const nameStart = offset + 46;
        const nameEnd = nameStart + nameLength;
        if (nameEnd > buffer.length) {
            throw new Error("Архив ripgrep поврежден: имя ZIP entry выходит за пределы файла.");
        }
        const nameBuffer = buffer.subarray(nameStart, nameEnd);
        const name = decodeZipName(nameBuffer, flags).replace(/\\/g, "/");
        entries.push({
            name,
            directory: name.endsWith("/"),
            compressionMethod,
            compressedSize,
            localHeaderOffset
        });
        offset = nameEnd + extraLength + commentLength;
    }
    return entries;
}
function findEndOfCentralDirectory(buffer) {
    if (buffer.length < 22) {
        return -1;
    }
    const minOffset = Math.max(0, buffer.length - 65557);
    for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }
    return -1;
}
function readZipEntryPayload(buffer, entry) {
    const offset = entry.localHeaderOffset;
    if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
        throw new Error(`Архив ripgrep поврежден: не найден local ZIP header для ${entry.name}.`);
    }
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
        throw new Error(`Архив ripgrep поврежден: данные ZIP entry ${entry.name} выходят за пределы файла.`);
    }
    return buffer.subarray(dataStart, dataEnd);
}
function inflateZipEntry(buffer, compressionMethod, entryName) {
    if (compressionMethod === 0) {
        return buffer;
    }
    if (compressionMethod === 8) {
        return zlib.inflateRawSync(buffer);
    }
    throw new Error(`Архив ripgrep содержит неподдерживаемый ZIP compression method ${compressionMethod} для ${entryName}.`);
}
function decodeZipName(buffer, flags) {
    if (flags & 0x0800) {
        return buffer.toString("utf8");
    }
    return buffer.toString("utf8");
}
function isEmptyTarBlock(header) {
    for (const byte of header) {
        if (byte !== 0) {
            return false;
        }
    }
    return true;
}
function tarEntryName(header) {
    const name = readNullTerminatedString(header.subarray(0, 100));
    const prefix = readNullTerminatedString(header.subarray(345, 500));
    return (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");
}
function parseTarOctal(buffer) {
    const raw = readNullTerminatedString(buffer).trim();
    return raw ? Number.parseInt(raw, 8) || 0 : 0;
}
function readNullTerminatedString(buffer) {
    const zero = buffer.indexOf(0);
    const end = zero >= 0 ? zero : buffer.length;
    return buffer.subarray(0, end).toString("utf8");
}
function safeExtractPath(root, entryName) {
    const normalizedName = entryName.replace(/^\/+/, "");
    if (!normalizedName || normalizedName.includes("\0")) {
        return "";
    }
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, normalizedName);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Архив ripgrep содержит небезопасный путь: ${entryName}.`);
    }
    return target;
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