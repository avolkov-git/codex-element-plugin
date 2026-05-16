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
exports.createContextToolRequest = createContextToolRequest;
exports.toContextBlock = toContextBlock;
exports.createContextToolSuccess = createContextToolSuccess;
exports.createContextToolFailure = createContextToolFailure;
exports.createContextToolLedgerEntry = createContextToolLedgerEntry;
exports.estimateContextToolTokens = estimateContextToolTokens;
exports.hashContextToolReason = hashContextToolReason;
exports.sanitizeContextToolError = sanitizeContextToolError;
exports.sanitizeContextToolMetadata = sanitizeContextToolMetadata;
const crypto = __importStar(require("crypto"));
function createContextToolRequest(options) {
    return {
        id: `ctx-tool-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
        chatId: options.chatId,
        turnId: options.turnId,
        toolName: options.toolName,
        source: options.source,
        args: options.args,
        reason: options.reason,
        createdAt: new Date().toISOString(),
        mode: options.mode,
        limits: options.limits ?? {},
        scope: {
            readOnly: true,
            workspaceOnly: options.scope?.workspaceOnly,
            allowedRoots: options.scope?.allowedRoots,
            allowUnsavedEditorText: options.scope?.allowUnsavedEditorText
        }
    };
}
function toContextBlock(block) {
    return {
        source: block.source,
        text: block.text,
        matchCount: block.matchCount,
        mode: block.mode,
        score: block.score,
        priority: block.priority,
        tokensEstimate: block.tokensEstimate ?? estimateContextToolTokens(block.text),
        metadata: {
            ...block.metadata,
            contextTool: {
                toolName: block.origin.toolName,
                requestId: block.origin.requestId,
                root: block.origin.root,
                path: block.origin.path,
                title: block.origin.title,
                corpus: block.origin.corpus,
                score: block.origin.score
            }
        }
    };
}
function createContextToolSuccess(request, blocks, metadata = {}) {
    const chars = blocks.reduce((total, block) => total + block.text.length, 0);
    return {
        ok: true,
        requestId: request.id,
        toolName: request.toolName,
        source: request.source,
        blocks,
        stats: {
            itemCount: blocks.reduce((total, block) => total + block.matchCount, 0),
            blockCount: blocks.length,
            chars,
            truncated: blocks.some((block) => Boolean(block.metadata?.truncated))
        },
        metadata: sanitizeContextToolMetadata(metadata)
    };
}
function createContextToolFailure(request, error, partialBlocks = [], metadata = {}) {
    return {
        ok: false,
        requestId: request.id,
        toolName: request.toolName,
        source: request.source,
        error: sanitizeContextToolError(error),
        partialBlocks,
        metadata: sanitizeContextToolMetadata(metadata)
    };
}
function createContextToolLedgerEntry(options) {
    const completedAt = options.completedAt ?? Date.now();
    const status = options.result.ok ? "ok" : mapErrorCodeToStatus(options.result.error.code);
    const stats = options.result.ok
        ? options.result.stats
        : {
            itemCount: options.result.partialBlocks.reduce((total, block) => total + block.matchCount, 0),
            blockCount: options.result.partialBlocks.length,
            chars: options.result.partialBlocks.reduce((total, block) => total + block.text.length, 0),
            truncated: options.result.partialBlocks.some((block) => Boolean(block.metadata?.truncated))
        };
    return {
        requestId: options.request.id,
        chatId: options.request.chatId,
        turnId: options.request.turnId,
        toolName: options.request.toolName,
        source: options.request.source,
        status,
        mode: options.request.mode,
        reasonHash: hashContextToolReason(options.request.reason),
        startedAt: new Date(options.startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        elapsedMs: Math.max(0, completedAt - options.startedAt),
        roots: options.roots ?? options.request.scope.allowedRoots ?? [],
        itemCount: stats.itemCount,
        blockCount: stats.blockCount,
        chars: stats.chars,
        truncated: stats.truncated,
        errorCode: options.result.ok ? undefined : options.result.error.code,
        metadata: sanitizeContextToolMetadata(options.metadata ?? options.result.metadata)
    };
}
function estimateContextToolTokens(text) {
    return Math.max(0, Math.ceil(text.length / 4));
}
function hashContextToolReason(reason) {
    return crypto.createHash("sha256").update(reason).digest("hex").slice(0, 16);
}
function sanitizeContextToolError(error) {
    return {
        code: error.code,
        message: shorten(error.message.replace(/\s+/g, " ").trim(), 240),
        retryable: error.retryable
    };
}
function sanitizeContextToolMetadata(metadata) {
    const safe = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (/(^|\.)(text|content|prompt|raw|body|sourceText|fileText)$/iu.test(key)) {
            continue;
        }
        safe[key] = sanitizeMetadataValue(value, 0);
    }
    return safe;
}
function sanitizeMetadataValue(value, depth) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value === "string" ? shorten(value, 500) : value;
    }
    if (Array.isArray(value)) {
        return depth >= 2 ? `[array:${value.length}]` : value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
    }
    if (typeof value === "object") {
        if (depth >= 2) {
            return "[object]";
        }
        const result = {};
        for (const [key, item] of Object.entries(value).slice(0, 30)) {
            if (/(^|\.)(text|content|prompt|raw|body|sourceText|fileText)$/iu.test(key)) {
                continue;
            }
            result[key] = sanitizeMetadataValue(item, depth + 1);
        }
        return result;
    }
    return String(value);
}
function mapErrorCodeToStatus(code) {
    switch (code) {
        case "denied":
        case "unsafePath":
            return "denied";
        case "timeout":
            return "timeout";
        case "unsupported":
            return "unsupported";
        default:
            return "error";
    }
}
function shorten(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
//# sourceMappingURL=contextTools.js.map