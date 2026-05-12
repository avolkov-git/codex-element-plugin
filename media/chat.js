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
    suppressScrollEvents: false,
    openMenu: null,
    openModelSubmenu: null,
    contextPopup: null,
    contextDetails: null,
    contextDetailsLoading: false,
    drafts: Object.create(null),
    planningArmedByChat: Object.create(null)
  };

  document.addEventListener("click", (event) => {
    if (event.target && event.target.closest && event.target.closest(".composer-selector")) {
      return;
    }
    if (event.target && event.target.closest && (event.target.closest(".context-details-popover") || event.target.closest(".context-chip-button"))) {
      return;
    }
    if (state.contextPopup) {
      state.contextPopup = null;
      state.contextDetails = null;
      state.contextDetailsLoading = false;
      render();
      return;
    }
    if (state.openMenu) {
      state.openMenu = null;
      state.openModelSubmenu = null;
      render();
    }
  });

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
    if (message.type === "event" && message.event === "chat.context.details") {
      state.contextDetails = message.payload || null;
      state.contextPopup = state.contextDetails && state.contextDetails.kind ? state.contextDetails.kind : state.contextPopup;
      state.contextDetailsLoading = false;
      render();
    }
    if (message.type === "event" && message.event === "chat.plan.reviseDraft") {
      const snapshot = state.snapshot;
      if (!snapshot || !snapshot.chat) {
        return;
      }
      setDraft(snapshot.chat.id, "Измени план: ");
      setPlanningArmed(snapshot.chat.id, true);
      render();
      requestAnimationFrame(() => {
        const textarea = root.querySelector("[data-role='prompt-input']");
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
      });
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

    const previousChatId = state.renderedChatId || snapshot.chat.id;
    const focusState = capturePromptFocus(previousChatId);
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
      state.openMenu = null;
      state.openModelSubmenu = null;
      state.contextPopup = null;
      state.contextDetails = null;
      state.contextDetailsLoading = false;
    }
    const initialUnreadRender = snapshot.chat.hasUnread && !state.hasRenderedCurrentChat;
    const shouldStickToBottom = !initialUnreadRender && (state.stickToBottom || previousWasNearBottom);

    root.innerHTML = `
      <main class="app">
        ${chatHeader(snapshot)}
        <section class="body" data-role="transcript">
          ${snapshot.transcript.map(message).join("")}
          ${state.notice ? `<div class="event">${escapeHtml(state.notice)}</div>` : ""}
          <div class="transcript-end" data-role="transcript-end"></div>
        </section>
        ${snapshot.chat.archivedAt ? archivedFooter() : composerFooter(snapshot)}
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
    restorePromptFocus(focusState, snapshot.chat.id);

    root.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        if (command === "chat.cancel") {
          state.notice = "";
          vscode.postMessage({ type: "command", command });
          return;
        }
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
          setDraft(snapshot.chat.id, "");
          const sendMode = isPlanningArmed(snapshot.chat.id) ? "planning" : "normal";
          setPlanningArmed(snapshot.chat.id, false);
          state.notice = "";
          state.stickToBottom = true;
          vscode.postMessage({ type: "command", command, payload: { prompt, mode: sendMode } });
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
        if (command === "chat.access.toggle") {
          toggleMenu("access");
          return;
        }
        if (command === "chat.planning.toggle") {
          setPlanningArmed(snapshot.chat.id, !isPlanningArmed(snapshot.chat.id));
          render();
          return;
        }
        if (command === "chat.plan.implement") {
          const planText = getPlanText(button.dataset.planId || "");
          if (!planText) {
            state.notice = "План не найден.";
            render();
            return;
          }
          setPlanningArmed(snapshot.chat.id, false);
          vscode.postMessage({ type: "command", command, payload: { planText } });
          return;
        }
        if (command === "chat.plan.revise") {
          const planText = getPlanText(button.dataset.planId || "");
          vscode.postMessage({ type: "command", command, payload: { planText } });
          return;
        }
        if (command === "chat.restore") {
          vscode.postMessage({ type: "command", command });
          return;
        }
        if (command === "chat.header.toggle") {
          vscode.postMessage({ type: "command", command });
          return;
        }
        if (command === "chat.context.projectDetails" || command === "chat.context.docsDetails") {
          const popupKind = command === "chat.context.projectDetails" ? "project" : "docs";
          if (state.contextPopup === popupKind && !state.contextDetailsLoading) {
            state.contextPopup = null;
            state.contextDetails = null;
            render();
            return;
          }
          state.contextPopup = popupKind;
          state.contextDetails = null;
          state.contextDetailsLoading = true;
          closeMenus();
          render();
          vscode.postMessage({ type: "command", command });
          return;
        }
        if (command === "chat.model.toggle") {
          toggleMenu("model");
          loadModelsIfNeeded();
          return;
        }
        if (command === "chat.model.submenu.toggle") {
          state.openMenu = "model";
          state.openModelSubmenu = state.openModelSubmenu === "other" ? null : "other";
          render();
          loadModelsIfNeeded();
          return;
        }
        if (command === "chat.effort.toggle") {
          toggleMenu("effort");
          return;
        }
        if (command === "chat.speed.toggle") {
          toggleMenu("speed");
          return;
        }
        if (command === "chat.access.set") {
          closeMenus();
          vscode.postMessage({
            type: "command",
            command,
            payload: { accessMode: button.dataset.accessMode || "" }
          });
          return;
        }
        if (command === "chat.model.set") {
          closeMenus();
          vscode.postMessage({
            type: "command",
            command,
            payload: {
              modelId: button.dataset.modelId || null,
              modelLabel: button.dataset.modelLabel || ""
            }
          });
          return;
        }
        if (command === "chat.effort.set") {
          closeMenus();
          vscode.postMessage({
            type: "command",
            command,
            payload: { effort: button.dataset.effort || "" }
          });
          return;
        }
        if (command === "chat.speed.set") {
          closeMenus();
          vscode.postMessage({
            type: "command",
            command,
            payload: { speed: button.dataset.speed || "" }
          });
          return;
        }
        vscode.postMessage({ type: "command", command });
      });
    });

    const textarea = root.querySelector("[data-role='prompt-input']");
    if (textarea) {
      textarea.addEventListener("input", () => {
        setDraft(snapshot.chat.id, textarea.value);
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const send = root.querySelector("[data-command='chat.send']");
          if (send && !send.disabled) {
            send.click();
          }
        }
      });
    }
  }

  function composerFooter(snapshot) {
    return `
      <footer class="composer">
        <div class="composer-box">
          <textarea data-role="prompt-input" placeholder="Напишите задачу для Codex">${escapeHtml(getDraft(snapshot.chat.id))}</textarea>
          <div class="composer-actions${snapshot.chat.activeRunMode === "planning" ? " planning-active" : ""}">
            <div class="composer-left">
              ${accessSelector(snapshot.chat.accessMode)}
              ${planningSelector(snapshot)}
            </div>
            <div class="composer-right">
              ${modelSelector(snapshot)}
              ${effortSelector(snapshot.chat.effort)}
              ${speedSelector(snapshot.chat.speed)}
              <div class="chips">
                ${snapshot.chat.kind === "project" ? projectChips(snapshot) : `<span class="context-note">Без проектного контекста</span>`}
              </div>
              ${sendOrStopButton(snapshot.chat)}
            </div>
          </div>
        </div>
      </footer>
    `;
  }

  function archivedFooter() {
    return `
      <footer class="composer archived-composer">
        <div class="composer-box archived-composer-note">
          Диалог в архиве. <button class="inline-link" type="button" data-command="chat.restore">Восстановите его</button>, чтобы продолжить.
        </div>
      </footer>
    `;
  }

  function chatHeader(snapshot) {
    const mode = snapshot.chatHeaderMode === "expanded" ? "expanded" : "collapsed";
    const status = chatStatusPill(snapshot.chat);
    const toggle = headerToggle(mode);
    if (mode === "expanded") {
      return `
        <header class="header header-expanded">
          <div class="header-main">
            <div class="eyebrow">${escapeHtml(chatKindLabel(snapshot.chat.kind, "title"))}</div>
            <div class="title">${escapeHtml(snapshot.chat.title)}</div>
            <div class="meta">Auth: ${escapeHtml(snapshot.auth.accountLabel)} · ${escapeHtml(snapshot.runtime.label)}</div>
          </div>
          <div class="header-actions">
            ${status}
            ${toggle}
          </div>
        </header>
      `;
    }
    return `
      <header class="header header-collapsed">
        <div class="compact-title-line">
          <span class="compact-chat-title">${escapeHtml(snapshot.chat.title)}</span><span class="compact-separator">, </span><span class="compact-chat-kind">${escapeHtml(chatKindLabel(snapshot.chat.kind, "inline"))}</span>
        </div>
        <div class="header-actions">
          ${toggle}
        </div>
      </header>
    `;
  }

  function chatKindLabel(kind, variant) {
    if (kind === "project") {
      return variant === "inline" ? "проектный чат" : "Проектный чат";
    }
    return variant === "inline" ? "общий чат" : "Общий чат";
  }

  function chatStatusPill(chat) {
    return `<div class="chat-status-pill ${escapeAttribute(chatStatusClass(chat))}">${escapeHtml(chatStatusLabel(chat))}</div>`;
  }

  function chatStatusLabel(chat) {
    if (chat.archivedAt) return "АРХИВ";
    if (chat.status === "idle") return "ГОТОВ";
    if (chat.status === "running") return "ВЫПОЛНЯЕТСЯ";
    if (chat.status === "waitingApproval") return "ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ";
    if (chat.status === "cancelling") return "ОСТАНАВЛИВАЕТСЯ";
    if (chat.status === "error") return "ОШИБКА";
    return "ГОТОВ";
  }

  function chatStatusClass(chat) {
    if (chat.archivedAt) return "archived";
    if (chat.status === "running") return "running";
    if (chat.status === "waitingApproval") return "approval";
    if (chat.status === "cancelling") return "cancelling";
    if (chat.status === "error") return "error";
    return "idle";
  }

  function headerToggle(mode) {
    const expanded = mode === "expanded";
    return `
      <button class="header-toggle" type="button" data-command="chat.header.toggle" aria-label="${expanded ? "Свернуть шапку чата" : "Развернуть шапку чата"}" title="${expanded ? "Свернуть" : "Развернуть"}">
        ${expanded ? angleDownIcon() : angleRightIcon()}
      </button>
    `;
  }

  function angleDownIcon() {
    return `
      <svg class="header-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12,15.5c-.38,0-.76-.14-1.06-.44l-5.5-5.5c-.59-.59-.59-1.54,0-2.12s1.54-.59,2.12,0l4.44,4.44,4.44-4.44c.59-.59,1.54-.59,2.12,0s.59,1.54,0,2.12l-5.5,5.5c-.29,.29-.68,.44-1.06,.44Z"/>
      </svg>
    `;
  }

  function angleRightIcon() {
    return `
      <svg class="header-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M9.5,19c-.38,0-.76-.14-1.06-.44-.59-.59-.59-1.54,0-2.12l4.44-4.44-4.44-4.44c-.59-.59-.59-1.54,0-2.12s1.54-.59,2.12,0l5.5,5.5c.59,.59,.59,1.54,0,2.12l-5.5,5.5c-.29,.29-.68,.44-1.06,.44Z"/>
      </svg>
    `;
  }

  function capturePromptFocus(chatId) {
    const textarea = root.querySelector("[data-role='prompt-input']");
    if (!textarea || document.activeElement !== textarea) {
      return { chatId, focused: false, selectionStart: 0, selectionEnd: 0 };
    }
    setDraft(chatId, textarea.value);
    return {
      chatId,
      focused: true,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd
    };
  }

  function restorePromptFocus(focusState, chatId) {
    if (!focusState || !focusState.focused || focusState.chatId !== chatId) {
      return;
    }
    const textarea = root.querySelector("[data-role='prompt-input']");
    if (!textarea) {
      return;
    }
    textarea.focus();
    const start = Math.min(focusState.selectionStart, textarea.value.length);
    const end = Math.min(focusState.selectionEnd, textarea.value.length);
    textarea.setSelectionRange(start, end);
  }

  function getDraft(chatId) {
    return state.drafts[chatId] || "";
  }

  function setDraft(chatId, value) {
    if (!chatId) {
      return;
    }
    if (value) {
      state.drafts[chatId] = value;
    } else {
      delete state.drafts[chatId];
    }
  }

  function isPlanningArmed(chatId) {
    return Boolean(chatId && state.planningArmedByChat[chatId]);
  }

  function setPlanningArmed(chatId, value) {
    if (!chatId) {
      return;
    }
    if (value) {
      state.planningArmedByChat[chatId] = true;
    } else {
      delete state.planningArmedByChat[chatId];
    }
  }

  function getPlanText(planId) {
    const snapshot = state.snapshot;
    if (!snapshot || !Array.isArray(snapshot.transcript)) {
      return "";
    }
    const item = snapshot.transcript.find((candidate) => candidate.id === planId);
    if (!item) {
      return "";
    }
    return extractPlan(item.text)?.plan || "";
  }

  function toggleMenu(menu) {
    state.openMenu = state.openMenu === menu ? null : menu;
    if (state.openMenu !== "model") {
      state.openModelSubmenu = null;
    }
    render();
  }

  function closeMenus() {
    state.openMenu = null;
    state.openModelSubmenu = null;
  }

  function loadModelsIfNeeded() {
    if (
      state.snapshot &&
      state.snapshot.modelOptionsStatus !== "ready" &&
      state.snapshot.modelOptionsStatus !== "loading"
    ) {
      vscode.postMessage({ type: "command", command: "chat.models.load" });
    }
  }

  function projectChips(snapshot) {
    const project = snapshot.projectContext || { status: "notIndexed", label: "Проектный контекст будет собран при отправке" };
    const docs = snapshot.docs || { status: "notConfigured", label: "Документация не настроена" };
    const rules = snapshot.rulesContext || { status: snapshot.chat.rulesEnabled === false ? "disabled" : "missing", label: "Файл .local-codex/rules.md не найден" };
    const projectActive = project.status === "active" || project.status === "indexing";
    const docsActive = docs.status === "configured";
    return `
      ${contextIconChip({
        title: project.label,
        label: projectActive ? "Контекст проекта включен" : "Контекст проекта выключен",
        state: project.status === "error" ? "error" : projectActive ? "active" : "muted",
        icon: projectActive ? folderOpenRegIcon() : folderOpenIcon(),
        command: "chat.context.projectDetails"
      })}
      ${contextIconChip({
        title: docs.label,
        label: docsActive ? "Документация включена" : "Документация выключена",
        state: docs.status === "error" ? "error" : docsActive ? "active" : "muted",
        icon: docsActive ? bookBookmarkRegIcon() : bookBookmarkIcon(),
        command: "chat.context.docsDetails"
      })}
      ${rulesContextChip(rules)}
      ${contextDetailsPopup()}
    `;
  }

  function contextIconChip(options) {
    return `
      <button class="context-chip context-chip-button ${escapeAttribute(options.state)}" type="button" data-command="${escapeAttribute(options.command)}" title="${escapeAttribute(options.title)}" aria-label="${escapeAttribute(options.label)}">
        ${options.icon}
      </button>
    `;
  }

  function contextDetailsPopup() {
    if (!state.contextPopup) {
      return "";
    }
    const title = state.contextPopup === "project" ? "Проектный контекст" : "Документация";
    const details = state.contextDetails && state.contextDetails.kind === state.contextPopup ? state.contextDetails : undefined;
    return `
      <div class="context-details-popover" role="dialog" aria-label="${escapeAttribute(title)}">
        ${state.contextDetailsLoading ? contextDetailsLoading(title) : contextDetailsBody(state.contextPopup, details)}
      </div>
    `;
  }

  function contextDetailsLoading(title) {
    return `
      <div class="context-details-title">${escapeHtml(title)}</div>
      <div class="context-details-empty">Загрузка...</div>
    `;
  }

  function contextDetailsBody(kind, details) {
    if (!details) {
      return `
        <div class="context-details-title">${kind === "project" ? "Проектный контекст" : "Документация"}</div>
        <div class="context-details-empty">Подробности недоступны.</div>
      `;
    }
    return kind === "project" ? projectDetailsBody(details) : docsDetailsBody(details);
  }

  function projectDetailsBody(details) {
    const files = Array.isArray(details.files) ? details.files : [];
    return `
      <div class="context-details-title">Проектный контекст</div>
      <div class="context-details-row"><span>Статус</span><strong>${escapeHtml(details.label || statusLabel(details.status))}</strong></div>
      ${details.workspaceRoot ? `<div class="context-details-row"><span>Workspace</span><code>${escapeHtml(details.workspaceRoot)}</code></div>` : ""}
      ${details.indexPath ? `<div class="context-details-row"><span>Индекс</span><code>${escapeHtml(details.indexPath)}</code></div>` : ""}
      ${details.updatedAt ? `<div class="context-details-row"><span>Обновлен</span><span>${escapeHtml(formatDetailsDate(details.updatedAt))}</span></div>` : ""}
      ${details.error ? `<div class="context-details-error">${escapeHtml(details.error)}</div>` : ""}
      <div class="context-details-subtitle">Индексированные файлы (${Number(details.count || files.length)})</div>
      ${files.length ? `
        <div class="context-file-list">
          ${files.map((file) => `<div class="context-file-item">${escapeHtml(file)}</div>`).join("")}
        </div>
      ` : `<div class="context-details-empty">${escapeHtml(projectDetailsEmptyText(details))}</div>`}
    `;
  }

  function projectDetailsEmptyText(details) {
    return details.status === "notIndexed"
      ? "Индекс проекта еще не собран. Он будет создан при первом проектном запросе."
      : "В индексе проекта пока нет файлов.";
  }

  function docsDetailsBody(details) {
    const sourceLabel = details.source === "normalized" ? "Нормализованная документация" : "Документация не используется";
    return `
      <div class="context-details-title">Документация</div>
      <div class="context-details-row"><span>Источник</span><strong>${escapeHtml(sourceLabel)}</strong></div>
      ${details.normalizedPath ? `<div class="context-details-row"><span>Каталог</span><code>${escapeHtml(details.normalizedPath)}</code></div>` : ""}
      ${details.indexPath ? `<div class="context-details-row"><span>Индекс</span><code>${escapeHtml(details.indexPath)}</code></div>` : ""}
      ${details.error ? `<div class="context-details-error">${escapeHtml(details.error)}</div>` : ""}
    `;
  }

  function statusLabel(status) {
    if (status === "active" || status === "configured") return "Активен";
    if (status === "indexing") return "Индексируется";
    if (status === "error") return "Ошибка";
    if (status === "disabled") return "Отключен";
    return "Не собран";
  }

  function formatDetailsDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function rulesContextChip(rules) {
    const missing = rules.status === "missing";
    const active = rules.status === "active";
    const error = rules.status === "error";
    const command = missing ? "chat.rules.open" : "chat.rules.toggle";
    const label = missing
      ? "Правила отсутствуют. Нажмите, чтобы создать файл правил проекта."
      : active
        ? "Правила включены"
        : error
          ? "Ошибка правил проекта"
          : "Правила выключены";
    const state = missing ? "warning" : error ? "error" : active ? "active" : "muted";
    return `
      <button class="context-chip context-chip-button ${state}" type="button" data-command="${command}" title="${escapeAttribute(rules.label)}" aria-label="${escapeAttribute(label)}">
        ${active ? documentRegIcon() : documentIcon()}
      </button>
    `;
  }

  function sendOrStopButton(chat) {
    const cancellable = chat.status === "running" || chat.status === "waitingApproval" || chat.status === "cancelling";
    if (!cancellable) {
      return `<button class="button" data-command="chat.send">Отправить</button>`;
    }
    const stopping = chat.status === "cancelling";
    return `
      <button class="button stop-button" data-command="chat.cancel" ${stopping ? "disabled" : ""}>
        ${stopping ? "Останавливаем..." : "Остановить"}
      </button>
    `;
  }

  function accessSelector(accessMode) {
    const modes = [
      { value: "read-only", label: "Только чтение", icon: lockIcon },
      { value: "workspace-write", label: "Подтверждение", icon: shieldIcon },
      { value: "danger-full-access", label: "Полный доступ", icon: unlockIcon }
    ];
    const active = modes.find((mode) => mode.value === accessMode) || modes[0];
    const danger = active.value === "danger-full-access";
    return `
      <div class="access-selector composer-selector${danger ? " danger" : ""}${state.openMenu === "access" ? " open" : ""}">
        <button class="selector-trigger access-trigger" type="button" data-command="chat.access.toggle" aria-label="Режим доступа" aria-haspopup="menu">
          ${active.icon()}
          <span>${escapeHtml(active.label)}</span>
        </button>
        <div class="selector-menu access-menu" role="menu">
          ${modes.map((mode) => `
            <button class="selector-option access-option${mode.value === active.value ? " selected" : ""}${mode.value === "danger-full-access" ? " danger" : ""}" type="button" data-command="chat.access.set" data-access-mode="${escapeAttribute(mode.value)}" role="menuitem">
              ${mode.icon()}
              <span>${escapeHtml(mode.label)}</span>
              ${mode.value === active.value ? `<span class="access-check">✓</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function planningSelector(snapshot) {
    const armed = isPlanningArmed(snapshot.chat.id);
    const running = snapshot.chat.status === "running" && snapshot.chat.activeRunMode === "planning";
    const label = running ? "Планируется" : "План";
    return `
      <button class="planning-toggle${armed ? " armed" : ""}${running ? " running" : ""}" type="button" data-command="chat.planning.toggle" title="Режим планирования для следующей отправки">
        <span class="planning-dot"></span>
        <span>${escapeHtml(label)}</span>
      </button>
    `;
  }

  function modelSelector(snapshot) {
    const options = modelOptions(snapshot);
    const topModels = [
      { id: null, label: "5.5", displayLabel: "GPT-5.5", icon: true },
      { id: "gpt-5.4", label: "GPT-5.4", displayLabel: "GPT-5.4", icon: true }
    ];
    const otherModels = otherModelOptions(options);
    const activeLabel = snapshot.chat.modelLabel || "5.5";
    return `
      <div class="model-selector composer-selector${state.openMenu === "model" ? " open" : ""}">
        <button class="selector-trigger model-trigger" type="button" data-command="chat.model.toggle" aria-label="Модель" aria-haspopup="menu">
          <span>${escapeHtml(shortModelLabel(activeLabel))}</span>
        </button>
        <div class="selector-menu model-menu" role="menu">
          <div class="selector-menu-title">Модель</div>
          ${topModels.map((option) => {
            const selected = isModelSelected(snapshot.chat, option);
            return `
              <button class="selector-option model-option${selected ? " selected" : ""}" type="button" data-command="chat.model.set" data-model-id="${escapeAttribute(option.id || "")}" data-model-label="${escapeAttribute(option.label)}" role="menuitem">
                ${boltIcon()}
                <span>${escapeHtml(option.displayLabel)}</span>
                ${selected ? `<span class="access-check">✓</span>` : ""}
              </button>
            `;
          }).join("")}
          <button class="selector-option model-option submenu-option${state.openModelSubmenu === "other" ? " selected" : ""}" type="button" data-command="chat.model.submenu.toggle" role="menuitem" aria-haspopup="menu">
            <span>Другие модели</span>
            <span class="submenu-chevron">›</span>
          </button>
          ${snapshot.modelOptionsStatus === "loading" ? `<div class="selector-hint">Загружаем список моделей...</div>` : ""}
          ${state.openModelSubmenu === "other" ? `
            <div class="selector-submenu model-submenu" role="menu">
              ${otherModels.map((option) => {
                const selected = isModelSelected(snapshot.chat, option);
                return `
                  <button class="selector-option model-option${selected ? " selected" : ""}" type="button" data-command="chat.model.set" data-model-id="${escapeAttribute(option.id || "")}" data-model-label="${escapeAttribute(option.label)}" role="menuitem">
                    <span>${escapeHtml(option.displayLabel || option.label)}</span>
                    ${selected ? `<span class="access-check">✓</span>` : ""}
                  </button>
                `;
              }).join("")}
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }

  function effortSelector(effort) {
    const options = [
      { value: "low", label: "Низкий" },
      { value: "medium", label: "Средний" },
      { value: "high", label: "Высокий" },
      { value: "xhigh", label: "Очень высокий" }
    ];
    const active = options.find((option) => option.value === effort) || options[1];
    return `
      <div class="effort-selector composer-selector${state.openMenu === "effort" ? " open" : ""}">
        <button class="selector-trigger effort-trigger" type="button" data-command="chat.effort.toggle" aria-label="Интеллект" aria-haspopup="menu">
          <span>${escapeHtml(active.label)}</span>
        </button>
        <div class="selector-menu effort-menu" role="menu">
          <div class="selector-menu-title">Интеллект</div>
          ${options.map((option) => `
            <button class="selector-option effort-option${option.value === active.value ? " selected" : ""}" type="button" data-command="chat.effort.set" data-effort="${escapeAttribute(option.value)}" role="menuitem">
              <span>${escapeHtml(option.label)}</span>
              ${option.value === active.value ? `<span class="access-check">✓</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function speedSelector(speed) {
    const options = [
      { value: "standard", label: "Стандартный", displayLabel: "Стандартный", description: "Стандартная скорость, обычный расход" },
      { value: "fast", label: "Быстрый", displayLabel: "x1.5", description: "Скорость 1,5x, повышенный расход" }
    ];
    const active = options.find((option) => option.value === speed) || options[0];
    return `
      <div class="speed-selector composer-selector${state.openMenu === "speed" ? " open" : ""}">
        <button class="selector-trigger speed-trigger" type="button" data-command="chat.speed.toggle" aria-label="Скорость" aria-haspopup="menu">
          <span>${escapeHtml(active.displayLabel)}</span>
        </button>
        <div class="selector-menu speed-menu" role="menu">
          <div class="selector-menu-title">Скорость</div>
          ${options.map((option) => `
            <button class="selector-option speed-option${option.value === active.value ? " selected" : ""}" type="button" data-command="chat.speed.set" data-speed="${escapeAttribute(option.value)}" role="menuitem">
              <span class="speed-option-text">
                <span>${escapeHtml(option.label)}</span>
                <span class="speed-option-description">${escapeHtml(option.description)}</span>
              </span>
              ${option.value === active.value ? `<span class="access-check">✓</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function modelOptions(snapshot) {
    return Array.isArray(snapshot.modelOptions) && snapshot.modelOptions.length
      ? snapshot.modelOptions
      : [
        { id: null, label: "5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
        { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
        { id: "gpt-5.2", label: "GPT-5.2" }
      ];
  }

  function otherModelOptions(options) {
    const known = [
      { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
      { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
      { id: "gpt-5.2", label: "GPT-5.2" }
    ];
    const merged = [...options, ...known];
    const seen = new Set();
    return merged
      .filter((option) => {
        const label = option.label || "";
        const id = option.id || "";
        const short = shortModelLabel(label).toLowerCase();
        if (!id && (short === "5.5" || label.toLowerCase() === "авто")) {
          return false;
        }
        if (id.toLowerCase() === "gpt-5.5" || id.toLowerCase() === "gpt-5.4" || short === "5.5" || short === "5.4") {
          return false;
        }
        const key = id || label;
        if (!key || seen.has(key.toLowerCase())) {
          return false;
        }
        seen.add(key.toLowerCase());
        return true;
      })
      .map((option) => ({ ...option, displayLabel: option.label }));
  }

  function isModelSelected(chat, option) {
    const chatId = chat.modelId || "";
    const optionId = option.id || "";
    const chatShort = shortModelLabel(chat.modelLabel || "").toLowerCase();
    const optionShort = shortModelLabel(option.label || "").toLowerCase();
    if (optionShort === "5.5" && (chatShort === "5.5" || chatId.toLowerCase() === "gpt-5.5")) {
      return true;
    }
    if (optionShort === "5.4" && (chatShort === "5.4" || chatId.toLowerCase() === "gpt-5.4")) {
      return true;
    }
    if (chatId || optionId) {
      return chatId === optionId;
    }
    return chatShort === optionShort;
  }

  function shortModelLabel(label) {
    return label
      .replace(/^GPT-/i, "")
      .replace(/^gpt-/i, "")
      .replace(/ Codex$/i, " Codex");
  }

  function boltIcon() {
    return `
      <svg class="selector-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M13.18 2.03 4.41 13.08A1 1 0 0 0 5.2 14.7h5.36l-1.72 6.07a1 1 0 0 0 1.74.9l8.98-11.43A1 1 0 0 0 18.77 8.6h-5.42l1.55-5.72a1 1 0 0 0-1.72-.85Z"/>
      </svg>
    `;
  }

  function lockIcon() {
    return `
      <svg class="access-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M19,8.276v-1.276c0-3.86-3.141-7-7-7S5,3.14,5,7v1.276c-1.742,.621-3,2.271-3,4.224v7c0,2.481,2.019,4.5,4.5,4.5h11c2.481,0,4.5-2.019,4.5-4.5v-7c0-1.953-1.258-3.602-3-4.224Zm-13-1.276c0-3.309,2.691-6,6-6s6,2.691,6,6v1.051c-.166-.019-.329-.051-.5-.051H6.5c-.171,0-.334,.032-.5,.051v-1.051Zm15,12.5c0,1.93-1.57,3.5-3.5,3.5H6.5c-1.93,0-3.5-1.57-3.5-3.5v-7c0-1.93,1.57-3.5,3.5-3.5h11c1.93,0,3.5,1.57,3.5,3.5v7Zm-8.5-5v3c0,.276-.224,.5-.5,.5s-.5-.224-.5-.5v-3c0-.276,.224-.5,.5-.5s.5,.224,.5,.5Z"/>
      </svg>
    `;
  }

  function shieldIcon() {
    return `
      <svg class="access-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12,24c-.077,0-.153-.018-.224-.053l-.425-.212c-2.194-1.098-9.354-5.191-9.354-11.8l.002-5.346c0-1.943,1.239-3.66,3.084-4.271L11.843,.077c.102-.034,.213-.034,.314,0l6.759,2.241c1.845,.612,3.084,2.329,3.084,4.271l-.002,5.346c0,7.499-7.172,10.967-9.37,11.852l-.441,.177c-.06,.024-.124,.036-.187,.036ZM12,1.078L5.398,3.267c-1.435,.476-2.398,1.811-2.398,3.322l-.002,5.346c0,6.035,6.736,9.874,8.801,10.906l.224,.112,.232-.093c2.051-.825,8.743-4.053,8.743-10.924l.002-5.346c0-1.511-.964-2.846-2.398-3.322L12,1.078Z"/>
      </svg>
    `;
  }

  function unlockIcon() {
    return `
      <svg class="access-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M17.5,8H6.5c-.171,0-.334,.032-.5,.051v-1.051c0-3.309,2.691-6,6-6,2.245,0,4.285,1.238,5.324,3.231,.127,.246,.431,.339,.675,.212,.244-.127,.34-.43,.212-.674-1.212-2.325-3.592-3.769-6.211-3.769-3.859,0-7,3.14-7,7v1.276c-1.742,.621-3,2.271-3,4.224v7c0,2.481,2.019,4.5,4.5,4.5h11c2.481,0,4.5-2.019,4.5-4.5v-7c0-2.481-2.019-4.5-4.5-4.5Zm3.5,11.5c0,1.93-1.57,3.5-3.5,3.5H6.5c-1.93,0-3.5-1.57-3.5-3.5v-7c0-1.93,1.57-3.5,3.5-3.5h11c1.93,0,3.5,1.57,3.5,3.5v7Zm-8.5-5v3c0,.276-.224,.5-.5,.5s-.5-.224-.5-.5v-3c0-.276,.224-.5,.5-.5s.5,.224,.5,.5Z"/>
      </svg>
    `;
  }

  function folderOpenRegIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m23.493,11.017c-.487-.654-1.234-1.03-2.05-1.03h-.443v-1.987c0-2.757-2.243-5-5-5h-5.056c-.154,0-.31-.037-.447-.105l-3.155-1.578c-.414-.207-.878-.316-1.342-.316h-2C1.794,1,0,2.794,0,5v13c0,2.757,2.243,5,5,5h12.558c2.226,0,4.15-1.432,4.802-3.607l1.532-6.116c.234-.782.089-1.605-.398-2.26ZM2,18V5c0-1.103.897-2,2-2h2c.154,0,.31.037.447.105l3.155,1.578c.414.207.878.316,1.342.316h5.056c1.654,0,3,1.346,3,3v1.987h-10.385c-1.7,0-3.218,1.079-3.789,2.72l-2.19,7.138c-.398-.509-.636-1.15-.636-1.845Zm19.964-5.253l-1.532,6.115c-.384,1.279-1.539,2.138-2.874,2.138H5c-.208,0-.411-.021-.607-.062l2.334-7.609c.279-.803,1.039-1.342,1.889-1.342h12.828c.242,0,.383.14.445.224.062.084.156.259.075.536Z"/>
      </svg>
    `;
  }

  function folderOpenIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m23.596,11.827c-.391-.525-.993-.827-1.652-.827h-.943v-3.5c0-2.481-2.019-4.5-4.5-4.5h-6.056c-.232,0-.464-.055-.671-.158l-3.155-1.578c-.345-.172-.731-.264-1.118-.264h-2C1.57,1,0,2.57,0,4.5v14c0,2.481,2.019,4.5,4.5,4.5h13.558c2.003,0,3.735-1.289,4.317-3.229l1.537-6.138c.188-.626.072-1.285-.316-1.807ZM1,18.5V4.5c0-1.378,1.121-2.5,2.5-2.5h2c.232,0,.464.055.671.158l3.155,1.578c.345.172.731.264,1.118.264h6.056c1.93,0,3.5,1.57,3.5,3.5v3.5h-11.885c-1.49,0-2.818.938-3.311,2.354l-2.433,7.924c-.834-.64-1.372-1.647-1.372-2.777Zm21.948-5.132l-1.537,6.138c-.448,1.492-1.796,2.494-3.354,2.494H4.5c-.435,0-.851-.08-1.234-.225l2.489-8.111c.347-.996,1.295-1.665,2.36-1.665h13.828c.34,0,.649.154.851.424.198.266.257.603.154.944Z"/>
      </svg>
    `;
  }

  function bookBookmarkRegIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M17,0H7C4.243,0,2,2.243,2,5v15c0,2.206,1.794,4,4,4h11c2.757,0,5-2.243,5-5V5c0-2.757-2.243-5-5-5Zm3,5v11H8V2h4V10.347c0,.623,.791,.89,1.169,.395l1.331-1.743,1.331,1.743c.378,.495,1.169,.228,1.169-.395V2c1.654,0,3,1.346,3,3ZM6,2.184v13.816c-.732,0-1.409,.212-2,.556V5c0-1.302,.839-2.402,2-2.816Zm11,19.816H6c-2.629-.047-2.627-3.954,0-4h14v1c0,1.654-1.346,3-3,3Z"/>
      </svg>
    `;
  }

  function bookBookmarkIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M17.5,0H6.5C4.019,0,2,2.019,2,4.5V20.5c0,1.93,1.57,3.5,3.5,3.5h12c2.481,0,4.5-2.019,4.5-4.5V4.5c0-2.481-2.019-4.5-4.5-4.5Zm3.5,4.5v12.5H7V1h5V9.848c0,.502,.307,.93,.782,1.091,.476,.16,.979,.007,1.284-.392l.934-1.223,.934,1.223c.306,.402,.82,.551,1.284,.392,.475-.161,.782-.589,.782-1.091V1.036c1.694,.243,3,1.704,3,3.464ZM13,1h4V9.848c0,.09-.056,.127-.103,.144-.046,.015-.114,.02-.168-.051l-1.331-1.743c-.189-.248-.605-.248-.795,0l-1.331,1.743c-.056,.072-.123,.067-.168,.052-.047-.016-.103-.054-.103-.144V1ZM3,4.5c0-1.76,1.306-3.221,3-3.464v15.964h-.5c-.978,0-1.864,.404-2.5,1.053V4.5Zm14.5,18.5H5.5c-3.286-.059-3.284-4.942,0-5h15.5v1.5c0,1.93-1.57,3.5-3.5,3.5Z"/>
      </svg>
    `;
  }

  function documentRegIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m17 14a1 1 0 0 1 -1 1h-8a1 1 0 0 1 0-2h8a1 1 0 0 1 1 1zm-4 3h-5a1 1 0 0 0 0 2h5a1 1 0 0 0 0-2zm9-6.515v8.515a5.006 5.006 0 0 1 -5 5h-10a5.006 5.006 0 0 1 -5-5v-14a5.006 5.006 0 0 1 5-5h4.515a6.958 6.958 0 0 1 4.95 2.05l3.484 3.486a6.951 6.951 0 0 1 2.051 4.949zm-6.949-7.021a5.01 5.01 0 0 0 -1.051-.78v4.316a1 1 0 0 0 1 1h4.316a4.983 4.983 0 0 0 -.781-1.05zm4.949 7.021c0-.165-.032-.323-.047-.485h-4.953a3 3 0 0 1 -3-3v-4.953c-.162-.015-.321-.047-.485-.047h-4.515a3 3 0 0 0 -3 3v14a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3z"/>
      </svg>
    `;
  }

  function documentIcon() {
    return `
      <svg class="context-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m17,13.5c0,.276-.224,.5-.5,.5H7.5c-.276,0-.5-.224-.5-.5s.224-.5,.5-.5h9c.276,0,.5,.224,.5,.5Zm-3.5,3.5h-6c-.276,0-.5,.224-.5,.5s.224,.5,.5,.5h6c.276,0,.5-.224,.5-.5s-.224-.5-.5-.5Zm8.5-7.015v9.515c0,2.481-2.019,4.5-4.5,4.5H6.5c-2.481,0-4.5-2.019-4.5-4.5V4.5C2,2.019,4.019,0,6.5,0h5.515c1.735,0,3.368,.676,4.597,1.904l3.484,3.485c1.228,1.227,1.904,2.859,1.904,4.596Zm-6.096-7.375c-.551-.55-1.2-.959-1.904-1.231v5.12c0,.827,.673,1.5,1.5,1.5h5.121c-.273-.704-.682-1.354-1.232-1.904l-3.484-3.485Zm5.096,7.375c0-.335-.038-.663-.096-.985h-5.404c-1.379,0-2.5-1.122-2.5-2.5V1.096c-.323-.058-.651-.096-.985-.096h-5.515c-1.93,0-3.5,1.57-3.5,3.5v15c0,1.93,1.57,3.5,3.5,3.5h11c1.93,0,3.5-1.57,3.5-3.5v-9.515Z"/>
      </svg>
    `;
  }

  function message(item) {
    const plan = item.role === "assistant" ? extractPlan(item.text) : undefined;
    if (plan) {
      return `
        <article class="message plan-message">
          <div class="plan-card">
            <div class="plan-kicker">План</div>
            <div class="plan-text">${escapeHtml(plan.plan)}</div>
            <div class="plan-actions">
              <button class="button secondary" data-command="chat.plan.revise" data-plan-id="${escapeAttribute(item.id)}">Изменить</button>
              <button class="button" data-command="chat.plan.implement" data-plan-id="${escapeAttribute(item.id)}">Реализовать</button>
            </div>
          </div>
        </article>
      `;
    }
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
            <button class="button stop-button" data-command="chat.cancel">Остановить</button>
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

  function extractPlan(text) {
    const value = String(text || "");
    const full = value.match(/<codex_plan>\s*([\s\S]*?)\s*<\/codex_plan>/i);
    if (full && full[1] && full[1].trim()) {
      return { plan: full[1].trim() };
    }

    const open = value.toLowerCase().indexOf("<codex_plan>");
    if (open < 0) {
      return undefined;
    }
    const partial = value.slice(open + "<codex_plan>".length).replace(/<\/codex_plan>\s*$/i, "").trim();
    return { plan: partial || "Codex готовит план..." };
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
