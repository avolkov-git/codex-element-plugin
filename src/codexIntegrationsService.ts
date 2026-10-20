import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CodexRuntimeController } from "./codexRuntimeController";
import { MANAGED_BROWSER_MCP_NAME } from "./codexIntegrationConstants";
import { Logger } from "./logger";
import { resolveBundledRuntimeExecutable, validateRuntimeExecutable } from "./platform";
import { SettingsService } from "./settingsService";
import { McpRuntimeStatus, McpServerOption, SkillOption, SkillSelection } from "./types";
import { UserProfileService } from "./userProfileService";
import { elementMcpEndpointKey } from "./elementMcpEndpoint";
import { ElementMcpSessionView, ElementMcpTarget } from "./elementMcpSessionTypes";

export interface McpServerSaveInput {
  originalName?: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  bearerTokenEnvVar?: string;
  enabled?: boolean;
}

export type IntegrationSectionStatus = "idle" | "loading" | "ready" | "partial" | "error";

export interface McpConnectionTestResult {
  name: string;
  status: "ready" | "authRequired" | "disabled" | "failed";
  message: string;
  runtimeStatus: McpServerOption["runtimeStatus"];
  authStatus: McpServerOption["authStatus"];
  toolCount: number;
  resourceCount: number;
  details?: string;
}

export interface CodexIntegrationsSnapshot {
  status: IntegrationSectionStatus;
  mcpStatus: IntegrationSectionStatus;
  skillsStatus: IntegrationSectionStatus;
  mcpServers: McpServerOption[];
  skills: SkillOption[];
  message: string;
  mcpMessage: string;
  skillsMessage: string;
  updatedAt?: string;
  elementIdeSession?: ElementMcpSessionView;
}

interface McpCliRecord {
  name: string;
  enabled?: boolean;
  disabled_reason?: string | null;
  transport?: Record<string, unknown>;
  auth_status?: string;
}

interface CliResult {
  stdout: string;
  stderr: string;
}

