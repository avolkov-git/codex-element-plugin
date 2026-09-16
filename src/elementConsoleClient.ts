import * as http from "http";
import * as https from "https";

export interface ElementConnection { server: string; clientId: string; clientSecret: string; projectId: string; }
export type ConsoleRequest = (url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string, signal?: AbortSignal) => Promise<unknown>;
export type ConsoleStage = "configuration" | "token" | "user" | "project" | "identity" | "application";
export type ConsoleErrorCode = "configuration_missing" | "configuration_invalid" | "token_missing" | "http_status" | "network" | "timeout" | "response_size" | "response_json" | "response_shape" | "identity_fields" | "cancelled";

/** Diagnostics contain only our field names/status codes, never Console response bodies. */
export class ElementConsoleError extends Error {
  constructor(readonly stage: ConsoleStage, readonly code: ConsoleErrorCode, message: string, readonly detail = "", readonly statusCode?: number) {
    super(message);
    this.name = "ElementConsoleError";
  }

  get diagnostic(): string {
    return `stage=${this.stage}; code=${this.code}${this.statusCode === undefined ? "" : `; http=${this.statusCode}`}${this.detail ? `; ${this.detail}` : ""}`;
  }
}

/** A per-lookup Console session using only the credentials of this IDE, not an MCP session. */
export class ElementConsoleClient {
  private readonly connection: ElementConnection;

  constructor(connection: ElementConnection, private readonly request: ConsoleRequest = requestConsoleJson) {
    this.connection = { ...connection };
  }

  async readIdentity(signal?: AbortSignal): Promise<{ server: string; user: Record<string, unknown>; project: Record<string, unknown> }> {
    const { server, get } = await this.session(signal);
    const user = await get("/api/v2/me", "user");
    const project = await get(`/api/v2/projects/${encodeURIComponent(this.connection.projectId)}`, "project");
    return { server, user, project };
  }

  async readApplication(applicationId: string, pageUrl: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!applicationId.trim()) {
      throw new ElementConsoleError("configuration", "configuration_missing", "В IDE не выбрано приложение (1C.applicationId). Выберите приложение средствами IDE и повторите проверку.");
    }
    const { get } = await this.session(signal);
    // Match the bundle's PaasClient.getApplicationInfo, including reverse-proxy headers.
    return get(`/api/v2/applications/${encodeURIComponent(applicationId)}`, "application", {
      "X-Forwarded-Host": pageUrl.host,
      "X-Forwarded-Proto": pageUrl.protocol.slice(0, -1)
    });
  }

  private async session(signal?: AbortSignal) {
    const missing = (["server", "clientId", "clientSecret", "projectId"] as const).filter((key) => !this.connection[key]?.trim());
    if (missing.length) {
      throw new ElementConsoleError("configuration", "configuration_missing", "Не удалось определить подключение IDE. Откройте IDE из проекта Element. Не заполнены настройки: " + missing.map((key) => `1C.${key}`).join(", ") + ".", `missing=${missing.join(",")}`);
    }
    const server = normalizeConsoleServer(this.connection.server);
    const getToken = async (): Promise<string> => {
      const result = consoleObject(await this.call(new URL(`${server}/sys/token`), "POST", {
        Authorization: `Basic ${Buffer.from(`${this.connection.clientId}:${this.connection.clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }, "grant_type=CLIENT_CREDENTIALS", signal), "token");
      // Element normally supplies id_token. Some Console versions use access_token.
      const token = text(result.id_token) || text(result.access_token);
      if (!token || token === "Not implemented") {
        throw new ElementConsoleError("token", "token_missing", "Console не вернула id_token/access_token для проверки пользователя IDE.");
      }
      return token;
    };
    let token = await getToken();
    let refreshed = false;
    const get = async (endpoint: string, stage: "user" | "project" | "application", headers: Record<string, string> = {}): Promise<Record<string, unknown>> => {
      try {
        return consoleObject(await this.call(new URL(`${server}${endpoint}`), "GET", { ...headers, Authorization: `Bearer ${token}` }, undefined, signal), stage);
      } catch (error) {
        // Only an expired credential can be retried, once per lookup. Never retry 403 or guess another user.
        if (!(error instanceof ElementConsoleError) || error.statusCode !== 401 || refreshed) { throw error; }
        refreshed = true;
        token = await getToken();
        return consoleObject(await this.call(new URL(`${server}${endpoint}`), "GET", { ...headers, Authorization: `Bearer ${token}` }, undefined, signal), stage);
      }
    };
    return { server, get };
  }

  private async call(url: URL, method: "GET" | "POST", headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const stage = requestStage(url, method);
    if (signal?.aborted) { throw cancelled(stage); }
    try { return await this.request(url, method, headers, body, signal); }
    catch (error) {
      if (signal?.aborted) { throw cancelled(stage); }
      if (error instanceof ElementConsoleError) { throw error; }
      throw new ElementConsoleError(stage, "network", `Не удалось подключиться к Console (${stageLabel(stage)}). Проверьте доступность сервера Element.`);
    }
  }
}

