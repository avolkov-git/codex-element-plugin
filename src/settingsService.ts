import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { discoverDocsCorpora, fingerprintDocsCorpora } from "./docsCorpusService";
import { DocsContextDetails, DocsRootDetail } from "./types";

interface ServerSettingsFile {
  version: number;
  proxy?: {
    url?: string;
    username?: string;
  };
  docs?: {
    sourcePath?: string;
    normalizedPath?: string;
  };
}

interface ConfigRootResolution {
  path: string;
}

interface ProxySettingsSnapshot {
  url: string;
  username: string;
  passwordSaved: boolean;
  validationMessage: string;
}

export interface ProxySaveInput {
  url: string;
  username: string;
  password: string;
}

export interface ProxySettingsView {
  url: string;
  username: string;
  passwordSaved: boolean;
}

export interface DocsSettingsView {
  sourcePath: string;
  normalizedPath: string;
  validationMessage: string;
}

export interface RuntimeProxySettings {
  url: string;
  username: string;
  password: string;
}

export class SettingsService {
  private readonly configRoot: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const root = resolveConfigRoot(context);
    this.configRoot = root.path;
    this.ensureStructure();
  }

  async getSidebarProxyStatus(): Promise<{ status: "notConfigured" | "configured" | "error"; label: string }> {
    const proxy = await this.getProxySnapshot();
    if (!proxy.url) {
      return { status: "notConfigured", label: "Proxy не настроен" };
    }
    if (proxy.validationMessage) {
      return { status: "error", label: "Proxy ошибка" };
    }
    if (proxy.username && !proxy.passwordSaved) {
      return { status: "error", label: "Proxy требует пароль" };
    }
    return { status: "configured", label: "Proxy настроен" };
  }

  async getProxySettingsView(): Promise<ProxySettingsView> {
    const proxy = await this.getProxySnapshot();
    return {
      url: proxy.url,
      username: proxy.username,
      passwordSaved: proxy.passwordSaved
    };
  }

  getDocsSettingsView(): DocsSettingsView {
    const docs = this.readSettings().docs;
    const sourcePath = docs?.sourcePath?.trim() ?? "";
    const normalizedPath = docs?.normalizedPath?.trim() ?? "";
    return {
      sourcePath,
      normalizedPath,
      validationMessage: validateDocsPath(normalizedPath)
    };
  }

  getSidebarDocsStatus(): { status: "notConfigured" | "configured" | "error"; label: string } {
    const details = this.getDocsContextDetails();
    if (details.status === "notConfigured") {
      return { status: "notConfigured", label: "Документация не настроена" };
    }
    if (details.status === "error") {
      return { status: "error", label: "Документация недоступна" };
    }
    return { status: "configured", label: "Документация активна" };
  }

  getDocsContextDetails(): DocsContextDetails {
    const docs = this.getDocsSettingsView();
    const allowedRoots = collectDocsRootDetails(docs.normalizedPath, docs.sourcePath, this.configRoot);
    const configuredRoots = allowedRoots.filter((root) => root.status === "configured");

    if (!allowedRoots.length) {
      return {
        kind: "docs",
        status: "notConfigured",
        label: "Документация не настроена",
        source: "none",
        error: "Документация не используется: путь не задан."
      };
    }

    if (!configuredRoots.length) {
      return {
        kind: "docs",
        status: "error",
        label: "Документация недоступна",
        source: "none",
        normalizedPath: docs.normalizedPath,
        sourcePath: docs.sourcePath,
        allowedRoots,
        error: allowedRoots.map((root) => `${root.label}: ${root.error || "корпус не найден"}`).join("; ")
      };
    }

    const primary = configuredRoots[0];
    const corpora = configuredRoots.flatMap((root) => root.corpora ?? []);
    return {
      kind: "docs",
      status: "configured",
      label: configuredRoots.length > 1 ? `Документация: ${configuredRoots.length} источника` : primary.label,
      source: configuredRoots.length > 1 || primary.kind !== "normalized" ? "multiple" : "normalized",
      normalizedPath: docs.normalizedPath,
      sourcePath: docs.sourcePath,
      indexPath: primary.corpora?.[0]?.indexPath,
      corpora,
      allowedRoots,
      fingerprint: primary.fingerprint,
      fingerprintFiles: primary.fingerprintFiles,
      fingerprintLatestMtimeMs: primary.fingerprintLatestMtimeMs
    };
  }

  getConfigRoot(): string {
    return this.configRoot;
  }

  getDefaultDocsNormalizedPath(): string {
    return path.join(this.configRoot, "server", "normalized-docs");
  }

  getUserCodexHome(profileId: string): string {
    return path.join(this.configRoot, "users", profileId, "codex-home");
  }

  listExistingProfileIds(): string[] {
    const usersRoot = path.join(this.configRoot, "users");
    try {
      return fs.readdirSync(usersRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((profileId) => fs.existsSync(path.join(usersRoot, profileId, "codex-home")))
        .sort();
    } catch {
      return [];
    }
  }

  async ensureUserCodexHome(profileId: string): Promise<string> {
    const codexHome = this.getUserCodexHome(profileId);
    await fs.promises.mkdir(codexHome, { recursive: true });
    return codexHome;
  }

  async getRuntimeProxySettings(): Promise<RuntimeProxySettings> {
    const proxy = await this.getProxySnapshot();
    if (!proxy.url) {
      return { url: "", username: "", password: "" };
    }
    if (proxy.validationMessage) {
      throw new Error(proxy.validationMessage);
    }

    const password = await this.context.secrets.get(proxyPasswordSecretKey()) ?? "";
    if (proxy.username && !password) {
      throw new Error("Для proxy указан логин, но пароль не найден в SecretStorage.");
    }

    return {
      url: proxy.url,
      username: proxy.username,
      password
    };
  }

  async saveProxy(input: ProxySaveInput): Promise<void> {
    const url = input.url.trim();
    const username = input.username.trim();
    const password = input.password;

    if (!url) {
      this.writeSettings({ ...this.readSettings(), proxy: { url: "", username: "" } });
      await this.context.secrets.delete(proxyPasswordSecretKey());
      return;
    }

    const validationMessage = validateProxyUrl(url);
    if (validationMessage) {
      throw new Error(validationMessage);
    }

    if (!username && password.length > 0) {
      throw new Error("Пароль нельзя сохранить без логина proxy.");
    }

    if (username && password.length === 0) {
      throw new Error("Введите пароль proxy для указанного логина.");
    }

    this.writeSettings({ ...this.readSettings(), proxy: { url, username } });

    if (username) {
      await this.context.secrets.store(proxyPasswordSecretKey(), password);
    } else {
      await this.context.secrets.delete(proxyPasswordSecretKey());
    }
  }

  saveDocsNormalizedPath(normalizedPath: string): void {
    const current = this.readSettings();
    this.writeSettings({
      ...current,
      docs: {
        ...current.docs,
        normalizedPath: normalizedPath.trim()
      }
    });
  }

  saveDocsSourcePath(sourcePath: string): void {
    const current = this.readSettings();
    this.writeSettings({
      ...current,
      docs: {
        ...current.docs,
        sourcePath: sourcePath.trim()
      }
    });
  }

  saveDocsPaths(sourcePath: string, normalizedPath: string): void {
    const current = this.readSettings();
    this.writeSettings({
      ...current,
      docs: {
        ...current.docs,
        sourcePath: sourcePath.trim(),
        normalizedPath: normalizedPath.trim()
      }
    });
  }

  private async getProxySnapshot(): Promise<ProxySettingsSnapshot> {
    const settings = this.readSettings();
    const url = settings.proxy?.url?.trim() ?? "";
    const username = settings.proxy?.username?.trim() ?? "";
    const passwordSaved = Boolean(await this.context.secrets.get(proxyPasswordSecretKey()));
    const validationMessage = validateProxyUrl(url);
    return {
      url,
      username,
      passwordSaved,
      validationMessage
    };
  }

  private ensureStructure(): void {
    fs.mkdirSync(path.join(this.configRoot, "server"), { recursive: true });
    fs.mkdirSync(path.join(this.configRoot, "users"), { recursive: true });
  }

  private settingsPath(): string {
    return path.join(this.configRoot, "server", "settings.json");
  }

  private readSettings(): ServerSettingsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath(), "utf8")) as ServerSettingsFile;
      return typeof parsed === "object" && parsed !== null ? { ...parsed, version: parsed.version || 1 } : { version: 1 };
    } catch {
      return { version: 1 };
    }
  }

  private writeSettings(settings: ServerSettingsFile): void {
    fs.mkdirSync(path.dirname(this.settingsPath()), { recursive: true });
    fs.writeFileSync(this.settingsPath(), `${JSON.stringify({ ...settings, version: 1 }, null, 2)}\n`, "utf8");
  }
}

