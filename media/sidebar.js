(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const state = {
    snapshot: undefined,
    authMode: "choose",
    notice: ""
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "sidebar.snapshot") {
      state.snapshot = message.snapshot;
      render();
    }
    if (message.type === "event" && message.event === "shell.notice") {
      state.notice = String(message.payload || "");
      render();
    }
  });

  vscode.postMessage({ type: "ready", assetMode });
  render();

  function render() {
    const root = document.getElementById("root");
    const snapshot = state.snapshot;
    root.innerHTML = `
      <main class="app">
        ${brand()}
        ${snapshot ? (snapshot.auth.status === "authenticated" ? chatSections(snapshot) : authCard(snapshot)) : loading()}
      </main>
    `;
    bind(root);
  }

  function brand() {
    return `
      <section class="brand">
        <div class="mark">C</div>
        <div>
          <div class="title">Codex</div>
          <div class="subtitle">Codex for 1C: Element</div>
        </div>
      </section>
    `;
  }

  function loading() {
    return `<section class="card"><div class="muted">Загрузка...</div></section>`;
  }

  function authCard(snapshot) {
    if (state.authMode === "device") {
      return `
        <section class="card auth-panel">
          <div class="section-title">DEVICE CODE</div>
          <div class="muted">Здесь будет Device Code login. Runtime пока не подключен.</div>
          <div class="code-box">CODEX-0000</div>
          <button class="button" data-command="auth.deviceCode.select">Получить Device Code</button>
          <button class="button secondary" data-mode="choose">Назад</button>
          ${notice()}
        </section>
      `;
    }

    if (state.authMode === "apiKey") {
      return `
        <section class="card auth-panel">
          <div class="section-title">API KEY</div>
          <div class="muted">Ключ будет храниться в SecretStorage. Shell пока не отправляет ключ в backend.</div>
          <input class="input" type="password" placeholder="sk-..." autocomplete="off" />
          <button class="button" data-command="auth.apiKey.select">Сохранить и войти</button>
          <button class="button secondary" data-mode="choose">Назад</button>
          ${notice()}
        </section>
      `;
    }

    return `
      <section class="card auth-panel">
        <div class="section-title">Авторизация</div>
        <div class="button-stack">
          <button class="button" data-mode="device">DEVICE CODE</button>
          <button class="button secondary" data-mode="apiKey">API KEY</button>
          <button class="button ghost" data-command="settings.proxy.open">Настроить proxy</button>
        </div>
        ${notice()}
      </section>
    `;
  }

  function chatSections(snapshot) {
    return `
      ${chatSection("Проект", "project", snapshot)}
      ${chatSection("Чаты", "general", snapshot)}
      ${notice()}
    `;
  }

  function chatSection(title, kind, snapshot) {
    const chats = snapshot.chats.filter((chat) => chat.kind === kind);
    const command = kind === "project" ? "chat.createProject" : "chat.createGeneral";
    return `
      <section class="card">
        <div class="section-title">
          <span>${title}</span>
          <button class="small-button" title="Создать чат" data-command="${command}">+</button>
        </div>
        <div class="chat-list">
          ${chats.length ? chats.map((chat) => chatRow(chat, snapshot.activeChatId)).join("") : `<div class="empty">Чатов пока нет</div>`}
        </div>
      </section>
    `;
  }

  function chatRow(chat, activeChatId) {
    const active = chat.id === activeChatId ? " active" : "";
    return `
      <button class="chat-row${active}" data-command="chat.open" data-chat-id="${escapeHtml(chat.id)}">
        <div class="chat-title">${escapeHtml(chat.title)}</div>
        <div class="chat-meta">${formatDate(chat.updatedAt)} · ${escapeHtml(chat.status)}</div>
      </button>
    `;
  }

  function notice() {
    return state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : "";
  }

  function bind(root) {
    root.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.authMode = button.dataset.mode;
        state.notice = "";
        render();
      });
    });
    root.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        const payload = button.dataset.chatId ? { chatId: button.dataset.chatId } : undefined;
        vscode.postMessage({ type: "command", command, payload });
      });
    });
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
    } catch {
      return "";
    }
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
