import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import * as vscode from "vscode";
import { Logger } from "./logger";

const DEFAULT_MCP_URL = "http://127.0.0.1:9900";
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const GIT_STATUS_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

interface HttpResult {
  statusCode: number;
  body: string;
}

interface ElementGitStatus {
  commitId?: string;
  branchName?: string;
  modified?: boolean;
  aheadBehind?: { ahead: number; behind: number };
  commandStatus?: string;
  currentHead?: string;
}

export class ElementMcpIdeBridgeService implements vscode.Disposable {
  private readonly configurationSubscription: vscode.Disposable;
  private readonly workspaceSubscription: vscode.Disposable;
  private readonly timer: NodeJS.Timeout;
  private syncPromise: Promise<void> | undefined;
  private lastCsrfToken = "";
  private lastContextFingerprint = "";
  private lastWarning = "";
  private disposed = false;

  constructor(private readonly logger: Logger) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("1C.server")
        || event.affectsConfiguration("1C.clientId")
        || event.affectsConfiguration("1C.clientSecret")
        || event.affectsConfiguration("1C.projectId")
        || event.affectsConfiguration("codexElement.elementMcpUrl")
      ) {
        this.lastContextFingerprint = "";
        void this.sync();
      }
    });
    this.workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.lastContextFingerprint = "";
      void this.sync();
    });
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.sync(), 1_500).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.configurationSubscription.dispose();
    this.workspaceSubscription.dispose();
  }

  async sync(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.syncPromise) {
      return this.syncPromise;
    }
    const promise = this.performSync();
    this.syncPromise = promise;
    try {
      await promise;
    } finally {
      if (this.syncPromise === promise) {
        this.syncPromise = undefined;
      }
    }
  }

  private async performSync(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration();
    const server = configuration.get<string>("1C.server", "").trim();
    const clientId = configuration.get<string>("1C.clientId", "").trim();
    const clientSecret = configuration.get<string>("1C.clientSecret", "").trim();
    const projectId = configuration.get<string>("1C.projectId", "").trim();
    if (!server || !clientId || !clientSecret) {
      return;
    }

    let mcpBaseUrl: URL;
    try {
      const configured = vscode.workspace.getConfiguration("codexElement").get<string>("elementMcpUrl", DEFAULT_MCP_URL).trim();
      mcpBaseUrl = normalizeLocalMcpUrl(configured || DEFAULT_MCP_URL);
    } catch (error) {
      this.warnOnce(normalizeError(error));
      return;
    }

    const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    const gitStatus = await readElementGitStatus();
    const payload = {
      server,
      client_id: clientId,
      client_secret: clientSecret,
      workspace_folders: workspaceFolders,
      ...(projectId ? { project_id: projectId } : {}),
      ...(gitStatus ? { git_status: gitStatus } : {})
    };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    try {
      const page = await requestText(new URL("/", mcpBaseUrl), { method: "GET" });
      if (page.statusCode !== 200) {
        throw new Error(`1C Element MCP вернул HTTP ${page.statusCode}.`);
      }
      const csrfToken = extractCsrfToken(page.body);
      if (csrfToken === this.lastCsrfToken && fingerprint === this.lastContextFingerprint) {
        return;
      }
      const body = JSON.stringify(payload);
      const response = await requestText(new URL("/api/integrations/element-console", mcpBaseUrl), {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "X-Element-MCP-Token": csrfToken
        }
      });
      if (response.statusCode !== 200) {
        const message = safeResponseMessage(response.body) || `HTTP ${response.statusCode}`;
        throw new Error(`MCP отклонил контекст IDE: ${message}`);
      }
      this.lastCsrfToken = csrfToken;
      this.lastContextFingerprint = fingerprint;
      this.lastWarning = "";
      this.logger.info(
        `Element MCP IDE bridge synchronized ${workspaceFolders.length} workspace folder(s); `
        + "Console credentials remain outside the Codex turn context."
      );
    } catch (error) {
      this.warnOnce(normalizeError(error));
    }
  }

  private warnOnce(message: string): void {
    if (message === this.lastWarning) {
      return;
    }
    this.lastWarning = message;
    this.logger.warn(`Element MCP IDE bridge is not synchronized: ${message}`);
  }
}

async function readElementGitStatus(): Promise<ElementGitStatus | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      vscode.commands.executeCommand<unknown>("g5rt.team.status"),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), GIT_STATUS_TIMEOUT_MS);
        timeout.unref?.();
      })
    ]);
    return normalizeElementGitStatus(raw);
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeElementGitStatus(value: unknown): ElementGitStatus | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const result: ElementGitStatus = {};
  for (const key of ["commitId", "branchName", "commandStatus", "currentHead"] as const) {
    const field = source[key];
    if (typeof field === "string" && field.length <= 512) {
      result[key] = field;
    }
  }
  if (typeof source.modified === "boolean") {
    result.modified = source.modified;
  }
  const aheadBehind = source.aheadBehind;
  if (aheadBehind && typeof aheadBehind === "object") {
    const counters = aheadBehind as Record<string, unknown>;
    if (
      Number.isInteger(counters.ahead)
      && Number.isInteger(counters.behind)
      && Number(counters.ahead) >= 0
      && Number(counters.behind) >= 0
    ) {
      result.aheadBehind = { ahead: Number(counters.ahead), behind: Number(counters.behind) };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeLocalMcpUrl(value: string): URL {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  if (!(["127.0.0.1", "localhost", "::1"].includes(hostname))) {
    throw new Error("Автоматическая передача контекста IDE разрешена только локальному MCP на loopback-интерфейсе.");
  }
  if (!(["http:", "https:"].includes(parsed.protocol))) {
    throw new Error("Адрес 1C Element MCP должен использовать HTTP или HTTPS.");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed;
}

function extractCsrfToken(document: string): string {
  const match = document.match(/<meta\s+name=["']element-mcp-token["']\s+content=["']([^"']+)["']/i);
  if (!match?.[1]) {
    throw new Error("Локальный сервер не поддерживает безопасный IDE handoff; обновите 1C Element MCP.");
  }
  return match[1];
}

function requestText(
  target: URL,
  options: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: options.method,
      headers: options.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Ответ MCP слишком большой."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("MCP не ответил вовремя.")));
    request.on("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function safeResponseMessage(body: string): string {
  try {
    const value = JSON.parse(body) as { message?: unknown };
    return typeof value.message === "string" ? value.message.slice(0, 500) : "";
  } catch {
    return "";
  }
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(client[_-]?secret|access[_-]?token|authorization)\s*[:=]\s*\S+/gi, "$1=[скрыто]");
}
