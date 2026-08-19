(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const persistedUiState = typeof vscode.getState === "function" ? vscode.getState() : undefined;
  const state = {
    snapshot: undefined,
    proxyDraft: undefined,
    docsDraft: undefined,
    toolsDraft: undefined,
    browserDraft: undefined,
    browserDirty: false,
    browserTest: null,
    mcpEditor: null,
    mcpSaving: false,
    mcpMessage: "",
    mcpMessageKind: "info",
    mcpAction: null,
    skillsQuery: "",
    skillsSource: "all",
    skillsEnabled: "all",
    collapsedSections: {
      mcp: Boolean(persistedUiState?.collapsedSections?.mcp),
      skills: Boolean(persistedUiState?.collapsedSections?.skills)
    },
    focusTarget: "",
    pendingSaveScope: "",
    normalizer: undefined,
    ripgrepInstaller: undefined,
    message: "",
    messageKind: "info"
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "settings.snapshot") {
      const browserDraft = state.browserDirty && state.snapshot && document.querySelector("#browser-base-url")
        ? captureBrowserDraft(false)
        : undefined;
      if (state.mcpEditor && document.querySelector("#mcp-name")) {
        state.mcpEditor = captureMcpEditor();
      }
      state.snapshot = message.snapshot;
      state.browserDraft = browserDraft
        ? {
            ...(message.snapshot?.browser || {}),
            enabled: browserDraft.enabled,
            baseUrl: browserDraft.baseUrl,
            allowedOrigins: browserDraft.allowedOrigins,
            disableSandbox: browserDraft.disableSandbox,
            validationMessage: ""
          }
        : undefined;
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.saved") {
      if (state.pendingSaveScope === "proxy") {
        state.proxyDraft = undefined;
      } else if (state.pendingSaveScope === "docs") {
        state.docsDraft = undefined;
      } else if (state.pendingSaveScope === "tools") {
        state.toolsDraft = undefined;
      } else if (state.pendingSaveScope === "browser") {
        state.browserDraft = undefined;
        state.browserDirty = false;
      }
      state.pendingSaveScope = "";
      state.message = String(message.payload || "Настройки сохранены.");
      state.messageKind = "success";
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.error") {
      state.pendingSaveScope = "";
      state.message = String(message.payload || "Не удалось сохранить настройки.");
      state.messageKind = "error";
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.mcp.saved") {
      state.mcpSaving = false;
      state.mcpMessage = "";
      state.mcpEditor = null;
      state.message = String(message.payload || "MCP-сервер сохранен.");
      state.messageKind = "success";
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.mcp.error") {
      state.mcpSaving = false;
      state.mcpMessage = String(message.payload || "Не удалось сохранить MCP-сервер.");
      state.mcpMessageKind = "error";
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.mcp.test.result") {
      const result = message.payload && typeof message.payload === "object" ? message.payload : {};
      state.mcpAction = {
        type: "test",
        name: String(result.name || state.mcpAction?.name || ""),
        status: String(result.status || "failed"),
        message: String(result.message || "Не удалось проверить MCP-сервер."),
        details: String(result.details || "")
      };
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.browser.test.result") {
      const result = message.payload && typeof message.payload === "object" ? message.payload : {};
      state.browserTest = {
        status: String(result.status || "failed"),
        message: String(result.message || "Не удалось проверить встроенный браузер."),
        details: String(result.details || "")
      };
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.docs.normalize.progress") {
      state.normalizer = message.payload || { status: "running", percent: 0, stage: "running", message: "Нормализация выполняется" };
      state.message = "";
      render();
    }
    if (message.type === "event" && message.event === "settings.tools.ripgrep.install.progress") {
      state.ripgrepInstaller = message.payload || { status: "running", percent: 0, stage: "running", message: "Установка ripgrep выполняется" };
      state.message = "";
      render();
    }
  });

  vscode.postMessage({ type: "ready", assetMode });
  render();

  function render() {
    const presentationState = capturePresentationState();
    const root = document.getElementById("root");
    const snapshotProxy = state.snapshot && state.snapshot.proxy ? state.snapshot.proxy : { url: "", username: "", passwordSaved: false };
    const snapshotDocs = state.snapshot && state.snapshot.docs ? state.snapshot.docs : { normalizedPath: "", validationMessage: "" };
    const snapshotTools = state.snapshot && state.snapshot.tools ? state.snapshot.tools : {
      ripgrepPath: "",
      ripgrepManaged: false,
      ripgrepVersion: "",
      ripgrepStatus: "notConfigured",
      validationMessage: ""
    };
    const snapshotNormalizer = state.snapshot && state.snapshot.normalizer ? state.snapshot.normalizer : { status: "idle", percent: 0, stage: "idle", message: "" };
    const snapshotRipgrepInstaller = state.snapshot && state.snapshot.ripgrepInstaller ? state.snapshot.ripgrepInstaller : { status: "idle", percent: 0, stage: "idle", message: "" };
    const snapshotBrowser = state.snapshot && state.snapshot.browser ? state.snapshot.browser : {
      enabled: false,
      baseUrl: "",
      allowedOrigins: [],
      disableSandbox: false,
      validationMessage: "",
      status: "notInstalled",
      statusMessage: "Browser runtime не установлен в поставке плагина.",
      platformId: "",
      playwrightMcpVersion: "",
      nodeVersion: ""
    };
    const integrations = state.snapshot && state.snapshot.integrations ? state.snapshot.integrations : {
      status: "idle",
      mcpStatus: "idle",
      skillsStatus: "idle",
      mcpServers: [],
      skills: [],
      message: "Интеграции загружаются только по запросу.",
      mcpMessage: "",
      skillsMessage: ""
    };
    const proxy = state.proxyDraft || snapshotProxy;
    const docs = state.docsDraft || snapshotDocs;
    const tools = state.toolsDraft || snapshotTools;
    const browser = state.browserDraft || snapshotBrowser;
    const normalizer = state.normalizer || snapshotNormalizer;
    const ripgrepInstaller = state.ripgrepInstaller || snapshotRipgrepInstaller;
    const normalizerRunning = normalizer.status === "running";
    const ripgrepInstalling = ripgrepInstaller.status === "running";
    const extensionVersion = state.snapshot && typeof state.snapshot.extensionVersion === "string"
      ? state.snapshot.extensionVersion.trim()
      : "";
    root.innerHTML = `
      <main class="settings-app">
        <header class="settings-header">
          <div class="settings-product-meta">
            <span class="eyebrow">CODEX FOR 1C: ELEMENT</span>
            ${extensionVersion ? `<span class="settings-version">v${escapeHtml(extensionVersion)}</span>` : ""}
          </div>
          <h1>Настройки</h1>
        </header>
        <section class="settings-section" aria-label="Настройки proxy">
          <h2>Proxy</h2>
          <label class="field">
            <span>Proxy URL</span>
            <input id="proxy-url" type="text" autocomplete="off" placeholder="http://proxy.example:8080" value="${escapeAttribute(proxy.url)}" />
          </label>
          <div class="field-grid">
            <label class="field">
              <span>Логин</span>
              <input id="proxy-username" type="text" autocomplete="off" value="${escapeAttribute(proxy.username)}" />
            </label>
            <label class="field">
              <span>Пароль</span>
              <input id="proxy-password" type="password" autocomplete="new-password" placeholder="${proxy.passwordSaved ? "пароль сохранен" : ""}" />
            </label>
          </div>
          <button class="button" id="save-proxy" type="button">Сохранить</button>
        </section>
        <section class="settings-section" aria-label="Настройки документации">
          <h2>Документация</h2>
          <label class="field">
            <span>Нормализованная документация</span>
            <input id="docs-normalized-path" type="text" autocomplete="off" placeholder="C:\\CodexElement\\normalized-docs" value="${escapeAttribute(docs.normalizedPath)}" />
          </label>
          ${docs.validationMessage ? `<div class="hint error">${escapeHtml(docs.validationMessage)}</div>` : ""}
          ${normalizerView(normalizer)}
          <div class="button-row">
            <button class="button" id="save-docs" type="button" ${normalizerRunning ? "disabled" : ""}>Сохранить</button>
            <button class="button secondary" id="normalize-docs" type="button" ${normalizerRunning ? "disabled" : ""}>Нормализовать</button>
            <button class="button secondary" id="open-base-context" type="button">Базовый контекст</button>
          </div>
        </section>
        ${browserSection(browser)}
        ${mcpSection(integrations)}
        ${skillsSection(integrations)}
        <section class="settings-section" aria-label="Прочие настройки">
          <h2>Прочее</h2>
          <label class="field">
            <span>Путь до ripgrep (rg)</span>
            <input id="tools-ripgrep-path" type="text" autocomplete="off" placeholder="C:\\Program Files\\ripgrep\\rg.exe" value="${escapeAttribute(tools.ripgrepPath)}" />
          </label>
          ${ripgrepStatusView(tools)}
          ${ripgrepInstallerView(ripgrepInstaller)}
          <div class="button-row">
            <button class="button" id="save-ripgrep" type="button" ${ripgrepInstalling ? "disabled" : ""}>Сохранить</button>
            <button class="button secondary" id="install-ripgrep" type="button" ${ripgrepInstalling ? "disabled" : ""}>Установить</button>
          </div>
        </section>
        ${message()}
      </main>
    `;
    bind(root);
    restorePresentationState(presentationState);
  }

  function bind(root) {
    const saveButton = root.querySelector("#save-proxy");
    if (!saveButton) {
      return;
    }
    saveButton.addEventListener("click", () => {
      const url = valueOf("#proxy-url");
      const username = valueOf("#proxy-username");
      const password = valueOf("#proxy-password");
      state.proxyDraft = { url, username, password, passwordSaved: false };
      state.pendingSaveScope = "proxy";
      state.message = "";
      vscode.postMessage({
        type: "command",
        command: "settings.proxy.save",
        payload: { url, username, password }
      });
    });

    root.querySelectorAll("#proxy-url, #proxy-username, #proxy-password").forEach((control) => {
      control.addEventListener("input", () => {
        state.proxyDraft = {
          url: valueOf("#proxy-url"),
          username: valueOf("#proxy-username"),
          password: valueOf("#proxy-password"),
          passwordSaved: Boolean(state.snapshot?.proxy?.passwordSaved)
        };
      });
    });

    root.querySelector("#docs-normalized-path")?.addEventListener("input", () => {
      state.docsDraft = {
        normalizedPath: valueOf("#docs-normalized-path"),
        validationMessage: ""
      };
    });

    root.querySelector("#tools-ripgrep-path")?.addEventListener("input", () => {
      state.toolsDraft = {
        ...(state.snapshot?.tools || {}),
        ripgrepPath: valueOf("#tools-ripgrep-path")
      };
    });

    root.querySelectorAll("#browser-enabled, #browser-base-url, #browser-origins, #browser-disable-sandbox").forEach((control) => {
      control.addEventListener("input", captureBrowserDraft);
      control.addEventListener("change", captureBrowserDraft);
    });

    root.querySelector("#save-browser")?.addEventListener("click", () => {
      const browser = captureBrowserDraft();
      state.pendingSaveScope = "browser";
      state.browserTest = null;
      state.message = "";
      vscode.postMessage({ type: "command", command: "settings.browser.save", payload: browser });
    });

    root.querySelector("#test-browser")?.addEventListener("click", () => {
      state.browserTest = { status: "testing", message: "Проверяем Node.js, Playwright MCP и Chromium...", details: "" };
      render();
      vscode.postMessage({ type: "command", command: "settings.browser.test" });
    });

    const saveDocsButton = root.querySelector("#save-docs");
    if (saveDocsButton) {
      saveDocsButton.addEventListener("click", () => {
        const normalizedPath = valueOf("#docs-normalized-path");
        state.docsDraft = { normalizedPath, validationMessage: "" };
        state.pendingSaveScope = "docs";
        state.message = "";
        vscode.postMessage({
          type: "command",
          command: "settings.docs.save",
          payload: { normalizedPath }
        });
      });
    }

    const normalizeDocsButton = root.querySelector("#normalize-docs");
    if (normalizeDocsButton) {
      normalizeDocsButton.addEventListener("click", () => {
        const normalizedPath = valueOf("#docs-normalized-path");
        state.docsDraft = { normalizedPath, validationMessage: "" };
        state.normalizer = { status: "running", percent: 0, stage: "start", message: "Запуск нормализатора документации" };
        state.message = "";
        render();
        vscode.postMessage({
          type: "command",
          command: "settings.docs.normalize",
          payload: { normalizedPath }
        });
      });
    }

    const openBaseContextButton = root.querySelector("#open-base-context");
    if (openBaseContextButton) {
      openBaseContextButton.addEventListener("click", () => {
        vscode.postMessage({
          type: "command",
          command: "settings.docs.openBaseContext"
        });
      });
    }

    const saveRipgrepButton = root.querySelector("#save-ripgrep");
    if (saveRipgrepButton) {
      saveRipgrepButton.addEventListener("click", () => {
        const ripgrepPath = valueOf("#tools-ripgrep-path");
        state.toolsDraft = {
          ripgrepPath,
          ripgrepManaged: false,
          ripgrepVersion: "",
          ripgrepStatus: "notConfigured",
          validationMessage: ""
        };
        state.pendingSaveScope = "tools";
        state.message = "";
        vscode.postMessage({
          type: "command",
          command: "settings.tools.ripgrep.save",
          payload: { ripgrepPath }
        });
      });
    }

    const installRipgrepButton = root.querySelector("#install-ripgrep");
    if (installRipgrepButton) {
      installRipgrepButton.addEventListener("click", () => {
        state.ripgrepInstaller = { status: "running", percent: 0, stage: "start", message: "Запуск установки ripgrep" };
        state.message = "";
        render();
        vscode.postMessage({
          type: "command",
          command: "settings.tools.ripgrep.install"
        });
      });
    }

    bindIntegrations(root);
  }

  function mcpSection(integrations) {
    const servers = Array.isArray(integrations.mcpServers) ? integrations.mcpServers : [];
    const status = integrations.mcpStatus || integrations.status || "idle";
    const loading = status === "loading";
    const stale = status === "partial" || (status === "error" && servers.length > 0);
    const collapsed = state.collapsedSections.mcp;
    const toolCount = servers.reduce((total, server) => total + Number(server.toolCount || 0), 0);
    const summary = servers.length
      ? `${servers.length} ${pluralRu(servers.length, "сервер", "сервера", "серверов")} · ${toolCount} ${pluralRu(toolCount, "инструмент", "инструмента", "инструментов")}`
      : "Серверов нет";
    return `
      <section class="settings-section integration-section${collapsed ? " is-collapsed" : ""}" aria-label="MCP-серверы">
        <div class="section-heading integration-section-heading">
          ${integrationSectionLabel("MCP-серверы", summary, collapsed)}
          <div class="compact-actions">
            <button class="icon-text-button" id="refresh-integrations" type="button" ${loading ? "disabled" : ""}>${loading ? "Обновляем..." : "Обновить"}</button>
            <button class="icon-text-button primary-quiet" id="add-mcp" type="button">Добавить сервер</button>
          </div>
          ${integrationSectionToggle("mcp", "MCP-серверы", collapsed)}
          ${collapsed ? "" : `<p class="integration-section-description">Подключают внешние инструменты и данные к Codex. Конфигурация общая для текущего профиля.</p>`}
        </div>
        <div class="integration-section-content" id="integration-section-mcp" ${collapsed ? "hidden" : ""}>
          ${status === "idle" ? integrationEmptyState("Список еще не загружен", "Нажмите «Обновить», чтобы получить серверы из профиля Codex.") : ""}
          ${loading && !servers.length ? integrationLoadingState("Проверяем конфигурацию и runtime-статусы MCP-серверов") : ""}
          ${status === "error" && !servers.length ? integrationErrorState(integrations.mcpMessage || integrations.message || "Не удалось загрузить MCP-серверы.") : ""}
          ${status !== "idle" && !servers.length && status !== "loading" && status !== "error" ? integrationEmptyState("MCP-серверов пока нет", "Добавьте локальный stdio-сервер или удаленный HTTP-сервер.") : ""}
          ${stale ? integrationStaleState(integrations.mcpMessage || "Часть runtime-статусов недоступна. Показаны последние доступные данные.") : ""}
          ${servers.length ? `<div class="integration-list">${servers.map(mcpServerRow).join("")}</div>` : ""}
          ${state.mcpEditor ? mcpEditor(state.mcpEditor) : ""}
          ${integrations.updatedAt ? `<div class="integration-updated">Обновлено ${escapeHtml(formatUpdatedAt(integrations.updatedAt))}</div>` : ""}
        </div>
      </section>
    `;
  }

  function mcpServerRow(server) {
    const runtime = mcpRuntimeLabel(server.runtimeStatus);
    const endpoint = server.transport === "stdio"
      ? server.command || "Команда не указана"
      : safeEndpointLabel(server.url || "URL не указан");
    const toolCount = Number(server.toolCount || 0);
    const resourceCount = Number(server.resourceCount || 0);
    const testing = state.mcpAction?.type === "test" && state.mcpAction?.name === server.name && state.mcpAction?.status === "testing";
    const managedBrowser = server.managed === "browser";
    const metrics = [
      `${toolCount} ${pluralRu(toolCount, "инструмент", "инструмента", "инструментов")}`,
      `${resourceCount} ${pluralRu(resourceCount, "ресурс", "ресурса", "ресурсов")}`,
      mcpAuthLabel(server.authStatus)
    ].join(" · ");
    return `
      <div class="integration-row${server.enabled === false ? " disabled" : ""}" data-mcp-row="${escapeAttribute(server.name)}">
        <span class="status-dot ${escapeAttribute(server.runtimeStatus || "unknown")}" aria-hidden="true"></span>
        <div class="integration-main">
          <div class="integration-title-line">
            <strong>${escapeHtml(server.name)}</strong>
            <span class="integration-badge">${server.transport === "stdio" ? "STDIO" : "HTTP"}</span>
            ${managedBrowser ? `<span class="integration-badge">Встроенный браузер</span>` : ""}
            <span class="integration-runtime">${escapeHtml(runtime)}</span>
          </div>
          <div class="integration-endpoint" title="${escapeAttribute(endpoint)}">${escapeHtml(endpoint)}</div>
          <div class="integration-meta">${escapeHtml(metrics)}</div>
          ${server.error ? technicalErrorDetails("Сервер сообщил об ошибке", server.error) : ""}
          ${mcpActionFeedback(server.name)}
        </div>
        <div class="integration-actions">
          ${server.transport === "http" && server.authStatus === "notLoggedIn" ? `<button class="quiet-button" type="button" data-mcp-oauth="${escapeAttribute(server.name)}">Войти</button>` : ""}
          ${managedBrowser ? "" : `<label class="toggle-control" title="${server.enabled === false ? "Включить сервер" : "Выключить сервер"}">
            <input type="checkbox" role="switch" aria-label="${server.enabled === false ? "Включить" : "Выключить"} MCP-сервер ${escapeAttribute(server.name)}" data-focus-key="mcp-toggle:${escapeAttribute(server.name)}" data-mcp-toggle="${escapeAttribute(server.name)}" ${server.enabled === false ? "" : "checked"} />
            <span aria-hidden="true"></span>
          </label>`}
          <button class="quiet-button" type="button" data-focus-key="mcp-test:${escapeAttribute(server.name)}" data-mcp-test="${escapeAttribute(server.name)}" ${server.enabled === false || testing ? "disabled" : ""}>${testing ? "Проверяем..." : "Проверить"}</button>
          ${managedBrowser ? "" : `<button class="icon-button" type="button" data-mcp-edit="${escapeAttribute(server.name)}" title="Изменить" aria-label="Изменить MCP-сервер ${escapeAttribute(server.name)}">✎</button>
          <button class="icon-button danger" type="button" data-mcp-delete="${escapeAttribute(server.name)}" title="Удалить" aria-label="Удалить MCP-сервер ${escapeAttribute(server.name)}">×</button>`}
        </div>
      </div>
    `;
  }

  function mcpEditor(editor) {
    const transport = editor.transport === "http" ? "http" : "stdio";
    const saving = state.mcpSaving;
    return `
      <div class="integration-editor" aria-label="${editor.originalName ? "Редактирование MCP-сервера" : "Новый MCP-сервер"}" aria-busy="${saving ? "true" : "false"}">
        <div class="editor-heading">
          <h3>${editor.originalName ? `MCP: ${escapeHtml(editor.originalName)}` : "Новый MCP-сервер"}</h3>
          <button class="icon-button" id="cancel-mcp" type="button" title="Закрыть" aria-label="Закрыть редактор MCP" ${saving ? "disabled" : ""}>×</button>
        </div>
        <div class="field-grid integration-grid">
          <label class="field">
            <span>Имя сервера</span>
            <input id="mcp-name" type="text" autocomplete="off" placeholder="my-server" value="${escapeAttribute(editor.name || "")}" ${saving ? "disabled" : ""} />
            <small>Пробелы будут заменены дефисами. Допустимы латинские буквы, цифры, <code>-</code> и <code>_</code>.</small>
          </label>
          <label class="field">
            <span>Транспорт</span>
            <select id="mcp-transport" ${saving ? "disabled" : ""}>
              <option value="stdio" ${transport === "stdio" ? "selected" : ""}>Локальная команда (STDIO)</option>
              <option value="http" ${transport === "http" ? "selected" : ""}>Удаленный сервер (HTTP)</option>
            </select>
          </label>
        </div>
        ${transport === "stdio" ? `
          <label class="field">
            <span>Команда</span>
            <input id="mcp-command" type="text" autocomplete="off" placeholder="npx" value="${escapeAttribute(editor.command || "")}" ${saving ? "disabled" : ""} />
          </label>
          <label class="field">
            <span>Аргументы <small>по одному на строку</small></span>
            <textarea id="mcp-args" rows="4" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/workspace" ${saving ? "disabled" : ""}>${escapeHtml(Array.isArray(editor.args) ? editor.args.join("\n") : "")}</textarea>
          </label>
        ` : `
          <label class="field">
            <span>URL</span>
            <input id="mcp-url" type="url" autocomplete="off" placeholder="https://mcp.example.com/mcp" value="${escapeAttribute(editor.url || "")}" ${saving ? "disabled" : ""} />
          </label>
          <label class="field">
            <span>Переменная окружения с bearer token <small>необязательно</small></span>
            <input id="mcp-bearer-env" type="text" autocomplete="off" placeholder="MY_MCP_TOKEN" value="${escapeAttribute(editor.bearerTokenEnvVar || "")}" ${saving ? "disabled" : ""} />
          </label>
          <div class="hint compact">В настройках хранится только имя переменной. Значение токена должно быть задано в окружении процесса Element.</div>
        `}
        ${mcpEditorMessage()}
        <div class="button-row editor-actions">
          <button class="button" id="save-mcp" type="button" ${saving ? "disabled" : ""}>${saving ? "Сохраняем..." : "Сохранить сервер"}</button>
          <button class="button secondary" id="cancel-mcp-secondary" type="button" ${saving ? "disabled" : ""}>Отмена</button>
        </div>
      </div>
    `;
  }

  function mcpEditorMessage() {
    if (!state.mcpMessage) {
      return "";
    }
    return `<div class="editor-feedback ${escapeAttribute(state.mcpMessageKind)}" role="status" aria-live="polite">${escapeHtml(state.mcpMessage)}</div>`;
  }

  function browserSection(browser) {
    const origins = Array.isArray(browser.allowedOrigins) ? browser.allowedOrigins.join("\n") : String(browser.allowedOrigins || "");
    const ready = browser.status === "ready";
    const previouslyEnabled = state.snapshot?.browser?.enabled === true;
    const settingsActionAvailable = ready || previouslyEnabled;
    const testing = state.browserTest?.status === "testing";
    const statusKind = ready ? "success" : "error";
    return `
      <section class="settings-section browser-section" aria-label="Браузерное тестирование">
        <div class="section-heading browser-heading">
          <div>
            <h2>Браузерное тестирование</h2>
            <p>Codex управляет изолированным Chromium на сервере Element через встроенный Playwright MCP.</p>
          </div>
          <label class="toggle-control browser-master-toggle" title="Включить браузерное тестирование">
            <input id="browser-enabled" type="checkbox" role="switch" aria-label="Включить браузерное тестирование" ${browser.enabled ? "checked" : ""} ${settingsActionAvailable ? "" : "disabled"} />
            <span aria-hidden="true"></span>
          </label>
        </div>
        <div class="browser-boundary-note">
          <strong>Браузер работает на сервере, а не на компьютере пользователя.</strong>
          <span>Он может открывать URL приложений, доступные из окружения сервера Element, нажимать кнопки, заполнять формы и делать снимки экрана.</span>
        </div>
        <label class="field">
          <span>URL приложения</span>
          <input id="browser-base-url" type="url" autocomplete="off" placeholder="http://127.0.0.1:9090/applications/..." value="${escapeAttribute(browser.baseUrl)}" />
          <small>Эта страница открывается в начале новой изолированной browser-сессии.</small>
        </label>
        <label class="field">
          <span>Разрешенные origins <small>по одному на строку</small></span>
          <textarea id="browser-origins" spellcheck="false" placeholder="http://127.0.0.1:9090">${escapeHtml(origins)}</textarea>
          <small>Origin URL приложения добавляется автоматически. Ограничение снижает риск случайных переходов, но не заменяет сетевую изоляцию.</small>
        </label>
        <label class="browser-checkbox-row">
          <input id="browser-disable-sandbox" type="checkbox" ${browser.disableSandbox ? "checked" : ""} />
          <span><strong>Отключить Chromium sandbox</strong><small>Только для контейнера, где sandbox не запускается. Это снижает безопасность браузера.</small></span>
        </label>
        <div class="browser-runtime-status ${escapeAttribute(statusKind)}" role="status">
          <span class="status-dot ${ready ? "ready" : "failed"}" aria-hidden="true"></span>
          <span><strong>${ready ? "Runtime готов" : "Runtime недоступен"}</strong>${escapeHtml(browser.statusMessage || "")}</span>
          ${ready ? `<small>${escapeHtml(browser.platformId)} · Playwright MCP ${escapeHtml(browser.playwrightMcpVersion)} · Node.js ${escapeHtml(browser.nodeVersion)}</small>` : ""}
        </div>
        ${browser.validationMessage ? `<div class="hint error">${escapeHtml(browser.validationMessage)}</div>` : ""}
        ${state.browserTest ? `
          <div class="browser-test-result ${state.browserTest.status === "ready" ? "success" : state.browserTest.status === "testing" ? "loading" : "error"}" role="status">
            ${state.browserTest.status === "testing" ? `<span class="inline-spinner" aria-hidden="true"></span>` : ""}
            <span>${escapeHtml(state.browserTest.message)}</span>
            ${state.browserTest.details ? `<small>${escapeHtml(state.browserTest.details)}</small>` : ""}
          </div>
        ` : ""}
        <div class="button-row">
          <button class="button" id="save-browser" type="button" ${settingsActionAvailable ? "" : "disabled"}>Сохранить</button>
          <button class="button secondary" id="test-browser" type="button" ${ready && !testing ? "" : "disabled"}>${testing ? "Проверяем..." : "Проверить runtime"}</button>
        </div>
      </section>
    `;
  }

  function skillsSection(integrations) {
    const skills = Array.isArray(integrations.skills) ? integrations.skills : [];
    const status = integrations.skillsStatus || integrations.status || "idle";
    const visible = status !== "idle";
    const collapsed = state.collapsedSections.skills;
    const enabledCount = skills.filter((skill) => skill.enabled !== false).length;
    const summary = skills.length
      ? `${skills.length} ${pluralRu(skills.length, "навык", "навыка", "навыков")} · ${enabledCount} включено`
      : "Навыков нет";
    const scopes = [...new Set(skills.map((skill) => skill.scope || "unknown"))]
      .sort((left, right) => skillScopeLabel(left).localeCompare(skillScopeLabel(right)));
    return `
      <section class="settings-section integration-section${collapsed ? " is-collapsed" : ""}" aria-label="Навыки Codex">
        <div class="section-heading integration-section-heading">
          ${integrationSectionLabel("Навыки", summary, collapsed)}
          ${integrationSectionToggle("skills", "Навыки", collapsed)}
          ${collapsed ? "" : `<p class="integration-section-description">Инструкции и рабочие процессы, которые можно прикрепить к конкретному сообщению в чате.</p>`}
        </div>
        <div class="integration-section-content" id="integration-section-skills" ${collapsed ? "hidden" : ""}>
          ${skills.length ? `
            <div class="skills-toolbar" role="search" aria-label="Фильтры навыков">
              <label class="compact-field skills-search-field">
                <span>Поиск</span>
                <input id="skills-search" type="search" autocomplete="off" placeholder="Название, описание или идентификатор" value="${escapeAttribute(state.skillsQuery)}" />
              </label>
              <label class="compact-field">
                <span>Источник</span>
                <select id="skills-source">
                  <option value="all">Все источники</option>
                  ${scopes.map((scope) => `<option value="${escapeAttribute(scope)}" ${state.skillsSource === scope ? "selected" : ""}>${escapeHtml(skillScopeLabel(scope))}</option>`).join("")}
                </select>
              </label>
              <label class="compact-field">
                <span>Состояние</span>
                <select id="skills-enabled">
                  <option value="all" ${state.skillsEnabled === "all" ? "selected" : ""}>Все</option>
                  <option value="enabled" ${state.skillsEnabled === "enabled" ? "selected" : ""}>Включены</option>
                  <option value="disabled" ${state.skillsEnabled === "disabled" ? "selected" : ""}>Выключены</option>
                </select>
              </label>
            </div>
          ` : ""}
          ${!visible ? integrationEmptyState("Навыки еще не загружены", "Они появятся вместе с MCP-серверами после обновления интеграций.") : ""}
          ${status === "loading" && !skills.length ? integrationLoadingState("Загружаем навыки из runtime и профиля Codex") : ""}
          ${status === "error" && !skills.length ? integrationErrorState(integrations.skillsMessage || integrations.message || "Не удалось загрузить навыки.") : ""}
          ${visible && !skills.length && status !== "loading" && status !== "error" ? integrationEmptyState("Доступных навыков нет", "Добавьте навыки в профиль Codex или workspace и обновите список.") : ""}
          ${(status === "partial" || (status === "error" && skills.length)) ? integrationStaleState(integrations.skillsMessage || "Не удалось обновить список. Показаны последние доступные данные.") : ""}
          ${skills.length ? `<div id="skills-results">${skillsResults(integrations)}</div>` : ""}
          ${integrations.updatedAt ? `<div class="integration-updated">Обновлено ${escapeHtml(formatUpdatedAt(integrations.updatedAt))}</div>` : ""}
        </div>
      </section>
    `;
  }

  function integrationSectionLabel(title, summary, collapsed) {
    return `
      <div class="integration-section-label">
        <span class="integration-section-title" role="heading" aria-level="2">${escapeHtml(title)}</span>
        ${collapsed ? `<span class="integration-section-summary">${escapeHtml(summary)}</span>` : ""}
      </div>
    `;
  }

  function integrationSectionToggle(section, title, collapsed) {
    return `
      <button class="integration-section-toggle" type="button" data-section-toggle="${escapeAttribute(section)}" data-focus-key="section-toggle:${escapeAttribute(section)}" aria-label="${collapsed ? "Развернуть" : "Свернуть"} раздел ${escapeAttribute(title)}" aria-expanded="${collapsed ? "false" : "true"}" aria-controls="integration-section-${escapeAttribute(section)}">
        <span class="integration-section-chevron" aria-hidden="true">${sectionChevron(collapsed)}</span>
      </button>
    `;
  }

  function sectionChevron(collapsed) {
    const path = collapsed ? "M9 5l5 5-5 5" : "M5 7l5 5 5-5";
    return `<svg viewBox="0 0 20 20" width="20" height="20" focusable="false"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
  }

  function skillsResults(integrations) {
    const skills = filterSkills(Array.isArray(integrations.skills) ? integrations.skills : []);
    if (!skills.length) {
      return integrationEmptyState("Ничего не найдено", "Измените запрос или фильтры источника и состояния.");
    }
    return `
      <div class="skills-result-count" aria-live="polite">Показано ${skills.length} из ${integrations.skills.length}</div>
      <div class="integration-list skills-list">${skills.map(skillRow).join("")}</div>
    `;
  }

  function filterSkills(skills) {
    const query = String(state.skillsQuery || "").trim().toLocaleLowerCase("ru");
    return skills.filter((skill) => {
      if (state.skillsSource !== "all" && (skill.scope || "unknown") !== state.skillsSource) {
        return false;
      }
      if (state.skillsEnabled === "enabled" && skill.enabled === false) {
        return false;
      }
      if (state.skillsEnabled === "disabled" && skill.enabled !== false) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [skill.displayName, skill.name, skill.shortDescription, skill.description, skill.path]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("ru").includes(query));
    });
  }

  function skillRow(skill) {
    const scope = skillScopeLabel(skill.scope);
    const dependencies = Number(skill.dependencyCount || 0);
    return `
      <div class="integration-row skill-row${skill.enabled === false ? " disabled" : ""}">
        <div class="skill-symbol" aria-hidden="true">✦</div>
        <div class="integration-main">
          <div class="integration-title-line"><strong>${escapeHtml(skill.displayName || skill.name)}</strong><span class="integration-badge">${escapeHtml(scope)}</span></div>
          <div class="integration-description">${escapeHtml(skill.shortDescription || skill.description || "Описание не указано")}</div>
          <div class="integration-meta">${escapeHtml(skill.name)}${dependencies ? ` · зависимостей: ${dependencies}` : ""}</div>
        </div>
        <label class="toggle-control" title="${skill.enabled === false ? "Включить навык" : "Выключить навык"}">
          <input type="checkbox" role="switch" aria-label="${skill.enabled === false ? "Включить" : "Выключить"} навык ${escapeAttribute(skill.displayName || skill.name)}" data-focus-key="skill:${escapeAttribute(skill.path)}" data-skill-toggle="${escapeAttribute(skill.path)}" data-skill-name="${escapeAttribute(skill.name)}" ${skill.enabled === false ? "" : "checked"} />
          <span aria-hidden="true"></span>
        </label>
      </div>
    `;
  }

  function integrationEmptyState(title, description) {
    return `<div class="integration-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
  }

  function integrationLoadingState(message) {
    return `<div class="integration-loading" role="status"><span class="inline-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
  }

  function integrationErrorState(message) {
    return `<div class="inline-state error" role="alert"><strong>Не удалось загрузить данные</strong><span>${escapeHtml(message)}</span><button class="quiet-button retry-integrations" type="button">Повторить</button></div>`;
  }

  function integrationStaleState(message) {
    return `<div class="inline-state warning" role="status"><strong>Данные могут быть устаревшими</strong><span>${escapeHtml(message)}</span></div>`;
  }

  function bindIntegrations(root) {
    const refreshIntegrations = () => {
      state.message = "";
      vscode.postMessage({ type: "command", command: "settings.integrations.refresh" });
    };
    root.querySelector("#refresh-integrations")?.addEventListener("click", refreshIntegrations);
    root.querySelectorAll(".retry-integrations").forEach((button) => button.addEventListener("click", refreshIntegrations));
    root.querySelectorAll("[data-section-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const section = button.dataset.sectionToggle;
        if (section !== "mcp" && section !== "skills") {
          return;
        }
        captureVisibleDrafts();
        state.collapsedSections[section] = !state.collapsedSections[section];
        persistUiState();
        state.focusTarget = `[data-focus-key="section-toggle:${section}"]`;
        render();
      });
    });
    root.querySelector("#add-mcp")?.addEventListener("click", () => {
      state.collapsedSections.mcp = false;
      persistUiState();
      state.mcpEditor = { name: "", transport: "stdio", command: "", args: [], url: "", bearerTokenEnvVar: "", enabled: true };
      state.mcpSaving = false;
      state.mcpMessage = "";
      state.mcpAction = null;
      state.message = "";
      state.focusTarget = "#mcp-name";
      render();
    });
    root.querySelectorAll("[data-mcp-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const server = findMcpServer(button.dataset.mcpEdit || "");
        if (!server) {
          return;
        }
        state.collapsedSections.mcp = false;
        persistUiState();
        state.mcpEditor = {
          originalName: server.name,
          name: server.name,
          transport: server.transport,
          command: server.command || "",
          args: Array.isArray(server.args) ? [...server.args] : [],
          url: server.url || "",
          bearerTokenEnvVar: server.bearerTokenEnvVar || "",
          enabled: server.enabled !== false
        };
        state.mcpSaving = false;
        state.mcpMessage = "";
        state.mcpAction = null;
        state.message = "";
        state.focusTarget = "#mcp-name";
        render();
      });
    });
    root.querySelectorAll("[data-mcp-delete]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "command", command: "settings.mcp.delete", payload: { name: button.dataset.mcpDelete || "" } });
      });
    });
    root.querySelectorAll("[data-mcp-oauth]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "command", command: "settings.mcp.oauth", payload: { name: button.dataset.mcpOauth || "" } });
      });
    });
    root.querySelectorAll("[data-mcp-test]").forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.dataset.mcpTest || "";
        if (!name) {
          return;
        }
        state.mcpAction = {
          type: "test",
          name,
          status: "testing",
          message: "Проверяем запуск, авторизацию и доступные возможности...",
          details: ""
        };
        state.focusTarget = `[data-focus-key="mcp-test:${attributeSelectorValue(name)}"]`;
        render();
        vscode.postMessage({ type: "command", command: "settings.mcp.test", payload: { name } });
      });
    });
    root.querySelectorAll("[data-mcp-toggle]").forEach((control) => {
      control.addEventListener("change", () => {
        vscode.postMessage({
          type: "command",
          command: "settings.mcp.toggle",
          payload: { name: control.dataset.mcpToggle || "", enabled: Boolean(control.checked) }
        });
      });
    });
    bindSkillToggles(root);

    root.querySelector("#skills-search")?.addEventListener("input", (event) => {
      state.skillsQuery = event.target.value;
      updateSkillsResults(root);
    });
    root.querySelector("#skills-source")?.addEventListener("change", (event) => {
      state.skillsSource = event.target.value || "all";
      updateSkillsResults(root);
    });
    root.querySelector("#skills-enabled")?.addEventListener("change", (event) => {
      state.skillsEnabled = event.target.value || "all";
      updateSkillsResults(root);
    });

    const closeEditor = () => {
      state.mcpEditor = null;
      state.mcpSaving = false;
      state.mcpMessage = "";
      render();
    };
    root.querySelector("#cancel-mcp")?.addEventListener("click", closeEditor);
    root.querySelector("#cancel-mcp-secondary")?.addEventListener("click", closeEditor);
    root.querySelector("#mcp-transport")?.addEventListener("change", (event) => {
      state.mcpEditor = captureMcpEditor();
      state.mcpEditor.transport = event.target.value === "http" ? "http" : "stdio";
      render();
    });
    root.querySelectorAll("#mcp-name, #mcp-command, #mcp-args, #mcp-url, #mcp-bearer-env").forEach((control) => {
      control.addEventListener("input", () => {
        state.mcpEditor = captureMcpEditor();
        state.mcpMessage = "";
      });
    });
    root.querySelector(".integration-editor")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !state.mcpSaving) {
        event.preventDefault();
        closeEditor();
      }
    });
    root.querySelector("#save-mcp")?.addEventListener("click", () => {
      const editor = captureMcpEditor();
      const validation = validateMcpEditor(editor);
      if (validation.error) {
        state.mcpEditor = editor;
        state.mcpMessage = validation.error;
        state.mcpMessageKind = "error";
        render();
        return;
      }
      editor.name = validation.name;
      state.mcpEditor = editor;
      state.mcpSaving = true;
      state.mcpMessage = validation.nameChanged ? `Сервер будет сохранен с именем ${validation.name}.` : "";
      state.mcpMessageKind = "info";
      state.message = "";
      render();
      vscode.postMessage({ type: "command", command: "settings.mcp.save", payload: editor });
    });
  }

  function bindSkillToggles(container) {
    container.querySelectorAll("[data-skill-toggle]").forEach((control) => {
      control.addEventListener("change", () => {
        vscode.postMessage({
          type: "command",
          command: "settings.skill.toggle",
          payload: {
            name: control.dataset.skillName || "",
            path: control.dataset.skillToggle || "",
            enabled: Boolean(control.checked)
          }
        });
      });
    });
  }

  function updateSkillsResults(root) {
    const results = root.querySelector("#skills-results");
    const integrations = state.snapshot && state.snapshot.integrations;
    if (!results || !integrations) {
      return;
    }
    results.innerHTML = skillsResults(integrations);
    bindSkillToggles(results);
  }

  function validateMcpEditor(editor) {
    const rawName = String(editor.name || "").trim();
    const name = rawName.replace(/\s+/g, "-");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      return { error: "Укажите имя от 1 до 64 символов: латинские буквы, цифры, _ или -.", name: rawName, nameChanged: false };
    }
    if (editor.transport === "http") {
      try {
        const url = new URL(String(editor.url || "").trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return { error: "URL MCP-сервера должен начинаться с http:// или https://.", name, nameChanged: name !== rawName };
        }
      } catch {
        return { error: "Укажите корректный URL MCP-сервера.", name, nameChanged: name !== rawName };
      }
      const bearerEnv = String(editor.bearerTokenEnvVar || "").trim();
      if (bearerEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerEnv)) {
        return { error: "Имя переменной bearer token содержит недопустимые символы.", name, nameChanged: name !== rawName };
      }
    } else if (!String(editor.command || "").trim()) {
      return { error: "Укажите команду запуска MCP-сервера.", name, nameChanged: name !== rawName };
    }
    return { error: "", name, nameChanged: name !== rawName };
  }

  function captureMcpEditor() {
    const current = state.mcpEditor || {};
    return {
      originalName: current.originalName || "",
      name: valueOf("#mcp-name"),
      transport: valueOf("#mcp-transport") === "http" ? "http" : "stdio",
      command: valueOf("#mcp-command"),
      args: valueOf("#mcp-args").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      url: valueOf("#mcp-url"),
      bearerTokenEnvVar: valueOf("#mcp-bearer-env"),
      enabled: current.enabled !== false
    };
  }

  function captureBrowserDraft(markDirty = true) {
    const draft = {
      ...(state.snapshot?.browser || {}),
      enabled: Boolean(document.querySelector("#browser-enabled")?.checked),
      baseUrl: valueOf("#browser-base-url"),
      allowedOrigins: valueOf("#browser-origins").split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean),
      disableSandbox: Boolean(document.querySelector("#browser-disable-sandbox")?.checked),
      validationMessage: ""
    };
    state.browserDraft = draft;
    if (markDirty) {
      state.browserDirty = true;
    }
    return draft;
  }

  function findMcpServer(name) {
    const integrations = state.snapshot && state.snapshot.integrations;
    return integrations && Array.isArray(integrations.mcpServers)
      ? integrations.mcpServers.find((server) => server.name === name)
      : null;
  }

  function mcpRuntimeLabel(status) {
    return ({ ready: "Готов", starting: "Запускается", failed: "Ошибка", cancelled: "Остановлен", unknown: "Не запускался" })[status] || "Неизвестно";
  }

  function mcpActionFeedback(name) {
    const action = state.mcpAction;
    if (!action || action.name !== name) {
      return "";
    }
    const kind = action.status === "ready"
      ? "success"
      : action.status === "failed"
        ? "error"
        : action.status === "testing"
          ? "loading"
          : "warning";
    return `
      <div class="mcp-action-feedback ${escapeAttribute(kind)}" role="status" aria-live="polite">
        ${action.status === "testing" ? `<span class="inline-spinner" aria-hidden="true"></span>` : ""}
        <span>${escapeHtml(action.message)}</span>
        ${action.details ? technicalErrorDetails("Технические подробности", action.details) : ""}
      </div>
    `;
  }

  function technicalErrorDetails(label, details) {
    return `
      <details class="technical-details">
        <summary>${escapeHtml(label)}</summary>
        <pre>${escapeHtml(details)}</pre>
      </details>
    `;
  }

  function mcpAuthLabel(status) {
    return ({ unsupported: "без авторизации", notLoggedIn: "требуется вход", bearerToken: "bearer token", oAuth: "OAuth подключен", unknown: "авторизация не определена" })[status] || "авторизация не определена";
  }

  function skillScopeLabel(scope) {
    return ({
      user: "Профиль",
      repo: "Проект",
      system: "Системный",
      admin: "Администратор",
      plugin: "Плагин",
      marketplace: "Marketplace",
      unknown: "Источник не определен"
    })[scope] || "Источник не определен";
  }

  function pluralRu(value, one, few, many) {
    const normalized = Math.abs(Math.trunc(Number(value) || 0));
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

  function formatUpdatedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "недавно";
    }
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function safeEndpointLabel(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  }

  function valueOf(selector) {
    const input = document.querySelector(selector);
    return input ? input.value : "";
  }

  function captureVisibleDrafts() {
    if (state.mcpEditor && document.querySelector("#mcp-name")) {
      state.mcpEditor = captureMcpEditor();
    }
    if (state.browserDirty && state.snapshot && document.querySelector("#browser-base-url")) {
      captureBrowserDraft(false);
    }
  }

  function persistUiState() {
    if (typeof vscode.setState !== "function") {
      return;
    }
    const current = typeof vscode.getState === "function" ? vscode.getState() : {};
    vscode.setState({
      ...(current || {}),
      collapsedSections: { ...state.collapsedSections }
    });
  }

  function capturePresentationState() {
    const active = document.activeElement;
    let selector = "";
    if (active && active.id) {
      selector = `[id="${attributeSelectorValue(active.id)}"]`;
    } else if (active && active.dataset?.focusKey) {
      selector = `[data-focus-key="${attributeSelectorValue(active.dataset.focusKey)}"]`;
    }
    return {
      selector,
      selectionStart: typeof active?.selectionStart === "number" ? active.selectionStart : null,
      selectionEnd: typeof active?.selectionEnd === "number" ? active.selectionEnd : null,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  }

  function restorePresentationState(presentationState) {
    const selector = state.focusTarget || presentationState.selector;
    state.focusTarget = "";
    requestAnimationFrame(() => {
      if (selector) {
        const target = document.querySelector(selector);
        if (target && typeof target.focus === "function") {
          target.focus({ preventScroll: true });
          if (presentationState.selectionStart !== null && typeof target.setSelectionRange === "function") {
            const max = String(target.value || "").length;
            target.setSelectionRange(
              Math.min(presentationState.selectionStart, max),
              Math.min(presentationState.selectionEnd ?? presentationState.selectionStart, max)
            );
          }
        }
      }
      window.scrollTo(presentationState.scrollX, presentationState.scrollY);
    });
  }

  function attributeSelectorValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function message() {
    if (!state.message) {
      return "";
    }
    return `<div class="message ${state.messageKind}">${escapeHtml(state.message)}</div>`;
  }

  function normalizerView(normalizer) {
    if (!normalizer || !normalizer.message) {
      return "";
    }
    const statusClass = normalizer.status === "error" ? " error" : normalizer.status === "completed" ? " success" : "";
    const percent = Math.max(0, Math.min(100, Number(normalizer.percent || 0)));
    return `
      <div class="normalizer${statusClass}">
        <div class="progress" aria-label="Прогресс нормализации">
          <div class="progress-bar" style="width: ${percent}%"></div>
        </div>
        <div class="normalizer-status">${escapeHtml(normalizer.message)}${normalizer.status === "running" ? ` · ${percent}%` : ""}</div>
      </div>
    `;
  }

  function ripgrepStatusView(tools) {
    if (!tools || tools.ripgrepStatus === "notConfigured") {
      return `<div class="hint">rg не настроен. Codex сможет работать, но поиск по проекту может быть медленнее или падать на командах rg.</div>`;
    }
    if (tools.ripgrepStatus === "error") {
      return `<div class="hint error">${escapeHtml(tools.validationMessage || "Путь до rg недоступен.")}</div>`;
    }
    const version = tools.ripgrepVersion ? `, версия ${tools.ripgrepVersion}` : "";
    const managed = tools.ripgrepManaged ? " · установлен плагином" : "";
    return `<div class="hint success">rg найден${version}${managed}.</div>`;
  }

  function ripgrepInstallerView(progress) {
    if (!progress || !progress.message) {
      return "";
    }
    const statusClass = progress.status === "error" ? " error" : progress.status === "completed" ? " success" : "";
    const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    return `
      <div class="normalizer${statusClass}">
        <div class="progress" aria-label="Прогресс установки ripgrep">
          <div class="progress-bar" style="width: ${percent}%"></div>
        </div>
        <div class="normalizer-status">${escapeHtml(progress.message)}${progress.status === "running" ? ` · ${percent}%` : ""}</div>
      </div>
    `;
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
