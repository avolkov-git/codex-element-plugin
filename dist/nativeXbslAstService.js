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
exports.NativeXbslAstService = void 0;
exports.collectNativeAstSymbols = collectNativeAstSymbols;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const HARD_SOURCE_LIMIT = 1024 * 1024;
const HARD_RESPONSE_LIMIT = 16 * 1024 * 1024;
const REASONS = {
    disposed: "Адаптер штатного AST остановлен.",
    cancelled: "Разбор штатного AST отменён.",
    timeout: "Штатный AST не ответил за отведённое время.",
    source_limit: "Файл слишком большой для дополнительного разбора AST.",
    queue_limit: "Очередь разбора штатного AST заполнена.",
    parser_not_found: "Штатный XBSL-парсер не найден в установленном плагине 1С:Элемент.",
    helper_not_found: "В поставке Codex отсутствует адаптер штатного AST.",
    java_not_found: "Java для штатного AST не найдена. Проверьте E1C_IDE_JAVA_HOME или JAVA_HOME.",
    parser_api_unavailable: "API установленного штатного парсера несовместим с адаптером AST.",
    process_failed: "Процесс штатного AST не удалось запустить или он завершился.",
    protocol_error: "Адаптер штатного AST вернул некорректный ответ.",
    ast_limit: "Полное дерево AST превышает лимит размера или глубины; обрезанное дерево не используется.",
    parser_failed: "Штатный парсер не смог построить дерево AST.",
    discovery_failed: "Не удалось определить установленный штатный парсер.",
};
/** One lazy syntax-only Java worker, separate from (and never restarting) the native LSP. */
class NativeXbslAstService {
    constructor(extensionPath, logger, options = {}) {
        this.extensionPath = extensionPath;
        this.logger = logger;
        this.options = options;
        this.queue = [];
        this.cache = new Map();
        this.cacheBytes = 0;
        this.disposed = false;
        this.sequence = 0;
        this.starts = 0;
        this.hits = 0;
        this.requests = 0;
        this.timeoutMs = bounded(options.timeoutMs, 12000, 10, 60000);
        this.sourceLimit = bounded(options.maxSourceBytes, HARD_SOURCE_LIMIT, 1, HARD_SOURCE_LIMIT);
        this.responseLimit = bounded(options.maxResponseBytes, HARD_RESPONSE_LIMIT, 128, HARD_RESPONSE_LIMIT);
        this.queueLimit = bounded(options.maxQueueSize, 32, 1, 128);
        this.cacheLimit = bounded(options.maxCacheBytes, 32 * 1024 * 1024, 0, 64 * 1024 * 1024);
        this.cacheEntries = bounded(options.maxCacheEntries, 64, 0, 256);
    }
    parse(source, options = {}) {
        const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
        if (this.disposed)
            return Promise.resolve(failure(sourceHash, "disposed"));
        if (options.signal?.aborted)
            return Promise.resolve(failure(sourceHash, "cancelled"));
        if (Buffer.byteLength(source, "utf8") > this.sourceLimit)
            return Promise.resolve(failure(sourceHash, "source_limit"));
        if (this.queue.length + (this.active ? 1 : 0) >= this.queueLimit)
            return Promise.resolve(failure(sourceHash, "queue_limit"));
        return new Promise(resolve => {
            const task = {
                id: ++this.sequence, source, sourceHash, resolve, done: false, signal: options.signal,
                timer: setTimeout(() => this.cancel(task, "timeout"), this.timeoutMs),
            };
            if (task.signal) {
                task.abort = () => this.cancel(task, "cancelled");
                task.signal.addEventListener("abort", task.abort, { once: true });
            }
            this.queue.push(task);
            this.pump();
        });
    }
    getMetrics() {
        return { processStarts: this.starts, parseRequests: this.requests, cacheHits: this.hits, cacheEntries: this.cache.size,
            cacheBytes: this.cacheBytes, queued: this.queue.length, active: !!this.active };
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const task of this.queue.splice(0))
            this.finish(task, failure(task.sourceHash, "disposed"));
        if (this.active)
            this.finish(this.active, failure(this.active.sourceHash, "disposed"));
        if (this.worker)
            this.stop(this.worker, "disposed");
        this.cache.clear();
        this.cacheBytes = 0;
    }
    pump() {
        if (this.disposed || this.active)
            return;
        const task = this.queue.shift();
        if (!task)
            return;
        if (task.done) {
            this.pump();
            return;
        }
        this.active = task;
        void this.run(task).catch(() => {
            this.finish(task, failure(task.sourceHash, "discovery_failed", "unavailable"));
        }).finally(() => {
            if (this.active === task)
                this.active = undefined;
            this.pump();
        });
    }
    async run(task) {
        const installation = await this.discover();
        if (task.done || this.disposed)
            return;
        if (typeof installation === "string") {
            this.finish(task, failure(task.sourceHash, installation, "unavailable"));
            return;
        }
        const key = `${installation.fingerprint}:${task.sourceHash}`;
        const cached = this.cache.get(key);
        if (cached) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            this.hits += 1;
            this.finish(task, { ...cached.result, cacheHit: true });
            return;
        }
        const worker = this.ensureWorker(installation);
        if (!worker) {
            this.finish(task, { ...failure(task.sourceHash, "process_failed", "unavailable"), parserVersion: installation.version });
            return;
        }
        clearTimeout(worker.idleTimer);
        this.requests += 1;
        const reply = await new Promise(resolve => {
            this.reply = { id: task.id, worker, resolve };
            try {
                worker.child.stdin.write(`${task.id}\t${Buffer.from(task.source, "utf8").toString("base64")}\n`, error => {
                    if (error)
                        this.stop(worker, "process_failed");
                });
            }
            catch {
                this.stop(worker, "process_failed");
            }
        });
        if (task.done || this.disposed)
            return;
        const result = decodeReply(reply, task.sourceHash, installation, task.source.length);
        if (result.status === "ready")
            this.putCache(key, result);
        else
            this.logger.warn(`Native XBSL AST: ${result.code || "parser_failed"}.`);
        this.finish(task, result);
        if (!worker.stopped) {
            worker.idleTimer = setTimeout(() => this.stop(worker, "idle"), bounded(this.options.idleTimeoutMs, 60000, 10, 600000));
            worker.idleTimer.unref();
        }
    }
    finish(task, result) {
        if (task.done)
            return;
        task.done = true;
        clearTimeout(task.timer);
        if (task.abort)
            task.signal?.removeEventListener("abort", task.abort);
        task.source = "";
        task.resolve(result);
    }
    cancel(task, code) {
        if (task.done)
            return;
        this.finish(task, failure(task.sourceHash, code));
        const queued = this.queue.indexOf(task);
        if (queued >= 0)
            this.queue.splice(queued, 1);
        if (this.active === task && this.worker)
            this.stop(this.worker, code);
    }
    ensureWorker(installation) {
        if (this.worker && this.worker.installation.fingerprint === installation.fingerprint && !this.worker.stopped)
            return this.worker;
        if (this.worker)
            this.stop(this.worker, "parser_changed");
        try {
            const child = (this.options.spawnProcess || child_process_1.spawn)(installation.java, [
                "-Xmx256m", "-Xss2m", "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true",
                "-cp", `${installation.helper}${path.delimiter}${installation.jar}`, "NativeXbslAst",
            ], { stdio: "pipe", windowsHide: true, shell: false, env: this.options.env || process.env });
            const worker = { child, installation, chunks: [], bytes: 0, stopped: false };
            this.worker = worker;
            this.starts += 1;
            child.stdout.on("data", (chunk) => this.onData(worker, chunk));
            // Drain parser diagnostics without storing source snippets or unbounded stderr in logs.
            child.stderr.resume();
            child.stdin.on("error", () => this.stop(worker, "process_failed"));
            child.on("error", () => this.stop(worker, "process_failed"));
            child.on("exit", () => this.stop(worker, "process_failed"));
            return worker;
        }
        catch {
            return undefined;
        }
    }
    onData(worker, chunk) {
        if (worker.stopped)
            return;
        let start = 0;
        for (let i = 0; i < chunk.length; i += 1) {
            if (chunk[i] !== 10)
                continue;
            const part = chunk.subarray(start, i);
            worker.bytes += part.length;
            if (worker.bytes > this.responseLimit) {
                this.stop(worker, "ast_limit");
                return;
            }
            worker.chunks.push(part);
            const frame = Buffer.concat(worker.chunks, worker.bytes).toString("utf8");
            worker.chunks = [];
            worker.bytes = 0;
            start = i + 1;
            let reply;
            try {
                reply = JSON.parse(frame);
            }
            catch {
                this.stop(worker, "protocol_error");
                return;
            }
            if (reply?.id === 0 && reply.status === "unavailable") {
                this.stop(worker, "parser_api_unavailable");
                return;
            }
            const pending = this.reply;
            if (!pending || pending.worker !== worker || reply?.id !== pending.id) {
                this.stop(worker, "protocol_error");
                return;
            }
            this.reply = undefined;
            pending.resolve(reply);
        }
        if (start < chunk.length) {
            const rest = chunk.subarray(start);
            worker.bytes += rest.length;
            if (worker.bytes > this.responseLimit) {
                this.stop(worker, "ast_limit");
                return;
            }
            worker.chunks.push(rest);
        }
    }
    stop(worker, code) {
        if (worker.stopped)
            return;
        worker.stopped = true;
        clearTimeout(worker.idleTimer);
        if (this.worker === worker)
            this.worker = undefined;
        if (this.reply?.worker === worker) {
            const pending = this.reply;
            this.reply = undefined;
            pending.resolve({ id: pending.id, status: code === "parser_api_unavailable" ? "unavailable" : "error", code });
        }
        worker.chunks = [];
        worker.bytes = 0;
        worker.child.stdin.destroy();
        worker.child.stdout.destroy();
        worker.child.stderr.destroy();
        // The helper never spawns descendants. A forceful kill also terminates a stuck native parser.
        if (worker.child.exitCode === null) {
            try {
                worker.child.kill("SIGKILL");
            }
            catch { /* Already exited. */ }
        }
    }
    putCache(key, result) {
        const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        if (!this.cacheEntries || bytes > this.cacheLimit)
            return;
        while (this.cache.size >= this.cacheEntries || this.cacheBytes + bytes > this.cacheLimit) {
            const oldest = this.cache.keys().next().value;
            if (!oldest)
                break;
            this.cacheBytes -= this.cache.get(oldest).bytes;
            this.cache.delete(oldest);
        }
        freezeTree(result);
        this.cache.set(key, { result, bytes });
        this.cacheBytes += bytes;
    }
    async discover() {
        const helper = path.join(this.extensionPath, "resources", "context", "ast", "native-xbsl-ast.jar");
        const helperStat = await fileStat(helper);
        if (!helperStat)
            return "helper_not_found";
        const env = this.options.env || process.env;
        const candidates = [];
        if (this.options.parserJarPath)
            candidates.push(this.options.parserJarPath);
        else {
            const roots = [];
            if (env.LSP_SERVER_PATH)
                roots.push(path.join(env.LSP_SERVER_PATH, "repo"));
            let extensionPaths = this.options.nativeExtensionPaths;
            if (!extensionPaths) {
                try {
                    const vscode = require("vscode");
                    extensionPaths = vscode.extensions.all.filter(extension => /(?:^|[.@-])appengine-plugin(?:$|[.@-])/i.test(extension.id)
                        || /(?:^|[\\/])@?1c-appengine-plugin$/i.test(extension.extensionPath)).map(extension => extension.extensionPath);
                }
                catch {
                    extensionPaths = [];
                }
            }
            if (!env.LSP_SERVER_PATH) {
                for (const extension of extensionPaths)
                    roots.push(path.join(extension, "bin", "appengine-lsp", "repo"));
                for (const parent of [path.dirname(this.extensionPath), path.dirname(path.dirname(this.extensionPath))]) {
                    for (const name of ["@1c-appengine-plugin", "1c-appengine-plugin"])
                        roots.push(path.join(parent, name, "bin", "appengine-lsp", "repo"));
                }
            }
            for (const root of new Set(roots)) {
                try {
                    const jars = (await fs.promises.readdir(root)).filter(name => /^com\.e1c\.g5rt\.lsp\.server\.appengine-[\w.-]+\.jar$/i.test(name));
                    // Do not guess which of several native installations is active.
                    if (jars.length === 1)
                        candidates.push(path.join(root, jars[0]));
                    if (candidates.length)
                        break;
                }
                catch { /* The native extension is optional. */ }
            }
        }
        const jar = candidates[0];
        const jarStat = jar && await fileStat(jar);
        if (!jar || !jarStat)
            return "parser_not_found";
        let java = this.options.javaPath;
        if (!java) {
            for (const value of [env.E1C_IDE_JAVA_HOME, env.JAVA_HOME]) {
                if (!value)
                    continue;
                try {
                    const stat = await fs.promises.stat(value);
                    java = stat.isDirectory() ? path.join(value, "bin", process.platform === "win32" ? "java.exe" : "java") : value;
                }
                catch {
                    return "java_not_found";
                }
                if (!await fileStat(java))
                    return "java_not_found";
                break;
            }
        }
        java || (java = process.platform === "win32" ? "java.exe" : "java");
        const version = path.basename(jar).replace(/^com\.e1c\.g5rt\.lsp\.server\.appengine-/, "").replace(/\.jar$/i, "");
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
            path.resolve(jar), version, jarStat.size, jarStat.mtimeMs, helperStat.size, helperStat.mtimeMs, java,
        ])).digest("hex");
        return { jar, version, fingerprint, java, helper };
    }
}
exports.NativeXbslAstService = NativeXbslAstService;
function collectNativeAstSymbols(result) {
    if (result.status !== "ready" || !result.root)
        return [];
    const symbols = [];
    const stack = [result.root];
    while (stack.length) {
        const node = stack.pop();
        let name = node.attributes.name;
        let kind;
        if (/^(?:Method|AbstractMethod)$/.test(node.kind))
            kind = "method";
        else if (/^(?:Bsl)?(?:Object|Enum|Type|Structure|Class|Interface)(?:Declaration)?$/.test(node.kind))
            kind = "type";
        else if (node.role === "imports" || /^Import/.test(node.kind)) {
            kind = "import";
            if (Array.isArray(node.attributes.namespace))
                name = node.attributes.namespace.filter(value => typeof value === "string").join("::");
        }
        else if (/MethodInvocation$/.test(node.kind)) {
            kind = "call";
            const prefix = node.children.find(child => child.role === "prefix");
            const feature = prefix?.children.find(child => child.role === "name");
            name = name || prefix?.attributes.name || feature?.attributes.name;
        }
        else if (/^(?:Variable|VariableDeclaration|Constant|Const)$/.test(node.kind))
            kind = "variable";
        else if (node.kind === "Parameter")
            kind = "parameter";
        if (kind && typeof name === "string" && name && node.startOffset >= 0) {
            symbols.push({ name, kind, nodeKind: node.kind, startOffset: node.startOffset, endOffset: node.endOffset, startLine: node.startLine, endLine: node.endLine });
        }
        for (let i = node.children.length - 1; i >= 0; i -= 1)
            stack.push(node.children[i]);
    }
    return symbols;
}
function failure(sourceHash, code, status = "error") {
    return { status, sourceHash, code, reason: REASONS[code] || REASONS.parser_failed, diagnostics: [], partial: false,
        semanticBound: false, referencesExcluded: true, nodeCount: 0 };
}
async function fileStat(file) {
    try {
        const stat = await fs.promises.stat(file);
        return stat.isFile() ? stat : undefined;
    }
    catch {
        return undefined;
    }
}
function bounded(value, fallback, min, max) {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
function decodeReply(reply, sourceHash, installation, sourceLength) {
    const identity = { parserVersion: installation.version, parserFingerprint: installation.fingerprint };
    if (reply.status !== "ready")
        return { ...failure(sourceHash, typeof reply.code === "string" ? reply.code : "protocol_error", reply.status === "unavailable" ? "unavailable" : "error"), ...identity };
    if (!Array.isArray(reply.diagnostics) || typeof reply.partial !== "boolean" || reply.semanticBound !== false || reply.referencesExcluded !== true
        || !Number.isInteger(reply.nodeCount) || !validateTree(reply.root, sourceLength, reply.nodeCount)) {
        return { ...failure(sourceHash, "protocol_error"), ...identity };
    }
    const diagnostics = reply.diagnostics;
    if (diagnostics.some(d => !d || typeof d.message !== "string" || ![d.line, d.column, d.endLine, d.endColumn, d.startOffset, d.endOffset].every(Number.isInteger))) {
        return { ...failure(sourceHash, "protocol_error"), ...identity };
    }
    return { status: "ready", sourceHash, ...identity, root: reply.root ? reply.root : undefined,
        diagnostics, partial: reply.partial, semanticBound: false, referencesExcluded: true, nodeCount: reply.nodeCount, cacheHit: false };
}
function validateTree(root, sourceLength, expected) {
    if (root === null)
        return expected === 0;
    const stack = [{ node: root, depth: 0 }];
    let count = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (!node || typeof node !== "object" || depth > 256 || ++count > 50000)
            return false;
        const n = node;
        if (typeof n.kind !== "string" || !Array.isArray(n.children) || !n.attributes || typeof n.attributes !== "object"
            || Array.isArray(n.attributes) || ![n.startOffset, n.endOffset, n.startLine, n.endLine].every(Number.isInteger)
            || n.startOffset < -1 || n.endOffset < n.startOffset || n.endOffset > sourceLength
            || (n.startOffset === -1 && (n.endOffset !== -1 || n.startLine !== 0 || n.endLine !== 0))
            || (n.startOffset >= 0 && (n.startLine < 1 || n.endLine < n.startLine)))
            return false;
        if (n.role !== undefined && typeof n.role !== "string")
            return false;
        if (Object.values(n.attributes).some(value => !plainAttribute(value)))
            return false;
        for (const map of [n.attributeValueTypes, n.attributeSources]) {
            if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some(value => typeof value !== "string")))
                return false;
        }
        for (const child of n.children)
            stack.push({ node: child, depth: depth + 1 });
    }
    return count === expected;
}
function plainAttribute(value) {
    if (Array.isArray(value))
        return value.every(item => !Array.isArray(item) && plainAttribute(item));
    return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
function freezeTree(result) {
    const stack = [result];
    while (stack.length) {
        const object = stack.pop();
        for (const value of Object.values(object))
            if (value && typeof value === "object" && !Object.isFrozen(value))
                stack.push(value);
        Object.freeze(object);
    }
}
//# sourceMappingURL=nativeXbslAstService.js.map