export class CodexIntegrationsService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private snapshot: CodexIntegrationsSnapshot = {
    status: "idle",
    mcpStatus: "idle",
    skillsStatus: "idle",
    mcpServers: [],
    skills: [],
    message: "Интеграции загружаются только по запросу.",
    mcpMessage: "",
    skillsMessage: ""
  };
  private readonly runtimeSubscription: vscode.Disposable;
  private refreshPromise: Promise<CodexIntegrationsSnapshot> | undefined;
  private managedBrowserProvider: (() => McpServerSaveInput | undefined) | undefined;
  private elementSessionProvider: (() => ElementMcpSessionView) | undefined;
  private beforeMcpConfigurationChange: (() => Promise<void>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly profiles: UserProfileService,
    private readonly runtime: CodexRuntimeController,
    private readonly logger: Logger
  ) {
    this.runtimeSubscription = runtime.onDidChangeIntegrations(() => {
      if (this.snapshot.status !== "idle") {
        void this.refresh(true);
      }
    });
  }

  dispose(): void {
    this.runtimeSubscription.dispose();
    this.changeEmitter.dispose();
  }

  getSnapshot(): CodexIntegrationsSnapshot {
    const session = this.elementSessionProvider?.();
    return {
      ...this.snapshot,
      elementIdeSession: session,
      mcpServers: this.withManagedBrowser(this.snapshot.mcpServers).map((server) => ({
        ...server, args: server.args ? [...server.args] : undefined,
        ...(session?.serverName === server.name && !["ready", "renewing"].includes(session.status) ? {
          runtimeStatus: session.status === "connecting" ? "starting" as const : "failed" as const,
          error: session.message, toolCount: 0, resourceCount: 0
        } : {})
      })),
      skills: this.snapshot.skills.map((skill) => ({ ...skill }))
    };
  }

  setManagedBrowserProvider(provider: () => McpServerSaveInput | undefined): void {
    this.managedBrowserProvider = provider;
  }

  setElementSessionProvider(provider: () => ElementMcpSessionView, beforeChange: () => Promise<void>): void {
    this.elementSessionProvider = provider;
    this.beforeMcpConfigurationChange = beforeChange;
  }

  notifyElementSessionChanged(): void {
    this.changeEmitter.fire();
  }

  async getElementMcpTargets(home?: string): Promise<ElementMcpTarget[]> {
    const endpoint = this.elementEndpoint();
    if (!endpoint) return [];
    const records = await this.readConfiguredMcpRecords(home);
    const stdioServerNames = records.filter(record =>
      record.enabled !== false && record.transport?.type === "stdio").map(record => record.name).sort();
    return records.flatMap(record => {
      const transport = record.transport;
      if (transport?.type !== "streamable_http" || typeof transport.url !== "string"
        || elementMcpEndpointKey(transport.url, true) !== endpoint) return [];
      const headers = [transport.http_headers, transport.env_http_headers];
      const sessionHeaderConfigured = referencesSessionEnvironment(transport) || headers.some(header =>
        header && typeof header === "object" && Object.keys(header).some(name =>
          ["x-element-ide-session", "x-element-ide-control", "x-element-mcp-token"].includes(name.toLowerCase())));
      const sessionTokenUsedElsewhere = records.some(other => {
        if (other.name === record.name || other.enabled === false || other.transport?.type !== "streamable_http") return false;
        return referencesSessionEnvironment(other.transport);
      });
      return [{ name: record.name, url: transport.url, enabled: record.enabled !== false,
        sessionHeaderConfigured, stdioServerNames: [...stdioServerNames], sessionTokenUsedElsewhere }];
    });
  }

  private elementEndpoint(): string | undefined {
    return elementMcpEndpointKey(vscode.workspace.getConfiguration("codexElement").get<string>("elementMcpUrl", "http://127.0.0.1:9900"));
  }

  async refresh(forceSkills = false, retryElementSession = false): Promise<CodexIntegrationsSnapshot> {
    if (this.refreshPromise) {
      if (retryElementSession && ["error", "expired"].includes(this.elementSessionProvider?.().status ?? "")) {
        await this.refreshPromise.catch(() => undefined);
        return this.refresh(forceSkills, true);
      }
      return this.refreshPromise;
    }
    const refresh = this.performRefresh(forceSkills, retryElementSession);
    this.refreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = undefined;
      }
    }
  }

  private async performRefresh(forceSkills: boolean, retryElementSession: boolean): Promise<CodexIntegrationsSnapshot> {
    const previous = this.snapshot;
    this.snapshot = {
      ...this.snapshot,
      status: "loading",
      mcpStatus: "loading",
      skillsStatus: "loading",
      message: "Проверяем MCP-серверы и навыки...",
      mcpMessage: "",
      skillsMessage: ""
    };
    this.changeEmitter.fire();

    const mcpWarnings: string[] = [];
    const skillsWarnings: string[] = [];
    let configured: McpServerOption[] = previous.mcpServers;
    let runtimeStatuses: McpRuntimeStatus[] = [];
    let skills: SkillOption[] = previous.skills;
    let configuredLoaded = false;
    let runtimeLoaded = false;
    let skillsLoaded = false;

    try {
      if (retryElementSession && ["error", "expired"].includes(this.elementSessionProvider?.().status ?? "")) {
        await this.beforeMcpConfigurationChange?.();
      }
      configured = await this.listConfiguredMcpServers();
      configuredLoaded = true;
    } catch (error) {
      mcpWarnings.push(`Не удалось прочитать конфигурацию MCP: ${errorMessage(error)}`);
    }
    try {
      runtimeStatuses = await this.runtime.loadMcpRuntimeStatuses();
      runtimeLoaded = true;
    } catch (error) {
      mcpWarnings.push(`Runtime-статусы MCP недоступны: ${errorMessage(error)}`);
    }
    try {
      skills = await this.runtime.loadSkills(forceSkills);
      skillsLoaded = true;
    } catch (error) {
      skillsWarnings.push(`Не удалось обновить навыки: ${errorMessage(error)}`);
    }

    const statusesByName = new Map(runtimeStatuses.map((status) => [status.name, status]));
    const mcpServers = this.withManagedBrowser(configured).map((server) => {
      const runtimeStatus = statusesByName.get(server.name);
      return runtimeStatus ? {
        ...server,
        authStatus: runtimeStatus.authStatus,
        runtimeStatus: runtimeStatus.runtimeStatus,
        toolCount: runtimeStatus.toolCount,
        resourceCount: runtimeStatus.resourceCount,
        description: runtimeStatus.description,
        error: runtimeStatus.error
      } : server;
    });

    const mcpStatus = mcpWarnings.length
      ? (mcpServers.length || configuredLoaded || runtimeLoaded ? "partial" : "error")
      : "ready";
    const skillsStatus = skillsWarnings.length
      ? (skills.length ? "partial" : "error")
      : "ready";
    const warnings = [...mcpWarnings, ...skillsWarnings];
    this.snapshot = {
      status: mcpStatus === "error" && skillsStatus === "error" ? "error" : warnings.length ? "partial" : "ready",
      mcpStatus,
      skillsStatus,
      mcpServers,
      skills,
      message: warnings.join(" "),
      mcpMessage: mcpWarnings.join(" "),
      skillsMessage: skillsWarnings.join(" "),
      updatedAt: new Date().toISOString()
    };
    this.changeEmitter.fire();
    this.logger.info(
      `Integrations refreshed: mcp=${mcpServers.length}; mcpStatus=${mcpStatus}; skills=${skills.length}; skillsStatus=${skillsStatus}; warnings=${warnings.length}.`
    );
    return this.getSnapshot();
  }

  async saveMcpServer(input: McpServerSaveInput): Promise<string> {
    const normalized = normalizeMcpInput(input);
    if (isReservedBrowserName(normalized.name) || (normalized.originalName && isReservedBrowserName(normalized.originalName))) {
      throw new Error("Управляемый браузер настраивается в разделе браузерного тестирования, а не в общем MCP-профиле.");
    }
    if (normalized.transport === "http" && this.elementEndpoint() && elementMcpEndpointKey(normalized.url!, true) === this.elementEndpoint()) {
      const configured = await this.getElementMcpTargets();
      if (configured.some(server => server.name !== normalized.name && server.name !== normalized.originalName)) {
        throw new Error("Этот 1C Element MCP уже подключён. Измените существующий сервер, не создавая второе подключение.");
      }
      if (normalized.bearerTokenEnvVar?.toUpperCase() === "ELEMENT_IDE_MCP_SESSION_TOKEN") {
        throw new Error("Переменная IDE-сессии управляется плагином и не может использоваться как bearer token.");
      }
    }
    const codexHome = await this.getCodexHome();
    const elementChanged = await this.invalidateElementBindingIfNeeded(normalized.transport === "http" ? normalized.url : undefined);
    await editMcpConfig(codexHome, async (stagedHome) => {
      if (normalized.transport === "http" && this.elementEndpoint()
        && elementMcpEndpointKey(normalized.url!, true) === this.elementEndpoint()
        && (await this.getElementMcpTargets(stagedHome)).some(server => server.name !== normalized.name && server.name !== normalized.originalName)) {
        throw new Error("Другой сеанс уже добавил этот 1C Element MCP. Обновите список серверов.");
      }
      if (normalized.originalName) {
        await this.runCli(["mcp", "remove", normalized.originalName], stagedHome);
      }
      const args = ["mcp", "add", normalized.name];
      if (normalized.transport === "http") {
        args.push("--url", normalized.url!);
        if (normalized.bearerTokenEnvVar) {
          args.push("--bearer-token-env-var", normalized.bearerTokenEnvVar);
        }
      } else {
        args.push("--", normalized.command!, ...(normalized.args ?? []));
      }
      await this.runCli(args, stagedHome);
      if (normalized.enabled === false) {
        await setMcpEnabledInConfig(path.join(stagedHome, "config.toml"), normalized.name, false);
      }
    });
    await this.reloadRuntimeMcpIfRunning(elementChanged);
    await this.refreshAfterMcpMutation();
    this.logger.info(`MCP server saved: name=${normalized.name}; transport=${normalized.transport}; enabled=${normalized.enabled !== false}.`);
    return normalized.name;
  }

  async getConfiguredMcpServer(name: string): Promise<McpServerOption | undefined> {
    const normalizedName = validateMcpName(name);
    return (await this.listConfiguredMcpServers()).find((server) => server.name === normalizedName);
  }

  async removeMcpServer(name: string): Promise<void> {
    const normalizedName = validateMcpName(name);
    const codexHome = await this.getCodexHome();
    const elementChanged = await this.invalidateElementBindingIfNeeded();
    await editMcpConfig(codexHome, async (stagedHome) => {
      await this.runCli(["mcp", "remove", normalizedName], stagedHome);
    });
    await this.reloadRuntimeMcpIfRunning(elementChanged);
    await this.refreshAfterMcpMutation();
    this.logger.info(`MCP server removed: name=${normalizedName}.`);
  }

  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const normalizedName = validateMcpName(name);
    if (isReservedBrowserName(normalizedName)) {
      throw new Error("Измените настройки браузерного тестирования текущего пользователя и проекта.");
    }
    if (enabled) {
      const targets = await this.getElementMcpTargets();
      if (targets.some(target => target.name === normalizedName)
        && targets.some(target => target.name !== normalizedName && target.enabled)) {
        throw new Error("Этот 1C Element MCP уже включён под другим именем. Оставьте одно подключение.");
      }
    }
    const codexHome = await this.getCodexHome();
    const elementChanged = await this.invalidateElementBindingIfNeeded(undefined, enabled ? normalizedName : undefined);
    await editMcpConfig(codexHome, async (stagedHome) => {
      if (enabled) {
        const targets = await this.getElementMcpTargets(stagedHome);
        if (targets.some(target => target.name === normalizedName) && targets.some(target => target.name !== normalizedName && target.enabled)) {
          throw new Error("Другой сеанс уже включил этот 1C Element MCP. Обновите список серверов.");
        }
      }
      await setMcpEnabledInConfig(path.join(stagedHome, "config.toml"), normalizedName, enabled);
    });
    await this.reloadRuntimeMcpIfRunning(elementChanged);
    await this.refreshAfterMcpMutation();
    this.logger.info(`MCP server ${enabled ? "enabled" : "disabled"}: name=${normalizedName}.`);
  }

  async startMcpOAuth(name: string): Promise<void> {
    await this.runtime.startMcpOAuth(validateMcpName(name));
  }

  async testMcpServer(name: string): Promise<McpConnectionTestResult> {
    const normalizedName = validateMcpName(name);
    let configured = this.snapshot.mcpServers.find((server) => server.name === normalizedName);
    if (!configured) {
      const servers = await this.listConfiguredMcpServers();
      configured = servers.find((server) => server.name === normalizedName);
    }
    if (!configured) {
      throw new Error(`MCP-сервер ${normalizedName} не найден в профиле Codex.`);
    }
    if (!configured.enabled) {
      return {
        name: normalizedName,
        status: "disabled",
        message: "Сервер выключен. Включите его перед проверкой.",
        runtimeStatus: "cancelled",
        authStatus: configured.authStatus,
        toolCount: 0,
        resourceCount: 0
      };
    }

    await this.reloadRuntimeMcpIfRunning();
    const statuses = await this.runtime.loadMcpRuntimeStatuses();
    const session = this.elementSessionProvider?.();
    if (session?.serverName === normalizedName && !["ready", "renewing"].includes(session.status)) {
      return { name: normalizedName, status: "failed", message: session.message, runtimeStatus: "failed",
        authStatus: configured.authStatus, toolCount: 0, resourceCount: 0 };
    }
    const runtimeStatus = statuses.find((candidate) => candidate.name === normalizedName);
    const resolved: McpServerOption = runtimeStatus ? {
      ...configured,
      authStatus: runtimeStatus.authStatus,
      runtimeStatus: runtimeStatus.runtimeStatus,
      toolCount: runtimeStatus.toolCount,
      resourceCount: runtimeStatus.resourceCount,
      description: runtimeStatus.description,
      error: runtimeStatus.error
    } : {
      ...configured,
      runtimeStatus: "failed",
      error: "App-server не вернул статус этого MCP-сервера."
    };

    this.snapshot = {
      ...this.snapshot,
      mcpStatus: resolved.runtimeStatus === "failed" ? "partial" : this.snapshot.mcpStatus,
      mcpServers: replaceMcpServer(this.snapshot.mcpServers, resolved),
      updatedAt: new Date().toISOString()
    };
    this.changeEmitter.fire();

    const status: McpConnectionTestResult["status"] = resolved.authStatus === "notLoggedIn"
      ? "authRequired"
      : resolved.runtimeStatus === "ready"
        ? "ready"
        : "failed";
    const message = status === "ready"
      ? `Соединение установлено: ${resolved.toolCount} ${pluralRu(resolved.toolCount, "инструмент", "инструмента", "инструментов")}, ${resolved.resourceCount} ${pluralRu(resolved.resourceCount, "ресурс", "ресурса", "ресурсов")}.`
      : status === "authRequired"
        ? "Сервер доступен, но требует входа."
        : mcpFailureMessage(resolved.runtimeStatus, resolved.error);
    this.logger.info(
      `MCP server tested: name=${normalizedName}; status=${status}; runtime=${resolved.runtimeStatus}; auth=${resolved.authStatus}; tools=${resolved.toolCount}; resources=${resolved.resourceCount}.`
    );
    return {
      name: normalizedName,
      status,
      message,
      runtimeStatus: resolved.runtimeStatus,
      authStatus: resolved.authStatus,
      toolCount: resolved.toolCount,
      resourceCount: resolved.resourceCount,
      details: resolved.error
    };
  }

  async setSkillEnabled(skill: SkillSelection, enabled: boolean): Promise<void> {
    if (!skill.name.trim() || !path.isAbsolute(skill.path)) {
      throw new Error("Навык не содержит корректный абсолютный путь.");
    }
    await this.runtime.setSkillEnabled(skill, enabled);
    await this.refresh(true);
    this.logger.info(`Skill ${enabled ? "enabled" : "disabled"}: name=${skill.name}; scope=profile/runtime.`);
  }

  async listEnabledSkills(forceReload = false): Promise<SkillOption[]> {
    const skills = await this.runtime.loadSkills(forceReload);
    if (this.snapshot.status !== "idle") {
      this.snapshot = {
        ...this.snapshot,
        skills,
        skillsStatus: "ready",
        skillsMessage: "",
        updatedAt: new Date().toISOString()
      };
      this.changeEmitter.fire();
    }
    return skills.filter((skill) => skill.enabled);
  }

  private async listConfiguredMcpServers(): Promise<McpServerOption[]> {
    const records = await this.readConfiguredMcpRecords();
    return this.withManagedBrowser(records.flatMap((candidate) => normalizeMcpCliRecord(candidate)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async readConfiguredMcpRecords(home?: string): Promise<McpCliRecord[]> {
    const result = await this.runCli(["mcp", "list", "--json"], home);
    const records = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(records)) {
      throw new Error("Codex CLI вернул некорректный список MCP-серверов.");
    }
    return records.filter((record): record is McpCliRecord => Boolean(record && typeof record === "object" && typeof record.name === "string"));
  }

  private withManagedBrowser(configured: McpServerOption[]): McpServerOption[] {
    const servers = configured.filter((server) => !isReservedBrowserName(server.name));
    const managed = this.managedBrowserProvider?.();
    if (managed) {
      const previous = configured.find((server) => server.name === managed.name);
      servers.push({
        authStatus: "unsupported", runtimeStatus: "unknown", toolCount: 0, resourceCount: 0,
        ...previous,
        name: managed.name, enabled: managed.enabled !== false, transport: "stdio", command: managed.command,
        args: [...managed.args ?? []], managed: "browser"
      });
    }
    return servers;
  }

  private async reloadRuntimeMcpIfRunning(elementChanged = false): Promise<void> {
    // Cancel even a still-starting client that read configuration before publication.
    if (elementChanged) await this.beforeMcpConfigurationChange?.();
    else await this.invalidateElementBindingIfNeeded();
    if (this.runtime.isBackendRunning()) await this.runtime.reloadMcpServers();
  }

  private async refreshAfterMcpMutation(): Promise<CodexIntegrationsSnapshot> {
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
    return this.refresh(true);
  }

  private async invalidateElementBindingIfNeeded(incomingUrl?: string, enablingName?: string): Promise<boolean> {
    if (!this.beforeMcpConfigurationChange) return false;
    const session = this.elementSessionProvider?.();
    const endpoint = this.elementEndpoint();
    if ((session && ["connecting", "ready", "renewing", "revoking"].includes(session.status))
      || (incomingUrl && endpoint && elementMcpEndpointKey(incomingUrl, true) === endpoint)
      || (await this.getElementMcpTargets()).some(target => target.enabled || target.name === enablingName)) {
      await this.beforeMcpConfigurationChange();
      return true;
    }
    return false;
  }

  private async getCodexHome(): Promise<string> {
    const profileId = await this.profiles.requireProfileId(this.settings.listExistingProfileIds());
    return this.settings.ensureUserCodexHome(profileId);
  }

  private async runCli(args: string[], home?: string): Promise<CliResult> {
    const resolution = resolveBundledRuntimeExecutable(this.context.extensionUri.fsPath);
    const validation = validateRuntimeExecutable(resolution);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const codexHome = home ?? await this.getCodexHome();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome
    };
    return runProcess(resolution.path, args, env, 20_000);
  }
}

