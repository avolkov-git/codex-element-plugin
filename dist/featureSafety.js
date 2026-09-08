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
exports.FeatureError = void 0;
exports.opaqueId = opaqueId;
exports.digest = digest;
exports.contained = contained;
exports.safeRelative = safeRelative;
exports.safeFile = safeFile;
exports.readRegular = readRegular;
exports.deadline = deadline;
exports.plainText = plainText;
exports.redactPreview = redactPreview;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class FeatureError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.FeatureError = FeatureError;
function opaqueId() {
    return (0, crypto_1.randomBytes)(18).toString("hex");
}
function digest(value) {
    return (0, crypto_1.createHash)("sha256").update(value).digest("hex");
}
function contained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function safeRelative(value) {
    if (!value || value.length > 2048 || path.isAbsolute(value) || /^[a-z]:/i.test(value)
        || /[\\\x00-\x1f\x7f]/.test(value)
        || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
        throw new FeatureError("blocked", "This path is outside the supported project file boundary.");
    }
    return value;
}
// Reject every symlink component, including a missing leaf's existing parents.
function safeFile(root, relative) {
    safeRelative(relative);
    let current = root;
    const parts = relative.split("/");
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
                throw new FeatureError("blocked", "Symlinks and non-directory path parents are not supported.");
            }
            if (!contained(root, fs.realpathSync(current))) {
                throw new FeatureError("blocked", "The file resolved outside its scope.");
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }
    return current;
}
function readRegular(file, maxBytes) {
    let descriptor;
    try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) {
            throw new FeatureError("unsupported", "Only bounded regular files without hard links are supported.");
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < buffer.length) {
            const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
            if (!read)
                break;
            count += read;
        }
        const after = fs.fstatSync(descriptor);
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
            throw new FeatureError("conflict", "The file changed while it was being read. Refresh and try again.");
        }
        return buffer.subarray(0, count);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
async function deadline(operation, milliseconds) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new FeatureError("timeout", "Element did not respond before the deadline. A dispatched IDE request may still finish; it was not cancelled.")), milliseconds);
            })
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function plainText(buffer) {
    const text = buffer.toString("utf8");
    if (buffer.includes(0) || !Buffer.from(text, "utf8").equals(buffer)) {
        throw new FeatureError("unsupported", "Binary and non-UTF-8 files are not supported by text review.");
    }
    return text;
}
function redactPreview(text) {
    return text
        .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, "[redacted private key]")
        .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)\b[^\r\n]*/gi, "[redacted credential field]")
        .replace(/\b(?:Bearer|Basic)\s+[a-z\d+/=._-]+/gi, "[redacted authorization]")
        .replace(/\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d_]{16,}|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)\b/gi, "[redacted token]")
        .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
        try {
            const url = new URL(value);
            url.username = "";
            url.password = "";
            url.search = "";
            url.hash = "";
            return url.toString();
        }
        catch {
            return "[redacted URL]";
        }
    })
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
//# sourceMappingURL=featureSafety.js.map