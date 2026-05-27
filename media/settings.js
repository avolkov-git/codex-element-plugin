(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const state = {
    snapshot: undefined,
    proxyDraft: undefined,
    docsDraft: undefined,
    toolsDraft: undefined,
    normalizer: undefined,
    ripgrepInstaller: undefined,
    message: "",
    messageKind: "info"
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "settings.snapshot") {
      state.snapshot = message.snapshot;
      if (state.messageKind === "success") {
        state.proxyDraft = undefined;
        state.docsDraft = undefined;
        state.toolsDraft = undefined;
      }
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.saved") {
      state.message = String(message.payload || "Настройки сохранены.");
      state.messageKind = "success";
      render();
      return;
    }
    if (message.type === "event" && message.event === "settings.error") {
      state.message = String(message.payload || "Не удалось сохранить настройки.");
      state.messageKind = "error";
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
    const proxy = state.proxyDraft || snapshotProxy;
    const docs = state.docsDraft || snapshotDocs;
    const tools = state.toolsDraft || snapshotTools;
    const normalizer = state.normalizer || snapshotNormalizer;
    const ripgrepInstaller = state.ripgrepInstaller || snapshotRipgrepInstaller;
    const normalizerRunning = normalizer.status === "running";
    const ripgrepInstalling = ripgrepInstaller.status === "running";
    root.innerHTML = `
      <main class="settings-app">
        <header class="settings-header">
          <div class="eyebrow">CODEX FOR 1C: ELEMENT</div>
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
      state.message = "";
      vscode.postMessage({
        type: "command",
        command: "settings.proxy.save",
        payload: { url, username, password }
      });
    });

    const saveDocsButton = root.querySelector("#save-docs");
    if (saveDocsButton) {
      saveDocsButton.addEventListener("click", () => {
        const normalizedPath = valueOf("#docs-normalized-path");
        state.docsDraft = { normalizedPath, validationMessage: "" };
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
  }

  function valueOf(selector) {
    const input = document.querySelector(selector);
    return input ? input.value : "";
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
