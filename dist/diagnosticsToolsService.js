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
exports.DiagnosticsToolsService = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const contextTools_1 = require("./contextTools");
const DIAGNOSTICS_SOURCE = "diagnostics";
const DEFAULT_PRIORITY = 115;
const DEFAULT_BLOCK_CHARS = 12000;
class DiagnosticsToolsService {
    constructor(diagnosticsContext, logger) {
        this.diagnosticsContext = diagnosticsContext;
        this.logger = logger;
    }
    async list(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "diagnostics.list",
            source: DIAGNOSTICS_SOURCE,
            args: { priority: options.priority },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: {
                workspaceOnly: true,
                allowUnsavedEditorText: false
            }
        }));
    }
    async execute(request) {
        const startedAt = Date.now();
        const result = await this.executeUnsafe(request).catch((error) => (0, contextTools_1.createContextToolFailure)(request, {
            code: "internalError",
            message: error instanceof Error ? error.message : String(error),
            retryable: false
        }));
        const roots = getMetadataStringArray(result.metadata.roots);
        const ledger = (0, contextTools_1.createContextToolLedgerEntry)({
            request,
            result,
            startedAt,
            roots,
            metadata: result.metadata
        });
        this.logger.info(`Diagnostics tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; ` +
            `chars=${ledger.chars}; roots=${ledger.roots.length}; files=${String(result.metadata.filesCount ?? 0)}; ` +
            `errors=${String(result.metadata.errorsCount ?? 0)}; elapsed=${ledger.elapsedMs}ms.`);
        return result;
    }
    async executeUnsafe(request) {
        if (request.toolName !== "diagnostics.list") {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "unsupported",
                message: `Unsupported diagnostics tool: ${request.toolName}`,
                retryable: false
            });
        }
        const priority = normalizePriority(request.args.priority);
        const result = await this.diagnosticsContext.collectErrorContext(priority);
        const metadata = metadataFromDiagnostics(result);
        const roots = getWorkspaceRootPaths();
        const fullMetadata = { ...metadata, roots };
        if (!result.block) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: result.reason === "no-workspace" ? "unavailable" : "notFound",
                message: diagnosticsFailureMessage(result.reason),
                retryable: true
            }, [], fullMetadata);
        }
        const text = trimToolBlock(result.block.text, request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: DIAGNOSTICS_SOURCE,
                text,
                matchCount: result.errorsCount,
                mode: "matched",
                score: result.block.score,
                priority: result.block.priority,
                tokensEstimate: Math.ceil(text.length / 4),
                metadata: {
                    filesCount: result.filesCount,
                    errorsCount: result.errorsCount,
                    totalErrorsCount: result.totalErrorsCount,
                    omittedErrorsCount: result.omittedErrorsCount,
                    fingerprint: result.fingerprint,
                    truncated: text.endsWith("…")
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: roots.join(";"),
                    score: result.block.score
                }
            }], fullMetadata);
    }
}
exports.DiagnosticsToolsService = DiagnosticsToolsService;
function normalizePriority(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(500, value)) : DEFAULT_PRIORITY;
}
function diagnosticsFailureMessage(reason) {
    if (reason === "no-workspace") {
        return "Workspace diagnostics are unavailable because no file workspace is open.";
    }
    if (reason === "no-errors") {
        return "No IDE errors are currently reported for workspace files.";
    }
    return "IDE diagnostics were not added.";
}
function metadataFromDiagnostics(result) {
    return {
        filesCount: result.filesCount,
        errorsCount: result.errorsCount,
        totalErrorsCount: result.totalErrorsCount,
        omittedErrorsCount: result.omittedErrorsCount,
        fingerprint: result.fingerprint,
        reason: result.reason
    };
}
function getWorkspaceRootPaths() {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => path.resolve(folder.uri.fsPath));
}
function trimToolBlock(value, maxChars) {
    const limit = Math.max(1000, Math.min(20000, Math.floor(maxChars)));
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
function getMetadataStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
//# sourceMappingURL=diagnosticsToolsService.js.map