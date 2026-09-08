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
exports.FeatureBrowserArtifacts = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const featureSafety_1 = require("./featureSafety");
const MAX_PREVIEW_BYTES = 24 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_VISITED = 2000;
const TTL_MS = 15 * 60000;
function fingerprint(stat) {
    return (0, featureSafety_1.digest)(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
}
function classify(name) {
    if (/\.(png|jpe?g|webp|gif)$/i.test(name))
        return "image";
    if (/\.har$/i.test(name))
        return "network";
    if (/\.(txt|log)$/i.test(name))
        return "console";
    if (/\.json$/i.test(name) && !/(?:config|storage[-_]?state|cookies|credentials|secrets)/i.test(name))
        return "data";
    return undefined;
}
class FeatureBrowserArtifacts {
    constructor() {
        this.records = new Map();
    }
    clear() { this.records.clear(); }
    async list(scope, root, chatId, assertContext) {
        this.prune();
        if (!root)
            return { items: [], truncated: false };
        root = this.validateRoot(scope, root, true);
        if (!fs.existsSync(root))
            return { items: [], truncated: false };
        const items = [];
        const directories = [{ relative: "", depth: 0 }];
        let visited = 0;
        while (directories.length && items.length < MAX_FILES && visited < MAX_VISITED) {
            const next = directories.shift();
            const directory = next.relative ? (0, featureSafety_1.safeFile)(root, next.relative) : root;
            const iterator = await fs.promises.opendir(directory);
            for await (const entry of iterator) {
                assertContext();
                if (++visited > MAX_VISITED || items.length >= MAX_FILES)
                    break;
                if (entry.name.startsWith(".") || entry.isSymbolicLink())
                    continue;
                const relative = next.relative ? `${next.relative}/${entry.name}` : entry.name;
                let file;
                try {
                    file = (0, featureSafety_1.safeFile)(root, relative);
                }
                catch {
                    continue;
                }
                if (entry.isDirectory()) {
                    if (next.depth < 4)
                        directories.push({ relative, depth: next.depth + 1 });
                    continue;
                }
                const kind = classify(entry.name);
                if (!entry.isFile() || !kind)
                    continue;
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.nlink !== 1)
                    continue;
                const id = (0, featureSafety_1.opaqueId)();
                const item = {
                    id, name: (0, featureSafety_1.redactPreview)(relative).slice(0, 240), kind, size: stat.size,
                    modifiedAt: stat.mtime.toISOString(),
                    previewAvailable: kind !== "image" || (stat.size <= MAX_IMAGE_BYTES && /\.(png|jpe?g)$/i.test(entry.name))
                };
                this.records.set(id, { item, relative, root, scope, chatId, fingerprint: fingerprint(stat), expires: Date.now() + TTL_MS });
                items.push(item);
            }
        }
        this.prune();
        return { items: items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), truncated: items.length >= MAX_FILES || visited >= MAX_VISITED || directories.length > 0 };
    }
    open(id, scope, root, chatId) {
        this.prune();
        const record = this.records.get(id);
        if (!record || record.scope !== scope || record.chatId !== chatId || !root || this.validateRoot(scope, root) !== record.root) {
            throw new featureSafety_1.FeatureError("blocked", "This artifact ID is unavailable in the current authenticated session. Refresh the artifact list.");
        }
        const file = (0, featureSafety_1.safeFile)(record.root, record.relative);
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || fingerprint(stat) !== record.fingerprint) {
                throw new featureSafety_1.FeatureError("conflict", "The artifact changed. Refresh its list before opening it.");
            }
            if (record.item.kind === "image" && !record.item.previewAvailable)
                return { artifact: record.item, preview: { kind: "unavailable", truncated: true, redacted: false, message: "Only bounded PNG/JPEG raster previews are enabled; other images remain listed without exposing raw paths." } };
            const limit = record.item.kind === "image" ? MAX_IMAGE_BYTES : record.item.kind === "console" ? MAX_PREVIEW_BYTES : MAX_JSON_BYTES;
            if (stat.size > limit && record.item.kind !== "console") {
                return { artifact: record.item, preview: { kind: "unavailable", truncated: true, redacted: false, message: "This artifact exceeds the safe inline preview limit. No raw file or server path was exposed." } };
            }
            const buffer = Buffer.alloc(Math.min(stat.size, limit));
            let count = 0;
            while (count < buffer.length) {
                const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
                if (!read)
                    break;
                count += read;
            }
            if (count !== buffer.length || fingerprint(fs.fstatSync(fd)) !== record.fingerprint)
                throw new featureSafety_1.FeatureError("conflict", "The artifact changed while its preview was read.");
            return { artifact: record.item, preview: preview(record.item.kind, buffer, stat.size > limit) };
        }
        finally {
            fs.closeSync(fd);
        }
    }
    validateRoot(scope, root, allowMissing = false) {
        const relative = path.relative(scope, root).split(path.sep).join("/");
        if (!path.isAbsolute(root) || !relative || !(0, featureSafety_1.contained)(scope, root))
            throw new featureSafety_1.FeatureError("blocked", "Browser artifacts must be in a dedicated directory within the authenticated scope.");
        const resolved = (0, featureSafety_1.safeFile)(scope, relative);
        if (allowMissing && !fs.existsSync(resolved))
            return resolved;
        if (!fs.statSync(resolved).isDirectory())
            throw new featureSafety_1.FeatureError("blocked", "The browser artifact directory is unavailable.");
        return resolved;
    }
    prune() {
        for (const [id, record] of this.records) {
            if (record.expires < Date.now() || this.records.size > 200)
                this.records.delete(id);
        }
    }
}
exports.FeatureBrowserArtifacts = FeatureBrowserArtifacts;
function preview(kind, buffer, truncated) {
    if (kind === "image") {
        const mimeType = imageType(buffer);
        if (!mimeType)
            throw new featureSafety_1.FeatureError("unsupported", "The artifact does not contain a supported raster image.");
        return { kind: "image", dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`, mimeType, truncated: false, redacted: false, message: "Screenshot pixels are not redacted; visible application data may be sensitive." };
    }
    const text = buffer.toString("utf8");
    if (kind === "console") {
        const limited = truncated ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text;
        return { kind: "text", text: (0, featureSafety_1.redactPreview)(limited).slice(0, MAX_PREVIEW_BYTES), truncated, redacted: true, message: "Common credential fields and URL query strings are removed. Application text may still be sensitive; this is a bounded preview, not raw log output." };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: "unavailable", truncated: false, redacted: true, message: "Invalid structured artifact; raw contents are not displayed." };
    }
    const data = asObject(parsed);
    const log = asObject(data.log);
    const entries = Array.isArray(log.entries) ? log.entries : undefined;
    if (entries) {
        const lines = entries.slice(0, 100).map((value) => {
            const item = asObject(value);
            const request = asObject(item.request);
            const response = asObject(item.response);
            let origin = "[invalid URL]";
            try {
                const url = new URL(String(request.url));
                if (/^https?:$/.test(url.protocol))
                    origin = url.origin;
            }
            catch { /* Omit malformed URLs. */ }
            const method = typeof request.method === "string" && /^[A-Z]{1,12}$/.test(request.method) ? request.method : "HTTP";
            const status = typeof response.status === "number" && Number.isFinite(response.status) ? response.status : "?";
            return `${method} ${origin}  ${status}`;
        });
        return { kind: "summary", text: lines.join("\n"), truncated: entries.length > 100, redacted: true, message: "Network summary only; headers, cookies, paths, queries, request bodies and response bodies are omitted." };
    }
    return { kind: "summary", text: Array.isArray(parsed) ? `Structured artifact: ${parsed.length} entries.` : "Structured browser artifact.", truncated: false, redacted: true, message: "Arbitrary JSON fields may contain credentials and are not exposed as raw output." };
}
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function imageType(value) {
    if (value.length >= 24 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        if (value.readUInt32BE(8) !== 13 || value.toString("ascii", 12, 16) !== "IHDR")
            throw new featureSafety_1.FeatureError("unsupported", "The PNG header is not valid.");
        let offset = 8;
        while (offset + 12 <= value.length) {
            const length = value.readUInt32BE(offset);
            if (length > value.length - offset - 12)
                break;
            if (value.toString("ascii", offset + 4, offset + 8) === "acTL")
                throw new featureSafety_1.FeatureError("unsupported", "Animated image previews are not enabled.");
            offset += length + 12;
        }
        const width = value.readUInt32BE(16), height = value.readUInt32BE(20);
        if (!width || !height || width * height > 24000000)
            throw new featureSafety_1.FeatureError("unsupported", "Image dimensions exceed the safe preview limit.");
        return "image/png";
    }
    if (value.length > 3 && value[0] === 0xff && value[1] === 0xd8) {
        let offset = 2;
        while (offset + 4 < value.length) {
            if (value[offset++] !== 0xff)
                break;
            while (value[offset] === 0xff)
                offset++;
            const marker = value[offset++];
            if (marker === 0xda || marker === 0xd9)
                break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
                continue;
            if (offset + 2 > value.length)
                break;
            const length = value.readUInt16BE(offset);
            if (length < 2 || offset + length > value.length)
                break;
            if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
                const height = value.readUInt16BE(offset + 3), width = value.readUInt16BE(offset + 5);
                if (!width || !height || width * height > 24000000)
                    throw new featureSafety_1.FeatureError("unsupported", "Image dimensions exceed the safe preview limit.");
                return "image/jpeg";
            }
            offset += length;
        }
    }
    return undefined;
}
//# sourceMappingURL=featureBrowserArtifacts.js.map