export function normalizeConsoleServer(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ElementConsoleError("configuration", "configuration_invalid", "В настройках 1C указан некорректный адрес сервера."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ElementConsoleError("configuration", "configuration_invalid", "Адрес сервера 1C должен быть HTTP(S) URL без учетных данных и параметров.");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/console(?:\/.*)?$/, "");
  return `${url.origin}${pathname}/console`;
}

export function consoleObject(value: unknown, stage: ConsoleStage): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) { return value as Record<string, unknown>; }
  throw new ElementConsoleError(stage, "response_shape", `Console вернула неожиданный формат ответа (${stageLabel(stage)}).`, `shape=${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
}

export function requestConsoleJson(url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string, signal?: AbortSignal): Promise<unknown> {
  const stage = requestStage(url, method);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled(stage)); return; }
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const cleanup = (): void => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); };
    const fail = (code: ConsoleErrorCode, message: string, statusCode?: number): void => {
      if (settled) { return; }
      settled = true; cleanup(); reject(new ElementConsoleError(stage, code, message, "", statusCode));
    };
    const transport = url.protocol === "https:" ? https : http;
    // No redirects, shared cookies, global proxy, or raw error/response text with credentials.
    const request = transport.request(url, { method, headers: { ...headers, Accept: "application/json", ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
      if (response.statusCode !== 200) {
        const status = response.statusCode ?? 0;
        fail("http_status", status === 401 || status === 403
          ? `Console отклонила проверку (${stageLabel(stage)}, HTTP ${status}). Повторно откройте IDE из проекта Element.`
          : `Не удалось проверить подключение IDE (${stageLabel(stage)}, Console HTTP ${status}).`, status);
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) { return; }
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail("response_size", `Ответ Console превышает допустимый размер (${stageLabel(stage)}).`); response.destroy(); return; }
        chunks.push(chunk);
      });
      const interrupted = (): void => fail("network", `Соединение с Console прервано (${stageLabel(stage)}). Повторите проверку.`);
      response.on("error", interrupted);
      response.on("aborted", interrupted);
      response.on("close", () => { if (!response.complete) { interrupted(); } });
      response.on("end", () => {
        if (settled) { return; }
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); settled = true; cleanup(); resolve(parsed); }
        catch { fail("response_json", `Console вернула некорректный JSON (${stageLabel(stage)}).`); }
      });
    });
    const abort = (): void => { fail("cancelled", "Проверка пользователя IDE отменена. Повторите действие."); request.destroy(); };
    signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { fail("timeout", `Console не ответила за 8 секунд (${stageLabel(stage)}). Проверьте доступность сервера Element.`); request.destroy(); }, 8_000);
    request.on("error", () => fail("network", `Не удалось подключиться к Console (${stageLabel(stage)}). Проверьте доступность сервера Element.`));
    request.end(body);
  });
}

function cancelled(stage: ConsoleStage): ElementConsoleError { return new ElementConsoleError(stage, "cancelled", "Пользователь или проект IDE изменился. Повторите действие."); }
function requestStage(url: URL, method: "GET" | "POST"): ConsoleStage { return method === "POST" ? "token" : url.pathname.endsWith("/me") ? "user" : url.pathname.includes("/api/v2/applications/") ? "application" : "project"; }
function stageLabel(stage: ConsoleStage): string { return { configuration: "настройки 1C", token: "получение токена", user: "пользователь /me", project: "проект", identity: "пользователь и проект", application: "приложение IDE" }[stage]; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