function resolveConfigRoot(context: vscode.ExtensionContext): ConfigRootResolution {
  const envRoot = process.env.CODEX_ELEMENT_CONFIG_ROOT?.trim();
  if (envRoot) {
    return { path: envRoot };
  }

  const settingRoot = vscode.workspace.getConfiguration("codexElement").get<string>("configRoot", "").trim();
  if (settingRoot) {
    return { path: settingRoot };
  }

  if (process.platform === "win32") {
    const programData = process.env.PROGRAMDATA || process.env.ProgramData;
    if (programData) {
      const candidate = path.join(programData, "CodexElement");
      if (ensureWritable(candidate)) {
        return { path: candidate };
      }
    }
  }

  const home = os.homedir();
  if (home) {
    const candidate = path.join(home, ".codex-element");
    if (ensureWritable(candidate)) {
      return { path: candidate };
    }
  }

  return { path: path.join(context.globalStorageUri.fsPath, "codex-element") };
}

function ensureWritable(candidate: string): boolean {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function validateProxyUrl(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      return "Для Codex websocket transport используйте proxy URL только вида http://host:port.";
    }
    if (!parsed.hostname || !parsed.port) {
      return "Укажите proxy URL с хостом и портом, например http://proxy.example:8080.";
    }
    if (parsed.username || parsed.password) {
      return "Логин и пароль proxy вводятся отдельными полями, не в URL.";
    }
  } catch {
    return "Proxy URL должен быть валидным, например http://proxy.example:8080.";
  }
  return "";
}

