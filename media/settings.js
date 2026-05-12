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
    normalizer: undefined,
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
  });

  vscode.postMessage({ type: "ready", assetMode });
  render();

  function render() {
    const root = document.getElementById("root");
    const snapshotProxy = state.snapshot && state.snapshot.proxy ? state.snapshot.proxy : { url: "", username: "", passwordSaved: false };
    const snapshotDocs = state.snapshot && state.snapshot.docs ? state.snapshot.docs : { normalizedPath: "", validationMessage: "" };
    const snapshotNormalizer = state.snapshot && state.snapshot.normalizer ? state.snapshot.normalizer : { status: "idle", percent: 0, stage: "idle", message: "" };
    const proxy = state.proxyDraft || snapshotProxy;
    const docs = state.docsDraft || snapshotDocs;
    const normalizer = state.normalizer || snapshotNormalizer;
    const normalizerRunning = normalizer.status === "running";
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
