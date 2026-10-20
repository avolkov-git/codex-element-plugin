import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import { performance } from "perf_hooks";
import * as vscode from "vscode";
import type { Logger } from "./logger";
import type { ElementMcpRuntimeLaunch, ElementMcpSessionView, ElementMcpTarget } from "./elementMcpSessionTypes";

const DEFAULT_MCP_URL = "http://127.0.0.1:9900";
const REQUEST_TIMEOUT_MS = 5_000;
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const SESSION_HEADER = "X-Element-IDE-Session";
const CONTROL_HEADER = "X-Element-IDE-Control";
const TOKEN_ENV = "ELEMENT_IDE_MCP_SESSION_TOKEN";
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIGURATION_KEYS = [
  "1C.server", "1C.clientId", "1C.clientSecret", "1C.accessToken", "1C.projectId",
  "1C.applicationId", "1C.spaceId", "1C.verifyTls", "1C.caBundle", "codexElement.elementMcpUrl"
];

interface Callbacks {
  getTargets: () => Promise<ElementMcpTarget[]>;
  onInvalidate: () => void;
}

interface Context {
  payload: Record<string, unknown>;
  projectId: string;
  applicationId: string;
  folders: string[];
  fingerprint: string;
}

interface Session {
  target: ElementMcpTarget;
  base: URL;
  context: Context;
  id: string;
  csrf: string;
  mcpToken: string;
  controlToken: string;
  expiresAt: number;
  renewAfterMs: number;
  failures: number;
  csrfRefreshed: boolean;
  verified: boolean;
}

interface HttpResult {
  statusCode: number;
  body: string;
}

// Only these locally authored messages may cross the bridge's error boundary.
class SessionError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

const cancelled = (): SessionError => new SessionError("Подготовка IDE-сессии Element MCP отменена.");
const invalidResponse = (): SessionError => new SessionError("Element MCP вернул некорректный ответ IDE-сессии. Обновите MCP и переподключитесь.");
const clock = (): number => performance.now();

