(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const state = {
    chatId: root.dataset.chatId,
    snapshot: undefined,
    notice: ""
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "chat.snapshot") {
      state.snapshot = message.snapshot;
      if (state.snapshot && state.snapshot.chat) {
        vscode.setState({ chatId: state.snapshot.chat.id });
      }
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
    const snapshot = state.snapshot;
    if (!snapshot) {
      root.innerHTML = `<main class="app"><div class="body"><div class="notice">Загрузка чата...</div></div></main>`;
      return;
    }

    root.innerHTML = `
      <main class="app">
        <header class="header">
          <div>
            <div class="eyebrow">${snapshot.chat.kind === "project" ? "Проектный чат" : "Общий чат"}</div>
            <div class="title">${escapeHtml(snapshot.chat.title)}</div>
            <div class="meta">Auth: ${escapeHtml(snapshot.auth.accountLabel)} · ${escapeHtml(snapshot.runtime.label)}</div>
          </div>
          <div class="badge">${escapeHtml(snapshot.chat.status)}</div>
        </header>
        <section class="body">
          <div class="notice">${escapeHtml(snapshot.shellNotice)}</div>
          ${snapshot.transcript.map(message).join("")}
          ${state.notice ? `<div class="event">${escapeHtml(state.notice)}</div>` : ""}
        </section>
        <footer class="composer">
          <div class="composer-box">
            <textarea placeholder="Напишите задачу для Codex"></textarea>
            <div class="composer-actions">
              <div class="chips">
                ${snapshot.chat.kind === "project" ? projectChips() : `<span class="chip">Без проектного контекста</span>`}
              </div>
              <button class="button" data-command="chat.send">Отправить</button>
            </div>
          </div>
        </footer>
      </main>
    `;

    root.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "command", command: button.dataset.command });
      });
    });
  }

  function projectChips() {
    return `
      <span class="chip">Проект</span>
      <span class="chip">Документация</span>
      <span class="chip">Библиотеки</span>
      <span class="chip">Правила</span>
    `;
  }

  function message(item) {
    return `
      <article class="message">
        <div class="message-role">${role(item.role)}</div>
        <div>${escapeHtml(item.text)}</div>
      </article>
    `;
  }

  function role(value) {
    if (value === "user") return "Пользователь";
    if (value === "assistant") return "Codex";
    return "Система";
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