function replaceMcpServer(servers: readonly McpServerOption[], replacement: McpServerOption): McpServerOption[] {
  const next = servers.map((server) => server.name === replacement.name ? replacement : server);
  return next.some((server) => server.name === replacement.name)
    ? next
    : [...next, replacement].sort((left, right) => left.name.localeCompare(right.name));
}

function isReservedBrowserName(name: string): boolean {
  return name === MANAGED_BROWSER_MCP_NAME || name.startsWith(`${MANAGED_BROWSER_MCP_NAME}-`);
}

function pluralRu(value: number, one: string, few: string, many: string): string {
  const normalized = Math.abs(Math.trunc(value));
  const lastTwo = normalized % 100;
  const last = normalized % 10;
  if (lastTwo >= 11 && lastTwo <= 14) {
    return many;
  }
  if (last === 1) {
    return one;
  }
  return last >= 2 && last <= 4 ? few : many;
}

function mcpFailureMessage(status: McpServerOption["runtimeStatus"], details?: string): string {
  if (status === "starting") {
    return "Сервер не успел завершить запуск. Повторите проверку через несколько секунд.";
  }
  if (status === "cancelled") {
    return "Запуск сервера был отменен runtime.";
  }
  const normalized = (details ?? "").toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "Сервер не ответил вовремя.";
  }
  if (normalized.includes("protocol") || normalized.includes("handshake") || normalized.includes("initialize")) {
    return "Сервер запущен, но не завершил MCP handshake.";
  }
  if (normalized.includes("refused") || normalized.includes("econnrefused")) {
    return "Подключение отклонено. Проверьте URL, порт и доступность сервера.";
  }
  if (normalized.includes("spawn") || normalized.includes("enoent") || normalized.includes("not found")) {
    return "Не удалось запустить команду MCP-сервера. Проверьте путь и аргументы.";
  }
  return "Не удалось подключиться к MCP-серверу.";
}

