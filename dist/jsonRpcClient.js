"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonRpcClient = void 0;
class JsonRpcClient {
    constructor(sendLine, onNotification, onServerRequest) {
        this.sendLine = sendLine;
        this.onNotification = onNotification;
        this.onServerRequest = onServerRequest;
        this.nextId = 1;
        this.disposed = false;
        this.pending = new Map();
    }
    request(method, params, timeoutMs = 15000) {
        if (this.disposed) {
            return Promise.reject(new Error("JSON-RPC client already disposed."));
        }
        const id = this.nextId++;
        const payload = params === undefined ? { id, method } : { id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            try {
                this.sendLine(JSON.stringify(payload));
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(`${method}: send failed`));
            }
        });
    }
    notify(method, params) {
        if (this.disposed) {
            throw new Error("JSON-RPC client already disposed.");
        }
        const payload = params === undefined ? { method } : { method, params };
        this.sendLine(JSON.stringify(payload));
    }
    handleLine(line) {
        let payload;
        try {
            payload = JSON.parse(line);
        }
        catch {
            return false;
        }
        if (!isObject(payload)) {
            return true;
        }
        if ("id" in payload &&
            (typeof payload.id === "number" || typeof payload.id === "string") &&
            typeof payload.method === "string") {
            void this.handleServerRequest(payload);
            return true;
        }
        if ("id" in payload && (typeof payload.id === "number" || typeof payload.id === "string")) {
            this.handleResponse(payload);
            return true;
        }
        if (typeof payload.method === "string") {
            this.onNotification({
                method: payload.method,
                params: "params" in payload ? payload.params : undefined
            });
            return true;
        }
        return true;
    }
    dispose() {
        this.disposed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`${pending.method}: JSON-RPC client disposed.`));
        }
        this.pending.clear();
    }
    handleResponse(response) {
        const fallbackId = typeof response.id === "string" ? Number(response.id) : response.id;
        const pending = this.pending.get(response.id) ?? this.pending.get(fallbackId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        this.pending.delete(fallbackId);
        if (response.error) {
            pending.reject(createJsonRpcError(pending.method, response.error));
            return;
        }
        pending.resolve(response.result);
    }
    async handleServerRequest(request) {
        if (!this.onServerRequest) {
            this.sendError(request.id, -32601, `Server request method is not supported: ${request.method}`);
            return;
        }
        try {
            const result = await this.onServerRequest(request);
            this.sendResult(request.id, result ?? {});
        }
        catch (error) {
            this.sendError(request.id, -32603, error instanceof Error ? error.message : "Server request handling failed.");
        }
    }
    sendResult(id, result) {
        if (!this.disposed) {
            this.sendLine(JSON.stringify({ id, result }));
        }
    }
    sendError(id, code, message) {
        if (!this.disposed) {
            this.sendLine(JSON.stringify({ id, error: { code, message } }));
        }
    }
}
exports.JsonRpcClient = JsonRpcClient;
function createJsonRpcError(method, error) {
    const message = error.message || "Unknown JSON-RPC error";
    const code = error.code === undefined ? "" : ` code=${error.code}`;
    return new Error(`${method}: ${message}${code}`);
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=jsonRpcClient.js.map