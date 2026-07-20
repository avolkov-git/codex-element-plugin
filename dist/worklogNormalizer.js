"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorklogOperationNormalizer = void 0;
const MAX_CHILDREN_PER_PARENT = {
    command: 6,
    search: 8,
    read: 8,
    file: 8,
    tool: 6
};
class WorklogOperationNormalizer {
    constructor() {
        this.itemBindings = new Map();
        this.childCountsByParent = new Map();
        this.childStatusesByParent = new Map();
        this.parentBatches = new Map();
    }
    applyItemStarted(params) {
        return this.applyItemEvent(params, "running");
    }
    applyItemCompleted(params) {
        return this.applyItemEvent(params, "completed");
    }
    outputPatch(params) {
        const itemId = extractItemId(params);
        if (!itemId) {
            return undefined;
        }
        const binding = this.itemBindings.get(itemId);
        if (!binding?.childId) {
            return undefined;
        }
        return {
            worklogId: binding.worklogId,
            childId: binding.childId
        };
    }
    forgetItem(params) {
        const itemId = extractItemId(params);
        if (itemId) {
            this.itemBindings.delete(itemId);
        }
    }
    applyItemEvent(params, status) {
        const descriptor = normalizeItem(params);
        if (!descriptor) {
            return undefined;
        }
        const itemId = extractItemId(params);
        const turnId = extractTurnId(params);
        const existingBinding = itemId ? this.itemBindings.get(itemId) : undefined;
        const parentId = existingBinding?.worklogId ?? this.resolveParentId(turnId, itemId, descriptor.kind);
        const createdAt = new Date().toISOString();
        const effectiveStatus = descriptor.status ?? status;
        const child = shouldCreateChild(descriptor)
            ? {
                id: existingBinding?.childId ?? childWorklogId(parentId, itemId, descriptor),
                kind: descriptor.kind,
                status: effectiveStatus,
                title: descriptor.title,
                source: descriptor.source,
                query: descriptor.query,
                path: descriptor.path,
                command: descriptor.command,
                server: descriptor.server,
                tool: descriptor.tool,
                argumentsPreview: descriptor.argumentsPreview,
                resultCount: descriptor.resultCount,
                outputPreview: descriptor.outputPreview,
                createdAt,
                completedAt: effectiveStatus === "completed" || effectiveStatus === "error" ? createdAt : undefined
            }
            : undefined;
        if (itemId) {
            this.itemBindings.set(itemId, {
                worklogId: parentId,
                childId: child?.id ?? existingBinding?.childId,
                operationKind: descriptor.kind,
                turnId: turnId || undefined
            });
        }
        if (child) {
            const previous = this.childCountsByParent.get(parentId) ?? 0;
            this.childCountsByParent.set(parentId, Math.max(previous, previous + (existingBinding?.childId === child.id ? 0 : 1), 1));
            const statuses = this.childStatusesByParent.get(parentId) ?? new Map();
            statuses.set(child.id, effectiveStatus);
            this.childStatusesByParent.set(parentId, statuses);
        }
        const parentStatus = parentStatusFor(parentId, this.childStatusesByParent, effectiveStatus);
        return {
            id: parentId,
            operationKind: descriptor.kind,
            status: parentStatus,
            title: parentTitle(descriptor.kind, parentStatus, this.childCountsByParent.get(parentId) ?? (child ? 1 : 0)),
            turnId: turnId || undefined,
            children: child ? [child] : undefined
        };
    }
    resolveParentId(turnId, itemId, kind) {
        const baseKey = parentWorklogBaseKey(turnId, itemId, kind);
        const batch = this.parentBatches.get(baseKey) ?? { generation: 0, count: 0 };
        const maxChildren = MAX_CHILDREN_PER_PARENT[kind] ?? Number.POSITIVE_INFINITY;
        if (batch.count >= maxChildren) {
            batch.generation += 1;
            batch.count = 0;
        }
        batch.count += 1;
        this.parentBatches.set(baseKey, batch);
        return parentWorklogId(baseKey, batch.generation);
    }
}
exports.WorklogOperationNormalizer = WorklogOperationNormalizer;
function parentStatusFor(parentId, statusesByParent, fallback) {
    const statuses = statusesByParent.get(parentId);
    if (!statuses?.size) {
        return fallback;
    }
    const values = [...statuses.values()];
    if (values.some((status) => status === "running")) {
        return "running";
    }
    if (values.some((status) => status === "error")) {
        return "error";
    }
    return "completed";
}
function normalizeItem(params) {
    const item = extractItemRecord(params);
    const type = extractItemType(params);
    const normalizedType = type.toLowerCase();
    if (type === "agentMessage"
        || type === "userMessage"
        || type === "hookPrompt"
        || type === "contextCompaction"
        || type === "plan"
        || type === "reasoning") {
        return undefined;
    }
    const command = extractFirstString(item, ["command", "cmd", "shellCommand", "argv", "commandLine"]);
    if (type === "commandExecution" || normalizedType.includes("command")) {
        const title = command ? simplifyShellCommand(command) : "Команда";
        return {
            kind: "command",
            source: "shell",
            title,
            command,
            outputPreview: limitText(extractFirstString(item, ["output", "stdout", "stderr", "result", "preview"]), 1200)
        };
    }
    const filePath = extractFirstString(item, ["path", "filePath", "absolutePath", "targetPath"]);
    const summary = extractFirstString(item, ["summary", "message", "description", "title"]);
    if (type === "mcpToolCall") {
        const server = getString(item.server);
        const tool = getString(item.tool);
        const appContext = isRecord(item.appContext) ? item.appContext : {};
        const appName = getString(appContext.appName);
        const statusValue = getString(item.status);
        const error = isRecord(item.error) ? getString(item.error.message) : "";
        return {
            kind: "tool",
            source: "runtime",
            title: mcpToolTitle(server, tool, appName),
            server: server || undefined,
            tool: tool || undefined,
            argumentsPreview: safeJsonPreview(item.arguments, 900),
            outputPreview: limitText(error || mcpResultPreview(item.result), 1200),
            status: statusValue === "failed" || error ? "error" : statusValue === "completed" ? "completed" : "running"
        };
    }
    if (type === "fileChange"
        || (normalizedType.includes("file") && /change|patch|edit|write|create|delete|rename/.test(normalizedType))) {
        return {
            kind: "file",
            source: "project",
            title: filePath ? `Изменение ${shortPath(filePath)}` : summary || "Изменение файлов",
            path: filePath,
            outputPreview: limitText(extractFirstString(item, ["output", "stdout", "stderr", "result", "preview"]), 1200)
        };
    }
    if (type === "readFile" || normalizedType.includes("readfile") || normalizedType.includes("read_file")) {
        return {
            kind: "read",
            source: classifyPathSource(filePath),
            title: filePath ? `Чтение ${shortPath(filePath)}` : summary || "Чтение файла",
            path: filePath
        };
    }
    if (type === "webSearch" || normalizedType.includes("search") || normalizedType.includes("grep")) {
        const query = extractFirstString(item, ["query", "pattern", "searchQuery", "needle", "regex", "term", "glob"]);
        const searchPath = extractFirstString(item, ["directory", "folder", "cwd", "root", "path", "filePath", "targetPath"]);
        const source = classifySearchSource(query, searchPath, type, normalizedType);
        return {
            kind: "search",
            source,
            title: searchTitle(query, searchPath, source, summary),
            query,
            path: searchPath,
            resultCount: extractFirstNumber(item, ["resultCount", "count", "matches", "total"]) ?? undefined,
            outputPreview: limitText(extractFirstString(item, ["output", "stdout", "stderr", "result", "preview"]), 1200)
        };
    }
    if ((normalizedType.includes("tool") || normalizedType.includes("mcp")) && summary) {
        return {
            kind: "tool",
            source: "runtime",
            title: summary,
            outputPreview: limitText(extractFirstString(item, ["output", "stdout", "stderr", "result", "preview"]), 1200)
        };
    }
    return undefined;
}
function shouldCreateChild(descriptor) {
    if (descriptor.command || descriptor.query || descriptor.path || descriptor.server || descriptor.tool || descriptor.argumentsPreview || descriptor.outputPreview || typeof descriptor.resultCount === "number") {
        return true;
    }
    return false;
}
function parentWorklogBaseKey(turnId, itemId, kind) {
    return `worklog-${turnId || itemId || "runtime"}-${kind}`;
}
function parentWorklogId(baseKey, generation) {
    return generation > 0 ? `${baseKey}-${generation}` : baseKey;
}
function childWorklogId(parentId, itemId, descriptor) {
    const basis = itemId || descriptor.command || descriptor.query || descriptor.path || descriptor.title;
    return `${parentId}-child-${hashText(basis)}`;
}
function parentTitle(kind, status, count) {
    const safeCount = Math.max(0, count);
    if (kind === "search") {
        if (status === "error")
            return "Поиск завершился с ошибкой";
        if (status === "completed")
            return safeCount > 1 ? `Выполнено ${safeCount} ${plural(safeCount, "поиск", "поиска", "поисков")}` : "Выполнен поиск";
        return safeCount > 1 ? `Выполняется ${safeCount} ${plural(safeCount, "поиск", "поиска", "поисков")}` : "Выполняется поиск";
    }
    if (kind === "command") {
        if (status === "error")
            return "Команды завершились с ошибкой";
        if (status === "completed")
            return safeCount > 1 ? `Выполнено ${safeCount} ${plural(safeCount, "команда", "команды", "команд")}` : "Выполнена команда";
        return safeCount > 1 ? `Выполняется ${safeCount} ${plural(safeCount, "команда", "команды", "команд")}` : "Выполняется команда";
    }
    if (kind === "file") {
        if (status === "error")
            return "Операции с файлами завершились с ошибкой";
        if (status === "completed")
            return safeCount > 1 ? `Изменено ${safeCount} ${plural(safeCount, "файл", "файла", "файлов")}` : "Изменён файл";
        return safeCount > 1 ? `Изменяется ${safeCount} ${plural(safeCount, "файл", "файла", "файлов")}` : "Изменяется файл";
    }
    if (kind === "read") {
        if (status === "completed")
            return safeCount > 1 ? `Изучено ${safeCount} ${plural(safeCount, "файл", "файла", "файлов")}` : "Изучен файл";
        return safeCount > 1 ? `Изучается ${safeCount} ${plural(safeCount, "файл", "файла", "файлов")}` : "Изучается файл";
    }
    if (kind === "reasoning") {
        return status === "completed" ? "Думал" : "Думает";
    }
    if (kind === "diagnostics") {
        return status === "completed" ? "Проверены ошибки IDE" : "Проверяются ошибки IDE";
    }
    if (kind === "context") {
        return status === "completed" ? "Контекст подготовлен" : "Готовится контекст";
    }
    if (status === "error")
        return safeCount > 1 ? "Инструменты завершились с ошибкой" : "Инструмент завершился с ошибкой";
    if (status === "completed")
        return safeCount > 1 ? `Выполнено ${safeCount} ${plural(safeCount, "инструмент", "инструмента", "инструментов")}` : "Инструмент выполнен";
    return safeCount > 1 ? `Выполняется ${safeCount} ${plural(safeCount, "инструмент", "инструмента", "инструментов")}` : "Выполняется инструмент";
}
function mcpToolTitle(server, tool, appName) {
    const source = appName || server || "MCP";
    return tool ? `${source}: ${tool}` : source;
}
function mcpResultPreview(value) {
    if (!isRecord(value)) {
        return safeJsonPreview(value, 1200) ?? "";
    }
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content
        .map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "")
        .filter(Boolean)
        .join("\n");
    if (text) {
        return redactText(text);
    }
    return safeJsonPreview(value.structuredContent ?? value, 1200) ?? "";
}
function safeJsonPreview(value, maxLength) {
    if (value === undefined || value === null) {
        return undefined;
    }
    try {
        const sanitized = sanitizeStructuredValue(value, new WeakSet());
        const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized, null, 2);
        return limitText(redactText(text), maxLength);
    }
    catch {
        return undefined;
    }
}
function sanitizeStructuredValue(value, seen) {
    if (typeof value === "string") {
        return redactText(value);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return "[циклическая ссылка]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, 30).map((entry) => sanitizeStructuredValue(entry, seen));
    }
    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, 40)) {
        output[key] = isSensitiveKey(key) ? "[скрыто]" : sanitizeStructuredValue(nested, seen);
    }
    return output;
}
function isSensitiveKey(key) {
    return /token|secret|password|authorization|api[-_]?key|cookie|credential/i.test(key);
}
function redactText(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [скрыто]")
        .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[скрыто]");
}
function searchTitle(query, searchPath, source, summary) {
    const terms = humanSearchTerms(query || summary);
    const target = searchTargetLabel(query, searchPath, source);
    if (terms && target) {
        return `Поиск ${terms} в ${target}`;
    }
    if (terms) {
        return `Поиск ${terms}`;
    }
    if (target) {
        return `Поиск в ${target}`;
    }
    return summary || "Поиск";
}
function humanSearchTerms(query) {
    const value = query.replace(/\bsite:\S+/ig, "").trim();
    const quoted = [...value.matchAll(/"([^"]{1,80})"/g)]
        .map((match) => match[1]?.trim())
        .filter(Boolean)
        .slice(0, 3);
    if (quoted.length) {
        return quoted.map((term) => `"${term}"`).join(" ");
    }
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned ? `"${shorten(cleaned, 80)}"` : "";
}
function searchTargetLabel(query, searchPath, source) {
    if (source === "docs") {
        const docsPath = docsPathFromQuery(query) || docsPathFromPath(searchPath);
        return docsPath ? `${docsPath}` : "документации 1C: Element";
    }
    if (source === "project") {
        return searchPath ? `проекте: ${shortPath(searchPath)}` : "проекте";
    }
    if (source === "web") {
        return "web";
    }
    return searchPath ? shortPath(searchPath) : "";
}
function docsPathFromQuery(query) {
    const match = query.match(/1cmycloud\.com\/console\/help\/(?:lang\/docs\/)?([^"\s]+)/i);
    return match?.[1] ? match[1].replace(/\/+/g, "/") : "";
}
function docsPathFromPath(value) {
    const normalized = value.replace(/\\/g, "/");
    const marker = normalized.match(/(?:docs\/help\/ru|ai-docs[^/]*)\/(.+)$/i);
    return marker?.[1] ? marker[1] : "";
}
function classifySearchSource(query, searchPath, type, normalizedType) {
    if (/site:1cmycloud\.com|1cmycloud\.com\/console\/help/i.test(query)) {
        return "docs";
    }
    if (type === "webSearch") {
        return "web";
    }
    if (normalizedType.includes("grep")) {
        return searchPath ? classifyPathSource(searchPath) : "project";
    }
    return classifyPathSource(searchPath);
}
function classifyPathSource(value) {
    const normalized = value.replace(/\\/g, "/").toLowerCase();
    if (!normalized) {
        return "runtime";
    }
    if (normalized.includes("/docs/") || normalized.includes("ai-docs") || normalized.includes("normalized-docs")) {
        return "docs";
    }
    if (normalized.includes("/workspace/") || normalized.includes("1c-element-workspace") || normalized.includes(".local-codex")) {
        return "project";
    }
    return "runtime";
}
function simplifyShellCommand(command) {
    const raw = command
        .replace(/\\"/g, '"')
        .trim();
    const powershell = raw.match(/\s-Command\s+(['"])([\s\S]*?)\1/i) ?? raw.match(/\s-Command\s+([\s\S]*)$/i);
    const value = (powershell?.[2] || powershell?.[1] || raw)
        .replace(/^(['"])([\s\S]*)\1$/, "$2")
        .replace(/\s+/g, " ")
        .replace(/\bGet-Content\s+-Raw\b/ig, "Get-Content")
        .trim();
    return shorten(value, 140);
}
function shortPath(value) {
    return shorten(value.replace(/\\/g, "/"), 120);
}
function shorten(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    const head = Math.max(20, Math.floor((maxLength - 3) * 0.58));
    const tail = Math.max(12, maxLength - head - 3);
    return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}
function plural(count, one, few, many) {
    if (count % 10 === 1 && count % 100 !== 11)
        return one;
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100))
        return few;
    return many;
}
function extractItemRecord(value) {
    const root = isRecord(value) ? value : {};
    return isRecord(root.item) ? root.item : root;
}
function extractItemId(value) {
    const root = isRecord(value) ? value : {};
    return getString(root.itemId) || (isRecord(root.item) ? getString(root.item.id) : "");
}
function extractTurnId(value) {
    const root = isRecord(value) ? value : {};
    return getString(root.turnId) || (isRecord(root.turn) ? getString(root.turn.id) : "");
}
function extractItemType(value) {
    const root = isRecord(value) ? value : {};
    return getString(root.type) || (isRecord(root.item) ? getString(root.item.type) : "");
}
function extractFirstString(value, keys) {
    for (const key of keys) {
        const found = findStringByKey(value, key);
        if (found) {
            return found;
        }
    }
    return "";
}
function findStringByKey(value, key) {
    if (!isRecord(value)) {
        if (Array.isArray(value) && (key === "argv" || key === "command")) {
            return value.map((part) => typeof part === "string" ? part : "").filter(Boolean).join(" ");
        }
        return "";
    }
    if (typeof value[key] === "string") {
        return value[key];
    }
    if (Array.isArray(value[key]) && (key === "argv" || key === "command")) {
        return value[key].map((part) => typeof part === "string" ? part : "").filter(Boolean).join(" ");
    }
    for (const nested of Object.values(value)) {
        const found = findStringByKey(nested, key);
        if (found) {
            return found;
        }
    }
    return "";
}
function extractFirstNumber(value, keys) {
    if (!isRecord(value)) {
        return null;
    }
    for (const key of keys) {
        const found = findNumberByKey(value, key);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
function findNumberByKey(value, key) {
    if (!isRecord(value)) {
        return null;
    }
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
        return value[key];
    }
    for (const nested of Object.values(value)) {
        const found = findNumberByKey(nested, key);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
function hashText(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(16);
}
function limitText(value, maxLength) {
    if (!value) {
        return undefined;
    }
    return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function getString(value) {
    return typeof value === "string" ? value : "";
}
//# sourceMappingURL=worklogNormalizer.js.map