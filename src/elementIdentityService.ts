import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ConsoleRequest, ElementConnection, ElementConsoleClient, ElementConsoleError, normalizeConsoleServer } from "./elementConsoleClient";
import type { Logger } from "./logger";

export { ConsoleRequest, ElementConnection, normalizeConsoleServer, requestConsoleJson } from "./elementConsoleClient";

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

/** Use this IDE's credentials, never the shared MCP server's active session. */
export class ElementIdentityService implements vscode.Disposable {
  private current: ElementIdentity | undefined;
  private fingerprint = "";
  private verifiedAt = 0;
  private generation = 0;
  private pending: Promise<ElementIdentity> | undefined;
  private abort: AbortController | undefined;
  private disposed = false;
  private readonly invalidated = new vscode.EventEmitter<void>();
  readonly onDidInvalidate = this.invalidated.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly connection: () => ElementConnection = readElementConnection, private readonly request?: ConsoleRequest, private readonly logger?: Pick<Logger, "info" | "warn">) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (["1C.server", "1C.clientId", "1C.clientSecret", "1C.projectId"].some((key) => event.affectsConfiguration(key))) { this.invalidate(); }
    });
  }

  getCurrent(): ElementIdentity | undefined {
    if (this.disposed) { return undefined; }
    if (this.fingerprint && this.fingerprint !== connectionFingerprint(this.connection())) { this.invalidate(); }
    return this.current;
  }

  async resolve(force = false): Promise<ElementIdentity> {
    if (this.disposed) { throw new Error("Проверка пользователя IDE остановлена."); }
    const connection = { ...this.connection() };
    const fingerprint = connectionFingerprint(connection);
    if (this.current && this.fingerprint === fingerprint && !force && Date.now() - this.verifiedAt < 60_000) { return this.current; }
    if (this.fingerprint && fingerprint !== this.fingerprint) { this.invalidate(); }
    if (this.pending) { return this.pending; }
    const generation = this.generation;
    this.fingerprint = fingerprint;
    const abort = new AbortController();
    this.abort = abort;
    this.logger?.info("Element Console identity: checking this IDE directly; MCP is not required.");
    const pending = resolveElementIdentity(connection, this.request, abort.signal).then((identity) => {
      if (generation !== this.generation || fingerprint !== connectionFingerprint(this.connection())) {
        throw new Error("Пользователь или проект IDE изменился. Повторите действие.");
      }
      this.current = identity;
      this.fingerprint = fingerprint;
      this.verifiedAt = Date.now();
      this.logger?.info("Element Console identity verified: user and project confirmed; history scope ready.");
      return identity;
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.current = undefined; this.verifiedAt = 0;
        const diagnostic = error instanceof ElementConsoleError ? error.diagnostic : "stage=identity; code=unexpected";
        this.logger?.warn(`Element Console identity rejected: ${diagnostic}. History remains closed.`);
      }
      throw error;
    }).finally(() => {
      if (this.pending === pending) { this.pending = undefined; }
      if (this.abort === abort) { this.abort = undefined; }
    });
    this.pending = pending;
    return pending;
  }

  invalidate(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.current = undefined;
    this.pending = undefined;
    this.fingerprint = "";
    this.verifiedAt = 0;
    this.invalidated.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abort?.abort(); this.abort = undefined;
    this.subscription.dispose(); this.invalidated.dispose(); this.current = undefined; this.pending = undefined;
  }
}

export async function resolveElementIdentity(connection: ElementConnection, request?: ConsoleRequest, signal?: AbortSignal): Promise<ElementIdentity> {
  const { server, user, project } = await new ElementConsoleClient(connection, request).readIdentity(signal);
  return identityFromConsole(server, connection.projectId, user, project);
}

