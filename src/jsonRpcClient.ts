import * as vscode from "vscode";

export type JsonRpcId = number | string;

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class JsonRpcClient implements vscode.Disposable {
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(
    private readonly sendLine: (line: string) => void,
    private readonly onNotification: (notification: JsonRpcNotification) => void,
    private readonly onServerRequest?: (request: JsonRpcServerRequest) => Promise<unknown> | unknown
  ) {}

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
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
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(`${method}: send failed`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      throw new Error("JSON-RPC client already disposed.");
    }
    const payload = params === undefined ? { method } : { method, params };
    this.sendLine(JSON.stringify(payload));
  }

  handleLine(line: string): boolean {
    let payload: unknown;

    try {
      payload = JSON.parse(line);
    } catch {
      return false;
    }

    if (!isObject(payload)) {
      return true;
    }

    if (
      "id" in payload &&
      (typeof payload.id === "number" || typeof payload.id === "string") &&
      typeof payload.method === "string"
    ) {
      void this.handleServerRequest(payload as unknown as JsonRpcServerRequest);
      return true;
    }

    if ("id" in payload && (typeof payload.id === "number" || typeof payload.id === "string")) {
      this.handleResponse(payload as unknown as JsonRpcResponse);
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

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: JSON-RPC client disposed.`));
    }
    this.pending.clear();
  }

  private handleResponse(response: JsonRpcResponse): void {
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

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    if (!this.onServerRequest) {
      this.sendError(request.id, -32601, `Server request method is not supported: ${request.method}`);
      return;
    }

    try {
      const result = await this.onServerRequest(request);
      this.sendResult(request.id, result ?? {});
    } catch (error) {
      this.sendError(
        request.id,
        -32603,
        error instanceof Error ? error.message : "Server request handling failed."
      );
    }
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    if (!this.disposed) {
      this.sendLine(JSON.stringify({ id, result }));
    }
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    if (!this.disposed) {
      this.sendLine(JSON.stringify({ id, error: { code, message } }));
    }
  }
}

function createJsonRpcError(method: string, error: NonNullable<JsonRpcResponse["error"]>): Error {
  const message = error.message || "Unknown JSON-RPC error";
  const code = error.code === undefined ? "" : ` code=${error.code}`;
  return new Error(`${method}: ${message}${code}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