function validateDocsPath(normalizedPath: string): string {
  if (!normalizedPath) {
    return "";
  }
  const discovery = discoverDocsCorpora(normalizedPath);
  return discovery.error ?? "";
}

function docsCorporaForDetails(normalizedPath: string): DocsContextDetails["corpora"] {
  const discovery = discoverDocsCorpora(normalizedPath);
  return discovery.corpora.map((corpus) => ({
    corpus: corpus.corpus,
    label: corpus.label,
    format: corpus.format,
    indexPath: corpus.indexPath,
    files: corpus.files.map((file) => file.path)
  }));
}

function docsFingerprintForDetails(normalizedPath: string): Pick<DocsContextDetails, "fingerprint" | "fingerprintFiles" | "fingerprintLatestMtimeMs"> {
  const fingerprint = fingerprintDocsCorpora(normalizedPath);
  return fingerprint ? {
    fingerprint: fingerprint.value,
    fingerprintFiles: fingerprint.fileCount,
    fingerprintLatestMtimeMs: fingerprint.latestMtimeMs
  } : {};
}

function collectDocsRootDetails(normalizedPath: string, sourcePath: string, configRoot: string): DocsRootDetail[] {
  const roots: Array<{ kind: DocsRootDetail["kind"]; label: string; path: string; includeIfMissing: boolean }> = [];
  if (normalizedPath) {
    roots.push({
      kind: "normalized",
      label: "Нормализованная документация",
      path: normalizedPath,
      includeIfMissing: true
    });
  }
  if (sourcePath && (!normalizedPath || path.resolve(sourcePath) !== path.resolve(normalizedPath))) {
    roots.push({
      kind: "source",
      label: "Исходная документация",
      path: sourcePath,
      includeIfMissing: true
    });
  }
  roots.push(...discoverServerDocsRoots(configRoot).map((root) => ({
    kind: "serverDocs" as const,
    label: "Документация server/docs",
    path: root,
    includeIfMissing: false
  })));

  const seen = new Set<string>();
  return roots
    .filter((root) => {
      const resolved = path.resolve(root.path);
      if (seen.has(resolved)) {
        return false;
      }
      seen.add(resolved);
      return root.includeIfMissing || fs.existsSync(resolved);
    })
    .map((root) => docsRootDetail(root.kind, root.label, root.path));
}

function docsRootDetail(kind: DocsRootDetail["kind"], label: string, rootPath: string): DocsRootDetail {
  const resolved = path.resolve(rootPath);
  const discovery = discoverDocsCorpora(resolved);
  if (discovery.error || !discovery.corpora.length) {
    return {
      kind,
      label,
      path: resolved,
      status: "error",
      error: discovery.error || "Поддерживаемый корпус документации не найден."
    };
  }

  return {
    kind,
    label,
    path: resolved,
    status: "configured",
    corpora: docsCorporaForDetails(resolved),
    ...docsFingerprintForDetails(resolved)
  };
}

function discoverServerDocsRoots(configRoot: string): string[] {
  const roots: string[] = [];
  const envRoot = process.env.CODEX_ELEMENT_SERVER_DOCS?.trim();
  if (envRoot) {
    roots.push(envRoot);
  }
  roots.push(path.join(configRoot, "server", "docs"));

  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    roots.push(
      path.join(current, "server", "docs", "help", "ru"),
      path.join(current, "server", "docs"),
      path.join(current, "docs", "help", "ru"),
      path.join(current, "docs")
    );
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const seen = new Set<string>();
  return roots
    .map((root) => path.resolve(root))
    .filter((root) => {
      if (seen.has(root) || !fs.existsSync(root)) {
        return false;
      }
      seen.add(root);
      return true;
    });
}

function proxyPasswordSecretKey(): string {
  return "codexElement.proxyPassword.server";
}