export function identityFromConsole(server: string, projectId: string, user: Record<string, unknown>, project: Record<string, unknown>): ElementIdentity {
  const issues: IdentityIssue[] = [];
  const userId = requiredText(user.id, "user.id", issues);
  const userListId = requiredText(aliased(user, "user-list-id", "userListId", "user.user-list-id", issues), "user.user-list-id", issues);
  const projectName = requiredText(project.name, "project.name", issues).normalize("NFC");
  const projectSpace = aliased(project, "space-id", "spaceId", "project.space-id", issues);
  // Preserve existing explicit-null scopes; absence is never interpreted as a server-root project.
  const serverRootProject = projectSpace === null;
  const spaceId = serverRootProject ? "" : requiredText(projectSpace, "project.space-id", issues);
  const confirmedProjectId = requiredText(project.id, "project.id", issues);
  if (confirmedProjectId && !sameProjectId(confirmedProjectId, projectId)) { issues.push({ field: "project.id", state: "mismatch" }); }
  const active = aliased(user, "is-active", "isActive", "user.is-active", issues);
  // Element 9.2 maps status == ACTIVE to this flag; NEW also yields false.
  // Console authorizes token, /me and project requests. This flag is not an access decision.
  if (active !== undefined && typeof active !== "boolean") { issues.push({ field: "user.is-active", state: "invalid-type" }); }
  if (project.deleted === true) { issues.push({ field: "project.deleted", state: "deleted" }); }
  else if (project.deleted !== undefined && typeof project.deleted !== "boolean") { issues.push({ field: "project.deleted", state: "invalid-type" }); }
  if (issues.length) {
    const fields = [...new Set(issues.map((issue) => issue.field))];
    const details = issues.map(({ field, state }) => `${field}:${state}`).join(",");
    throw new ElementConsoleError("identity", "identity_fields", "Console не подтвердила данные IDE: " + fields.map((field) => FIELD_LABELS[field]).join(", ") + ". История не открыта, чтобы не смешать диалоги. Подробности проверки записаны в логи Codex.", `fields=${details}`);
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

function readElementConnection(): ElementConnection {
  const config = vscode.workspace.getConfiguration("1C");
  return { server: config.get<string>("server", "").trim(), clientId: config.get<string>("clientId", "").trim(), clientSecret: config.get<string>("clientSecret", ""), projectId: config.get<string>("projectId", "").trim() };
}
function connectionFingerprint(connection: ElementConnection): string { return hash([connection.server, connection.clientId, connection.clientSecret, connection.projectId]); }
function hash(parts: string[]): string { return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32); }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

const FIELD_LABELS = {
  "user.id": "идентификатор пользователя (user.id)",
  "user.user-list-id": "список пользователей (user.user-list-id)",
  "user.is-active": "активность пользователя (user.is-active)",
  "project.id": "принадлежность проекта текущей IDE (project.id)",
  "project.name": "имя проекта (project.name)",
  "project.space-id": "пространство проекта (project.space-id)",
  "project.deleted": "доступность проекта (project.deleted)"
};
type IdentityField = keyof typeof FIELD_LABELS;
interface IdentityIssue { field: IdentityField; state: "missing" | "null" | "empty" | "invalid-type" | "conflict" | "mismatch" | "deleted"; }

function requiredText(value: unknown, field: IdentityField, issues: IdentityIssue[]): string {
  const result = string(value);
  if (!result) { issues.push({ field, state: value === undefined ? "missing" : value === null ? "null" : typeof value === "string" ? "empty" : "invalid-type" }); }
  return result;
}
function aliased(record: Record<string, unknown>, canonical: string, alias: string, field: IdentityField, issues: IdentityIssue[]): unknown {
  const hasCanonical = Object.prototype.hasOwnProperty.call(record, canonical);
  const hasAlias = Object.prototype.hasOwnProperty.call(record, alias);
  const value = hasCanonical ? record[canonical] : record[alias];
  if (hasCanonical && hasAlias && record[canonical] !== record[alias]) { issues.push({ field, state: "conflict" }); }
  return value;
}
function sameProjectId(left: string, right: string): boolean {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return left === right || (uuid.test(left) && uuid.test(right) && left.toLowerCase() === right.toLowerCase());
}
