(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const state = {
    snapshot: undefined,
    notice: "",
    lastTranscriptSignature: "",
    lastReadSignal: "",
    renderedChatId: "",
    hasRenderedCurrentChat: false,
    stickToBottom: true,
    suppressScrollEvents: false
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "chat.snapshot") {
      state.snapshot = message.snapshot || undefined;
      if (state.snapshot && state.snapshot.chat) {
        vscode.setState({ activeChatId: state.snapshot.chat.id });
      }
      render();
    }
    if (message.type === "event" && message.event === "shell.notice") {
      state.notice = String(message.payload || "");
      render();
    }
    if (message.type === "event" && message.event === "chat.error") {
      state.notice = String(message.payload || "");
      render();
    }
  });

  vscode.postMessage({ type: "ready", assetMode });
  render();

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot || !snapshot.chat) {
      root.innerHTML = `
        <main class="app empty-app">
          <section class="empty-state">
            <div class="empty-title">Codex</div>
            <div class="empty-text">Выберите диалог в sidebar или создайте новый.</div>
          </section>
        </main>
      `;
      return;
    }

    const previousBody = root.querySelector("[data-role='transcript']");
    const previousScrollTop = previousBody ? previousBody.scrollTop : 0;
    const previousWasNearBottom = previousBody ? isNearBottom(previousBody) : true;
    if (state.renderedChatId !== snapshot.chat.id) {
      state.renderedChatId = snapshot.chat.id;
      state.hasRenderedCurrentChat = false;
      state.lastReadSignal = "";
      state.lastTranscriptSignature = "";
      state.notice = "";
      state.stickToBottom = !snapshot.chat.hasUnread;
    }
    const initialUnreadRender = snapshot.chat.hasUnread && !state.hasRenderedCurrentChat;
    const shouldStickToBottom = !initialUnreadRender && (state.stickToBottom || previousWasNearBottom);

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
        <section class="body" data-role="transcript">
          <div class="notice">${escapeHtml(snapshot.shellNotice)}</div>
          ${snapshot.transcript.map(message).join("")}
          ${state.notice ? `<div class="event">${escapeHtml(state.notice)}</div>` : ""}
          <div class="transcript-end" data-role="transcript-end"></div>
        </section>
        <footer class="composer">
          <div class="composer-box">
            <textarea data-role="prompt-input" placeholder="Напишите задачу для Codex"></textarea>
            <div class="composer-actions">
              <div class="chips">
                ${snapshot.chat.kind === "project" ? projectChips(snapshot) : `<span class="chip">Без проектного контекста</span>`}
              </div>
              <button class="button" data-command="chat.send" ${snapshot.chat.status === "running" || snapshot.chat.status === "waitingApproval" ? "disabled" : ""}>Отправить</button>
            </div>
          </div>
        </footer>
        ${snapshot.chat.pendingApproval ? approvalModal(snapshot.chat.pendingApproval) : ""}
      </main>
    `;

    const body = root.querySelector("[data-role='transcript']");
    const end = root.querySelector("[data-role='transcript-end']");
    const signature = transcriptSignature(snapshot);
    const transcriptChanged = signature !== state.lastTranscriptSignature;
    if (body) {
      body.addEventListener("scroll", () => {
        if (state.suppressScrollEvents) {
          return;
        }
        state.stickToBottom = isNearBottom(body);
        notifyReadToBottomIfNeeded(body, snapshot);
      });
      body.addEventListener("wheel", () => {
        requestAnimationFrame(() => {
          state.stickToBottom = isNearBottom(body);
          notifyReadToBottomIfNeeded(body, snapshot);
        });
      });
      requestAnimationFrame(() => {
        restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged);
        notifyReadToBottomIfNeeded(body, snapshot);
      });
    }
    state.lastTranscriptSignature = signature;
    state.hasRenderedCurrentChat = true;

    root.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        if (command === "chat.send") {
          const input = root.querySelector("[data-role='prompt-input']");
          const prompt = input ? input.value : "";
          if (!prompt.trim()) {
            state.notice = "Введите сообщение для Codex.";
            render();
            return;
          }
          if (input) {
            input.value = "";
          }
          state.notice = "";
          state.stickToBottom = true;
          vscode.postMessage({ type: "command", command, payload: { prompt } });
          return;
        }
        if (command === "approval.approve" || command === "approval.deny") {
          vscode.postMessage({
            type: "command",
            command,
            payload: { approvalId: button.dataset.approvalId || "" }
          });
          return;
        }
        vscode.postMessage({ type: "command", command });
      });
    });

    const textarea = root.querySelector("[data-role='prompt-input']");
    if (textarea) {
      textarea.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          const send = root.querySelector("[data-command='chat.send']");
          if (send && !send.disabled) {
            send.click();
          }
        }
      });
    }
  }

  function projectChips(snapshot) {
    const project = snapshot.projectContext || { status: "notIndexed", label: "Проектный контекст будет собран при отправке" };
    const projectClass = project.status === "active" ? " active" : project.status === "error" ? " error" : project.status === "indexing" ? " pending" : "";
    const docs = snapshot.docs || { status: "notConfigured", label: "Документация не настроена" };
    const docsClass = docs.status === "configured" ? " active" : docs.status === "error" ? " error" : "";
    const rules = snapshot.rulesContext || { status: snapshot.chat.rulesEnabled === false ? "disabled" : "missing", label: "Файл .local-codex/rules.md не найден" };
    const rulesClass = rules.status === "active" ? " active" : rules.status === "error" ? " error" : rules.status === "disabled" ? " muted" : "";
    return `
      <span class="chip${projectClass}" title="${escapeAttribute(project.label)}">${escapeHtml(projectLabel(project.status))}</span>
      <span class="chip${docsClass}" title="${escapeAttribute(docs.label)}">Документация: ${escapeHtml(docs.status === "configured" ? "активна" : "не настроена")}</span>
      <button class="chip chip-button${rulesClass}" type="button" data-command="chat.rules.toggle" title="${escapeAttribute(rules.label)}">${escapeHtml(rulesLabel(rules.status))}</button>
    `;
  }

  function projectLabel(status) {
    if (status === "active") {
      return "Проект: активен";
    }
    if (status === "indexing") {
      return "Проект: индексируется";
    }
    if (status === "error") {
      return "Проект: ошибка";
    }
    if (status === "disabled") {
      return "Проект: недоступен";
    }
    return "Проект";
  }

  function rulesLabel(status) {
    if (status === "active") {
      return "Правила: активны";
    }
    if (status === "disabled") {
      return "Правила: выключены";
    }
    if (status === "error") {
      return "Правила: ошибка";
    }
    return "Правила: отсутствуют";
  }

  function message(item) {
    return `
      <article class="message">
        <div class="message-role">${role(item.role)}</div>
        <div class="message-text">${escapeHtml(item.text)}</div>
      </article>
    `;
  }

  function approvalModal(approval) {
    return `
      <section class="approval-overlay" role="dialog" aria-modal="true" aria-label="${escapeAttribute(approval.title)}">
        <div class="approval-modal">
          <div class="approval-kicker">Требуется подтверждение</div>
          <h2>${escapeHtml(approval.title)}</h2>
          <p class="approval-description">${escapeHtml(approval.description)}</p>
          <dl class="approval-details">
            <div>
              <dt>Тип</dt>
              <dd>${escapeHtml(approvalKindLabel(approval.kind))}</dd>
            </div>
            ${approval.command ? `<div><dt>Команда</dt><dd><code>${escapeHtml(approval.command)}</code></dd></div>` : ""}
            ${approval.path ? `<div><dt>Файл</dt><dd><code>${escapeHtml(approval.path)}</code></dd></div>` : ""}
            ${approval.cwd ? `<div><dt>Каталог</dt><dd><code>${escapeHtml(approval.cwd)}</code></dd></div>` : ""}
          </dl>
          ${approval.diff ? `<pre class="approval-diff">${escapeHtml(approval.diff)}</pre>` : `<pre class="approval-diff muted">${escapeHtml(approval.payloadPreview || "Подробности действия недоступны.")}</pre>`}
          <div class="approval-actions">
            <button class="button secondary" data-command="approval.deny" data-approval-id="${escapeAttribute(approval.id)}">Отклонить</button>
            <button class="button" data-command="approval.approve" data-approval-id="${escapeAttribute(approval.id)}">Разрешить</button>
          </div>
        </div>
      </section>
    `;
  }

  function approvalKindLabel(kind) {
    if (kind === "command") return "Команда";
    if (kind === "file") return "Файл";
    if (kind === "diff") return "Изменение";
    if (kind === "network") return "Сеть";
    return "Действие";
  }

  function transcriptSignature(snapshot) {
    return snapshot.transcript
      .map((item) => `${item.id}:${item.text.length}:${item.role}`)
      .join("|");
  }

  function isNearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 160;
  }

  function restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged) {
    if (shouldStickToBottom) {
      scrollTranscriptToBottom(body, end);
      return;
    }

    body.scrollTop = Math.min(previousScrollTop, body.scrollHeight);
    if (transcriptChanged) {
      state.stickToBottom = isNearBottom(body);
    }
  }

  function scrollTranscriptToBottom(body, end) {
    state.suppressScrollEvents = true;
    body.scrollTop = body.scrollHeight;
    if (end && typeof end.scrollIntoView === "function") {
      end.scrollIntoView({ block: "end" });
    }
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
      if (end && typeof end.scrollIntoView === "function") {
        end.scrollIntoView({ block: "end" });
      }
      state.stickToBottom = true;
      state.suppressScrollEvents = false;
    });
  }

  function notifyReadToBottomIfNeeded(body, snapshot) {
    if (!snapshot.chat.hasUnread || !isNearBottom(body)) {
      return;
    }
    const readSignal = `${snapshot.chat.id}:${snapshot.chat.updatedAt}`;
    if (state.lastReadSignal === readSignal) {
      return;
    }
    state.lastReadSignal = readSignal;
    vscode.postMessage({ type: "command", command: "chat.readToBottom" });
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

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
