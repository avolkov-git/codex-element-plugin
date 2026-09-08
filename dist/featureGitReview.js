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
exports.isDirty = isDirty;
exports.listReviewPaths = listReviewPaths;
exports.captureReview = captureReview;
exports.mutateReview = mutateReview;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const featureSafety_1 = require("./featureSafety");
const MAX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
function gitEnvironment(indexFile) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.toUpperCase().startsWith("GIT_"))
            env[key] = value;
    }
    return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) };
}
async function git(root, args, input, indexFile, allowFailure = false) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.execFile)("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.pager=cat", "-C", root, ...args], {
            env: gitEnvironment(indexFile), encoding: "buffer", timeout: 8000, maxBuffer: MAX_GIT_OUTPUT, windowsHide: true
        }, (error, stdout) => {
            if (error && !(allowFailure && typeof error.code === "number")) {
                reject(new featureSafety_1.FeatureError("error", "Git could not complete this bounded local operation. No remote command was requested."));
            }
            else {
                resolve(error ? Buffer.alloc(0) : stdout);
            }
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input);
    });
}
function indexContent(indexPath) {
    return (0, featureSafety_1.readRegular)(indexPath, MAX_INDEX_BYTES);
}
function stateHash(content) {
    return content === undefined ? "missing" : (0, featureSafety_1.digest)(content);
}
function isDirty(file) {
    return vscode.workspace.textDocuments.some((document) => {
        if (!document.isDirty || document.uri.scheme !== "file")
            return false;
        if (path.resolve(document.uri.fsPath) === file)
            return true;
        try {
            return fs.realpathSync(document.uri.fsPath) === file;
        }
        catch {
            return false;
        }
    });
}
async function repository(root) {
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
    if (!top || fs.realpathSync(top) !== root) {
        throw new featureSafety_1.FeatureError("blocked", "Review requires the current workspace to be the repository root; parent repositories are not used.");
    }
    const gitDir = fs.realpathSync((await git(root, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim());
    const indexPath = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).toString("utf8").trim());
    if (path.dirname(indexPath) !== gitDir) {
        throw new featureSafety_1.FeatureError("unsupported", "A nonstandard Git index location is not supported.");
    }
    const partial = await git(root, ["config", "--get", "extensions.partialClone"], undefined, undefined, true);
    const promisor = await git(root, ["config", "--get-regexp", "^remote\\..*\\.promisor$"], undefined, undefined, true);
    if (partial.length || /\s(?:true|yes|on|1)\s*$/im.test(promisor.toString("utf8"))) {
        throw new featureSafety_1.FeatureError("unsupported", "Partial-clone review is disabled because reading missing objects may trigger a remote fetch.");
    }
    return { gitDir, indexPath };
}
async function currentHead(root) {
    const value = (await git(root, ["rev-parse", "--verify", "HEAD"], undefined, undefined, true)).toString("utf8").trim();
    if (value && !/^[a-f\d]{40,64}$/.test(value))
        throw new featureSafety_1.FeatureError("blocked", "Invalid Git revision.");
    return value;
}
async function entry(root, relative, head) {
    const output = await git(root, head === undefined ? ["ls-files", "--stage", "-z", "--", relative] : ["ls-tree", "-z", head, "--", relative]);
    const records = output.toString("utf8").split("\0").filter(Boolean);
    if (records.length > 1)
        throw new featureSafety_1.FeatureError("blocked", "Resolve this file's merge conflict in the IDE before review actions.");
    if (!records.length)
        return undefined;
    const match = /^(\d{6}) (?:blob )?([a-f\d]{40,64})(?: (\d))?\t/.exec(records[0]);
    if (!match || (head === undefined && match[3] !== "0") || !["100644", "100755"].includes(match[1])) {
        throw new featureSafety_1.FeatureError("unsupported", "Symlinks, submodules, and unmerged index entries cannot be changed by review.");
    }
    return { mode: match[1], oid: match[2] };
}
async function blob(root, value) {
    if (!value)
        return Buffer.alloc(0);
    const size = Number((await git(root, ["cat-file", "-s", value.oid])).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES)
        throw new featureSafety_1.FeatureError("unsupported", "This file exceeds the full-text review size limit (512 KiB).");
    const content = await git(root, ["cat-file", "blob", value.oid]);
    (0, featureSafety_1.plainText)(content);
    return content;
}
async function filterReason(root, relative) {
    const attributes = (await git(root, ["check-attr", "-z", "filter", "text", "eol", "working-tree-encoding", "ident", "--", relative])).toString("utf8").split("\0");
    for (let index = 2; index < attributes.length; index += 3) {
        if (attributes[index] !== "unspecified" && attributes[index] !== "unset") {
            return "Git content conversion is configured for this file. Use the IDE Git workflow to preserve filter/EOL semantics.";
        }
    }
    const autocrlf = (await git(root, ["config", "--get", "core.autocrlf"], undefined, undefined, true)).toString("utf8").trim();
    if (autocrlf && autocrlf !== "false")
        return "Git automatic line-ending conversion requires the IDE Git workflow.";
    const flags = (await git(root, ["ls-files", "-v", "-z", "--", relative])).toString("utf8");
    if (flags && !flags.startsWith("H "))
        return "Skip-worktree or assume-unchanged index entries require the IDE Git workflow.";
    return undefined;
}
async function listReviewPaths(root) {
    await repository(root);
    const head = await currentHead(root);
    const indexed = parseEntries(await git(root, ["ls-files", "--stage", "-z"]));
    const original = head ? parseEntries(await git(root, ["ls-tree", "-r", "-z", head])) : new Map();
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean);
    const trackFileMode = await tracksFileMode(root);
    const candidates = [...new Set([...indexed.keys(), ...original.keys(), ...untracked])];
    const result = [];
    let readBytes = 0;
    let count = 0;
    for (const relative of candidates) {
        if (count >= 10000 || readBytes >= 64 * 1024 * 1024)
            break;
        if (++count % 100 === 0)
            await new Promise((resolve) => setImmediate(resolve));
        const current = indexed.get(relative), previous = original.get(relative);
        if (current?.oid !== previous?.oid || current?.mode !== previous?.mode)
            result.push({ path: relative, layer: "index" });
        let changed = false;
        try {
            // git status/diff-files may execute clean filters. Hash raw bytes instead, with no hooks or conversion.
            const file = (0, featureSafety_1.safeFile)(root, relative);
            const content = (0, featureSafety_1.readRegular)(file, MAX_FILE_BYTES);
            if (content)
                readBytes += content.length;
            if (!current)
                changed = content !== undefined;
            else if (!content)
                changed = true;
            else {
                const oid = (0, crypto_1.createHash)(current.oid.length === 64 ? "sha256" : "sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
                changed = oid !== current.oid || (trackFileMode && (fs.statSync(file).mode & 0o111 ? "100755" : "100644") !== current.mode);
            }
        }
        catch {
            // Unsupported file types remain visible as unavailable, never silently reported clean.
            changed = true;
        }
        if (changed)
            result.push({ path: relative, layer: "worktree" });
    }
    return { items: result, truncated: count < candidates.length };
}
function parseEntries(output) {
    const result = new Map();
    for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
        const match = /^(\d{6}) (?:blob |tree |commit )?([a-f\d]{40,64})(?: (\d))?\t([\s\S]+)$/.exec(record);
        if (!match)
            throw new featureSafety_1.FeatureError("unsupported", "The Git index format could not be safely inspected.");
        result.set(match[4], { mode: match[1], oid: match[2] });
    }
    return result;
}
async function tracksFileMode(root) {
    return (await git(root, ["config", "--get", "core.filemode"], undefined, undefined, true)).toString("utf8").trim() !== "false";
}
async function captureReview(root, relative, layer) {
    (0, featureSafety_1.safeRelative)(relative);
    const file = (0, featureSafety_1.safeFile)(root, relative);
    const repo = await repository(root);
    const head = await currentHead(root);
    const indexHash = stateHash(indexContent(repo.indexPath));
    const headFileHash = stateHash((0, featureSafety_1.readRegular)(path.join(repo.gitDir, "HEAD"), 4096));
    const indexed = await entry(root, relative);
    const original = layer === "index" ? (head ? await entry(root, relative, head) : undefined) : indexed;
    const before = await blob(root, original);
    const disk = (0, featureSafety_1.readRegular)(file, MAX_FILE_BYTES);
    if (disk)
        (0, featureSafety_1.plainText)(disk);
    const after = layer === "index" ? await blob(root, indexed) : disk ?? Buffer.alloc(0);
    const beforeExists = !!original;
    const afterExists = layer === "index" ? !!indexed : disk !== undefined;
    const beforeMode = original?.mode ?? "100644";
    const trackFileMode = await tracksFileMode(root);
    const diskMode = disk === undefined ? 0 : fs.statSync(file).mode & 0o777;
    const afterMode = layer === "index" ? indexed?.mode ?? "100644"
        : !trackFileMode ? indexed?.mode ?? "100644" : disk === undefined ? "100644" : (diskMode & 0o111 ? "100755" : "100644");
    const mutationReason = layer === "index" ? "Staged revisions are read-only here. Revert applies only to working changes and preserves the index." : await filterReason(root, relative);
    const dirty = isDirty(file);
    const diskHash = stateHash(disk);
    const revision = (0, featureSafety_1.digest)(JSON.stringify([root, relative, layer, head, indexHash, headFileHash, stateHash(beforeExists ? before : undefined), stateHash(afterExists ? after : undefined), beforeMode, afterMode, diskHash, diskMode, trackFileMode]));
    if (indexHash !== stateHash(indexContent(repo.indexPath)) || head !== await currentHead(root)
        || diskHash !== stateHash((0, featureSafety_1.readRegular)((0, featureSafety_1.safeFile)(root, relative), MAX_FILE_BYTES))) {
        throw new featureSafety_1.FeatureError("conflict", "The repository changed while the review was captured. Refresh the list.");
    }
    const gitHashLength = indexed?.oid.length ?? original?.oid.length ?? (head.length || 40);
    return { path: relative, layer, root, ...repo, head, indexHash, headFileHash, gitHashLength, before, after, beforeExists, afterExists, beforeMode, afterMode, diskHash, diskMode, trackFileMode, revision, dirty, mutationReason };
}
function assertDiskAndIndex(review) {
    const file = (0, featureSafety_1.safeFile)(review.root, review.path);
    if (isDirty(file))
        throw new featureSafety_1.FeatureError("blocked", "This file has unsaved editor changes. Save or resolve them explicitly before stage/revert; no buffer was changed.");
    if (stateHash(indexContent(review.indexPath)) !== review.indexHash
        || stateHash((0, featureSafety_1.readRegular)(path.join(review.gitDir, "HEAD"), 4096)) !== review.headFileHash
        || stateHash((0, featureSafety_1.readRegular)(file, MAX_FILE_BYTES)) !== review.diskHash
        || (review.afterExists && (fs.statSync(file).mode & 0o777) !== review.diskMode)) {
        throw new featureSafety_1.FeatureError("conflict", "The file or Git index changed since review. Refresh before applying an action.");
    }
    return file;
}
async function mutateReview(review, operation, scopeRoot, assertContext) {
    if (review.layer !== "worktree" || review.mutationReason)
        throw new featureSafety_1.FeatureError("unsupported", review.mutationReason ?? "Only working changes can be staged or reverted.");
    if (operation === "revert" && (0, featureSafety_1.contained)(review.root, scopeRoot))
        throw new featureSafety_1.FeatureError("blocked", "Recovery storage must be outside the watched project tree.");
    const repo = await repository(review.root);
    if (repo.gitDir !== review.gitDir || repo.indexPath !== review.indexPath)
        throw new featureSafety_1.FeatureError("conflict", "The repository identity changed.");
    assertContext();
    const lockPath = `${review.indexPath}.lock`;
    let lock;
    try {
        lock = fs.openSync(lockPath, "wx", 0o600);
    }
    catch {
        throw new featureSafety_1.FeatureError("blocked", "The Git index is busy. Another Git operation may be running; its lock was not removed.");
    }
    const lockIdentity = fs.fstatSync(lock);
    const ownsLock = () => {
        try {
            const current = fs.lstatSync(lockPath);
            return current.isFile() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino;
        }
        catch {
            return false;
        }
    };
    let temporaryIndex;
    let temporaryFile;
    let committed = false;
    try {
        assertDiskAndIndex(review);
        if (review.head !== await currentHead(review.root))
            throw new featureSafety_1.FeatureError("conflict", "HEAD changed since review. Refresh the list.");
        if (review.trackFileMode !== await tracksFileMode(review.root))
            throw new featureSafety_1.FeatureError("conflict", "Git executable-bit handling changed since review.");
        if (await filterReason(review.root, review.path))
            throw new featureSafety_1.FeatureError("conflict", "Git content conversion or index flags changed since review.");
        if (operation === "stage") {
            temporaryIndex = path.join(review.gitDir, `codex-review-${(0, featureSafety_1.opaqueId)()}.index`);
            const previous = indexContent(review.indexPath);
            if (previous)
                fs.writeFileSync(temporaryIndex, previous, { flag: "wx", mode: 0o600 });
            else
                await git(review.root, ["read-tree", "--empty"], undefined, temporaryIndex);
            const oid = review.afterExists ? (await git(review.root, ["hash-object", "-w", "--stdin"], review.after)).toString("utf8").trim() : "0".repeat(review.gitHashLength);
            if (!/^[a-f\d]{40,64}$/.test(oid))
                throw new featureSafety_1.FeatureError("error", "Git did not return a valid blob revision.");
            await git(review.root, ["update-index", "-z", "--index-info"], Buffer.from(`${review.afterExists ? review.afterMode : "0"} ${oid}\t${review.path}\0`), temporaryIndex);
            const updated = indexContent(temporaryIndex);
            if (!updated)
                throw new featureSafety_1.FeatureError("error", "Git did not produce an updated index.");
            fs.writeFileSync(lock, updated);
            fs.fsyncSync(lock);
            if (review.head !== await currentHead(review.root))
                throw new featureSafety_1.FeatureError("conflict", "HEAD changed during staging.");
            assertContext();
            assertDiskAndIndex(review);
            if (!ownsLock())
                throw new featureSafety_1.FeatureError("conflict", "The owned Git index lock was replaced. No index update was published.");
            fs.closeSync(lock);
            lock = -1;
            fs.renameSync(lockPath, review.indexPath);
            committed = true;
            return {};
        }
        const recoveryId = (0, featureSafety_1.opaqueId)();
        const backupDirectory = (0, featureSafety_1.safeFile)(scopeRoot, "review-recovery");
        fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        const backup = (0, featureSafety_1.safeFile)(scopeRoot, `review-recovery/${recoveryId}.json`);
        const descriptor = fs.openSync(backup, "wx", 0o600);
        try {
            fs.writeFileSync(descriptor, JSON.stringify({ version: 1, path: review.path, revision: review.revision, exists: review.afterExists, mode: review.afterMode, contentBase64: review.after.toString("base64") }));
            fs.fsyncSync(descriptor);
        }
        finally {
            fs.closeSync(descriptor);
        }
        let file = assertDiskAndIndex(review);
        if (review.beforeExists) {
            // Only recreate missing directories inside the already validated workspace.
            fs.mkdirSync(path.dirname(file), { recursive: true });
            file = (0, featureSafety_1.safeFile)(review.root, review.path);
            temporaryFile = path.join(path.dirname(file), `.codex-revert-${(0, featureSafety_1.opaqueId)()}`);
            const permissions = review.afterExists ? review.diskMode & 0o666 : 0o644;
            const mode = permissions | (review.beforeMode === "100755" ? (permissions & 0o444) >> 2 : 0);
            const descriptor = fs.openSync(temporaryFile, "wx", mode);
            try {
                fs.writeFileSync(descriptor, review.before);
                fs.fsyncSync(descriptor);
            }
            finally {
                fs.closeSync(descriptor);
            }
        }
        if (review.head !== await currentHead(review.root))
            throw new featureSafety_1.FeatureError("conflict", "HEAD changed during revert.");
        assertContext();
        file = assertDiskAndIndex(review);
        if (!ownsLock())
            throw new featureSafety_1.FeatureError("conflict", "The owned Git index lock was replaced. No working-file replacement was performed.");
        if (!review.beforeExists) {
            if (review.afterExists)
                fs.unlinkSync(file);
        }
        else if (temporaryFile) {
            if (review.afterExists)
                fs.renameSync(temporaryFile, file);
            else {
                fs.linkSync(temporaryFile, file);
                fs.unlinkSync(temporaryFile);
            }
            temporaryFile = undefined;
        }
        return { recoveryId };
    }
    finally {
        if (lock >= 0)
            fs.closeSync(lock);
        if (!committed && ownsLock())
            fs.rmSync(lockPath, { force: true });
        if (temporaryIndex) {
            fs.rmSync(temporaryIndex, { force: true });
            fs.rmSync(`${temporaryIndex}.lock`, { force: true });
        }
        if (temporaryFile)
            fs.rmSync(temporaryFile, { force: true });
    }
}
//# sourceMappingURL=featureGitReview.js.map