export class ElementMcpIdeBridgeService implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ElementMcpSessionView>();
  readonly onDidChange = this.changes.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly secrets = new Set<string>();
  private readonly revocations = new Set<Promise<void>>();
  private callbacks: Callbacks | undefined;
  private view: ElementMcpSessionView = { status: "disconnected", message: "Element MCP не подключён." };
  private session: Session | undefined;
  private generation = 0;
  private launchGeneration = 0;
  private renewTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private preparation: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly logger: Logger) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (CONFIGURATION_KEYS.some((key) => event.affectsConfiguration(key))) { this.invalidate(); }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate())
    ];
  }

  configure(callbacks: Callbacks): void {
    if (this.closed) { return; }
    if (this.callbacks) { this.invalidate(); }
    this.callbacks = callbacks;
  }

  getView(): ElementMcpSessionView { return { ...this.view }; }

  sanitize(value: string): string {
    if (!this.secrets.size) { return value; }
    const matches: Array<[number, number]> = [];
    for (const secret of this.secrets) {
      let from = 0;
      while (from < value.length) {
        const start = value.indexOf(secret, from);
        if (start < 0) { break; }
        matches.push([start, start + secret.length]);
        from = start + 1;
      }
    }
    matches.sort((a, b) => a[0] - b[0]);
    let output = "", position = 0, end = -1;
    for (const [start, nextEnd] of matches) {
      if (start < end) { end = Math.max(end, nextEnd); continue; }
      if (end >= 0) { position = end; }
      output += value.slice(position, start) + "[REDACTED]";
      end = nextEnd;
    }
    return output + value.slice(end >= 0 ? end : position);
  }

  prepareRuntimeLaunch(isCurrent: () => boolean): Promise<ElementMcpRuntimeLaunch> {
    const generation = this.generation;
    const launch = ++this.launchGeneration;
    const current = (): boolean => !this.closed && this.generation === generation
      && this.launchGeneration === launch && isCurrent();
    // Serialize starts within one window; obsolete creates are drained and revoked.
    const next = this.preparation.catch(() => undefined).then(() => this.prepare(current)).catch((error) => {
      if (!this.closed && this.generation === generation && this.launchGeneration === launch && !isCurrent()) {
        this.setView({
          status: "disconnected", message: "Подготовка IDE-сессии Element MCP отменена.", serverName: this.view.serverName
        });
      }
      throw error;
    });
    this.preparation = next;
    return next;
  }

  invalidate(): void {
    this.generation++;
    this.launchGeneration++;
    const previous = this.session;
    this.session = undefined;
    this.clearTimers();
    this.setView({
      status: "disconnected", message: "Привязка Element MCP к workspace сброшена.",
      serverName: previous?.target.name ?? this.view.serverName
    });
    // The host must stop its runtime synchronously, before any revoke/network work.
    try { this.callbacks?.onInvalidate(); } catch { this.logger.warn("Element MCP runtime invalidation callback failed."); }
    if (previous) { this.revoke(previous); }
  }

  close(): Promise<void> {
    if (this.closing) { return this.closing; }
    this.closed = true;
    this.invalidate();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.closing = (async () => {
      await this.preparation.catch(() => undefined);
      while (this.revocations.size) { await Promise.all([...this.revocations]); }
      this.changes.dispose();
    })();
    return this.closing;
  }

  dispose(): void { void this.close(); }

  private async prepare(current: () => boolean): Promise<ElementMcpRuntimeLaunch> {
    this.requireCurrent(current);
    let targets: ElementMcpTarget[];
    try {
      targets = await this.readTargets();
    } catch {
      this.requireCurrent(current);
      this.fail("Не удалось проверить конфигурацию Element MCP. Проверьте настройки MCP и переподключитесь.");
      throw new SessionError(this.view.message);
    }
    this.requireCurrent(current);
    if (!targets.length) {
      if (this.session) { this.invalidate(); }
      this.setView({ status: "disconnected", message: "Включённое подключение Element MCP не настроено." });
      return { args: [], env: {} };
    }
    try {
      if (targets.length !== 1) {
        throw new SessionError("Настроено несколько включённых подключений Element MCP. Оставьте одно подключение к этому адресу.");
      }
      const target = targets[0];
      const base = this.validateTarget(target);
      const context = await bounded(this.readContext(), REQUEST_TIMEOUT_MS);
      this.requireCurrent(current);
      let session = this.session;
      if (session && (!sameTarget(session.target, target) || session.context.fingerprint !== context.fingerprint
        || clock() >= session.expiresAt)) {
        this.invalidate();
        throw cancelled();
      }
      this.setView({
        status: "connecting", message: "Проверяется привязка Element MCP к текущему workspace.", serverName: target.name
      });
      if (!session) {
        session = await this.create(target, base, context, current);
        if (!current()) { this.revoke(session); throw cancelled(); }
        this.session = session;
        this.schedule(session);
      }
      session.verified = false;
      const selected = session;
      const overrides = Object.fromEntries([
        [target.name, { url: target.url, env_http_headers: { [SESSION_HEADER]: TOKEN_ENV } }],
        ...(target.stdioServerNames ?? []).map((name) => [name, { env: { [TOKEN_ENV]: "" } }])
      ]);
      return {
        // One partial root deep-merges with base TOML. Runtime must append browser overrides after this.
        args: [
          "-c", `mcp_servers=${inlineToml(overrides)}`,
          "-c", `shell_environment_policy.set.${TOKEN_ENV}=""`
        ],
        env: { [TOKEN_ENV]: session.mcpToken },
        serverName: target.name,
        verify: async (callTool) => this.verify(selected, current, callTool)
      };
    } catch (error) {
      if (!current()) { throw cancelled(); }
      // A rejected create disables this MCP target, not the entire runtime launch.
      if (this.session) { this.invalidate(); }
      const message = safeMessage(error);
      this.setView({
        status: "error", message, serverName: targets.length === 1 ? targets[0].name : this.view.serverName
      });
      this.logger.warn(this.sanitize(message));
      return {
        args: ["-c", `mcp_servers=${inlineToml(Object.fromEntries(targets.map((target) => [target.name, { enabled: false }])))}`],
        env: {}
      };
    }
  }

  private async readTargets(): Promise<ElementMcpTarget[]> {
    if (!this.callbacks) { throw new SessionError("Менеджер IDE-сессий Element MCP не настроен."); }
    const targets = await bounded(this.callbacks.getTargets(), REQUEST_TIMEOUT_MS);
    if (!Array.isArray(targets) || targets.some((target) => !target || typeof target.name !== "string"
      || !target.name || typeof target.url !== "string" || typeof target.enabled !== "boolean")) {
      throw new SessionError("Некорректная конфигурация подключения Element MCP.");
    }
    return targets.filter((target) => target.enabled).map((target) => ({
      ...target, ...(Array.isArray(target.stdioServerNames) ? { stdioServerNames: [...target.stdioServerNames] } : {})
    }));
  }

  private validateTarget(target: ElementMcpTarget): URL {
    if (target.sessionHeaderConfigured) {
      throw new SessionError("Удалите сохранённые заголовки IDE-сессии из конфигурации MCP перед переподключением.");
    }
    if (target.sessionTokenUsedElsewhere) {
      throw new SessionError("Переменная токена IDE-сессии используется другим HTTP MCP. Удалите эту ссылку перед подключением Element MCP.");
    }
    if (target.stdioServerNames !== undefined && (!Array.isArray(target.stdioServerNames)
      || target.stdioServerNames.some((name) => typeof name !== "string" || !name || name === target.name))) {
      throw new SessionError("Не удалось безопасно изолировать токен от дочерних MCP. Проверьте имена stdio-подключений.");
    }
    const configured = vscode.workspace.getConfiguration("codexElement").get<string>("elementMcpUrl", DEFAULT_MCP_URL);
    const expected = normalizeLocalMcpUrl(configured || DEFAULT_MCP_URL);
    const actual = normalizeLocalMcpUrl(target.url);
    if (!["/mcp", "/mcp/"].includes(new URL(target.url).pathname) || endpointKey(actual) !== endpointKey(expected)) {
      throw new SessionError("Адрес Element MCP в настройках не совпадает с выбранным локальным подключением MCP.");
    }
    return actual;
  }

  private async readContext(): Promise<Context> {
    const config = vscode.workspace.getConfiguration("1C");
    const text = (key: string): string => {
      const value = config.get<unknown>(key, "");
      return typeof value === "string" ? value.trim() : "";
    };
    const server = text("server");
    const clientId = text("clientId");
    const clientSecret = text("clientSecret");
    const accessToken = text("accessToken");
    for (const secret of [config.get("clientId"), config.get("clientSecret"), config.get("accessToken"),
      clientId, clientSecret, accessToken]) { this.remember(secret); }
    const projectId = text("projectId").toLowerCase();
    const applicationId = text("applicationId").toLowerCase();
    if (!UUID.test(projectId) || !UUID.test(applicationId)) {
      throw new SessionError("Element IDE не передала идентификаторы текущего проекта и приложения. Управляемые действия недоступны.");
    }
    if (!server || !(accessToken || (clientId && clientSecret))) {
      throw new SessionError("Element IDE не передала данные авторизации Console. Управляемые действия недоступны.");
    }
    let consoleUrl: URL;
    try { consoleUrl = new URL(server); } catch { throw new SessionError("Некорректный адрес Console в Element IDE."); }
    if (!["http:", "https:"].includes(consoleUrl.protocol) || consoleUrl.username || consoleUrl.password
      || consoleUrl.search || consoleUrl.hash) { throw new SessionError("Некорректный адрес Console в Element IDE."); }
    const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
    if (!roots.length || roots.length > 16) {
      throw new SessionError("Для Element MCP требуется от одной до шестнадцати существующих локальных папок workspace.");
    }
    const folders: string[] = [];
    for (const root of roots) {
      try {
        const resolved = await fs.promises.realpath(root.uri.fsPath);
        if (resolved.length > 4096 || !(await fs.promises.stat(resolved)).isDirectory()) { throw new Error(); }
        if (!folders.includes(resolved)) { folders.push(resolved); }
      } catch { throw new SessionError("Локальная папка workspace Element IDE недоступна."); }
    }
    const verifyTls = config.get<unknown>("verifyTls", true);
    if (typeof verifyTls !== "boolean") { throw new SessionError("Некорректные настройки TLS в Element IDE."); }
    const payload: Record<string, unknown> = {
      protocol_version: 1, server,
      ...(accessToken ? { access_token: accessToken } : { client_id: clientId, client_secret: clientSecret }),
      project_id: projectId, application_id: applicationId, workspace_folders: folders,
      verify_tls: verifyTls,
      ...(text("spaceId") ? { space_id: text("spaceId") } : {}),
      ...(text("caBundle") ? { ca_bundle: text("caBundle") } : {})
    };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return { payload, projectId, applicationId, folders, fingerprint };
  }

  private async create(target: ElementMcpTarget, base: URL, context: Context, current: () => boolean): Promise<Session> {
    const status = await requestText(new URL("/api/status", base), { method: "GET" });
    this.requireCurrent(current);
    if (status.statusCode !== 200 || !supportedVersion(record(parseJson(status.body)).server)) {
      throw new SessionError("Требуется Element MCP версии 0.23.0 или новее с протоколом IDE-сессий v1. Обновите MCP.");
    }
    const csrf = await this.readCsrf(base);
    this.requireCurrent(current);
    const git = await this.readGitStatus();
    this.requireCurrent(current);
    const body = jsonBody({ ...context.payload, ...(git ? { git_status: git } : {}) });
    const started = clock();
    const response = await requestText(new URL("/api/integrations/ide-sessions", base), {
      method: "POST", body, headers: jsonHeaders(csrf, body)
    });
    let value: Record<string, unknown>;
    try { value = record(parseJson(response.body)); } catch (error) {
      if (response.statusCode !== 201) { throw httpError(response.statusCode, response.body); }
      throw error;
    }
    this.rememberTokens(value);
    // Even a malformed or obsolete successful create can have allocated a lease.
    const cleanup = typeof value.session_id === "string" && UUID.test(value.session_id) && validToken(value.control_token)
      ? { base, id: value.session_id, csrf, controlToken: value.control_token } : undefined;
    try {
      if (response.statusCode !== 201) { throw httpError(response.statusCode, response.body); }
      if (value.protocol_version !== 1 || value.mcp_header !== SESSION_HEADER || value.control_header !== CONTROL_HEADER
        || !validToken(value.mcp_token) || !validToken(value.control_token) || value.mcp_token === value.control_token
        || typeof value.session_id !== "string" || !UUID.test(value.session_id)) { throw invalidResponse(); }
      const timing = validateLease(value, context, value.session_id, started);
      this.requireCurrent(current);
      return {
        target: { ...target }, base, context, id: value.session_id, csrf,
        mcpToken: value.mcp_token, controlToken: value.control_token, ...timing,
        failures: 0, csrfRefreshed: false, verified: false
      };
    } catch (error) {
      if (cleanup) { this.revoke(cleanup); }
      throw error;
    }
  }

  private async verify(
    session: Session,
    current: () => boolean,
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  ): Promise<void> {
    const check = (): void => {
      this.requireCurrent(current);
      if (this.session !== session || clock() >= session.expiresAt) { throw cancelled(); }
    };
    try {
      check();
      const actions = toolResult(await bounded(callTool("get_managed_actions_status", {}), VERIFY_TIMEOUT_MS));
      check();
      validateScope(record(actions.workspace_scope), session.context, session.id);
      const app = toolResult(await bounded(callTool("get_current_application", {}), VERIFY_TIMEOUT_MS));
      check();
      const connection = record(app.connection);
      const projectMatches = sameUuid(app.application_project_id, session.context.projectId)
        || (app.project_match_kind === "group"
          && typeof app.application_project_id === "string" && UUID.test(app.application_project_id)
          && sameUuid(app.application_project_group_id, session.context.projectId));
      if (app.status !== "ready" || !sameUuid(record(app.application).id, session.context.applicationId)
        || !sameUuid(app.ide_project_id, session.context.projectId)
        || !projectMatches || app.matches_ide_project !== true
        || connection.source !== "ide_session" || !sameUuid(connection.project_id, session.context.projectId)
        || !sameUuid(connection.application_id, session.context.applicationId)) { throw invalidResponse(); }
      session.verified = true;
      this.setView({
        status: "ready", message: actions.migration_required === true
          ? "Приложение текущего workspace подключено. Управляемые действия отключены в MCP: требуется повторное сохранение политики оператором."
          : actions.can_prepare === true
            ? "Приложение текущего workspace подключено."
            : "Приложение текущего workspace подключено. Управляемые действия отключены в MCP.",
        serverName: session.target.name, projectId: session.context.projectId, applicationId: session.context.applicationId,
        canPrepare: actions.can_prepare === true, migrationRequired: actions.migration_required === true
      });
    } catch {
      // A late verification from a previous runtime must not stop its replacement.
      if (current() && this.session === session) {
        this.fail("Не удалось подтвердить привязку Element MCP к workspace. Сессия сброшена; переподключитесь перед использованием управляемых действий.");
      }
      throw new SessionError("Проверка привязки Element MCP к workspace завершилась ошибкой или была отменена.");
    }
  }

  private schedule(session: Session): void {
    this.clearTimers();
    if (this.session !== session || this.closed) { return; }
    const remaining = session.expiresAt - clock();
    if (remaining <= 0) { this.expire(); return; }
    this.expiryTimer = setTimeout(() => {
      if (this.session === session) { this.expire(); }
    }, remaining);
    this.expiryTimer.unref?.();
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      void this.renew(session);
    }, Math.min(session.renewAfterMs, remaining / 2));
    this.renewTimer.unref?.();
  }

  private async renew(session: Session): Promise<void> {
    const generation = this.generation;
    const current = (): boolean => !this.closed && this.generation === generation && this.session === session;
    try {
      const targets = await this.readTargets();
      if (!current()) { return; }
      if (targets.length !== 1 || !sameTarget(targets[0], session.target)) {
        throw new SessionError("Конфигурация Element MCP изменилась. Переподключитесь для привязки текущего workspace.");
      }
      this.validateTarget(targets[0]);
      const context = await bounded(this.readContext(), REQUEST_TIMEOUT_MS);
      if (!current()) { return; }
      if (context.fingerprint !== session.context.fingerprint) {
        throw new SessionError("Контекст Element IDE изменился. Переподключитесь для привязки текущего workspace.");
      }
      this.setView({ ...this.view, status: session.verified ? "renewing" : "connecting" });
      const git = await this.readGitStatus();
      if (!current()) { return; }
      const body = jsonBody(git ? { git_status: git } : {});
      const started = clock();
      const response = await requestText(new URL(`/api/integrations/ide-sessions/${session.id}`, session.base), {
        method: "POST", body, headers: { ...jsonHeaders(session.csrf, body), [CONTROL_HEADER]: session.controlToken }
      });
      if (!current()) { return; }
      if (response.statusCode === 403 && !session.csrfRefreshed) {
        session.csrfRefreshed = true;
        session.csrf = await this.readCsrf(session.base);
        if (!current()) { return; }
        this.scheduleRetry(session, 0);
        return;
      }
      if (response.statusCode !== 200) { throw httpError(response.statusCode, response.body); }
      const value = record(parseJson(response.body));
      this.rememberTokens(value);
      if ("mcp_token" in value || "control_token" in value) { throw invalidResponse(); }
      Object.assign(session, validateLease(value, session.context, session.id, started));
      session.failures = 0;
      session.csrfRefreshed = false;
      this.setView({ ...this.view, status: session.verified ? "ready" : "connecting" });
      this.schedule(session);
    } catch (error) {
      if (!current()) { return; }
      if (error instanceof SessionError && error.retryable && session.failures < RETRY_DELAYS_MS.length) {
        this.scheduleRetry(session, RETRY_DELAYS_MS[session.failures++]);
      } else {
        this.fail(safeMessage(error));
      }
    }
  }

  private scheduleRetry(session: Session, delay: number): void {
    // Leave the independent expiry watchdog armed, including during a stalled renew.
    if (clock() + delay + REQUEST_TIMEOUT_MS >= session.expiresAt) { this.expire(); return; }
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      if (this.session === session) { void this.renew(session); }
    }, delay);
    this.renewTimer.unref?.();
  }

  private expire(): void {
    this.invalidate();
    this.setView({
      status: "expired", message: "Срок IDE-сессии Element MCP истёк. Переподключитесь для привязки текущего workspace.",
      serverName: this.view.serverName
    });
  }

  private fail(message: string): void {
    this.invalidate();
    this.setView({ status: "error", message, serverName: this.view.serverName });
    this.logger.warn(this.sanitize(message));
  }

  private revoke(session: Pick<Session, "base" | "id" | "csrf" | "controlToken">): void {
    const operation = (async () => {
      try {
        const response = await requestText(new URL(`/api/integrations/ide-sessions/${session.id}`, session.base), {
          method: "DELETE", headers: { "X-Element-MCP-Token": session.csrf, [CONTROL_HEADER]: session.controlToken }
        });
        if (response.statusCode !== 200 && response.statusCode !== 401) { throw invalidResponse(); }
      } catch {
        this.logger.warn("Element MCP session revoke was not confirmed; an already dispatched operation may still complete.");
      }
    })();
    this.revocations.add(operation);
    void operation.finally(() => this.revocations.delete(operation));
  }

  private async readCsrf(base: URL): Promise<string> {
    const response = await requestText(new URL("/", base), { method: "GET" });
    if (response.statusCode !== 200) { throw httpError(response.statusCode); }
    const token = response.body.match(/<meta\s+name=["']element-mcp-token["']\s+content=["']([^"']+)["']/i)?.[1];
    this.remember(token);
    if (!token || !/^[\x21-\x7e]{1,256}$/.test(token)) {
      throw new SessionError("Element MCP не предоставил локальный токен управления сессией. Обновите MCP и переподключитесь.");
    }
    return token;
  }

  private async readGitStatus(): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = record(await bounded(vscode.commands.executeCommand("g5rt.team.status"), 2_000));
      const git: Record<string, unknown> = {};
      if (typeof raw.modified === "boolean") { git.modified = raw.modified; }
      if (typeof raw.branchName === "string" && raw.branchName.length <= 512 && !/[\x00-\x1f\x7f]/.test(raw.branchName)
        && this.sanitize(raw.branchName) === raw.branchName) { git.branchName = raw.branchName; }
      return Object.keys(git).length ? git : undefined;
    } catch { return undefined; }
  }

  private remember(value: unknown): void {
    if (typeof value === "string" && value) {
      this.secrets.add(value);
      this.secrets.add(JSON.stringify(value).slice(1, -1));
    }
  }

  private rememberTokens(value: Record<string, unknown>): void {
    for (const key of ["mcp_token", "control_token", "access_token", "client_secret"]) { this.remember(value[key]); }
  }

  private requireCurrent(current: () => boolean): void {
    if (!current()) { throw cancelled(); }
  }

  private setView(view: ElementMcpSessionView): void {
    this.view = Object.fromEntries(Object.entries(view).map(([key, value]) =>
      [key, typeof value === "string" ? this.sanitize(value) : value])) as unknown as ElementMcpSessionView;
    this.changes.fire(this.getView());
  }

  private clearTimers(): void {
    if (this.renewTimer) { clearTimeout(this.renewTimer); this.renewTimer = undefined; }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
  }
}

function normalizeLocalMcpUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SessionError("Некорректный адрес Element MCP."); }
  const literal = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(value);
  const literalPath = literal?.[1] ?? "";
  if (!["http:", "https:"].includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname.toLowerCase())
    || !literal || value !== value.trim() || parsed.username || parsed.password || /[?#\\@]/.test(value)
    || !["/", "/mcp", "/mcp/"].includes(parsed.pathname) || !["", "/", "/mcp", "/mcp/"].includes(literalPath)) {
    throw new SessionError("Element MCP требует локальный loopback-адрес HTTP(S) без авторизации, параметров запроса и пути, отличного от /mcp/.");
  }
  return new URL(parsed.origin);
}

function endpointKey(url: URL): string { return `${url.protocol}//loopback:${url.port || (url.protocol === "https:" ? "443" : "80")}`; }
type TomlPatch = string | boolean | { [key: string]: TomlPatch };
function inlineToml(value: TomlPatch): string {
  if (typeof value === "string") { return JSON.stringify(value).replace(/\x7f/g, "\\u007f"); }
  if (typeof value === "boolean") { return String(value); }
  return `{${Object.entries(value).map(([key, item]) => `${inlineToml(key)}=${inlineToml(item)}`).join(",")}}`;
}
function sameTarget(a: ElementMcpTarget, b: ElementMcpTarget): boolean {
  return a.name === b.name && a.url === b.url && a.enabled === b.enabled
    && Boolean(a.sessionHeaderConfigured) === Boolean(b.sessionHeaderConfigured)
    && Boolean(a.sessionTokenUsedElsewhere) === Boolean(b.sessionTokenUsedElsewhere)
    && JSON.stringify(a.stdioServerNames ?? []) === JSON.stringify(b.stdioServerNames ?? []);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { throw invalidResponse(); }
}
function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value); }
function sameUuid(value: unknown, expected: string): boolean { return typeof value === "string" && value.toLowerCase() === expected.toLowerCase(); }
function supportedVersion(server: unknown): boolean {
  const version = record(server).version;
  if (typeof version !== "string") { return false; }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9a-z.-]+)?$/i.exec(version);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) > 23 || (Number(match[2]) === 23 && Number(match[3]) >= 0));
}
function validateScope(value: Record<string, unknown>, context: Context, id: string): void {
  if (value.status !== "ready" || !sameUuid(value.session_id, id)
    || !sameUuid(value.project_id, context.projectId) || !sameUuid(value.application_id, context.applicationId)
    || !Array.isArray(value.workspace_folders) || value.workspace_folders.length !== context.folders.length
    || value.workspace_folders.some((folder, index) => folder !== context.folders[index])
    || !Number.isInteger(value.expires_in_seconds) || Number(value.expires_in_seconds) <= 0) {
    throw invalidResponse();
  }
}
function validateLease(
  value: Record<string, unknown>, context: Context, id: string, started: number
): Pick<Session, "expiresAt" | "renewAfterMs"> {
  validateScope(value, context, id);
  const lease = Number(value.lease_seconds);
  const renew = Number(value.renew_after_seconds);
  if (!Number.isInteger(value.lease_seconds) || lease <= 0 || lease > 180
    || !Number.isInteger(value.renew_after_seconds) || renew <= 0 || renew >= lease
    || Number(value.expires_in_seconds) > lease) { throw invalidResponse(); }
  const expiresAt = started + Number(value.expires_in_seconds) * 1000;
  if (clock() >= expiresAt) { throw invalidResponse(); }
  return { expiresAt, renewAfterMs: renew * 1000 };
}
function toolResult(value: unknown): Record<string, unknown> {
  const raw = record(value);
  if (raw.isError === true || raw.error) { throw invalidResponse(); }
  if (raw.structuredContent) { return record(raw.structuredContent); }
  if (Array.isArray(raw.content)) {
    const texts = raw.content.filter((item) => record(item).type === "text");
    if (texts.length !== 1 || typeof texts[0].text !== "string" || Buffer.byteLength(texts[0].text) > MAX_RESPONSE_BYTES) {
      throw invalidResponse();
    }
    return record(parseJson(texts[0].text));
  }
  return raw;
}
function jsonBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) { throw new SessionError("Контекст IDE-сессии Element MCP превышает допустимый размер запроса."); }
  return body;
}
function jsonHeaders(csrf: string, body: string): Record<string, string> {
  return { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "X-Element-MCP-Token": csrf };
}
function safeMessage(error: unknown): string {
  return error instanceof SessionError ? error.message : "Не удалось создать IDE-сессию Element MCP. Проверьте настройки локального MCP и переподключитесь.";
}
function sessionRejectionReason(body: string, httpStatus: number): string | undefined {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(body)); } catch { return undefined; }
  // MCP 0.23.1 provides stable codes. Remote messages and identifiers never become UI copy.
  if (value.code !== undefined) {
    if (httpStatus === 400 && value.status === "invalid") {
      switch (value.code) {
        case "application_project_missing":
          return "В карточке приложения Console нет ID проекта. Проверьте данные приложения в Console; MCP не может подтвердить его связь с текущей IDE.";
        case "application_project_invalid":
          return "В карточке приложения Console указан некорректный ID проекта: ожидается UUID. Проверьте данные приложения в Console.";
        case "application_project_mismatch":
          return "Проект приложения в Console не совпадает с 1C.projectId текущей IDE. Откройте IDE нужного приложения и проверьте соответствие 1C.applicationId и 1C.projectId.";
      }
    }
    if (![401, 403, 502].includes(httpStatus) || value.status !== "rejected") { return undefined; }
    const upstream = typeof value.http_status === "number" && Number.isInteger(value.http_status)
      && value.http_status >= 400 && value.http_status <= 599
      && httpStatus === ([401, 403].includes(value.http_status) ? value.http_status : 502)
      ? value.http_status : undefined;
    const detail = upstream ? ` (Console HTTP ${upstream})` : "";
    if (value.code === "console_authentication_failed") {
      if (upstream === 401) {
        return "Console отклонила авторизацию MCP (Console HTTP 401). Проверьте параметры авторизации Console в настройках IDE.";
      }
      if (upstream === 403) {
        return "Console запретила MCP доступ к списку пространств (Console HTTP 403). Проверьте права учётной записи Console, используемой IDE.";
      }
      return `MCP не смог проверить авторизацию через список пространств Console${detail}. Проверьте доступ MCP к Console, адрес сервера и параметры авторизации в IDE.`;
    }
    if (value.code === "console_application_failed") {
      if (upstream === 401) {
        return "Console отклонила авторизацию при чтении приложения (Console HTTP 401). Проверьте параметры авторизации Console в настройках IDE.";
      }
      if (upstream === 403) {
        return "Console запретила чтение приложения (Console HTTP 403). Проверьте права учётной записи IDE на это приложение.";
      }
      if (upstream === 404) {
        return "Console не нашла приложение по 1C.applicationId (Console HTTP 404). Проверьте выбранный сервер и приложение текущей IDE. Это не ошибка отсутствующего протокола MCP.";
      }
      return `MCP не смог прочитать или проверить карточку приложения в Console${detail}. Проверьте доступ MCP к Console, 1C.applicationId и журнал MCP. Несовпадение проектов не установлено.`;
    }
    return undefined;
  }
  if (httpStatus !== 400) { return undefined; }
  if (value.status !== "invalid" || typeof value.message !== "string" || value.message.length > 8192) { return undefined; }
  // Recognize v1 validation errors for display only; never echo remote paths, credentials, or instructions.
  const message = value.message;
  if (message.startsWith("Workspace folder не существует или недоступен серверу MCP: ")) {
    return "MCP не видит папку workspace, переданную IDE. Проверьте доступ к ней от имени процесса MCP. Если MCP работает в контейнере, путь должен быть доступен и внутри контейнера.";
  }
  if (message === "Console не подтвердила связь application_id с project_id текущей IDE") {
    return "Console не подтвердила связь приложения с проектом текущей IDE. Проверьте доступ MCP к Console и соответствие 1C.applicationId и 1C.projectId; ошибка чтения приложения также может привести к этому отказу.";
  }
  if (message === "Достигнут лимит IDE-сессий; закройте неиспользуемые подключения") {
    return "Достигнут лимит IDE-сессий MCP. Закройте неиспользуемые окна IDE или дождитесь истечения их сессий и повторите подключение.";
  }
  if (message === "Требуется protocol_version=1; обновите плагин" || message === "Неизвестные поля IDE-контекста") {
    return "MCP не принял формат контекста IDE. Проверьте совместимость версий плагина и MCP с протоколом IDE-сессий v1.";
  }
  if (message === "IDE должна передать корректные project_id и application_id") {
    return "MCP не принял идентификаторы 1C.projectId и 1C.applicationId. Переподключите IDE к приложению и повторите проверку.";
  }
  if (message === "IDE должна передать непустой workspace_folders"
    || message === "workspace_folders должен быть массивом не более 16 путей"
    || message === "Каждый workspace folder должен быть непустым локальным путём") {
    return "MCP не принял список папок workspace. Требуется от одной до шестнадцати локальных папок, доступных процессу MCP.";
  }
  if (/^Некорректное поле git_status\.(branchName|commitId|commandStatus|currentHead|modified|aheadBehind)$/.test(message)
    || message === "git_status контекста IDE должен быть объектом") {
    return "MCP не принял сводку состояния Git из IDE. Проверьте совместимость версий плагина и MCP.";
  }
  if (message.startsWith("Файл CA bundle не найден: ")) {
    return "MCP не нашёл файл сертификатов из 1C.caBundle. Проверьте, доступен ли этот файл процессу MCP.";
  }
  return undefined;
}
function httpError(code: number, body = ""): SessionError {
  if (code === 404 || code === 426) { return new SessionError("Протокол IDE-сессий v1 недоступен. Обновите Element MCP до версии 0.23.0 или новее."); }
  const reason = sessionRejectionReason(body, code);
  if (code === 400) {
    return new SessionError(`Element MCP отклонил IDE-сессию (HTTP 400). ${reason
      ?? "Причина отказа не распознана. Нужен журнал MCP за время подключения; повторная проверка без устранения причины может не помочь."}`);
  }
  if ([401, 403].includes(code)) {
    return new SessionError(`Element MCP отклонил IDE-сессию (HTTP ${code}). ${reason ?? "Проверьте контекст IDE и переподключитесь."}`);
  }
  return new SessionError(`Запрос IDE-сессии Element MCP завершился ошибкой (HTTP ${code}).${reason ? ` ${reason}` : ""}`, code === 408 || code === 429 || code >= 500);
}
async function bounded<T>(operation: PromiseLike<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new SessionError("Истекло время ожидания операции IDE-сессии Element MCP.", true)), milliseconds);
        timeout.unref?.();
      })
    ]);
  } finally { if (timeout) { clearTimeout(timeout); } }
}

function requestText(
  target: URL, options: { method: "GET" | "POST" | "DELETE"; headers?: Record<string, string>; body?: string }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: SessionError, value?: HttpResult): void => {
      if (settled) { return; }
      settled = true;
      if (timeout) { clearTimeout(timeout); }
      if (error) { reject(error); } else { resolve(value!); }
    };
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: options.method, headers: options.headers, agent: false, maxHeaderSize: 16 * 1024
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(new SessionError("Ответ Element MCP превышает допустимый размер."));
          response.destroy();
          request.destroy();
        } else { chunks.push(chunk); }
      });
      response.on("aborted", () => finish(new SessionError("Ответ Element MCP был прерван.", true)));
      response.on("error", () => finish(new SessionError("Не удалось прочитать ответ Element MCP.", true)));
      response.on("end", () => finish(undefined, { statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // Total deadline, not an idle timeout: a trickling peer must not hold credentials indefinitely.
    timeout = setTimeout(() => {
      finish(new SessionError("Истекло время ожидания ответа Element MCP.", true));
      request.destroy();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    request.on("error", () => finish(new SessionError("Не удалось выполнить запрос Element MCP.", true)));
    if (options.body) { request.write(options.body); }
    request.end();
  });
}
