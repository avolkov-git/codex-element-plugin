(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const state = {
    snapshot: undefined,
    draft: undefined,
    message: "",
    messageKind: "info"
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "settings.snapshot") {
      state.snapshot = message.snapshot;
      if (state.messageKind === "success") {
        state.draft = undefined;
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
    }
  });

  vscode.postMessage({ type: "ready", assetMode });
  render();

  function render() {
    const root = document.getElementById("root");
    const snapshotProxy = state.snapshot && state.snapshot.proxy ? state.snapshot.proxy : { url: "", username: "", passwordSaved: false };
    const proxy = state.draft || snapshotProxy;
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
          ${message()}
        </section>
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
      state.draft = { url, username, password, passwordSaved: false };
      state.message = "";
      vscode.postMessage({
        type: "command",
        command: "settings.proxy.save",
        payload: { url, username, password }
      });
    });
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