function normalizeMcpInput(input: McpServerSaveInput): Required<Pick<McpServerSaveInput, "name" | "transport" | "enabled">> & McpServerSaveInput {
  const name = validateMcpName(input.name);
  const originalName = input.originalName?.trim() ? validateMcpName(input.originalName) : undefined;
  if (input.transport === "http") {
    const rawUrl = input.url?.trim() ?? "";
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("Укажите корректный URL MCP-сервера.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MCP URL должен использовать http или https.");
    }
    const bearerTokenEnvVar = input.bearerTokenEnvVar?.trim() ?? "";
    if (bearerTokenEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar)) {
      throw new Error("Имя переменной bearer token содержит недопустимые символы.");
    }
    return { ...input, originalName, name, transport: "http", url: parsed.toString(), bearerTokenEnvVar, enabled: input.enabled !== false };
  }
  const command = input.command?.trim() ?? "";
  if (!command || /[\r\n\0]/.test(command)) {
    throw new Error("Укажите команду запуска MCP-сервера.");
  }
  const args = (input.args ?? []).map((arg) => arg.trim()).filter(Boolean).slice(0, 50);
  return { ...input, originalName, name, transport: "stdio", command, args, enabled: input.enabled !== false };
}

function referencesSessionEnvironment(transport: Record<string, unknown>): boolean {
  const reserved = (value: unknown): boolean =>
    typeof value === "string" && value.toUpperCase() === "ELEMENT_IDE_MCP_SESSION_TOKEN";
  const headers = transport.env_http_headers;
  return reserved(transport.bearer_token_env_var)
    || Boolean(headers && typeof headers === "object" && Object.values(headers).some(reserved));
}

