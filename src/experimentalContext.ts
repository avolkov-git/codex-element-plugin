export const EXPERIMENTAL_CONTEXT_KEY = "features.context_management.experimental_mode";

export interface ExperimentalContextView {
  status: "idle" | "checking" | "ready" | "unsupported" | "error";
  enabled: boolean;
  runtimeEnabled: boolean | null;
  eligible: boolean;
  canChange: boolean;
  scopeId: string;
  revision: string;
  message: string;
}

export interface ExperimentalContextControls {
  getExperimentalContextView(): ExperimentalContextView;
  refreshExperimentalContext(): Promise<ExperimentalContextView>;
  saveExperimentalContext(enabled: boolean, scopeId: string, revision: string): Promise<ExperimentalContextView>;
  onDidChangeExperimentalContext: (listener: () => void) => { dispose(): unknown };
}

export type ContextRpcRequest = (method: string, params: unknown) => Promise<unknown>;

export function emptyExperimentalContext(): ExperimentalContextView {
  return { status: "idle", enabled: false, runtimeEnabled: null, eligible: false, canChange: false,
    scopeId: "", revision: "", message: "Доступность ещё не проверена." };
}

/** Read only runtime-owned config; never infer activation from experimentalApi. */
export async function readExperimentalContext(request: ContextRpcRequest, scopeId: string): Promise<ExperimentalContextView> {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let feature: Record<string, unknown> | undefined;
  for (let page = 0; page < 20; page++) {
    const result = record(await request("experimentalFeature/list", { cursor, limit: 100 }));
    if (!Array.isArray(result.data)) throw new Error("Сервер Codex вернул некорректный список экспериментальных функций.");
    feature = result.data.map(record).find(item => item.name === "context_management");
    if (feature || !result.nextCursor) break;
    if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor) || page === 19) {
      throw new Error("Не удалось получить полный список функций Codex. Повторите проверку.");
    }
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  if (!feature || feature.stage === "removed" || typeof feature.enabled !== "boolean") {
    return { ...emptyExperimentalContext(), scopeId, status: "unsupported", message: "Встроенный app-server не поддерживает экспериментальный контекст. Обновите плагин." };
  }
  const config = record(await request("config/read", { includeLayers: true }));
  const value = record(record(record(config.config).features).context_management);
  const userLayer = Array.isArray(config.layers)
    ? config.layers.map(record).find(layer => record(layer.name).type === "user" && !record(layer.name).profile && !layer.disabledReason)
    : undefined;
  const account = record(record(await request("account/read", { refreshToken: false })).account);
  const plan = typeof account.planType === "string" ? account.planType.toLowerCase().replace(/[- ]/g, "_") : "";
  const eligible = account.type === "chatgpt" && ["plus", "pro", "pro_lite", "prolite"].includes(plan);
  const enabled = value.experimental_mode === true;
  const revision = typeof userLayer?.version === "string" ? userLayer.version : "";
  const message = !eligible
    ? "Для этого режима нужен вход через ChatGPT с подпиской Plus, Pro или Pro Lite."
    : enabled
      ? feature.enabled
        ? "Включено в настройках. Доступность для выбранной модели проверяет app-server при запуске диалога."
        : "Настройка включена, но runtime не подтвердил её применение. Проверьте ограничения конфигурации."
      : "Выключено.";
  return { status: "ready", enabled, runtimeEnabled: feature.enabled, eligible, canChange: Boolean(revision) && (eligible || enabled), scopeId, revision,
    message: revision ? message : "Не удалось проверить версию настроек пользователя. Изменение заблокировано; повторите проверку." };
}

export async function writeExperimentalContext(request: ContextRpcRequest, enabled: boolean, revision: string): Promise<void> {
  if (!revision) throw new Error("Версия настроек неизвестна. Повторите проверку.");
  const result = record(await request("config/value/write", {
    keyPath: EXPERIMENTAL_CONTEXT_KEY, value: enabled, mergeStrategy: "upsert", expectedVersion: revision
  }));
  if (result.status !== "ok" && result.status !== "okOverridden") {
    throw new Error("Сервер Codex не подтвердил сохранение настройки контекста.");
  }
  if (result.status === "okOverridden" || result.overriddenMetadata) {
    throw new Error("Выбор сохранён, но переопределён конфигурацией проекта или сервера. Проверьте настройки Codex и повторите проверку.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
