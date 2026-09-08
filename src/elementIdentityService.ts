import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as vscode from "vscode";

export interface ElementIdentity {
  server: string;
  userId: string;
  userListId: string;
  login: string;
  userLabel: string;
  userKey: string;
  projectId: string;
  projectName: string;
  spaceId: string;
  projectKey: string;
}

export interface ElementConnection { server: string; clientId: string; clientSecret: string; projectId: string; }
export type ConsoleRequest = (url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string) => Promise<unknown>;

/** Use this IDE's credentials, never the shared MCP server's active session. */
export class ElementIdentityService implements vscode.Disposable {
  private current: ElementIdentity | undefined;
  private fingerprint = "";
  private verifiedAt = 0;
  private generation = 0;
  private pending: Promise<ElementIdentity> | undefined;
  private readonly invalidated = new vscode.EventEmitter<void>();
  readonly onDidInvalidate = this.invalidated.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly connection: () => ElementConnection = readElementConnection, private readonly request: ConsoleRequest = requestConsoleJson) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (["1C.server", "1C.clientId", "1C.clientSecret", "1C.projectId"].some((key) => event.affectsConfiguration(key))) { this.invalidate(); }
    });
  }

  getCurrent(): ElementIdentity | undefined {
    if (this.current && this.fingerprint !== connectionFingerprint(this.connection())) { this.invalidate(); }
    return this.current;
  }

  async resolve(force = false): Promise<ElementIdentity> {
    const connection = this.connection();
    const fingerprint = connectionFingerprint(connection);
    if (this.current && this.fingerprint === fingerprint && !force && Date.now() - this.verifiedAt < 60_000) { return this.current; }
    if (this.fingerprint && fingerprint !== this.fingerprint) { this.invalidate(); }
    if (this.pending) { return this.pending; }
    const generation = this.generation;
    const pending = resolveElementIdentity(connection, this.request).then((identity) => {
      if (generation !== this.generation || fingerprint !== connectionFingerprint(this.connection())) {
        throw new Error("Пользователь или проект IDE изменился. Повторите действие.");
      }
      this.current = identity;
      this.fingerprint = fingerprint;
      this.verifiedAt = Date.now();
      return identity;
    }).catch((error: unknown) => {
      if (generation === this.generation) { this.current = undefined; this.verifiedAt = 0; }
      throw error;
    }).finally(() => { if (this.pending === pending) { this.pending = undefined; } });
    this.pending = pending;
    return pending;
  }

  invalidate(): void {
    this.generation += 1;
    this.current = undefined;
    this.pending = undefined;
    this.fingerprint = "";
    this.verifiedAt = 0;
    this.invalidated.fire();
  }

  dispose(): void { this.subscription.dispose(); this.invalidated.dispose(); this.current = undefined; this.generation += 1; }
}

export async function resolveElementIdentity(connection: ElementConnection, request: ConsoleRequest = requestConsoleJson): Promise<ElementIdentity> {
  if (!connection.server || !connection.clientId || !connection.clientSecret || !connection.projectId) {
    throw new Error("Не удалось определить пользователя и проект IDE. Откройте IDE из проекта Element и проверьте подключение 1C.");
  }
  const server = normalizeConsoleServer(connection.server);
  const tokenResult = object(await request(new URL(`${server}/sys/token`), "POST", {
    Authorization: `Basic ${Buffer.from(`${connection.clientId}:${connection.clientSecret}`, "utf8").toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded"
  }, "grant_type=CLIENT_CREDENTIALS"));
  const token = string(tokenResult.id_token);
  if (!token) { throw new Error("Console не вернула токен для проверки пользователя IDE."); }
  const headers = { Authorization: `Bearer ${token}` };
  const user = object(await request(new URL(`${server}/api/v2/me`), "GET", headers));
  const project = object(await request(new URL(`${server}/api/v2/projects/${encodeURIComponent(connection.projectId)}`), "GET", headers));
  return identityFromConsole(server, connection.projectId, user, project);
}

export function identityFromConsole(server: string, projectId: string, user: Record<string, unknown>, project: Record<string, unknown>): ElementIdentity {
  const userId = string(user.id);
  const userListId = string(user["user-list-id"]);
  const projectName = string(project.name).normalize("NFC");
  const spaceId = string(project["space-id"]);
  const serverRootProject = project["space-id"] === null;
  if (!userId || !userListId || user["is-active"] === false || !projectName || (!spaceId && !serverRootProject) || string(project.id) !== projectId || project.deleted === true) {
    throw new Error("Console не подтвердила пользователя, пространство или имя проекта. История не открыта, чтобы не смешать диалоги.");
  }
  const normalizedServer = normalizeConsoleServer(server);
  const login = string(user.login);
  return {
    server: normalizedServer, userId, userListId, login,
    userLabel: string(user.presentation) || login || userId,
    userKey: `ide-${hash([normalizedServer, userListId, userId])}`,
    projectId, projectName, spaceId,
    // Deployment/application/workspace must not change the history namespace.
    projectKey: `project-${hash(serverRootProject ? [normalizedServer, "server-root", projectName] : [normalizedServer, "space", spaceId, projectName])}`
  };
}

export function identityScopeRoot(configRoot: string, identity: ElementIdentity): string {
  return path.join(configRoot, "users", identity.userKey, "projects", identity.projectKey);
}

export function normalizeConsoleServer(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("В настройках 1C указан некорректный адрес сервера."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Адрес сервера 1C должен быть HTTP(S) URL без учетных данных и параметров.");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/console(?:\/.*)?$/, "");
  return `${url.origin}${pathname}/console`;
}

function readElementConnection(): ElementConnection {
  const config = vscode.workspace.getConfiguration("1C");
  return { server: config.get<string>("server", "").trim(), clientId: config.get<string>("clientId", "").trim(), clientSecret: config.get<string>("clientSecret", ""), projectId: config.get<string>("projectId", "").trim() };
}
function connectionFingerprint(connection: ElementConnection): string { return hash([connection.server, connection.clientId, connection.clientSecret, connection.projectId]); }
function hash(parts: string[]): string { return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32); }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function requestConsoleJson(url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)); } };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method, headers: { ...headers, Accept: "application/json", ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(response.statusCode === 401 || response.statusCode === 403 ? "Console отклонила проверку пользователя IDE. Повторно откройте IDE из Element." : `Не удалось проверить пользователя и проект IDE (Console HTTP ${response.statusCode ?? "?"}).`);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail("Ответ Console превышает допустимый размер."); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("error", () => fail("Соединение с Console прервано при проверке пользователя IDE."));
      response.on("end", () => {
        if (settled) { return; }
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); settled = true; resolve(parsed); }
        catch { fail("Console вернула некорректный ответ при проверке пользователя IDE."); }
      });
    });
    // No redirects or raw response/error text: these can contain credentials.
    const timeout = setTimeout(() => { fail("Console не ответила за 8 секунд. Проверьте доступность сервера Element."); request.destroy(); }, 8000);
    request.on("close", () => clearTimeout(timeout));
    request.on("error", () => fail("Не удалось подключиться к Console для проверки пользователя IDE."));
    request.end(body);
  });
}