function validateMcpName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
    throw new Error("Имя MCP-сервера: 1-64 символа, только латиница, цифры, _ и -.");
  }
  return normalized;
}

function normalizeMcpCliRecord(value: unknown): McpServerOption[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as McpCliRecord;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const transport = record.transport && typeof record.transport === "object" ? record.transport : {};
  const type = transport.type === "stdio" ? "stdio" : transport.type === "streamable_http" ? "http" : undefined;
  if (!name || !type) {
    return [];
  }
  return [{
    name,
    enabled: record.enabled !== false,
    transport: type,
    command: type === "stdio" && typeof transport.command === "string" ? transport.command : undefined,
    args: type === "stdio" && Array.isArray(transport.args) ? transport.args.filter((arg): arg is string => typeof arg === "string") : undefined,
    url: type === "http" && typeof transport.url === "string" ? transport.url : undefined,
    bearerTokenEnvVar: type === "http" && typeof transport.bearer_token_env_var === "string" ? transport.bearer_token_env_var : undefined,
    authStatus: normalizeCliAuthStatus(record.auth_status),
    runtimeStatus: "unknown",
    toolCount: 0,
    resourceCount: 0,
    error: record.disabled_reason || undefined,
    managed: name === MANAGED_BROWSER_MCP_NAME ? "browser" : undefined
  }];
}

