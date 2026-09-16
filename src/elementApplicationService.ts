import { createHash } from "crypto";
import * as vscode from "vscode";
import { ConsoleRequest, ElementConnection, ElementConsoleClient, ElementConsoleError } from "./elementConsoleClient";
import type { Logger } from "./logger";

interface ApplicationConnection extends ElementConnection { applicationId: string; externalUri: string; }
export interface ElementApplicationView {
  status: "idle" | "loading" | "ready" | "error";
  url: string;
  name: string;
  message: string;
}
export interface BrowserApplicationProvider {
  getView(): ElementApplicationView;
  resolve(force?: boolean): Promise<ElementApplicationView>;
}

const CONFIG_KEYS = ["server", "clientId", "clientSecret", "projectId", "applicationId", "serverExternalUri"];
const emptyView = (): ElementApplicationView => ({ status: "idle", url: "", name: "", message: "Адрес приложения ещё не получен из IDE." });

/** Application selection is independent of the persistent project/history namespace. */
export class ElementApplicationService implements BrowserApplicationProvider, vscode.Disposable {
  private current = emptyView();
  private fingerprint = "";
  private checkedAt = 0;
  private pending: Promise<ElementApplicationView> | undefined;
  private abort: AbortController | undefined;
  private disposed = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly connection: () => ApplicationConnection = readConnection,
    private readonly request?: ConsoleRequest,
    private readonly readPageLocation: () => PromiseLike<unknown> = () => vscode.commands.executeCommand("com.e1c.g5rt.getCurrentPageLocation")
  ) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (CONFIG_KEYS.some((key) => event.affectsConfiguration(`1C.${key}`))) this.invalidate();
    });
  }

  getView(): ElementApplicationView {
    if (this.fingerprint && this.fingerprint !== fingerprint(this.connection())) this.invalidate();
    return { ...this.current };
  }

  async resolve(force = false): Promise<ElementApplicationView> {
    if (this.disposed) return { ...emptyView(), status: "error", message: "Проверка приложения IDE остановлена." };
    const connection = { ...this.connection() };
    const key = fingerprint(connection);
    if (this.fingerprint && this.fingerprint !== key) this.invalidate();
    if (this.pending) return this.pending;
    const cacheMs = this.current.status === "ready" ? 60_000 : 5_000;
    if (!force && this.checkedAt && Date.now() - this.checkedAt < cacheMs) return this.getView();
    this.fingerprint = key;
    this.current = { ...emptyView(), status: "loading", message: "Получаем адрес приложения из IDE..." };
    const abort = new AbortController();
    this.abort = abort;
    const pending = this.lookup(connection, abort.signal).then((application) => {
      if (abort.signal.aborted || this.disposed || key !== fingerprint(this.connection())) {
        return { ...emptyView(), status: "error" as const, message: "Приложение или пользователь IDE изменился. Повторите действие." };
      }
      this.current = application;
      this.checkedAt = Date.now();
      this.logger.info("Element application URL resolved from Console for the current IDE; MCP is not required.");
      return this.getView();
    }).catch((error: unknown) => {
      const view: ElementApplicationView = { ...emptyView(), status: "error", message: error instanceof Error ? error.message : "Не удалось получить адрес приложения из IDE." };
      if (!abort.signal.aborted && !this.disposed && key === fingerprint(this.connection())) {
        this.current = view;
        this.checkedAt = Date.now();
        this.logger.warn(`Element application lookup failed: ${error instanceof ElementConsoleError ? error.diagnostic : "invalid_application"}.`);
      }
      return view;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      if (this.abort === abort) this.abort = undefined;
    });
    this.pending = pending;
    return pending;
  }

  invalidate(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.pending = undefined;
    this.fingerprint = "";
    this.checkedAt = 0;
    this.current = emptyView();
  }

  dispose(): void { this.disposed = true; this.invalidate(); this.subscription.dispose(); }

  private async lookup(connection: ApplicationConnection, signal: AbortSignal): Promise<ElementApplicationView> {
    if (!connection.applicationId) throw new Error("В IDE не выбрано приложение (1C.applicationId). Выберите приложение средствами IDE и повторите проверку.");
    let pageLocation: unknown;
    if (process.env.E1C_IDE_MODE === "advanced" || process.env.E1C_IDE_MODE === "testing") {
      pageLocation = connection.server;
    } else {
      let timer: NodeJS.Timeout | undefined;
      try {
        pageLocation = await Promise.race([
          this.readPageLocation(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IDE не вернула внешний адрес.")), 3_000); })
        ]);
      } catch {
        // An explicit external address also supports hosts without the frontend command.
        pageLocation = connection.externalUri || connection.server;
      } finally { clearTimeout(timer); }
    }
    const pageUrl = httpUrl(pageLocation, "IDE вернула некорректный адрес страницы.");
    const application = await new ElementConsoleClient(connection, this.request).readApplication(connection.applicationId, pageUrl, signal);
    if (!sameId(application.id, connection.applicationId)) {
      throw new Error("Console вернула другое приложение. Адрес браузера не изменён; повторите проверку в текущей IDE.");
    }
    if (application["project-id"] !== undefined && !sameId(application["project-id"], connection.projectId)) {
      throw new Error("Приложение Console не относится к проекту текущей IDE.");
    }
    const url = httpUrl(application.uri, "Console не вернула корректный HTTP(S) адрес приложения. Проверьте его публикацию в Element.");
    return { status: "ready", url: url.toString(), name: text(application["display-name"]) || text(application.name), message: "Приложение определено по текущей IDE." };
  }
}

function readConnection(): ApplicationConnection {
  const config = vscode.workspace.getConfiguration("1C");
  return {
    server: config.get<string>("server", "").trim(), clientId: config.get<string>("clientId", "").trim(),
    clientSecret: config.get<string>("clientSecret", ""), projectId: config.get<string>("projectId", "").trim(),
    applicationId: config.get<string>("applicationId", "").trim(), externalUri: config.get<string>("serverExternalUri", "").trim()
  };
}
function fingerprint(connection: ApplicationConnection): string { return createHash("sha256").update(JSON.stringify(connection)).digest("hex"); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function sameId(left: unknown, right: string): boolean {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return typeof left === "string" && (left === right || (uuid.test(left) && uuid.test(right) && left.toLowerCase() === right.toLowerCase()));
}
function httpUrl(value: unknown, message: string): URL {
  const input = text(value);
  if (!input || input.length > 8192 || /[\x00-\x20\x7f]/.test(input)) throw new Error(message);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(message); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(message);
  return url;
}
