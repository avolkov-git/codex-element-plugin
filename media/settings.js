(function () {
  if (window.__codexElementAppReady) return;
  if (!window.__codexElementSettingsIcons) return;
  const vscode = acquireVsCodeApi();
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const persisted = typeof vscode.getState === "function" ? vscode.getState() : undefined;
  const pages = [
    { id: "connection", title: "Подключение", icon: "network" },
    { id: "docs", title: "Документация", icon: "book" },
    { id: "tools", title: "Инструменты", icon: "plug" },
    { id: "skills", title: "Навыки", icon: "skills" },
    { id: "system", title: "Система", icon: "settings" }
  ];
  const root = document.getElementById("root");
  let presentationFrame = 0;
  let composing = false;
  let deferredRender = false;
  const state = {
    snapshot: undefined,
    activePage: pages.some(page => page.id === persisted?.activePage) ? persisted.activePage : "tools",
    pageScrolls: {},
    drawer: null,
    drawerReturnFocus: "",
    focusTarget: "",
    proxyDraft: undefined,
    docsDraft: undefined,
    toolsDraft: undefined,
    browserDraft: undefined,
    browserDirty: false,
    browserTest: null,
    contextChecked: false,
    contextDesired: false,
    pending: {},
    pendingSaveScope: "",
    integrationsBeforeRefresh: null,
    sectionFeedback: {},
    feedbackToReveal: null,
    mcpEditor: null,
    mcpSaving: false,
    mcpMessage: "",
    mcpMessageKind: "info",
    mcpAction: null,
    skillsQuery: "",
    skillsSource: "all",
    skillsEnabled: "all",
    normalizer: undefined,
    ripgrepInstaller: undefined,
    context: { status: "idle", text: "", originalText: "", sourcePath: "", revision: "", dirty: false, saving: false, message: "", kind: "info" },
    message: "",
    messageKind: "info"
  };

  window.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "settings.snapshot") {
      captureVisibleDrafts();
      state.snapshot = message.snapshot || {};
      if (state.snapshot.integrations?.mcpStatus !== "loading" && state.snapshot.integrations?.skillsStatus !== "loading") state.integrationsBeforeRefresh = null;
      if (state.browserDirty && state.browserDraft) {
        state.browserDraft = { ...(state.snapshot.browser || {}), enabled: state.browserDraft.enabled, disableSandbox: state.browserDraft.disableSandbox };
      }
      render();
      checkContextIfNeeded();
      return;
    }
    if (message.type !== "event") return;
    const scope = message.scope || state.pendingSaveScope;
    if (message.event === "settings.saved" || message.event === "settings.error") {
      const success = message.event === "settings.saved";
      if (!success && (scope === "mcp" || scope === "skills") && state.integrationsBeforeRefresh) {
        state.snapshot.integrations = state.integrationsBeforeRefresh;
        state.integrationsBeforeRefresh = null;
      }
      if (success) commitDraft(scope);
      delete state.pending[scope];
      if (state.pendingSaveScope === scope) state.pendingSaveScope = "";
      if (scope === "docs" && state.normalizer?.status === "running") {
        state.normalizer = { status: success ? "idle" : "error", percent: 0, message: "" };
      }
      setFeedback(scope, message.payload || (success ? "Настройки сохранены." : "Не удалось сохранить настройки."), success ? "success" : "error");
      if (!success) state.feedbackToReveal = scope || "";
    } else if (message.event === "settings.mcp.saved") {
      const returnFocus = state.mcpEditor?.originalName ? `[data-mcp-edit="${attributeSelectorValue(state.mcpEditor.name)}"]` : "#add-mcp";
      state.mcpSaving = false;
      state.mcpEditor = null;
      state.mcpMessage = "";
      if (state.drawer === "mcp") { state.drawer = null; state.focusTarget = returnFocus; }
      setFeedback("mcp", message.payload || "MCP-сервер сохранён.", "success");
    } else if (message.event === "settings.mcp.deleted") {
      if (state.mcpEditor?.originalName === message.payload?.name) {
        state.mcpEditor = null;
        state.mcpMessage = "";
        if (state.drawer === "mcp") { state.drawer = null; state.focusTarget = "#add-mcp"; }
      }
    } else if (message.event === "settings.mcp.error") {
      state.mcpSaving = false;
      state.mcpMessage = String(message.payload || "Не удалось сохранить MCP-сервер.");
      state.mcpMessageKind = "error";
      state.feedbackToReveal = "mcp-editor";
    } else if (message.event === "settings.mcp.test.result") {
      const result = message.payload || {};
      state.mcpAction = { type: "test", name: String(result.name || state.mcpAction?.name || ""), status: String(result.status || "failed"), message: String(result.message || "Не удалось проверить MCP-сервер."), details: String(result.details || "") };
    } else if (message.event === "settings.browser.test.result") {
      const result = message.payload || {};
      state.browserTest = { status: String(result.status || "failed"), message: String(result.message || "Не удалось проверить браузер."), details: String(result.details || "") };
      if (state.browserTest.status === "failed") state.feedbackToReveal = "browser-test";
    } else if (message.event === "settings.docs.normalize.progress") {
      state.normalizer = message.payload || { status: "running", percent: 0, message: "Нормализация выполняется" };
    } else if (message.event === "settings.tools.ripgrep.install.progress") {
      state.ripgrepInstaller = message.payload || { status: "running", percent: 0, message: "Установка ripgrep выполняется" };
    } else if (message.event === "settings.docs.baseContext.loaded") {
      const value = message.payload || {};
      state.context = { status: "ready", text: String(value.text || ""), originalText: String(value.text || ""), sourcePath: String(value.sourcePath || ""), revision: String(value.revision || ""), dirty: false, saving: false, message: "", kind: "info" };
    } else if (message.event === "settings.docs.baseContext.saved") {
      state.context.saving = false;
      state.context.dirty = false;
      state.context.originalText = state.context.text;
      state.context.revision = String(message.payload?.revision || state.context.revision);
      state.context.message = String(message.payload?.message || "Базовый контекст сохранён.");
      state.context.kind = "success";
    } else if (message.event === "settings.docs.baseContext.error") {
      state.context.saving = false;
      if (state.context.status === "loading") state.context.status = state.context.revision ? "ready" : "error";
      state.context.message = String(message.payload || "Не удалось прочитать базовый контекст.");
      state.context.kind = "error";
      state.feedbackToReveal = "context";
    } else return;
    render();
  });

  root.addEventListener("compositionstart", () => { composing = true; });
  root.addEventListener("compositionend", () => {
    composing = false;
    if (deferredRender) { deferredRender = false; render(); }
  });
  root.addEventListener("click", handleClick);
  root.addEventListener("input", handleInput);
  root.addEventListener("change", handleChange);
  root.addEventListener("keydown", handleKeydown);
  render();
  window.__codexElementAppReady = true;
  vscode.postMessage({ type: "ready", assetMode });

  function views() {
    const snapshot = state.snapshot || {};
    return {
      proxy: state.proxyDraft || snapshot.proxy || { url: "", username: "", passwordSaved: false },
      docs: state.docsDraft || snapshot.docs || { normalizedPath: "", sourcePath: "", validationMessage: "" },
      tools: state.toolsDraft || snapshot.tools || { ripgrepPath: "", ripgrepVersion: "", ripgrepStatus: "notConfigured" },
      browser: state.browserDraft || snapshot.browser || { enabled: false, disableSandbox: false, status: "notInstalled", statusMessage: "Компоненты браузера не установлены." },
      integrations: snapshot.integrations || { status: "idle", mcpStatus: "idle", skillsStatus: "idle", mcpServers: [], skills: [] },
      normalizer: state.normalizer || snapshot.normalizer || { status: "idle" },
      installer: state.ripgrepInstaller || snapshot.ripgrepInstaller || { status: "idle" },
      system: snapshot.system || {},
      experimentalContext: snapshot.experimentalContext || { status: "idle", enabled: false, canChange: false, message: "Доступность ещё не проверена." },
      version: String(snapshot.extensionVersion || "")
    };
  }

  function render() {
    if (composing) { deferredRender = true; return; }
    const presentation = capturePresentationState();
    const view = views();
    root.innerHTML = `
      <div class="settings-app">
        <header class="settings-header"><div class="settings-brand">${icon("codex")}<span>Codex для 1С:Элемент</span></div>${view.version ? `<span class="settings-version">${escapeHtml(view.version)}</span>` : ""}</header>
        <div class="settings-workspace" ${state.drawer ? 'aria-hidden="true"' : ""}>
          <nav class="settings-nav" aria-label="Разделы настроек">
            <div class="settings-nav-title">Настройки</div>
            <div class="settings-nav-list">${pages.map(page => `<button class="settings-nav-button" type="button" data-settings-page="${page.id}" data-focus-key="page:${page.id}" ${page.id === state.activePage ? 'aria-current="page"' : ""}>${icon(page.icon)}<span>${page.title}</span>${pageHasError(page.id) ? `<span class="settings-nav-error" title="Есть ошибка">${icon("alert")}<span class="sr-only">Есть ошибка</span></span>` : ""}</button>`).join("")}</div>
            <div class="settings-nav-footer">Theia IDE${view.system.platformId || view.browser.platformId ? `<br>${escapeHtml(platformLabel(view.system.platformId || view.browser.platformId))}` : ""}</div>
          </nav>
          <main class="settings-main" data-active-page="${state.activePage}" aria-label="Содержимое настроек">
            <div class="settings-page">${messageView()}${state.snapshot ? renderPage(view) : `${pageHeading(pages.find(page => page.id === state.activePage).title)}${integrationLoadingState("Загружаем настройки...")}`}</div>
          </main>
        </div>
        ${renderDrawer(view)}
      </div>`;
    root.querySelector(".settings-workspace").inert = Boolean(state.drawer);
    restorePresentationState(presentation);
  }

  function renderPage(view) {
    if (state.activePage === "tools") return `${pageHeading("Инструменты", "Встроенный браузер и MCP-серверы")}${browserSection(view)}${mcpSection(view.integrations)}`;
    if (state.activePage === "skills") return skillsSection(view.integrations);
    if (state.activePage === "connection") {
      const proxy = view.proxy;
      const busy = Boolean(state.pending.proxy);
      return `${pageHeading("Подключение", "Сетевые настройки Codex")}
        <section class="settings-section" aria-label="Прокси-сервер"><div class="section-heading"><h2>Прокси-сервер</h2><span class="section-summary">${state.snapshot.proxy?.url ? "Через прокси" : "Прямое подключение"}</span></div>
          <div class="settings-form" aria-busy="${busy}">
            <label class="field"><span>Адрес прокси</span><input id="proxy-url" type="text" autocomplete="off" placeholder="http://proxy.example:8080" value="${escapeAttribute(proxy.url || "")}" ${disabled(busy)} /></label>
            <div class="field-grid"><label class="field"><span>Логин</span><input id="proxy-username" type="text" autocomplete="off" value="${escapeAttribute(proxy.username || "")}" ${disabled(busy)} /></label><label class="field"><span>Пароль</span><input id="proxy-password" type="password" autocomplete="new-password" value="${escapeAttribute(state.proxyDraft?.password || "")}" placeholder="${proxy.passwordSaved ? "Пароль сохранён" : ""}" ${disabled(busy)} /></label></div>
            ${sectionFeedback("proxy")}<div class="button-row"><button class="button" id="save-proxy" type="button" ${disabled(busy)}>${busy ? "Сохраняем..." : "Сохранить"}</button></div>
          </div>
        </section>`;
    }
    if (state.activePage === "docs") {
      const busy = Boolean(state.pending.docs) || view.normalizer.status === "running";
      const docs = view.docs;
      return `${pageHeading("Документация", "Локальная база знаний 1С:Элемент")}
        <section class="settings-section" aria-label="Источник документации"><div class="section-heading"><h2>Источник документации</h2>${statusLabel(docs.validationMessage ? "Проверьте каталог" : docs.normalizedPath ? "Каталог доступен" : "Не настроено", docs.validationMessage ? "failed" : docs.normalizedPath ? "ready" : "unknown")}</div>
          <div class="settings-form" aria-busy="${busy}"><label class="field"><span>Каталог нормализованной документации</span><input id="docs-normalized-path" type="text" autocomplete="off" value="${escapeAttribute(docs.normalizedPath || "")}" ${disabled(busy)} /></label>
            ${docs.validationMessage ? `<div class="hint error">${escapeHtml(docs.validationMessage)}</div>` : ""}
            ${docs.sourcePath ? dataRow("Исходная документация", docs.sourcePath) : ""}
            ${progressView(view.normalizer, "Прогресс нормализации")}${sectionFeedback("docs")}
            <div class="button-row"><button class="button" id="save-docs" type="button" ${disabled(busy)}>${state.pending.docs === "save" ? "Сохраняем..." : "Сохранить"}</button><button class="button secondary" id="normalize-docs" type="button" ${disabled(busy)}>${icon("refresh")}${view.normalizer.status === "running" ? "Нормализуем..." : "Нормализовать"}</button></div>
          </div>
        </section>
        <section class="settings-section"><div class="section-heading"><h2>Базовый контекст</h2><button class="settings-link" id="open-base-context" type="button">Открыть${icon("right")}</button></div>${state.drawer !== "context" && state.context.kind === "error" ? `<div class="hint error">${escapeHtml(state.context.message)}</div>` : ""}</section>`;
    }
    return `${pageHeading("Система", "Компоненты плагина и служебные инструменты")}
      ${experimentalContextSection(view.experimentalContext)}
      <section class="settings-section"><div class="section-heading"><h2>Компоненты</h2><span class="section-summary">${escapeHtml(platformLabel(view.system.platformId || view.browser.platformId))}</span></div>
        <div class="system-components">${dataRow("Плагин Codex", view.version)}${dataRow("Codex app-server (поставка)", view.system.codexVersion)}${dataRow("Playwright MCP", view.browser.playwrightMcpVersion)}${dataRow("Chromium", view.browser.chromiumVersion)}${dataRow("Node.js браузера", view.browser.nodeVersion)}</div>
      </section>
      <section class="settings-section"><div class="section-heading"><h2>Поиск по файлам</h2></div><div class="tool-row"><span class="row-symbol">${icon("fileSearch")}</span><div class="integration-main"><div class="integration-title-line"><strong>ripgrep</strong>${view.tools.ripgrepVersion ? `<span class="integration-badge">${escapeHtml(view.tools.ripgrepVersion)}</span>` : ""}</div>${ripgrepStatusView(view.tools)}</div><button class="button secondary" id="open-ripgrep" type="button">Настроить</button></div>${state.drawer !== "tools" ? `${progressView(view.installer, "Прогресс установки ripgrep")}${sectionFeedback("tools")}` : ""}</section>`;
  }

  function experimentalContextSection(context) {
    const pending = state.pending.experimentalContext;
    const checked = pending === "save" ? state.contextDesired : context.enabled;
    const busy = Boolean(pending) || context.status === "checking";
    const label = pending === "save" ? "Применяем..." : busy ? "Проверяем..." : context.status === "unsupported" ? "Не поддерживается" : context.status === "error" ? "Ошибка проверки" : context.status === "ready" ? context.enabled ? "Включено" : "Выключено" : "Не проверено";
    const kind = busy ? "starting" : context.status === "error" ? "failed" : context.enabled && context.status === "ready" ? "ready" : "unknown";
    return `<section class="settings-section" aria-label="Управление контекстом" aria-busy="${busy}">
      <div class="section-heading"><h2>Управление контекстом</h2><button class="icon-button" id="refresh-experimental-context" type="button" title="Проверить доступность контекста" aria-label="Проверить доступность контекста" ${disabled(busy)}>${icon("refresh")}</button></div>
      <div class="tool-row"><span class="row-symbol">${icon("book")}</span><div class="integration-main"><div class="integration-title-line"><strong>Контекст: заметки и история</strong><span class="integration-badge">Эксперимент</span></div><div class="integration-meta">${statusLabel(label, kind)}</div></div>
        <label class="toggle-control" title="Экспериментальный контекст"><input id="experimental-context-enabled" type="checkbox" role="switch" aria-label="Экспериментальный контекст" aria-describedby="experimental-context-status" ${checked ? "checked" : ""} ${disabled(busy || !context.canChange)} /><span aria-hidden="true"></span></label>
      </div>
      <div id="experimental-context-status" class="hint${context.status === "error" ? " error" : ""}" role="status">${escapeHtml(pending === "save" ? "Применяем режим к app-server текущего пользователя IDE..." : context.message || "Доступность ещё не проверена.")}</div>
      ${sectionFeedback("experimentalContext")}
    </section>`;
  }

  function browserSection(view) {
    const browser = view.browser;
    const ready = browser.status === "ready";
    const busy = Boolean(state.pending.browser);
    const testing = state.browserTest?.status === "testing";
    const application = browser.application || { status: "idle", message: "Получаем адрес приложения из IDE..." };
    const managed = (view.integrations.mcpServers || []).find(server => server.managed === "browser");
    const stateLabel = busy ? "Сохраняем..." : testing ? "Проверяем браузер" : !ready ? "Компоненты недоступны" : state.browserTest?.status === "failed" ? "Ошибка запуска" : managed?.runtimeStatus === "failed" ? "Ошибка MCP" : state.browserTest?.status === "ready" ? "Браузер проверен" : "Компоненты установлены";
    const stateKind = busy || testing ? "starting" : !ready || state.browserTest?.status === "failed" || managed?.runtimeStatus === "failed" ? "failed" : "ready";
    return `<section class="settings-section browser-section" aria-label="Браузерное тестирование">
      <div class="section-heading"><h2>Браузерное тестирование</h2></div>
      <div class="browser-runtime-row"><span class="row-symbol">${icon("browser")}</span><div class="integration-main"><div class="integration-title-line"><strong>Playwright</strong><span class="integration-badge">Встроенный</span></div><div class="integration-meta">${statusLabel(stateLabel, stateKind)}</div></div>
        <div class="integration-actions"><button class="button secondary" id="test-browser" type="button" ${disabled(!ready || testing || busy)}>${icon("play")}${testing ? "Проверяем..." : "Проверить"}</button><label class="toggle-control" title="Браузерное тестирование"><input id="browser-enabled" type="checkbox" role="switch" aria-label="Включить браузерное тестирование" ${browser.enabled ? "checked" : ""} ${disabled(busy || (!ready && !state.snapshot.browser?.enabled))} /><span aria-hidden="true"></span></label></div>
      </div>
      <div class="browser-info">
        <div class="settings-data-row browser-application" role="status"><span>Приложение IDE</span><div>${application.status === "ready" ? `<strong>${escapeHtml(application.name || "Приложение IDE")}</strong><div class="browser-application-url">${escapeHtml(application.url || "")}</div>` : `<span class="${application.status === "error" ? "error" : "muted"}">${escapeHtml(application.message || "Получаем адрес приложения из IDE...")}</span>`}${application.status === "error" || application.status === "idle" ? `<div><button class="settings-link" id="refresh-browser-application" type="button">${icon("refresh")}Повторить проверку</button></div>` : ""}</div></div>
        <div class="browser-bottom"><span class="browser-versions">${escapeHtml([browser.chromiumVersion ? `Chromium ${browser.chromiumVersion}` : "", browser.playwrightMcpVersion ? `Playwright MCP ${browser.playwrightMcpVersion}` : ""].filter(Boolean).join(" · "))}</span><button class="settings-link" id="open-browser-settings" type="button">Параметры запуска${icon("right")}</button></div>
        ${!ready ? `<div class="hint error">${escapeHtml(browser.statusMessage || "Компоненты браузера недоступны.")}</div>` : ""}
        ${browser.validationMessage && browser.validationMessage !== application.message && browser.validationMessage !== state.sectionFeedback.browser?.text ? `<div class="hint error">${escapeHtml(browser.validationMessage)}</div>` : ""}
        ${managed?.error ? technicalErrorDetails("Ошибка подключения MCP", managed.error) : ""}
        ${browserTestView()}
        ${state.drawer !== "browser" ? sectionFeedback("browser") : ""}
        ${state.browserDirty && !busy && state.drawer !== "browser" ? `<div class="browser-unsaved"><button class="button secondary" id="save-browser" type="button">${icon("check")}Сохранить изменения</button></div>` : ""}
      </div>
    </section>`;
  }

  function mcpSection(integrations) {
    const servers = (Array.isArray(integrations.mcpServers) ? integrations.mcpServers : []).filter(server => server.managed !== "browser");
    const status = integrations.mcpStatus || integrations.status || "idle";
    const loading = status === "loading";
    return `<section class="settings-section integration-section" aria-label="MCP-серверы">
      <div class="section-heading"><div class="section-label"><h2>MCP-серверы</h2><span class="section-count">${servers.length}</span></div><div class="compact-actions"><button class="icon-button" id="refresh-integrations" type="button" title="Обновить MCP-серверы" aria-label="Обновить MCP-серверы" ${disabled(loading)}>${icon("refresh")}</button><button class="icon-text-button" id="add-mcp" type="button">${icon("plus")}Добавить</button></div></div>
      ${state.drawer !== "mcp" ? sectionFeedback("mcp") : ""}
      ${integrationState(status, servers.length, integrations.mcpMessage || integrations.message, "MCP-серверов пока нет", "mcp")}
      <div class="integration-list">${servers.map(mcpServerRow).join("")}</div>
      ${integrations.updatedAt ? `<div class="integration-updated">Обновлено ${escapeHtml(formatUpdatedAt(integrations.updatedAt))}</div>` : ""}
    </section>`;
  }

  function mcpServerRow(server) {
    const endpoint = server.transport === "stdio" ? server.command || "Команда не указана" : safeEndpointLabel(server.url || "URL не указан");
    const count = safeCount(server.toolCount);
    const needsLogin = server.enabled !== false && server.authStatus === "notLoggedIn";
    const status = server.enabled === false ? "unknown" : needsLogin ? "warning" : server.runtimeStatus || "unknown";
    const label = server.enabled === false ? "Выключен" : needsLogin ? "Требуется вход" : server.runtimeStatus === "ready" ? `${count} ${pluralRu(count, "инструмент", "инструмента", "инструментов")}` : mcpRuntimeLabel(server.runtimeStatus);
    return `<div class="integration-row" data-mcp-row="${escapeAttribute(server.name)}"><span class="row-symbol">${icon("plug")}</span><div class="integration-main"><div class="integration-title-line"><strong>${escapeHtml(server.name)}</strong><span class="integration-badge">${server.transport === "stdio" ? "stdio" : "HTTP"}</span></div><div class="integration-endpoint" title="${escapeAttribute(endpoint)}">${escapeHtml(endpoint)}</div><div class="integration-meta">${statusLabel(label, status)}</div>${server.error ? technicalErrorDetails("Сервер сообщил об ошибке", server.error) : ""}${state.drawer !== "mcp" ? mcpActionFeedback(server.name) : ""}</div>
      <div class="integration-actions">${needsLogin && server.transport === "http" ? `<button class="quiet-button" type="button" data-mcp-oauth="${escapeAttribute(server.name)}">Войти</button>` : ""}<label class="toggle-control" title="${server.enabled === false ? "Включить" : "Выключить"} сервер"><input type="checkbox" role="switch" aria-label="${server.enabled === false ? "Включить" : "Выключить"} MCP-сервер ${escapeAttribute(server.name)}" data-focus-key="mcp-toggle:${escapeAttribute(server.name)}" data-mcp-toggle="${escapeAttribute(server.name)}" ${server.enabled === false ? "" : "checked"} /><span aria-hidden="true"></span></label><button class="icon-button" type="button" data-mcp-edit="${escapeAttribute(server.name)}" data-focus-key="mcp-edit:${escapeAttribute(server.name)}" title="Настроить ${escapeAttribute(server.name)}" aria-label="Настроить ${escapeAttribute(server.name)}">${icon("settings")}</button></div>
    </div>`;
  }

  function skillsSection(integrations) {
    const skills = Array.isArray(integrations.skills) ? integrations.skills : [];
    const status = integrations.skillsStatus || integrations.status || "idle";
    const scopes = [...new Set(skills.map(skill => skill.scope || "unknown"))].sort((left, right) => skillScopeLabel(left).localeCompare(skillScopeLabel(right)));
    if (state.skillsSource !== "all" && !scopes.includes(state.skillsSource)) state.skillsSource = "all";
    return `${pageHeading("Навыки", `${skills.length} ${pluralRu(skills.length, "навык", "навыка", "навыков")} · ${skills.filter(skill => skill.enabled !== false).length} включено`, `<button class="icon-button" id="refresh-skills" type="button" title="Обновить навыки" aria-label="Обновить навыки" ${disabled(status === "loading")}>${icon("refresh")}</button>`)}
      <section class="settings-section" aria-label="Навыки Codex">${sectionFeedback("skills")}
        ${skills.length ? `<div class="skills-toolbar" role="search" aria-label="Фильтры навыков"><label class="compact-field skills-search-field"><span class="sr-only">Найти навык</span><span class="skills-search">${icon("search")}<input id="skills-search" type="search" autocomplete="off" placeholder="Найти навык" aria-label="Найти навык" value="${escapeAttribute(state.skillsQuery)}" /></span></label><label class="compact-field"><span class="sr-only">Источник навыков</span><select id="skills-source" aria-label="Источник навыков"><option value="all">Все источники</option>${scopes.map(scope => `<option value="${escapeAttribute(scope)}" ${state.skillsSource === scope ? "selected" : ""}>${escapeHtml(skillScopeLabel(scope))}</option>`).join("")}</select></label><label class="compact-field"><span class="sr-only">Состояние навыков</span><select id="skills-enabled" aria-label="Состояние навыков"><option value="all" ${state.skillsEnabled === "all" ? "selected" : ""}>Все</option><option value="enabled" ${state.skillsEnabled === "enabled" ? "selected" : ""}>Включены</option><option value="disabled" ${state.skillsEnabled === "disabled" ? "selected" : ""}>Выключены</option></select></label></div>` : ""}
        ${integrationState(status, skills.length, integrations.skillsMessage || integrations.message, "Доступных навыков нет", "skills")}
        ${skills.length ? `<div id="skills-results">${skillsResults(integrations)}</div>` : ""}
        ${integrations.updatedAt ? `<div class="integration-updated">Обновлено ${escapeHtml(formatUpdatedAt(integrations.updatedAt))}</div>` : ""}
      </section>`;
  }

  function renderDrawer(view) {
    if (!state.drawer) return "";
    let title = "";
    let body = "";
    let footer = "";
    const cancel = `<button class="button secondary" type="button" data-close-drawer="discard" ${disabled(drawerBusy())}>Отмена</button>`;
    if (state.drawer === "mcp") {
      title = state.mcpEditor?.originalName || "Новый MCP-сервер";
      body = mcpEditorView(state.mcpEditor || {});
      footer = `${mcpEditorMessage()}${sectionFeedback("mcp")}<div class="button-row"><button class="button" id="save-mcp" type="button" ${disabled(state.mcpSaving)}>${state.mcpSaving ? "Сохраняем..." : "Сохранить сервер"}</button>${cancel}${state.mcpEditor?.originalName ? `<button class="icon-button danger" type="button" data-mcp-delete="${escapeAttribute(state.mcpEditor.originalName)}" title="Удалить сервер" aria-label="Удалить сервер" ${disabled(state.mcpSaving)}>${icon("trash")}</button>` : ""}</div>`;
    } else if (state.drawer === "browser") {
      title = "Параметры браузера";
      const browser = view.browser;
      const managed = (view.integrations.mcpServers || []).find(server => server.managed === "browser");
      body = `<div class="system-components">${dataRow("Playwright MCP", browser.playwrightMcpVersion)}${dataRow("Chromium", browser.chromiumVersion)}${dataRow("Node.js", browser.nodeVersion)}${dataRow("Платформа", platformLabel(browser.platformId))}</div><h3>Параметры запуска</h3><label class="browser-checkbox-row"><input id="browser-disable-sandbox" type="checkbox" ${browser.disableSandbox ? "checked" : ""} ${disabled(Boolean(state.pending.browser))} /><span><strong>Отключить изоляцию Chromium</strong><small>Только для сред, где Chromium sandbox не запускается.</small></span></label>${managed ? `<div class="button-row">${mcpTestButton(managed)}</div>${mcpActionFeedback(managed.name)}` : ""}${browser.status !== "ready" ? `<div class="hint error">${escapeHtml(browser.statusMessage || "Компоненты браузера недоступны.")}</div>` : ""}`;
      footer = `${sectionFeedback("browser")}<div class="button-row"><button class="button" id="save-browser" type="button" ${disabled(Boolean(state.pending.browser) || (!state.browserDirty && !state.pending.browser))}>${state.pending.browser ? "Сохраняем..." : "Сохранить"}</button>${cancel}</div>`;
    } else if (state.drawer === "tools") {
      title = "Поиск по файлам";
      const busy = Boolean(state.pending.tools) || view.installer.status === "running";
      body = `<h3>ripgrep${view.tools.ripgrepVersion ? ` ${escapeHtml(view.tools.ripgrepVersion)}` : ""}</h3>${ripgrepStatusView(view.tools)}<label class="field" style="margin-top:24px"><span>Путь к исполняемому файлу</span><textarea id="tools-ripgrep-path" rows="3" spellcheck="false" ${disabled(busy)}>${escapeHtml(view.tools.ripgrepPath || "")}</textarea></label>${progressView(view.installer, "Прогресс установки ripgrep")}`;
      footer = `${sectionFeedback("tools")}<div class="button-row"><button class="button" id="save-ripgrep" type="button" ${disabled(busy)}>${state.pending.tools ? "Сохраняем..." : "Сохранить"}</button><button class="button secondary" id="install-ripgrep" type="button" ${disabled(busy)}>${icon("download")}${view.installer.status === "running" ? "Устанавливаем..." : "Установить"}</button></div>`;
    } else if (state.drawer === "context") {
      const context = state.context;
      title = "Базовый контекст";
      body = context.status === "loading" ? integrationLoadingState("Читаем базовый контекст...") : `${context.sourcePath ? `<div class="context-source">${escapeHtml(context.sourcePath)}</div>` : ""}${context.status === "ready" ? `<label class="field"><span>Общие правила плагина</span><textarea id="base-context-text" spellcheck="false" ${disabled(context.saving)}>${escapeHtml(context.text)}</textarea></label>` : ""}<div class="compact-actions"><button class="quiet-button" id="reload-base-context" type="button" ${disabled(context.saving)} title="Перечитать файл">${icon("refresh")}Перечитать</button><button class="icon-button" id="open-base-context-file" type="button" title="Открыть файл в IDE" aria-label="Открыть файл в IDE">${icon("external")}</button></div>${context.confirmReload ? `<div class="context-reload-confirm" role="alert"><p>Перечитать файл и отменить несохранённые изменения?</p><div class="compact-actions"><button class="button secondary" id="confirm-reload-base-context" type="button">Перечитать файл</button><button class="quiet-button" id="cancel-reload-base-context" type="button">Оставить черновик</button></div></div>` : ""}`;
      footer = `${context.message ? `<div class="editor-feedback ${escapeAttribute(context.kind)}" data-feedback-scope="context" role="${context.kind === "error" ? "alert" : "status"}">${icon(context.kind === "error" ? "alert" : "check")}<span>${escapeHtml(context.message)}</span></div>` : ""}<div class="button-row"><button class="button" id="save-base-context" type="button" ${disabled(context.status !== "ready" || context.saving || !context.dirty)}>${context.saving ? "Сохраняем..." : "Сохранить"}</button>${cancel}</div>`;
    }
    return `<div class="settings-drawer-layer"><button class="settings-drawer-backdrop" type="button" tabindex="-1" data-close-drawer="keep" aria-label="Закрыть панель" ${disabled(drawerBusy())}></button><aside class="settings-drawer" id="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-drawer-title" tabindex="-1"><div class="settings-drawer-head"><h2 id="settings-drawer-title">${escapeHtml(title)}</h2><button class="icon-button" id="close-settings-drawer" type="button" data-close-drawer="keep" aria-label="Закрыть панель" title="Закрыть панель" ${disabled(drawerBusy())}>${icon("close")}</button></div><div class="settings-drawer-body">${body}</div><div class="settings-drawer-footer">${footer}</div></aside></div>`;
  }

  function mcpEditorView(editor) {
    const http = editor.transport === "http";
    const saving = state.mcpSaving;
    const server = editor.originalName ? findMcpServer(editor.originalName) : null;
    return `<div class="integration-editor" aria-busy="${saving}">
      ${server ? `<div class="compact-actions" style="margin-bottom:20px">${mcpTestButton(server)}<span class="section-summary">${safeCount(server.resourceCount)} ${pluralRu(safeCount(server.resourceCount), "ресурс", "ресурса", "ресурсов")} · ${escapeHtml(mcpAuthLabel(server.authStatus))}</span></div>${mcpActionFeedback(server.name)}` : ""}
      <label class="field"><span>Имя сервера</span><input id="mcp-name" type="text" autocomplete="off" placeholder="my-server" value="${escapeAttribute(editor.name || "")}" ${disabled(saving)} /><small>Латинские буквы, цифры, дефис или подчёркивание. Пробелы заменяются дефисами.</small></label>
      <label class="field"><span>Транспорт</span><select id="mcp-transport" ${disabled(saving)}><option value="http" ${http ? "selected" : ""}>Удалённый сервер (HTTP)</option><option value="stdio" ${!http ? "selected" : ""}>Локальная команда (stdio)</option></select></label>
      ${http ? `<label class="field"><span>URL</span><input id="mcp-url" type="url" autocomplete="off" placeholder="http://127.0.0.1:9900/mcp" value="${escapeAttribute(editor.url || "")}" ${disabled(saving)} /></label><label class="field"><span>Переменная токена <small>необязательно</small></span><input id="mcp-bearer-env" type="text" autocomplete="off" placeholder="MY_MCP_TOKEN" value="${escapeAttribute(editor.bearerTokenEnvVar || "")}" ${disabled(saving)} /><small>Имя переменной окружения процесса Element, не сам токен.</small></label>` : `<label class="field"><span>Команда</span><input id="mcp-command" type="text" autocomplete="off" placeholder="node" value="${escapeAttribute(editor.command || "")}" ${disabled(saving)} /></label><label class="field"><span>Аргументы <small>по одному на строку</small></span><textarea id="mcp-args" rows="4" ${disabled(saving)}>${escapeHtml(Array.isArray(editor.args) ? editor.args.join("\n") : "")}</textarea></label>`}
    </div>`;
  }

  function handleClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.settingsPage) return selectPage(button.dataset.settingsPage);
    if (button.hasAttribute("data-close-drawer")) return closeDrawer(button.dataset.closeDrawer === "discard");
    if (button.dataset.mcpEdit) return openMcpEditor(button.dataset.mcpEdit);
    if (button.dataset.mcpDelete) return post("settings.mcp.delete", { name: button.dataset.mcpDelete });
    if (button.dataset.mcpOauth) return post("settings.mcp.oauth", { name: button.dataset.mcpOauth });
    if (button.dataset.mcpTest) {
      const name = button.dataset.mcpTest;
      state.mcpAction = { type: "test", name, status: "testing", message: "Проверяем подключение и инструменты...", details: "" };
      render(); post("settings.mcp.test", { name }); return;
    }
    if (button.classList.contains("retry-integrations")) return refreshIntegrations(button.dataset.scope || "mcp");
    switch (button.id) {
      case "refresh-experimental-context": return refreshExperimentalContext();
      case "save-proxy": {
        state.proxyDraft = { url: valueOf("#proxy-url"), username: valueOf("#proxy-username"), password: valueOf("#proxy-password"), passwordSaved: Boolean(state.snapshot?.proxy?.passwordSaved) };
        const { url, username, password } = state.proxyDraft;
        return saveScope("proxy", "settings.proxy.save", { url, username, password });
      }
      case "save-docs": {
        state.docsDraft = { ...views().docs, normalizedPath: valueOf("#docs-normalized-path"), validationMessage: "" };
        return saveScope("docs", "settings.docs.save", { normalizedPath: state.docsDraft.normalizedPath });
      }
      case "normalize-docs": {
        state.docsDraft = { ...views().docs, normalizedPath: valueOf("#docs-normalized-path"), validationMessage: "" };
        state.normalizer = { status: "running", percent: 0, message: "Запуск нормализации" };
        return saveScope("docs", "settings.docs.normalize", { normalizedPath: state.docsDraft.normalizedPath }, "normalize");
      }
      case "open-base-context":
        openDrawer("context", "#open-base-context");
        if (!state.context.dirty && !state.context.saving) readBaseContext();
        return;
      case "reload-base-context": return readBaseContext();
      case "confirm-reload-base-context": return readBaseContext(true);
      case "cancel-reload-base-context": state.context.confirmReload = false; render(); return;
      case "open-base-context-file": return post("settings.docs.openBaseContext");
      case "save-base-context": {
        if (state.context.saving || state.context.status !== "ready") return;
        state.context.text = valueOf("#base-context-text", state.context.text);
        state.context.saving = true; state.context.message = "";
        render(); post("settings.docs.baseContext.save", { text: state.context.text, revision: state.context.revision }); return;
      }
      case "open-browser-settings": return openDrawer("browser", "#open-browser-settings");
      case "open-ripgrep": return openDrawer("tools", "#open-ripgrep");
      case "save-ripgrep": {
        state.toolsDraft = { ...views().tools, ripgrepPath: valueOf("#tools-ripgrep-path"), validationMessage: "" };
        return saveScope("tools", "settings.tools.ripgrep.save", { ripgrepPath: state.toolsDraft.ripgrepPath });
      }
      case "install-ripgrep":
        state.ripgrepInstaller = { status: "running", percent: 0, message: "Запуск установки ripgrep" };
        delete state.sectionFeedback.tools; render(); post("settings.tools.ripgrep.install"); return;
      case "save-browser": return saveBrowser();
      case "refresh-browser-application": {
        const application = { status: "loading", message: "Получаем адрес приложения из IDE..." };
        state.snapshot.browser = { ...state.snapshot.browser, application };
        if (state.browserDraft) state.browserDraft.application = application;
        delete state.sectionFeedback.browser; render(); post("settings.browser.application.refresh"); return;
      }
      case "test-browser":
        if (state.browserTest?.status === "testing") return;
        state.browserTest = { status: "testing", message: "Проверяем запуск Node.js, Playwright MCP и Chromium...", details: "" };
        render(); post("settings.browser.test"); return;
      case "refresh-integrations": return refreshIntegrations("mcp");
      case "refresh-skills": return refreshIntegrations("skills");
      case "add-mcp": return openMcpEditor("");
      case "save-mcp": return saveMcp();
    }
  }

  function handleInput(event) {
    const input = event.target;
    if (["proxy-url", "proxy-username", "proxy-password"].includes(input.id)) {
      state.proxyDraft = { url: valueOf("#proxy-url"), username: valueOf("#proxy-username"), password: valueOf("#proxy-password"), passwordSaved: Boolean(state.snapshot?.proxy?.passwordSaved) };
    } else if (input.id === "docs-normalized-path") state.docsDraft = { ...views().docs, normalizedPath: input.value, validationMessage: "" };
    else if (input.id === "tools-ripgrep-path") state.toolsDraft = { ...views().tools, ripgrepPath: input.value, validationMessage: "" };
    else if (["mcp-name", "mcp-command", "mcp-args", "mcp-url", "mcp-bearer-env"].includes(input.id)) {
      state.mcpEditor = captureMcpEditor(); state.mcpMessage = "";
    } else if (input.id === "skills-search") { state.skillsQuery = input.value; updateSkillsResults(); }
    else if (input.id === "base-context-text") {
      state.context.text = input.value;
      state.context.dirty = state.context.text !== state.context.originalText;
      state.context.message = "";
      const save = root.querySelector("#save-base-context");
      if (save) save.disabled = !state.context.dirty || state.context.saving;
      const reload = root.querySelector("#reload-base-context");
      if (reload) reload.disabled = state.context.saving;
    }
  }

  function handleChange(event) {
    const input = event.target;
    if (input.id === "experimental-context-enabled") {
      const context = views().experimentalContext;
      if (!context.canChange || state.pending.experimentalContext) { render(); return; }
      state.contextDesired = Boolean(input.checked);
      saveScope("experimentalContext", "settings.experimentalContext.save", { enabled: Boolean(input.checked), scopeId: context.scopeId, revision: context.revision });
    }
    else if (input.id === "browser-enabled") { captureBrowserDraft(); saveBrowser(); }
    else if (input.id === "browser-disable-sandbox") { captureBrowserDraft(); render(); }
    else if (input.id === "mcp-transport") { state.mcpEditor = captureMcpEditor(); render(); }
    else if (input.id === "skills-source") { state.skillsSource = input.value || "all"; updateSkillsResults(); }
    else if (input.id === "skills-enabled") { state.skillsEnabled = input.value || "all"; updateSkillsResults(); }
    else if (input.dataset.mcpToggle) post("settings.mcp.toggle", { name: input.dataset.mcpToggle, enabled: Boolean(input.checked) });
    else if (input.dataset.skillToggle) post("settings.skill.toggle", { name: input.dataset.skillName || "", path: input.dataset.skillToggle, enabled: Boolean(input.checked) });
  }

  function handleKeydown(event) {
    if (event.key === "Enter" && !event.isComposing && event.target.tagName === "INPUT") {
      const button = state.drawer === "mcp" ? root.querySelector("#save-mcp") : state.activePage === "connection" ? root.querySelector("#save-proxy") : state.activePage === "docs" ? root.querySelector("#save-docs") : null;
      if (button && !button.disabled && event.target.type !== "checkbox") { event.preventDefault(); button.click(); }
    }
    if (!state.drawer) return;
    if (event.key === "Escape" && !drawerBusy()) { event.preventDefault(); closeDrawer(false); }
    if (event.key !== "Tab") return;
    const drawer = root.querySelector(".settings-drawer");
    const controls = [...drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(node => node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  function selectPage(page) {
    if (!pages.some(item => item.id === page) || state.activePage === page || state.drawer) return;
    captureVisibleDrafts();
    state.pageScrolls[state.activePage] = root.querySelector(".settings-main")?.scrollTop || 0;
    state.activePage = page;
    state.focusTarget = "#settings-page-title";
    persistUiState(); render();
    checkContextIfNeeded();
  }

  function checkContextIfNeeded() {
    if (state.activePage === "system" && state.snapshot && !state.contextChecked && views().experimentalContext.status === "idle") refreshExperimentalContext();
  }

  function refreshExperimentalContext() {
    state.contextChecked = true;
    saveScope("experimentalContext", "settings.experimentalContext.refresh", {}, "check");
  }

  function openDrawer(drawer, returnFocus) {
    captureVisibleDrafts();
    state.drawer = drawer;
    state.drawerReturnFocus = returnFocus;
    state.focusTarget = drawer === "mcp" ? "#mcp-name" : "#settings-drawer";
    render();
  }

  function closeDrawer(discard) {
    if (drawerBusy()) return;
    captureVisibleDrafts();
    if (discard) {
      if (state.drawer === "mcp") { state.mcpEditor = null; state.mcpMessage = ""; }
      if (state.drawer === "browser") { state.browserDraft = undefined; state.browserDirty = false; }
      if (state.drawer === "tools") state.toolsDraft = undefined;
      if (state.drawer === "context") { state.context.text = state.context.originalText; state.context.dirty = false; state.context.confirmReload = false; }
    }
    state.drawer = null;
    state.focusTarget = state.drawerReturnFocus;
    render();
  }

  function drawerBusy() {
    return (state.drawer === "mcp" && state.mcpSaving) || (state.drawer === "browser" && Boolean(state.pending.browser)) || (state.drawer === "context" && state.context.saving) || (state.drawer === "tools" && Boolean(state.pending.tools));
  }

  function readBaseContext(discardDraft = false) {
    if (state.context.status === "loading" || state.context.saving) return;
    if (state.context.dirty && !discardDraft) {
      state.context.confirmReload = true;
      state.focusTarget = "#cancel-reload-base-context";
      render(); return;
    }
    state.context.status = "loading"; state.context.message = ""; state.context.confirmReload = false;
    render(); post("settings.docs.baseContext.read");
  }

  function openMcpEditor(name) {
    const server = name ? findMcpServer(name) : null;
    if (name && (!server || server.managed === "browser")) return;
    if (!state.mcpEditor || (state.mcpEditor.originalName || "") !== name) {
      state.mcpEditor = server ? { originalName: server.name, name: server.name, transport: server.transport, command: server.command || "", args: Array.isArray(server.args) ? [...server.args] : [], url: server.url || "", bearerTokenEnvVar: server.bearerTokenEnvVar || "", enabled: server.enabled !== false } : { name: "", transport: "http", command: "", args: [], url: "", bearerTokenEnvVar: "", enabled: true };
      state.mcpMessage = "";
    }
    openDrawer("mcp", name ? `[data-mcp-edit="${attributeSelectorValue(name)}"]` : "#add-mcp");
  }

  function saveMcp() {
    if (state.mcpSaving) return;
    const editor = captureMcpEditor();
    const validation = validateMcpEditor(editor);
    state.mcpEditor = editor;
    if (validation.error) {
      state.mcpMessage = validation.error; state.mcpMessageKind = "error";
      state.feedbackToReveal = "mcp-editor";
      state.focusTarget = validation.field || "#mcp-name";
      render(); return;
    }
    editor.name = validation.name;
    state.mcpSaving = true;
    state.mcpMessage = validation.nameChanged ? `Сервер будет сохранён с именем ${validation.name}.` : "";
    state.mcpMessageKind = "info";
    render(); post("settings.mcp.save", editor);
  }

  function saveBrowser() {
    if (state.pending.browser) return;
    const browser = captureBrowserDraft();
    saveScope("browser", "settings.browser.save", { enabled: browser.enabled, disableSandbox: browser.disableSandbox });
  }

  function saveScope(scope, command, payload, action = "save") {
    if (state.pending[scope]) return;
    state.pending[scope] = action; state.pendingSaveScope = scope;
    delete state.sectionFeedback[scope]; state.message = "";
    render(); post(command, payload);
  }

  function commitDraft(scope) {
    if (!state.snapshot) return;
    if (scope === "proxy" && state.proxyDraft) {
      const { url, username, password, passwordSaved } = state.proxyDraft;
      state.snapshot.proxy = { url, username, passwordSaved: Boolean(url && (password || passwordSaved)) };
      state.proxyDraft = undefined;
    } else if (scope === "docs") {
      if (state.pending.docs === "save" && state.docsDraft) { state.snapshot.docs = { ...state.snapshot.docs, ...state.docsDraft }; state.docsDraft = undefined; }
      else if (state.normalizer?.status === "completed") state.docsDraft = undefined;
    } else if (scope === "tools") {
      if (state.toolsDraft) state.snapshot.tools = { ...state.snapshot.tools, ...state.toolsDraft };
      state.toolsDraft = undefined;
    } else if (scope === "browser") {
      if (state.browserDraft) state.snapshot.browser = { ...state.snapshot.browser, enabled: state.browserDraft.enabled, disableSandbox: state.browserDraft.disableSandbox };
      state.browserDraft = undefined; state.browserDirty = false;
    }
  }

  function captureBrowserDraft() {
    const current = state.browserDraft || state.snapshot?.browser || {};
    state.browserDraft = { ...current, enabled: checkboxValue("#browser-enabled", current.enabled), disableSandbox: checkboxValue("#browser-disable-sandbox", current.disableSandbox), validationMessage: "" };
    state.browserDirty = true;
    return state.browserDraft;
  }

  function captureVisibleDrafts() {
    if (state.mcpEditor && root.querySelector("#mcp-name")) state.mcpEditor = captureMcpEditor();
    if (state.browserDirty && (root.querySelector("#browser-enabled") || root.querySelector("#browser-disable-sandbox"))) captureBrowserDraft();
  }

  function captureMcpEditor() {
    const current = state.mcpEditor || {};
    const enabled = current.originalName ? findMcpServer(current.originalName)?.enabled !== false : current.enabled !== false;
    return { originalName: current.originalName || "", name: valueOf("#mcp-name", current.name || ""), transport: valueOf("#mcp-transport", current.transport) === "http" ? "http" : "stdio", command: valueOf("#mcp-command", current.command || ""), args: valueOf("#mcp-args", (current.args || []).join("\n")).split(/\r?\n/).map(value => value.trim()).filter(Boolean), url: valueOf("#mcp-url", current.url || ""), bearerTokenEnvVar: valueOf("#mcp-bearer-env", current.bearerTokenEnvVar || ""), enabled };
  }

  function validateMcpEditor(editor) {
    if (editor.originalName && !findMcpServer(editor.originalName)) return { error: "Сервер больше не найден в текущей конфигурации. Закройте панель и обновите список.", field: "#mcp-name" };
    const rawName = String(editor.name || "").trim();
    const name = rawName.replace(/\s+/g, "-");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return { error: "Укажите имя от 1 до 64 символов: латинские буквы, цифры, _ или -.", field: "#mcp-name" };
    if ((views().integrations.mcpServers || []).some(server => server.name === name && server.name !== editor.originalName)) return { error: "MCP-сервер с таким именем уже есть.", field: "#mcp-name" };
    if (editor.transport === "http") {
      try {
        const url = new URL(String(editor.url || "").trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "URL MCP-сервера должен начинаться с http:// или https://.", field: "#mcp-url" };
      } catch { return { error: "Укажите корректный URL MCP-сервера.", field: "#mcp-url" }; }
      const bearerEnv = String(editor.bearerTokenEnvVar || "").trim();
      if (bearerEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerEnv)) return { error: "Имя переменной токена содержит недопустимые символы.", field: "#mcp-bearer-env" };
    } else if (!String(editor.command || "").trim()) return { error: "Укажите команду запуска MCP-сервера.", field: "#mcp-command" };
    return { name, nameChanged: name !== rawName };
  }

  function refreshIntegrations(scope) {
    delete state.sectionFeedback[scope];
    if (state.snapshot) {
      if (!state.integrationsBeforeRefresh) state.integrationsBeforeRefresh = views().integrations;
      state.snapshot.integrations = { ...views().integrations, status: "loading", mcpStatus: "loading", skillsStatus: "loading" };
    }
    render(); post("settings.integrations.refresh", { scope });
  }

  function integrationState(status, count, details, emptyTitle, scope) {
    if (status === "loading") return integrationLoadingState(scope === "skills" ? "Обновляем навыки..." : "Обновляем MCP-серверы...");
    const refresh = `<button class="quiet-button retry-integrations" data-scope="${scope}" type="button">${icon("refresh")}${status === "error" ? "Повторить" : "Обновить"}</button>`;
    if (status === "idle") return `<div class="inline-state"><span class="muted">Список ещё не загружен.</span>${refresh}</div>`;
    if (status === "error" && !count) return `<div class="inline-state error" role="alert">${icon("alert")}<span>${escapeHtml(details || "Не удалось загрузить данные.")}</span>${refresh}</div>`;
    if (status === "partial" || (status === "error" && count)) return `<div class="inline-state warning" role="status">${icon("alert")}<span>${escapeHtml(details || "Показаны последние доступные данные.")}</span></div>`;
    return count ? "" : `<div class="integration-empty"><strong>${escapeHtml(emptyTitle)}</strong></div>`;
  }

  function skillsResults(integrations) {
    const all = integrations.skills || [];
    const query = state.skillsQuery.trim().toLocaleLowerCase("ru");
    const filtered = all.filter(skill => (state.skillsSource === "all" || (skill.scope || "unknown") === state.skillsSource) && (state.skillsEnabled !== "enabled" || skill.enabled !== false) && (state.skillsEnabled !== "disabled" || skill.enabled === false) && (!query || [skill.displayName, skill.name, skill.shortDescription, skill.description, skill.path].filter(Boolean).some(value => String(value).toLocaleLowerCase("ru").includes(query))));
    if (!filtered.length) return '<div class="integration-empty" role="status"><strong>Ничего не найдено</strong></div>';
    return `${filtered.length !== all.length ? `<div class="skills-result-count" aria-live="polite">Показано ${filtered.length} из ${all.length}</div>` : ""}<div class="integration-list skills-list">${filtered.map(skillRow).join("")}</div>`;
  }

  function skillRow(skill) {
    return `<div class="integration-row skill-row"><div class="integration-main"><div class="integration-title-line"><strong>${escapeHtml(skill.displayName || skill.name)}</strong><span class="integration-badge">${escapeHtml(skillScopeLabel(skill.scope))}</span></div><div class="integration-description">${escapeHtml(skill.shortDescription || skill.description || "Описание не указано")}</div><details class="skill-details"><summary>Подробности</summary><div class="integration-meta">${escapeHtml(skill.name)}${safeCount(skill.dependencyCount) ? ` · зависимостей: ${safeCount(skill.dependencyCount)}` : ""}</div><div class="integration-meta">${escapeHtml(skill.path || "")}</div></details></div><label class="toggle-control" title="${skill.enabled === false ? "Включить" : "Выключить"} навык"><input type="checkbox" role="switch" aria-label="${skill.enabled === false ? "Включить" : "Выключить"} навык ${escapeAttribute(skill.displayName || skill.name)}" data-focus-key="skill:${escapeAttribute(skill.path)}" data-skill-toggle="${escapeAttribute(skill.path)}" data-skill-name="${escapeAttribute(skill.name)}" ${skill.enabled === false ? "" : "checked"} /><span aria-hidden="true"></span></label></div>`;
  }

  function updateSkillsResults() {
    const results = root.querySelector("#skills-results");
    if (results) results.innerHTML = skillsResults(views().integrations);
  }

  function mcpTestButton(server) {
    const testing = state.mcpAction?.name === server.name && state.mcpAction.status === "testing";
    return `<button class="button secondary" type="button" data-mcp-test="${escapeAttribute(server.name)}" data-focus-key="mcp-test:${escapeAttribute(server.name)}" ${disabled(server.enabled === false || testing || state.mcpSaving)}>${icon("play")}${testing ? "Проверяем..." : "Проверить MCP"}</button>`;
  }

  function mcpActionFeedback(name) {
    const action = state.mcpAction;
    if (!action || action.name !== name) return "";
    const kind = action.status === "ready" ? "success" : action.status === "failed" ? "error" : "warning";
    return `<div class="mcp-action-feedback ${kind}" role="status">${action.status === "testing" ? '<span class="inline-spinner" aria-hidden="true"></span>' : ""}<span>${escapeHtml(action.message)}</span>${action.details ? technicalErrorDetails("Технические подробности", action.details) : ""}</div>`;
  }

  function browserTestView() {
    const result = state.browserTest;
    if (!result) return "";
    return `<div class="browser-test-result ${result.status === "ready" ? "success" : result.status === "testing" ? "loading" : "error"}" data-feedback-scope="browser-test" role="${result.status === "failed" ? "alert" : "status"}">${result.status === "testing" ? '<span class="inline-spinner" aria-hidden="true"></span>' : ""}<span>${escapeHtml(result.message)}</span>${result.details ? technicalErrorDetails("Технические подробности", result.details) : ""}</div>`;
  }

  function mcpEditorMessage() {
    return state.mcpMessage ? `<div class="editor-feedback ${escapeAttribute(state.mcpMessageKind)}" data-feedback-scope="mcp-editor" role="${state.mcpMessageKind === "error" ? "alert" : "status"}">${icon(state.mcpMessageKind === "error" ? "alert" : "check")}<span>${escapeHtml(state.mcpMessage)}</span></div>` : "";
  }

  function capturePresentationState() {
    const active = document.activeElement;
    let selector = "";
    if (active?.id) selector = `[id="${attributeSelectorValue(active.id)}"]`;
    else if (active?.dataset?.focusKey) selector = `[data-focus-key="${attributeSelectorValue(active.dataset.focusKey)}"]`;
    return { selector, selectionStart: typeof active?.selectionStart === "number" ? active.selectionStart : null, selectionEnd: typeof active?.selectionEnd === "number" ? active.selectionEnd : null, mainScroll: root.querySelector(".settings-main")?.scrollTop || 0, page: root.querySelector(".settings-main")?.dataset.activePage, drawer: Boolean(root.querySelector(".settings-drawer")), drawerScroll: root.querySelector(".settings-drawer-body")?.scrollTop || 0 };
  }

  function restorePresentationState(presentation) {
    const selector = state.focusTarget || presentation.selector;
    state.focusTarget = "";
    cancelAnimationFrame(presentationFrame);
    presentationFrame = requestAnimationFrame(() => {
      const main = root.querySelector(".settings-main");
      if (main) main.scrollTop = presentation.page === state.activePage ? presentation.mainScroll : state.pageScrolls[state.activePage] || 0;
      const body = root.querySelector(".settings-drawer-body");
      if (body) body.scrollTop = presentation.drawer ? presentation.drawerScroll : 0;
      const target = selector ? root.querySelector(selector) : null;
      if (target?.getClientRects().length && !target.disabled && (!state.drawer || target.closest(".settings-drawer"))) {
        target.focus({ preventScroll: true });
        if (selector === presentation.selector && presentation.selectionStart !== null && typeof target.setSelectionRange === "function") {
          const max = String(target.value || "").length;
          try { target.setSelectionRange(Math.min(presentation.selectionStart, max), Math.min(presentation.selectionEnd ?? presentation.selectionStart, max)); } catch { /* Non-text inputs do not expose a selection range. */ }
        }
      } else if (state.drawer) root.querySelector(".settings-drawer")?.focus({ preventScroll: true });
      if (state.feedbackToReveal !== null) { revealFeedback(state.feedbackToReveal); state.feedbackToReveal = null; }
    });
  }

  function revealFeedback(scope) {
    const feedback = [...root.querySelectorAll("[data-feedback-scope]")].find(node => node.dataset.feedbackScope === scope && node.getClientRects().length && (!state.drawer || node.closest(".settings-drawer")));
    if (!feedback) return;
    const container = feedback.closest(".settings-drawer-body, .settings-main") || feedback.closest(".settings-drawer");
    const rect = feedback.getBoundingClientRect();
    const bounds = container?.getBoundingClientRect() || { top: 0, bottom: innerHeight };
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) feedback.scrollIntoView({ block: "nearest" });
  }

  function persistUiState() {
    if (typeof vscode.setState !== "function") return;
    const current = typeof vscode.getState === "function" ? vscode.getState() : {};
    vscode.setState({ ...(current || {}), activePage: state.activePage });
  }

  function setFeedback(scope, text, kind) {
    if (["proxy", "docs", "browser", "tools", "mcp", "skills", "experimentalContext"].includes(scope)) state.sectionFeedback[scope] = { text: String(text), kind };
    else { state.message = String(text); state.messageKind = kind; }
  }

  function pageHasError(page) {
    const scopes = { connection: ["proxy"], docs: ["docs"], tools: ["browser", "mcp"], skills: ["skills"], system: ["tools", "experimentalContext"] }[page];
    return scopes.some(scope => state.sectionFeedback[scope]?.kind === "error") || (page === "docs" && state.context.kind === "error") || (page === "tools" && state.browserTest?.status === "failed");
  }

  function sectionFeedback(scope) {
    const feedback = state.sectionFeedback[scope];
    return feedback ? `<div class="section-feedback ${escapeAttribute(feedback.kind)}" data-feedback-scope="${scope}" role="${feedback.kind === "error" ? "alert" : "status"}">${icon(feedback.kind === "error" ? "alert" : "check")}<span>${escapeHtml(feedback.text)}</span></div>` : "";
  }

  function messageView() {
    return state.message ? `<div class="message ${escapeAttribute(state.messageKind)}" data-feedback-scope="" role="${state.messageKind === "error" ? "alert" : "status"}">${escapeHtml(state.message)}</div>` : "";
  }

  function progressView(progress, label) {
    if (!progress?.message) return "";
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    return `<div class="normalizer ${progress.status === "error" ? "error" : progress.status === "completed" ? "success" : ""}" role="status">${progress.status === "running" ? `<div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-bar" style="width:${percent}%"></div></div>` : ""}<div class="normalizer-status">${escapeHtml(progress.message)}${progress.status === "running" ? ` · ${percent}%` : ""}</div></div>`;
  }

  function ripgrepStatusView(tools) {
    if (tools.ripgrepStatus === "error") return `<div class="integration-meta error">${escapeHtml(tools.validationMessage || "Путь к ripgrep недоступен.")}</div>`;
    if (!tools.ripgrepStatus || tools.ripgrepStatus === "notConfigured") return '<div class="integration-meta">Не настроен</div>';
    return `<div class="integration-meta">${tools.ripgrepManaged ? "Установлен плагином" : "Используется указанный путь"}</div>`;
  }

  function pageHeading(title, description = "", actions = "") { return `<div class="page-heading"><div><h1 id="settings-page-title" tabindex="-1">${escapeHtml(title)}</h1>${description ? `<p class="page-description">${escapeHtml(description)}</p>` : ""}</div>${actions}</div>`; }
  function dataRow(label, value) { return `<div class="settings-data-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value || "Нет данных")}</span></div>`; }
  function statusLabel(label, status) { return `<span class="integration-runtime ${escapeAttribute(status)}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`; }
  function technicalErrorDetails(label, details) { return `<details class="technical-details"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(details)}</pre></details>`; }
  function integrationLoadingState(text) { return `<div class="integration-loading" role="status"><span class="inline-spinner" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div>`; }
  function icon(name) { return `<span class="settings-icon" aria-hidden="true">${window.__codexElementSettingsIcons?.[name] || ""}</span>`; }
  function post(command, payload) { vscode.postMessage({ type: "command", command, ...(payload === undefined ? {} : { payload }) }); }
  function disabled(value) { return value ? "disabled" : ""; }
  function checkboxValue(selector, fallback) { const node = root.querySelector(selector); return node ? Boolean(node.checked) : Boolean(fallback); }
  function valueOf(selector, fallback = "") { const node = root.querySelector(selector); return node ? node.value : fallback; }
  function findMcpServer(name) { return (views().integrations.mcpServers || []).find(server => server.name === name) || null; }
  function safeCount(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0; }
  function mcpRuntimeLabel(status) { return ({ ready: "Готов", starting: "Запускается", failed: "Ошибка подключения", cancelled: "Остановлен", unknown: "Не проверен" })[status] || "Не проверен"; }
  function mcpAuthLabel(status) { return ({ unsupported: "без авторизации", notLoggedIn: "требуется вход", bearerToken: "токен доступа", oAuth: "OAuth подключён" })[status] || "авторизация не определена"; }
  function skillScopeLabel(scope) { return ({ user: "Профиль", repo: "Проект", system: "Системный", admin: "Администратор", plugin: "Плагин", marketplace: "Каталог навыков" })[scope] || "Неизвестный источник"; }
  function platformLabel(id) { const [platform, arch] = String(id || "").split("-"); const label = ({ win32: "Windows", linux: "Linux", darwin: "macOS" })[platform] || platform; return [label, arch].filter(Boolean).join(" · "); }
  function pluralRu(value, one, few, many) { const number = safeCount(value), two = number % 100, last = number % 10; return two >= 11 && two <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many; }
  function formatUpdatedAt(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "недавно" : new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
  function safeEndpointLabel(value) { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; } }
  function attributeSelectorValue(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
  function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
  function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
})();