function normalizeCliAuthStatus(value: unknown): McpServerOption["authStatus"] {
  if (value === "unsupported") {
    return "unsupported";
  }
  if (value === "not_logged_in") {
    return "notLoggedIn";
  }
  if (value === "bearer_token") {
    return "bearerToken";
  }
  if (value === "oauth" || value === "o_auth") {
    return "oAuth";
  }
  return "unknown";
}

async function setMcpEnabledInConfig(configPath: string, name: string, enabled: boolean): Promise<void> {
  const source = await readOptionalFile(configPath);
  if (source === undefined) {
    throw new Error("config.toml не найден: сначала добавьте MCP-сервер.");
  }
  const lines = source.split(/\r?\n/);
  const header = `[mcp_servers.${name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    throw new Error(`MCP-сервер ${name} не найден в config.toml.`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.*\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const enabledIndex = lines.slice(start + 1, end).findIndex((line) => /^\s*enabled\s*=/.test(line));
  const value = `enabled = ${enabled ? "true" : "false"}`;
  if (enabledIndex >= 0) {
    lines[start + 1 + enabledIndex] = value;
  } else {
    lines.splice(start + 1, 0, value);
  }
  await fs.promises.writeFile(configPath, lines.join("\n"), "utf8");
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex CLI не ответил вовремя."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = limitOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = limitOutput(stderr + chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(sanitizeCliError(stderr.trim()) || `Codex CLI завершился с кодом ${code ?? "-"}.`));
      }
    });
  });
}

function limitOutput(value: string): string {
  return value.length <= 1_000_000 ? value : value.slice(value.length - 1_000_000);
}

function sanitizeCliError(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [скрыто]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/gi, "$1?[параметры скрыты]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[скрыто]");
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// CLI edits run against a private CODEX_HOME. Failure never restores an old live
// file over another IDE's edits. The lock coordinates extension hosts; the final
// comparison also detects writers that do not participate in our lock protocol.
async function editMcpConfig(home: string, edit: (stagedHome: string) => Promise<void>): Promise<void> {
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
  const realHome = await fs.promises.realpath(home);
  const lockPath = path.join(realHome, ".codex-element-mcp.lock");
  const deadline = Date.now() + 25_000;
  let lock: fs.promises.FileHandle;
  for (;;) {
    try {
      lock = await fs.promises.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Конфигурация MCP занята другим сеансом. Повторите операцию после его завершения.");
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  let staging: string | undefined;
  try {
    const configPath = path.join(realHome, "config.toml");
    const before = readConfigRevision(configPath);
    staging = await fs.promises.mkdtemp(path.join(realHome, ".mcp-edit-"));
    const stagedConfig = path.join(staging, "config.toml");
    if (before.content !== undefined) {
      await fs.promises.writeFile(stagedConfig, before.content, { mode: 0o600, flag: "wx" });
    }
    await edit(staging);
    const next = await readOptionalFile(stagedConfig);
    if (next === undefined) {
      throw new Error("Codex CLI не создал конфигурацию MCP.");
    }
    const handle = await fs.promises.open(stagedConfig, "r+");
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Keep comparison and rename in one event-loop turn. No async gap permits
    // another in-process config writer to slip in after the conflict check.
    const current = readConfigRevision(configPath);
    if (before.signature !== current.signature || before.content !== current.content) {
      throw new Error("Конфигурация MCP изменена другим процессом. Изменения сохранены; повторите операцию.");
    }
    fs.renameSync(stagedConfig, configPath);
  } finally {
    try {
      if (staging) {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    } finally {
      await lock.close();
      await fs.promises.unlink(lockPath);
    }
  }
}

function readConfigRevision(filePath: string): { signature: string; content: string | undefined } {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("config.toml должен быть обычным файлом, не символической ссылкой.");
    }
    return {
      signature: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
      content: fs.readFileSync(filePath, "utf8")
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { signature: "missing", content: undefined };
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
