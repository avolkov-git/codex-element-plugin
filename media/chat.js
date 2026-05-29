(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const TRANSCRIPT_INITIAL_WINDOW_SIZE = 40;
  const TRANSCRIPT_PAGE_SIZE = 20;
  const TRANSCRIPT_MAX_RENDERED_ITEMS = 40;
  const TRANSCRIPT_LOAD_THRESHOLD = 280;
  const state = {
    snapshot: undefined,
    transcriptWindow: undefined,
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
    planningArmedByChat: Object.create(null),
    expandedDiffFiles: Object.create(null),
    expandedActivities: Object.create(null),
    expandedWorklogs: Object.create(null),
    expandedTurnRuns: Object.create(null),
    liveDurationTimer: 0,
    showScrollToBottom: false,
    loadingBefore: false,
    loadingAfter: false,
    pendingScrollAnchor: null,
    scrollToBottomAfterWindow: false,
    lastTranscriptUserNavigationAt: 0,
    lastTranscriptNavigationDirection: "both",
    lastTranscriptStructureSignature: "",
    lastChromeSignature: "",
    allowStreamingPatch: false
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
      state.showScrollToBottom = false;
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
      const previousChatId = state.snapshot && state.snapshot.chat ? state.snapshot.chat.id : "";
      state.snapshot = message.snapshot || undefined;
      syncTranscriptWindowFromSnapshot(previousChatId);
      if (state.snapshot && state.snapshot.chat) {
        vscode.setState({ activeChatId: state.snapshot.chat.id });
      }
      state.allowStreamingPatch = true;
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
    if (message.type === "event" && message.event === "chat.transcript.window") {
      applyTranscriptWindowEvent(message.payload || {});
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

  function syncTranscriptWindowFromSnapshot(previousChatId) {
    const snapshot = state.snapshot;
    if (!snapshot || !snapshot.chat) {
      state.transcriptWindow = undefined;
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingScrollAnchor = null;
      state.scrollToBottomAfterWindow = false;
      return;
    }

    const incoming = normalizeTranscriptWindow(snapshot.transcriptWindow || windowFromLegacyTranscript(snapshot.transcript));
    const chatChanged = previousChatId !== snapshot.chat.id;
    if (chatChanged || !state.transcriptWindow) {
      state.transcriptWindow = incoming;
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingScrollAnchor = null;
      state.scrollToBottomAfterWindow = false;
      return;
    }

    if (!state.stickToBottom || state.transcriptWindow.hasAfter) {
      const currentEnd = (state.transcriptWindow.offset || 0) + (state.transcriptWindow.items?.length || 0);
      const incomingTotal = incoming.totalCount || 0;
      const hasNewerData = incoming.hasAfter || incomingTotal > currentEnd || incoming.lastItemId !== state.transcriptWindow.lastItemId;
      state.transcriptWindow = {
        ...state.transcriptWindow,
        totalCount: Math.max(state.transcriptWindow.totalCount || 0, incomingTotal),
        hasAfter: Boolean(state.transcriptWindow.hasAfter || hasNewerData)
      };
      return;
    }

    state.transcriptWindow = incoming;
    state.loadingBefore = false;
    state.loadingAfter = false;
  }

  function applyTranscriptWindowEvent(payload) {
    const mode = payload.mode || "tail";
    const incoming = normalizeTranscriptWindow(payload.window);
    if (!state.snapshot || !state.snapshot.chat) {
      return;
    }

    if (mode === "tail" || !state.transcriptWindow) {
      state.transcriptWindow = incoming;
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingScrollAnchor = null;
      state.scrollToBottomAfterWindow = mode === "tail";
      state.stickToBottom = true;
      state.showScrollToBottom = false;
      return;
    }

    if (mode === "before") {
      state.transcriptWindow = mergeTranscriptBefore(state.transcriptWindow, incoming);
      state.loadingBefore = false;
      return;
    }

    if (mode === "after") {
      state.transcriptWindow = mergeTranscriptAfter(state.transcriptWindow, incoming);
      state.loadingAfter = false;
    }
  }

  function normalizeTranscriptWindow(raw) {
    let items = Array.isArray(raw && raw.items) ? raw.items.filter(Boolean) : [];
    let offset = typeof raw?.offset === "number" && Number.isFinite(raw.offset) ? Math.max(0, raw.offset) : 0;
    if (items.length > TRANSCRIPT_MAX_RENDERED_ITEMS) {
      const removeCount = items.length - TRANSCRIPT_MAX_RENDERED_ITEMS;
      items = items.slice(removeCount);
      offset += removeCount;
    }
    const firstItemId = raw && typeof raw.firstItemId === "string" ? raw.firstItemId : items[0]?.id;
    const lastItemId = raw && typeof raw.lastItemId === "string" ? raw.lastItemId : items[items.length - 1]?.id;
    return {
      items,
      offset,
      totalCount: typeof raw?.totalCount === "number" && Number.isFinite(raw.totalCount) ? Math.max(0, raw.totalCount) : items.length,
      hasBefore: Boolean(raw?.hasBefore) || offset > 0,
      hasAfter: Boolean(raw?.hasAfter),
      firstItemId,
      lastItemId
    };
  }

  function windowFromLegacyTranscript(transcript) {
    const allItems = Array.isArray(transcript) ? transcript : [];
    const offset = Math.max(0, allItems.length - TRANSCRIPT_INITIAL_WINDOW_SIZE);
    const items = allItems.slice(offset);
    return {
      items,
      offset,
      totalCount: allItems.length,
      hasBefore: offset > 0,
      hasAfter: false,
      firstItemId: items[0]?.id,
      lastItemId: items[items.length - 1]?.id
    };
  }

  function mergeTranscriptBefore(current, incoming) {
    const currentItems = Array.isArray(current.items) ? current.items : [];
    const known = new Set(currentItems.map((item) => item.id));
    const incomingItems = (incoming.items || []).filter((item) => item && !known.has(item.id));
    let items = [...incomingItems, ...currentItems];
    let offset = incoming.offset || 0;
    let hasBefore = incoming.hasBefore;
    let hasAfter = current.hasAfter;
    if (items.length > TRANSCRIPT_MAX_RENDERED_ITEMS) {
      items = items.slice(0, TRANSCRIPT_MAX_RENDERED_ITEMS);
      hasAfter = true;
    }
    return buildClientTranscriptWindow(items, offset, Math.max(current.totalCount || 0, incoming.totalCount || 0), hasBefore, hasAfter);
  }

  function mergeTranscriptAfter(current, incoming) {
    const currentItems = Array.isArray(current.items) ? current.items : [];
    const known = new Set(currentItems.map((item) => item.id));
    const incomingItems = (incoming.items || []).filter((item) => item && !known.has(item.id));
    let items = [...currentItems, ...incomingItems];
    let offset = current.offset || 0;
    let hasBefore = current.hasBefore;
    let hasAfter = incoming.hasAfter;
    if (items.length > TRANSCRIPT_MAX_RENDERED_ITEMS) {
      const removeCount = items.length - TRANSCRIPT_MAX_RENDERED_ITEMS;
      items = items.slice(removeCount);
      offset += removeCount;
      hasBefore = true;
    }
    return buildClientTranscriptWindow(items, offset, Math.max(current.totalCount || 0, incoming.totalCount || 0), hasBefore, hasAfter);
  }

  function buildClientTranscriptWindow(items, offset, totalCount, hasBefore, hasAfter) {
    return {
      items,
      offset,
      totalCount,
      hasBefore,
      hasAfter,
      firstItemId: items[0]?.id,
      lastItemId: items[items.length - 1]?.id
    };
  }

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
      state.allowStreamingPatch = false;
      syncLiveDurationTimer();
      return;
    }

    const previousChatId = state.renderedChatId || snapshot.chat.id;
    const focusState = capturePromptFocus(previousChatId);
    const previousBody = root.querySelector("[data-role='transcript']");
    const previousScrollTop = previousBody ? previousBody.scrollTop : 0;
    const previousWasNearBottom = previousBody ? isAtTranscriptTail(previousBody) : true;
    const previousAnchor = captureTranscriptAnchor(previousBody);
    if (state.renderedChatId !== snapshot.chat.id) {
      state.renderedChatId = snapshot.chat.id;
      state.hasRenderedCurrentChat = false;
      state.lastReadSignal = "";
      state.lastTranscriptSignature = "";
      state.notice = "";
      state.stickToBottom = !snapshot.chat.hasUnread;
      state.transcriptWindow = normalizeTranscriptWindow(snapshot.transcriptWindow || windowFromLegacyTranscript(snapshot.transcript));
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingScrollAnchor = null;
      state.scrollToBottomAfterWindow = false;
      state.openMenu = null;
      state.openModelSubmenu = null;
      state.contextPopup = null;
      state.contextDetails = null;
      state.contextDetailsLoading = false;
      state.lastTranscriptStructureSignature = "";
      state.lastChromeSignature = "";
    }
    const currentChromeSignature = chatChromeSignature(snapshot);
    const currentTranscriptStructureSignature = transcriptStructureSignature(snapshot);
    if (
      state.hasRenderedCurrentChat
      && state.renderedChatId === snapshot.chat.id
      && state.allowStreamingPatch
      && currentChromeSignature === state.lastChromeSignature
      && currentTranscriptStructureSignature === state.lastTranscriptStructureSignature
      && tryPatchStreamingTranscript(snapshot)
    ) {
      state.lastTranscriptSignature = transcriptSignature(snapshot);
      state.lastChromeSignature = currentChromeSignature;
      state.lastTranscriptStructureSignature = currentTranscriptStructureSignature;
      state.allowStreamingPatch = false;
      syncLiveDurationTimer();
      return;
    }
    const initialUnreadRender = snapshot.chat.hasUnread && !state.hasRenderedCurrentChat;
    const shouldStickToBottom = !initialUnreadRender && (state.stickToBottom || previousWasNearBottom);

    root.innerHTML = `
      <main class="app">
        ${chatHeader(snapshot)}
        <section class="body" data-role="transcript">
          ${renderTranscriptWindow(getTranscriptWindow())}
          ${state.notice ? `<div class="event">${escapeHtml(state.notice)}</div>` : ""}
          <div class="transcript-end" data-role="transcript-end"></div>
        </section>
        ${scrollToBottomButton()}
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
        state.stickToBottom = isAtTranscriptTail(body);
        maybeRequestTranscriptWindow(body, {
          userInitiated: wasRecentTranscriptUserNavigation(),
          direction: state.lastTranscriptNavigationDirection
        });
        notifyReadToBottomIfNeeded(body, snapshot);
        updateScrollToBottomButton(body);
      });
      body.addEventListener("wheel", (event) => {
        markTranscriptUserNavigation(event.deltaY < 0 ? "before" : "after");
        requestAnimationFrame(() => {
          state.stickToBottom = isAtTranscriptTail(body);
          maybeRequestTranscriptWindow(body, {
            userInitiated: true,
            direction: state.lastTranscriptNavigationDirection
          });
          notifyReadToBottomIfNeeded(body, snapshot);
          updateScrollToBottomButton(body);
        });
      });
      body.addEventListener("pointerdown", () => {
        markTranscriptUserNavigation("both");
      });
      requestAnimationFrame(() => {
        restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged, state.pendingScrollAnchor || previousAnchor);
        state.pendingScrollAnchor = null;
        notifyReadToBottomIfNeeded(body, snapshot);
        updateScrollToBottomButton(body);
      });
    }
    state.lastTranscriptSignature = signature;
    state.lastChromeSignature = currentChromeSignature;
    state.lastTranscriptStructureSignature = currentTranscriptStructureSignature;
    state.allowStreamingPatch = false;
    state.hasRenderedCurrentChat = true;
    restorePromptFocus(focusState, snapshot.chat.id);
    syncLiveDurationTimer();

    root.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        if (command === "chat.cancel") {
          state.notice = "";
          vscode.postMessage({ type: "command", command });
          return;
        }
        if (command === "chat.scrollToBottom") {
          const transcript = root.querySelector("[data-role='transcript']");
          const transcriptEnd = root.querySelector("[data-role='transcript-end']");
          if (transcript) {
            state.stickToBottom = true;
            if (state.transcriptWindow && state.transcriptWindow.hasAfter) {
              state.scrollToBottomAfterWindow = true;
              state.showScrollToBottom = false;
              state.loadingAfter = false;
              vscode.postMessage({
                type: "command",
                command: "chat.transcript.tail",
                payload: { count: TRANSCRIPT_INITIAL_WINDOW_SIZE }
              });
            } else {
              scrollTranscriptToBottom(transcript, transcriptEnd, true);
              notifyReadToBottomIfNeeded(transcript, snapshot);
              updateScrollToBottomButton(transcript);
            }
          }
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
          const sendMode = isPlanningArmed(snapshot.chat.id) || getActiveClarification(snapshot) ? "planning" : "normal";
          setPlanningArmed(snapshot.chat.id, false);
          state.notice = "";
          state.stickToBottom = true;
          vscode.postMessage({ type: "command", command, payload: { prompt, mode: sendMode } });
          return;
        }
        if (command === "chat.clarification.answer") {
          const answer = button.dataset.answer || "";
          if (!answer.trim()) {
            return;
          }
          setDraft(snapshot.chat.id, "");
          setPlanningArmed(snapshot.chat.id, false);
          state.notice = "";
          state.stickToBottom = true;
          vscode.postMessage({ type: "command", command: "chat.send", payload: { prompt: answer, mode: "planning" } });
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
        if (command === "activity.toggle") {
          toggleActivity(button.dataset.activityId || "");
          return;
        }
        if (command === "worklog.toggle") {
          toggleWorklog(button.dataset.worklogId || "");
          return;
        }
        if (command === "turnRun.toggle") {
          toggleTurnRun(button.dataset.turnRunId || "");
          return;
        }
        if (command === "diff.toggleFile") {
          toggleDiffFile(button.dataset.diffId || "", Number(button.dataset.fileIndex || 0));
          return;
        }
        if (command === "diff.toggleAll") {
          toggleAllDiffFiles(button.dataset.diffId || "");
          return;
        }
        if (command === "diff.openNative") {
          vscode.postMessage({
            type: "command",
            command,
            payload: {
              diffId: button.dataset.diffId || "",
              fileIndex: Number(button.dataset.fileIndex || 0)
            }
          });
          return;
        }
        if (command === "markdown.openLink") {
          const target = button.dataset.target || "";
          if (target) {
            vscode.postMessage({
              type: "command",
              command,
              payload: { target }
            });
          }
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
        ${clarificationDock(snapshot)}
        <div class="composer-box">
          <textarea data-role="prompt-input" placeholder="Напишите задачу для Codex">${escapeHtml(getDraft(snapshot.chat.id))}</textarea>
          <div class="composer-actions${snapshot.chat.activeRunMode === "planning" ? " planning-active" : ""}">
            <div class="composer-left">
              ${accessSelector(snapshot.chat.accessMode)}
              ${planningSelector(snapshot)}
            </div>
            <div class="composer-right">
              ${contextWindowIndicator(snapshot.contextWindow)}
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

  function clarificationDock(snapshot) {
    const clarification = getActiveClarification(snapshot);
    if (!clarification) {
      return "";
    }
    const options = Array.isArray(clarification.options) ? clarification.options : [];
    return `
      <div class="clarification-dock" data-clarification-id="${escapeAttribute(clarification.id)}">
        <section class="clarification-card" aria-label="Уточняющий вопрос Codex">
          <div class="clarification-kicker">Уточняющий вопрос</div>
          <div class="clarification-question">${escapeHtml(clarification.question)}</div>
          ${options.length ? `
            <div class="clarification-options">
              ${options.map((option) => `
                <button class="clarification-option" type="button" data-command="chat.clarification.answer" data-answer="${escapeAttribute(option.answer)}">
                  <span class="clarification-option-title">${escapeHtml(option.title)}</span>
                  ${option.description ? `<span class="clarification-option-description">${escapeHtml(option.description)}</span>` : ""}
                </button>
              `).join("")}
            </div>
          ` : ""}
          <div class="clarification-hint">Выберите вариант или напишите свой ответ ниже.</div>
        </section>
      </div>
    `;
  }

  function contextWindowIndicator(contextWindow) {
    const usage = contextWindow || {};
    const percent = typeof usage.usedPercent === "number" ? Math.max(0, Math.min(100, usage.usedPercent)) : null;
    const angle = percent === null ? 0 : Math.round(percent * 3.6);
    const status = usage.status || "unknown";
    return `
      <div class="context-window-control ${escapeAttribute(status)}" style="--context-angle: ${angle}deg;" aria-label="Контекстное окно">
        <span class="context-window-ring" aria-hidden="true"></span>
        <div class="context-window-tooltip" role="tooltip">
          ${contextWindowTooltip(usage, percent)}
        </div>
      </div>
    `;
  }

  function contextWindowTooltip(usage, percent) {
    if (!usage || usage.status === "unknown") {
      return `
        <div class="context-window-muted">Контекстное окно:</div>
        <div>данные появятся после первого ответа Codex</div>
      `;
    }
    if (usage.status === "compacting") {
      return `
        <div class="context-window-muted">Контекстное окно:</div>
        <div>Codex сжимает контекст</div>
      `;
    }
    if (usage.status === "error") {
      return `
        <div class="context-window-muted">Контекстное окно:</div>
        <div>${escapeHtml(usage.message || "не удалось получить данные")}</div>
      `;
    }

    const filled = percent === null ? "неизвестно" : `${Math.round(percent)}% заполнено`;
    const used = formatTokenCount(usage.usedTokens);
    const max = formatTokenCount(usage.maxTokens);
    const usageLine = used && max
      ? `Использовано ${used} /<br>${max} токенов`
      : max
        ? `Размер окна ${max} токенов,<br>использование уточняется`
        : used
          ? `Использовано ${used} токенов,<br>размер окна уточняется`
          : "Использование токенов уточняется";
    return `
      <div class="context-window-muted">Контекстное окно:</div>
      <div class="context-window-muted">${escapeHtml(filled)}</div>
      <div class="context-window-strong">${usageLine}</div>
      <div class="context-window-strong">Codex автоматически<br>сжимает свой контекст</div>
    `;
  }

  function formatTokenCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "";
    }
    if (value >= 1000) {
      return `${Math.round(value / 1000)} к`;
    }
    return String(Math.round(value));
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

  function scrollToBottomButton() {
    return `
      <button class="scroll-to-bottom${state.showScrollToBottom ? " visible" : ""}" type="button" data-command="chat.scrollToBottom" data-role="scroll-to-bottom" aria-label="В конец диалога" title="В конец диалога">
        ${scrollDownIcon()}
      </button>
    `;
  }

  function scrollDownIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 18.5c-.38 0-.76-.15-1.05-.44l-6-6a1.5 1.5 0 0 1 2.1-2.12l3.45 3.44V4.5a1.5 1.5 0 0 1 3 0v8.88l3.45-3.44a1.5 1.5 0 1 1 2.1 2.12l-6 6c-.29.29-.67.44-1.05.44Z"/>
      </svg>
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
    const item = getTranscriptItems().find((candidate) => candidate.id === planId);
    if (!item) {
      return "";
    }
    if (item.kind === "plan") {
      return item.markdown || "";
    }
    if ((item.kind || "message") === "message") {
      return extractPlan(item.text)?.plan || "";
    }
    return "";
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
	      ${details.version ? `<div class="context-details-row"><span>Версия индекса</span><span>v${Number(details.version)}</span></div>` : ""}
	      ${details.chunkCount !== undefined ? `<div class="context-details-row"><span>Chunks</span><span>${Number(details.chunkCount)}</span></div>` : ""}
	      ${details.dirty !== undefined ? `<div class="context-details-row"><span>Состояние</span><span>${details.dirty ? "требует обновления" : "актуален"}</span></div>` : ""}
	      ${details.updatedAt ? `<div class="context-details-row"><span>Обновлен</span><span>${escapeHtml(formatDetailsDate(details.updatedAt))}</span></div>` : ""}
	      ${details.error ? `<div class="context-details-error">${escapeHtml(details.error)}</div>` : ""}
	      ${projectLastUsedChunks(details)}
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

	  function projectLastUsedChunks(details) {
	    const chunks = Array.isArray(details.lastUsedChunks) ? details.lastUsedChunks : [];
	    if (!chunks.length) {
	      return `<div class="context-details-row"><span>Последний turn</span><span>project chunks не использовались</span></div>`;
	    }
	    return `
	      <div class="context-details-subtitle">Последние использованные chunks (${chunks.length})</div>
	      <div class="context-file-list compact">
	        ${chunks.map((chunk) => `
	          <div class="context-file-item">
	            <strong>${escapeHtml(chunk.path || "project chunk")}</strong>
	            <span>${Number(chunk.startLine || 0)}-${Number(chunk.endLine || 0)}${chunk.score !== undefined ? ` · score ${escapeHtml(formatScore(chunk.score))}` : ""}</span>
	            ${Array.isArray(chunk.symbols) && chunk.symbols.length ? `<span>${chunk.symbols.map((symbol) => escapeHtml(symbol)).join(", ")}</span>` : ""}
	          </div>
	        `).join("")}
	      </div>
	    `;
	  }

  function docsDetailsBody(details) {
    const sourceLabel = details.source === "normalized"
      ? "Нормализованная документация"
      : details.source === "multiple"
        ? "Несколько разрешенных источников"
        : "Документация не используется";
    const corpora = Array.isArray(details.corpora) ? details.corpora : [];
    const roots = Array.isArray(details.allowedRoots) ? details.allowedRoots : [];
    const showRetrievalStats = details.lastRetrievalMode && details.lastRetrievalMode !== "metadata";
    return `
	      <div class="context-details-title">Документация</div>
	      <div class="context-details-row"><span>Источник</span><strong>${escapeHtml(sourceLabel)}</strong></div>
	      <div class="context-details-row"><span>Retrieval</span><strong>${escapeHtml(docsRetrievalModeLabel(details.lastRetrievalMode))}</strong></div>
	      ${showRetrievalStats && details.lastRetrievalAt ? `<div class="context-details-row"><span>Последний поиск</span><span>${escapeHtml(formatDetailsDate(details.lastRetrievalAt))}</span></div>` : ""}
	      ${showRetrievalStats && details.lastQueryCount !== undefined ? `<div class="context-details-row"><span>Запросов</span><span>${Number(details.lastQueryCount)}</span></div>` : ""}
	      ${showRetrievalStats && details.lastSelectedFragments !== undefined ? `<div class="context-details-row"><span>Фрагментов выбрано</span><span>${Number(details.lastSelectedFragments)}</span></div>` : ""}
	      ${details.normalizedPath ? `<div class="context-details-row"><span>Каталог</span><code>${escapeHtml(details.normalizedPath)}</code></div>` : ""}
      ${details.sourcePath ? `<div class="context-details-row"><span>Исходный каталог</span><code>${escapeHtml(details.sourcePath)}</code></div>` : ""}
      ${details.indexPath ? `<div class="context-details-row"><span>Индекс</span><code>${escapeHtml(details.indexPath)}</code></div>` : ""}
      ${details.fingerprint ? `<div class="context-details-row"><span>Fingerprint</span><code>${escapeHtml(details.fingerprint)}</code></div>` : ""}
      ${details.fingerprintLatestMtimeMs ? `<div class="context-details-row"><span>Обновлен</span><span>${escapeHtml(formatDetailsDate(details.fingerprintLatestMtimeMs))}</span></div>` : ""}
      ${details.fingerprintFiles ? `<div class="context-details-row"><span>Файлов индекса</span><span>${Number(details.fingerprintFiles)}</span></div>` : ""}
      ${roots.length ? `
        <div class="context-details-subtitle">Разрешенные roots (${roots.length})</div>
        <div class="context-file-list">
          ${roots.map((root) => `
            <div class="context-file-item">
              <strong>${escapeHtml(root.label || docsRootKindLabel(root.kind))}</strong>
              <span>${escapeHtml(root.status === "configured" ? "активен" : "ошибка")}${root.fingerprint ? ` · fingerprint ${escapeHtml(root.fingerprint)}` : ""}</span>
              <code>${escapeHtml(root.path || "")}</code>
              ${root.fingerprintLatestMtimeMs ? `<span>Обновлен: ${escapeHtml(formatDetailsDate(root.fingerprintLatestMtimeMs))}</span>` : ""}
              ${Array.isArray(root.corpora) && root.corpora.length ? `<span>Корпуса: ${root.corpora.map((item) => escapeHtml(item.corpus || item.label || "corpus")).join(", ")}</span>` : ""}
              ${root.error ? `<span class="context-details-error">${escapeHtml(root.error)}</span>` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${corpora.length ? `
        <div class="context-details-subtitle">Активные корпуса (${corpora.length})</div>
        <div class="context-file-list">
          ${corpora.map((corpus) => `
            <div class="context-file-item">
              <strong>${escapeHtml(corpus.label || corpus.corpus || "Корпус")}</strong>
              <span>${escapeHtml(corpus.corpus || "")}${corpus.format ? ` · ${escapeHtml(corpus.format)}` : ""}</span>
              ${corpus.indexPath ? `<code>${escapeHtml(corpus.indexPath)}</code>` : ""}
              ${Array.isArray(corpus.files) && corpus.files.length ? `<span>${corpus.files.length} файлов индекса</span>` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${details.error ? `<div class="context-details-error">${escapeHtml(details.error)}</div>` : ""}
    `;
  }

	  function docsRootKindLabel(kind) {
    if (kind === "normalized") return "Нормализованная документация";
    if (kind === "source") return "Исходная документация";
    if (kind === "serverDocs") return "Документация server/docs";
    return "Источник документации";
	  }

	  function docsRetrievalModeLabel(mode) {
	    if (mode === "metadata") return "настройки источников";
	    if (mode === "model-assisted") return "model-assisted";
	    if (mode === "deterministic") return "deterministic";
	    if (mode === "fallback") return "fallback";
	    return "не запускался";
	  }

	  function formatScore(value) {
	    const number = Number(value);
	    if (!Number.isFinite(number)) {
	      return String(value);
	    }
	    return number.toFixed(number >= 10 ? 0 : 2);
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
    const armed = isPlanningArmed(snapshot.chat.id) || Boolean(getActiveClarification(snapshot));
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

  function getTranscriptWindow() {
    if (state.transcriptWindow) {
      return state.transcriptWindow;
    }
    const snapshot = state.snapshot;
    return normalizeTranscriptWindow(snapshot?.transcriptWindow || windowFromLegacyTranscript(snapshot?.transcript));
  }

  function getTranscriptItems() {
    return getTranscriptWindow().items || [];
  }

  function getActiveClarification(snapshotOverride) {
    const snapshot = snapshotOverride || state.snapshot;
    if (!snapshot || !snapshot.chat || snapshot.chat.status !== "idle") {
      return null;
    }
    if (snapshot.activeClarification) {
      return parseClarificationItem(snapshot.activeClarification);
    }
    return activeClarificationFromItems(getTranscriptItems());
  }

  function activeClarificationFromItems(items) {
    const source = Array.isArray(items) ? items : [];
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const item = source[index];
      if (!item) {
        continue;
      }
      if (item.kind === "message" && item.role === "user") {
        return null;
      }
      if (item.kind === "clarification") {
        const parsed = parseClarificationItem(item);
        return parsed && parsed.question ? parsed : null;
      }
    }
    return null;
  }

  function parseClarificationItem(item) {
    if (!item || item.kind !== "clarification" || !String(item.question || "").trim()) {
      return null;
    }
    return {
      id: item.id || "",
      question: String(item.question || "").trim(),
      options: normalizeClarificationOptions(item.options),
      createdAt: item.createdAt || ""
    };
  }

  function normalizeClarificationOptions(options) {
    if (!Array.isArray(options)) {
      return [];
    }
    return options.map((option) => {
      const title = String(option && option.title || "").trim();
      const answer = String(option && option.answer || title).trim();
      const description = String(option && option.description || "").trim();
      return title && answer ? { title, answer, description } : null;
    }).filter(Boolean).slice(0, 5);
  }

  function renderTranscriptWindow(windowState) {
    const window = normalizeTranscriptWindow(windowState);
    const hasItems = Array.isArray(window.items) && window.items.length > 0;
    return `
      ${window.hasBefore ? `<div class="transcript-window-sentinel before" data-role="transcript-before">Загрузить предыдущие сообщения</div>` : ""}
      ${hasItems ? renderTranscript(window.items) : emptyTranscriptBlock(window)}
      ${window.hasAfter ? `<div class="transcript-window-sentinel after" data-role="transcript-after">Ниже есть новые сообщения</div>` : ""}
    `;
  }

  function emptyTranscriptBlock(windowState) {
    const chat = state.snapshot && state.snapshot.chat ? state.snapshot.chat : undefined;
    if (!chat) {
      return transcriptStateBlock({
        tone: "empty",
        icon: "info",
        title: "Диалог не выбран",
        message: "Выберите диалог в sidebar или создайте новый."
      });
    }
    if ((windowState.totalCount || 0) > 0) {
      return transcriptStateBlock({
        tone: "empty",
        icon: "info",
        title: "Фрагмент истории не загружен",
        message: "Перейдите в конец диалога или загрузите соседнюю часть истории."
      });
    }
    if (chat.archivedAt) {
      return transcriptStateBlock({
        tone: "empty",
        icon: "info",
        title: "Диалог в архиве",
        message: "В этом архивном диалоге пока нет сообщений."
      });
    }
    return transcriptStateBlock({
      tone: "empty",
      icon: "info",
      title: "Диалог пуст",
      message: "Отправьте первое сообщение, чтобы начать."
    });
  }

  function renderTranscript(items) {
    const source = Array.isArray(items) ? items : [];
    const activeClarification = getActiveClarification();
    const visibleSource = source.filter((item, index) => {
      if (!item) {
        return false;
      }
      if (activeClarification && item.id === activeClarification.id) {
        return false;
      }
      return item.kind !== "connection" || !source[index + 1] || source[index + 1].kind !== "connection";
    });
    return compactActivityItems(buildTranscriptPresentation(visibleSource))
      .map(transcriptItem)
      .filter(Boolean)
      .join("");
  }

  function buildTranscriptPresentation(items) {
    const source = Array.isArray(items) ? items : [];
    const itemById = new Map();
    const itemIndex = new Map();
    const turnRunByTurnId = new Map();
    source.forEach((item, index) => {
      if (!item || !item.id) return;
      itemById.set(item.id, item);
      itemIndex.set(item.id, index);
      if (item.kind === "turn-run" && item.turnId) {
        turnRunByTurnId.set(item.turnId, item);
      }
    });

    const output = [];
    for (const item of source) {
      if (!item) {
        continue;
      }
      if (item.kind === "turn-run") {
        output.push({
          ...item,
          __related: collectTurnRunRelatedItems(item, itemById, itemIndex)
        });
        continue;
      }
      const turnRun = item.turnId ? turnRunByTurnId.get(item.turnId) : undefined;
      if (turnRun && isTurnRunOperationalItem(item)) {
        if (item.kind === "activity" && item.activityKind === "turn") {
          continue;
        }
        if (turnRun.status !== "running") {
          continue;
        }
      }
      output.push(item);
    }
    return output;
  }

  function collectTurnRunRelatedItems(turnRun, itemById, itemIndex) {
    const ids = [
      ...(Array.isArray(turnRun.activityIds) ? turnRun.activityIds : []),
      ...(Array.isArray(turnRun.worklogIds) ? turnRun.worklogIds : []),
      ...(Array.isArray(turnRun.compactionIds) ? turnRun.compactionIds : [])
    ];
    const seen = new Set();
    return ids
      .map((id) => itemById.get(id))
      .filter((item) => {
        if (!item || !item.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return isTurnRunOperationalItem(item) && !(item.kind === "activity" && item.activityKind === "turn");
      })
      .sort((left, right) => (itemIndex.get(left.id) || 0) - (itemIndex.get(right.id) || 0));
  }

  function isTurnRunOperationalItem(item) {
    return Boolean(item && (item.kind === "activity" || item.kind === "worklog" || item.kind === "compaction"));
  }

  function compactActivityItems(items) {
    const output = [];
    let buffer = [];

    const flush = () => {
      if (buffer.length === 1) {
        output.push(buffer[0]);
      } else if (buffer.length > 1) {
        output.push(activityGroupItem(buffer));
      }
      buffer = [];
    };

    for (const item of items) {
      if (canCompactActivity(item)) {
        buffer.push(item);
        continue;
      }
      flush();
      output.push(item);
    }
    flush();
    return output;
  }

  function canCompactActivity(item) {
    if (!item || item.kind !== "activity" || isHiddenActivity(item)) {
      return false;
    }
    return (
      item.status === "completed"
      && !item.outputPreview
      && item.activityKind !== "turn"
      && item.activityKind !== "reasoning"
      && item.activityKind !== "unknown"
    );
  }

  function activityGroupItem(items) {
    const counts = Object.create(null);
    for (const item of items) {
      counts[item.activityKind] = (counts[item.activityKind] || 0) + 1;
    }
    const parts = [];
    if (counts.file) parts.push(formatActivityCount("изменён", "изменено", counts.file, "файл", "файла", "файлов"));
    if (counts.search) parts.push(formatActivityCount("изучен", "изучено", counts.search, "поиск", "поиска", "поисков"));
    if (counts.command) parts.push(formatActivityCount("выполнена", "выполнено", counts.command, "команда", "команды", "команд"));
    if (counts.tool) parts.push(formatActivityCount("выполнен", "выполнено", counts.tool, "инструмент", "инструмента", "инструментов"));
    if (counts.context) parts.push("обработан контекст");
    return {
      kind: "activity",
      id: `activity-group-${items[0].id}-${items[items.length - 1].id}`,
      activityKind: counts.file ? "file" : counts.search ? "search" : counts.command ? "command" : "tool",
      label: capitalize(parts.join(", ")),
      status: "completed",
      createdAt: items[0].createdAt,
      updatedAt: items[items.length - 1].updatedAt,
      completedAt: items[items.length - 1].completedAt || items[items.length - 1].updatedAt,
      details: items.map(activityDetailFromItem).filter(Boolean)
    };
  }

  function activityDetailFromItem(item) {
    const details = Array.isArray(item.details) ? item.details.filter(Boolean) : [];
    if (details.length) {
      return {
        ...details[0],
        activityKind: details[0].activityKind || item.activityKind,
        status: details[0].status || item.status,
        label: details[0].label || normalizeActivityLabel(item)
      };
    }
    return {
      activityKind: item.activityKind,
      status: item.status,
      label: normalizeActivityLabel(item),
      command: item.command || "",
      path: item.path || "",
      summary: item.summary || "",
      outputPreview: item.outputPreview || ""
    };
  }

  function formatActivityCount(oneVerb, manyVerb, count, one, few, many) {
    const noun = pluralRu(count, one, few, many);
    return `${count === 1 ? oneVerb : manyVerb} ${count} ${noun}`;
  }

  function pluralRu(count, one, few, many) {
    const abs = Math.abs(count);
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }

  function transcriptItem(item) {
    const kind = item.kind || "message";
    if (kind === "message") return messageBlock(item);
    if (kind === "turn-run") return turnRunBlock(item);
    if (kind === "activity") return activityBlock(item);
    if (kind === "worklog") return worklogBlock(item);
    if (kind === "diff") return diffBlock(item);
    if (kind === "plan") return planBlock(item);
    if (kind === "clarification") return "";
    if (kind === "compaction") return compactionBlock(item);
    if (kind === "connection") return connectionBlock(item);
    if (kind === "error") return errorBlock(item);
    return "";
  }

  function turnRunBlock(item) {
    const status = item.status || "running";
    const related = Array.isArray(item.__related) ? item.__related : [];
    const expanded = isTurnRunExpanded(item.id);
    const expandable = status !== "running" && related.length > 0;
    const label = turnRunLabel(item);
    const details = expandable && expanded ? turnRunDetailsHtml(related) : "";
    return `
      <article class="transcript-item turn-run-row ${escapeAttribute(status)} ${expandable ? "expandable" : ""} ${expanded ? "expanded" : ""}" data-item-id="${escapeAttribute(item.id)}">
        <${expandable ? "button" : "div"} class="turn-run-line" ${expandable ? `type="button" data-command="turnRun.toggle" data-turn-run-id="${escapeAttribute(item.id)}" aria-expanded="${expanded ? "true" : "false"}"` : ""}>
          ${activityIcon(status === "error" ? "unknown" : "turn")}
          <span class="turn-run-label">${label}</span>
          ${expandable ? `<span class="turn-run-chevron">${expanded ? angleDownIcon() : angleRightIcon()}</span>` : ""}
        </${expandable ? "button" : "div"}>
        ${details}
      </article>
    `;
  }

  function turnRunLabel(item) {
    const status = item.status || "running";
    if (status === "running") {
      return `Работает уже <span class="turn-run-time" data-live-duration="activity-time" data-created-at="${escapeAttribute(item.createdAt || "")}">${escapeHtml(elapsedLabel(item.createdAt))}</span>`;
    }
    const duration = durationLabel(item.createdAt, item.completedAt || item.updatedAt, { hideZero: true });
    if (status === "error") {
      return `Завершено с ошибкой${duration ? ` <span class="turn-run-time">${escapeHtml(duration)}</span>` : ""}`;
    }
    return `Работал на протяжении${duration ? ` <span class="turn-run-time">${escapeHtml(duration)}</span>` : ""}`;
  }

  function turnRunDetailsHtml(related) {
    const items = compactActivityItems(related)
      .map((item) => transcriptItem(item))
      .filter(Boolean)
      .join("");
    return items ? `<div class="turn-run-details">${items}</div>` : "";
  }

  function isTurnRunExpanded(turnRunId) {
    return Boolean(turnRunId && state.expandedTurnRuns[turnRunId]);
  }

  function toggleTurnRun(turnRunId) {
    if (!turnRunId) {
      return;
    }
    if (state.expandedTurnRuns[turnRunId]) {
      delete state.expandedTurnRuns[turnRunId];
    } else {
      state.expandedTurnRuns[turnRunId] = true;
    }
    render();
  }

  function messageBlock(item) {
    const roleValue = item.role || "assistant";
    const text = String(item.text || "");
    const plan = roleValue === "assistant" ? extractPlan(text) : undefined;
    if (plan) {
      return planBlock({
        kind: "plan",
        id: item.id,
        markdown: plan.plan,
        createdAt: item.createdAt,
        updatedAt: item.completedAt
      });
    }
    if (roleValue === "assistant" && containsClarificationMarker(text)) {
      return "";
    }
    if (roleValue === "user") {
      return `
        <article class="transcript-item user-message" data-item-id="${escapeAttribute(item.id)}">
          <div class="user-bubble">${markdownInline(text)}</div>
        </article>
      `;
    }
    if (roleValue === "system") {
      return `
        <article class="transcript-item system-message" data-item-id="${escapeAttribute(item.id)}">
          <div class="system-role">Система</div>
          <div class="markdown-body">${markdown(text)}</div>
        </article>
      `;
    }
    const duration = messageDurationHtml(item);
    const meta = [
      duration
    ].filter(Boolean);
    return `
      <article class="transcript-item assistant-message ${item.status === "streaming" ? "streaming" : ""}" data-item-id="${escapeAttribute(item.id)}">
        ${meta.length ? `<div class="assistant-meta">${meta.join("")}</div>` : ""}
        <div class="markdown-body">${markdown(text || (item.status === "streaming" ? "Думаю" : ""))}</div>
      </article>
    `;
  }

  function activityBlock(item) {
    if (isHiddenActivity(item)) {
      return "";
    }
    const label = activityLabelHtml(item);
    const elapsed = activityTimeHtml(item);
    const expanded = isActivityExpanded(item.id);
    const expandable = isActivityExpandable(item);
    const outputPreview = !expanded ? activityOutputPreviewHtml(item) : "";
    const details = expanded ? activityDetailsHtml(item) : "";
    return `
      <article class="transcript-item activity-row ${escapeAttribute(item.status || "completed")} ${expandable ? "expandable" : ""} ${expanded ? "expanded" : ""}" data-item-id="${escapeAttribute(item.id)}">
        <${expandable ? "button" : "div"} class="activity-line" ${expandable ? `type="button" data-command="activity.toggle" data-activity-id="${escapeAttribute(item.id)}" aria-expanded="${expanded ? "true" : "false"}"` : ""}>
          ${activityIcon(item.activityKind)}
          <span class="activity-label">${label}</span>
          ${elapsed}
          ${expandable ? `<span class="activity-chevron">${expanded ? angleDownIcon() : angleRightIcon()}</span>` : ""}
        </${expandable ? "button" : "div"}>
        ${outputPreview}
        ${details}
      </article>
    `;
  }

  function worklogBlock(item) {
    const children = visibleWorklogChildren(item);
    const expanded = isWorklogExpanded(item.id);
    const expandable = children.length > 0;
    const elapsed = worklogTimeHtml(item);
    return `
      <article class="transcript-item worklog-row ${escapeAttribute(item.status || "completed")} ${expandable ? "expandable" : ""} ${expanded ? "expanded" : ""}" data-item-id="${escapeAttribute(item.id)}">
        <${expandable ? "button" : "div"} class="worklog-line" ${expandable ? `type="button" data-command="worklog.toggle" data-worklog-id="${escapeAttribute(item.id)}" aria-expanded="${expanded ? "true" : "false"}"` : ""}>
          ${activityIcon(item.operationKind)}
          <span class="worklog-label">${escapeHtml(item.title || "Действие Codex")}</span>
          ${elapsed}
          ${expandable ? `<span class="worklog-chevron">${expanded ? angleDownIcon() : angleRightIcon()}</span>` : ""}
        </${expandable ? "button" : "div"}>
        ${expanded ? worklogChildrenHtml(item, children) : ""}
      </article>
    `;
  }

  function visibleWorklogChildren(item) {
    const parentTitle = String(item.title || "").trim();
    return (Array.isArray(item.children) ? item.children : [])
      .filter((child) => {
        if (!child) return false;
        const title = String(child.title || "").trim();
        if (!title) return false;
        return !(
          title === parentTitle
          && !child.query
          && !child.path
          && !child.command
          && !child.outputPreview
          && typeof child.resultCount !== "number"
        );
      });
  }

  function worklogChildrenHtml(item, children) {
    const visible = children.slice(0, 20);
    const hiddenCount = Math.max(0, children.length - visible.length);
    return `
      <div class="worklog-children">
        ${visible.map(worklogChildRowHtml).join("")}
        ${hiddenCount ? `<div class="worklog-more">Еще ${escapeHtml(hiddenCount)} ${escapeHtml(pluralRu(hiddenCount, "деталь", "детали", "деталей"))}</div>` : ""}
      </div>
    `;
  }

  function worklogChildRowHtml(child) {
    const durationHtml = child.status === "running"
      ? `<span class="worklog-child-time" data-live-duration="activity-time" data-created-at="${escapeAttribute(child.createdAt || "")}">${escapeHtml(elapsedLabel(child.createdAt))}</span>`
      : (() => {
        const duration = durationLabel(child.createdAt, child.completedAt, { hideZero: true });
        return duration ? `<span class="worklog-child-time">${escapeHtml(duration)}</span>` : "";
      })();
    const output = safeWorklogOutputPreview(child.outputPreview);
    const details = worklogChildDetailsHtml(child, output);
    const hasDetails = details.trim().length > 0;
    const status = worklogStatusIcon(child.status);
    return `
      <div class="worklog-child ${escapeAttribute(child.kind || "tool")} ${escapeAttribute(child.status || "completed")}">
        <div class="worklog-child-line">
          ${activityIcon(child.kind || "tool")}
          <span class="worklog-child-title">${escapeHtml(child.title || "Действие")}</span>
          ${durationHtml}
          <span class="worklog-child-status">${status}</span>
        </div>
        ${hasDetails ? details : ""}
      </div>
    `;
  }

  function worklogChildDetailsHtml(child, output) {
    if (child.kind === "command") {
      return `
        <div class="worklog-shell-card">
          <div class="worklog-shell-kicker">Shell</div>
          <pre class="worklog-shell-output">${escapeHtml(child.command ? `$ ${child.command}` : "$ команда")}${output ? `\n\n${escapeHtml(output)}` : "\n\nНет вывода"}</pre>
          <div class="worklog-shell-status">${child.status === "error" ? "Ошибка" : "✓ Успех"}</div>
        </div>
      `;
    }
    const rows = [
      child.query ? ["Запрос", child.query] : null,
      child.path ? ["Область", child.path] : null,
      child.source ? ["Источник", worklogSourceLabel(child.source)] : null,
      typeof child.resultCount === "number" ? ["Результатов", String(child.resultCount)] : null
    ].filter(Boolean);
    return `
      <div class="worklog-child-details">
        ${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`).join("")}
        ${output ? `<pre class="worklog-child-output">${escapeHtml(output)}</pre>` : ""}
      </div>
    `;
  }

  function worklogTimeHtml(item) {
    if (item.status === "running") {
      return `<span class="worklog-time" data-live-duration="activity-time" data-created-at="${escapeAttribute(item.createdAt || "")}">${escapeHtml(elapsedLabel(item.createdAt))}</span>`;
    }
    const duration = durationLabel(item.createdAt, item.completedAt || item.updatedAt, { hideZero: true });
    return duration ? `<span class="worklog-time">${escapeHtml(duration)}</span>` : "";
  }

  function isWorklogExpanded(worklogId) {
    return Boolean(worklogId && state.expandedWorklogs[worklogId]);
  }

  function toggleWorklog(worklogId) {
    if (!worklogId) {
      return;
    }
    if (state.expandedWorklogs[worklogId]) {
      delete state.expandedWorklogs[worklogId];
    } else {
      state.expandedWorklogs[worklogId] = true;
    }
    render();
  }

  function worklogStatusIcon(status) {
    if (status === "error") {
      return "Ошибка";
    }
    if (status === "running") {
      return "…";
    }
    return "✓";
  }

  function worklogSourceLabel(source) {
    if (source === "docs") return "документация 1C: Element";
    if (source === "project") return "проект";
    if (source === "web") return "web";
    if (source === "shell") return "shell";
    if (source === "ide") return "IDE";
    return "runtime";
  }

  function safeWorklogOutputPreview(value) {
    const preview = String(value || "").trim();
    if (!preview || looksLikeMojibake(preview)) {
      return "";
    }
    return preview.length > 2000 ? `${preview.slice(0, 2000)}\n...` : preview;
  }

  function diffBlock(item) {
    const files = Array.isArray(item.files) ? item.files : [];
    const hasDiff = files.some((file) => hasRenderableDiff(file.diff));
    const allExpanded = hasDiff && files.every((file, index) => !hasRenderableDiff(file.diff) || isDiffFileExpanded(item.id, file, index));
    return `
      <article class="transcript-item diff-card" data-item-id="${escapeAttribute(item.id)}">
        <div class="diff-header">
          <div>
            <span>${escapeHtml(item.title || "Изменения")}</span>
            <span class="diff-count">${escapeHtml(formatFilesCount(files.length))}</span>
            <span class="diff-add">+${escapeHtml(item.additions ?? 0)}</span>
            <span class="diff-del">-${escapeHtml(item.deletions ?? 0)}</span>
          </div>
          <button class="diff-review-button" type="button" data-command="diff.toggleAll" data-diff-id="${escapeAttribute(item.id)}" ${hasDiff ? "" : "disabled"}>
            ${hasDiff ? escapeHtml(allExpanded ? "Свернуть изменения" : "Просмотреть изменения") : "Diff недоступен"}
          </button>
        </div>
        ${files.length ? `
          <div class="diff-file-list">
            ${files.map((file, index) => diffFileRow(item.id, file, index)).join("")}
          </div>
        ` : inlineStateBlock({ tone: "empty", icon: "info", message: "Изменения пока не получены." })}
      </article>
    `;
  }

  function diffFileRow(diffId, file, index) {
    const expanded = isDiffFileExpanded(diffId, file, index);
    const rawDiff = String(file.diff || "");
    const hasDiff = hasRenderableDiff(rawDiff);
    const tooLarge = rawDiff.length > 50000;
    const diff = hasDiff && !tooLarge ? renderDiff(rawDiff, file.path) : "";
    const disabled = !hasDiff;
    const status = diffFileStatusLabel(file.status);
    return `
      <section class="diff-file ${expanded ? "expanded" : ""}">
        <div class="diff-file-header">
          <button class="diff-file-toggle" type="button" data-command="diff.toggleFile" data-diff-id="${escapeAttribute(diffId)}" data-file-index="${index}" ${disabled ? "disabled" : ""} aria-label="${expanded ? "Свернуть diff" : "Раскрыть diff"}">
            <span class="diff-file-chevron">${expanded ? angleDownIcon() : angleRightIcon()}</span>
            <code>${escapeHtml(file.path || "unknown")}</code>
          </button>
          <span class="diff-file-status">${escapeHtml(status)}</span>
          <span class="diff-add">+${escapeHtml(file.additions ?? 0)}</span>
          <span class="diff-del">-${escapeHtml(file.deletions ?? 0)}</span>
          <button class="diff-open-button" type="button" data-command="diff.openNative" data-diff-id="${escapeAttribute(diffId)}" data-file-index="${index}" ${hasDiff ? "" : "disabled"} title="${hasDiff ? "Открыть side-by-side diff в редакторе" : "Diff недоступен"}">
            Открыть в редакторе
          </button>
        </div>
        ${expanded && tooLarge ? inlineStateBlock({ tone: "warning", icon: "warning", message: "Слишком большой diff, откройте его в редакторе." }) : ""}
        ${expanded && diff ? `<pre class="diff-code">${diff}</pre>` : ""}
        ${expanded && !hasDiff ? inlineStateBlock({ tone: "empty", icon: "info", message: "Diff недоступен." }) : ""}
      </section>
    `;
  }

  function diffFileStatusLabel(status) {
    if (status === "added") {
      return "создан";
    }
    if (status === "deleted") {
      return "удален";
    }
    if (status === "renamed") {
      return "переименован";
    }
    if (status === "unknown") {
      return "изменение";
    }
    return "изменен";
  }

  function hasRenderableDiff(diff) {
    return String(diff || "")
      .split("\n")
      .some((line) => (
        line.startsWith("@@")
        || (line.startsWith("+") && !line.startsWith("+++"))
        || (line.startsWith("-") && !line.startsWith("---"))
      ));
  }

  function toggleDiffFile(diffId, fileIndex) {
    const item = getDiffItem(diffId);
    if (!item || !Array.isArray(item.files) || !item.files[fileIndex] || !item.files[fileIndex].diff) {
      return;
    }
    const file = item.files[fileIndex];
    const key = diffFileStateKey(diffId, file, fileIndex);
    state.expandedDiffFiles[key] = !isDiffFileExpanded(diffId, file, fileIndex);
    render();
  }

  function toggleAllDiffFiles(diffId) {
    const item = getDiffItem(diffId);
    if (!item || !Array.isArray(item.files) || !item.files.some((file) => file.diff)) {
      return;
    }
    const shouldExpand = !item.files.every((file, index) => !file.diff || isDiffFileExpanded(diffId, file, index));
    item.files.forEach((file, index) => {
      if (file.diff) {
        state.expandedDiffFiles[diffFileStateKey(diffId, file, index)] = shouldExpand;
      }
    });
    render();
  }

  function getDiffItem(diffId) {
    return getTranscriptItems().find((item) => item && item.kind === "diff" && item.id === diffId);
  }

  function isDiffFileExpanded(diffId, file, index) {
    const key = diffFileStateKey(diffId, file, index);
    if (Object.prototype.hasOwnProperty.call(state.expandedDiffFiles, key)) {
      return Boolean(state.expandedDiffFiles[key]);
    }
    return isDefaultExpandedDiffFile(diffId, index);
  }

  function isDefaultExpandedDiffFile(diffId, index) {
    const item = getDiffItem(diffId);
    if (!item || !Array.isArray(item.files) || diffHasExplicitState(diffId)) {
      return false;
    }
    return item.files.findIndex((file) => Boolean(file.diff)) === index;
  }

  function diffHasExplicitState(diffId) {
    const prefix = `${diffId}:`;
    return Object.keys(state.expandedDiffFiles).some((key) => key.startsWith(prefix));
  }

  function diffFileStateKey(diffId, file, index) {
    return `${diffId}:${file.path || index}`;
  }

  function planBlock(item) {
    const chat = state.snapshot && state.snapshot.chat ? state.snapshot.chat : {};
    const canAct = !chat.archivedAt && chat.status === "idle";
    const disabledAttrs = canAct ? "" : ` disabled title="${escapeAttribute(chat.archivedAt ? "Диалог в архиве" : "Дождитесь завершения текущего запроса")}"`;
    return `
      <article class="transcript-item plan-message" data-item-id="${escapeAttribute(item.id)}">
        <div class="plan-card" role="region" aria-label="Финальный план Codex">
          <div class="plan-header">
            <div class="plan-heading">
              ${planIcon()}
              <div>
                <div class="plan-kicker">Финальный план</div>
                <div class="plan-title">Готов к реализации</div>
              </div>
            </div>
          </div>
          <div class="plan-text markdown-body">${markdown(item.markdown || "")}</div>
          <div class="plan-actions">
            <button class="button secondary plan-secondary" data-command="chat.plan.revise" data-plan-id="${escapeAttribute(item.id)}"${disabledAttrs}>Изменить план</button>
            <button class="button plan-primary" data-command="chat.plan.implement" data-plan-id="${escapeAttribute(item.id)}"${disabledAttrs}>Реализовать</button>
          </div>
        </div>
      </article>
    `;
  }

  function planIcon() {
    return `
      <svg class="plan-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M7 3h10a3 3 0 0 1 3 3v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v13h12V6a1 1 0 0 0-1-1H7Zm2 4h6v2H9V9Zm0 4h6v2H9v-2Zm0 4h4v2H9v-2Z"/>
      </svg>
    `;
  }

  function compactionBlock(item) {
    return `
      <div class="transcript-item compaction-divider" data-item-id="${escapeAttribute(item.id)}">
        <span></span>
        <strong>${documentRegIcon()}${escapeHtml(item.label || "Контекст автоматически сжат")}</strong>
        <span></span>
      </div>
    `;
  }

  function connectionBlock(item) {
    const message = item.message || connectionStatusLabel(item);
    const status = item.status || "reconnecting";
    const title = status === "failed"
      ? "Соединение не восстановлено"
      : status === "recovered"
        ? "Соединение восстановлено"
        : "Восстановление соединения";
    return transcriptStateBlock({
      id: item.id,
      tone: `connection ${status}`,
      icon: status === "failed" ? "error" : status === "recovered" ? "success" : "sync",
      title,
      message
    });
  }

  function errorBlock(item) {
    return transcriptStateBlock({
      id: item.id,
      tone: "error",
      icon: "error",
      title: "Ошибка выполнения",
      messageHtml: markdown(item.message || "Codex сообщил об ошибке."),
      details: item.details
    });
  }

  function transcriptStateBlock(options) {
    const id = options.id ? ` data-item-id="${escapeAttribute(options.id)}"` : "";
    const message = options.messageHtml || escapeHtml(options.message || "");
    return `
      <article class="transcript-item transcript-state ${escapeAttribute(options.tone || "info")}"${id}>
        <div class="transcript-state-icon">${transcriptStateIcon(options.icon || "info")}</div>
        <div class="transcript-state-content">
          <div class="transcript-state-title">${escapeHtml(options.title || "Состояние")}</div>
          ${message ? `<div class="transcript-state-message markdown-body">${message}</div>` : ""}
          ${options.details ? `
            <details class="transcript-state-details">
              <summary>Подробности</summary>
              <pre>${escapeHtml(options.details)}</pre>
            </details>
          ` : ""}
        </div>
      </article>
    `;
  }

  function inlineStateBlock(options) {
    return `
      <div class="inline-state ${escapeAttribute(options.tone || "empty")}">
        <span class="inline-state-icon">${transcriptStateIcon(options.icon || "info")}</span>
        <span>${escapeHtml(options.message || "")}</span>
      </div>
    `;
  }

  function transcriptStateIcon(kind) {
    if (kind === "error") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 14.75a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm1-2.75h-2V6h2v8Z"/>
        </svg>
      `;
    }
    if (kind === "success") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.6-4-4 1.4-1.4 2.6 2.58 5-5 1.4 1.42-6.4 6.4Z"/>
        </svg>
      `;
    }
    if (kind === "sync") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 0 0-7.75 6h2.1A6 6 0 0 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h8V3l-3.35 3.35ZM6.35 17.65A7.95 7.95 0 0 0 12 20a8 8 0 0 0 7.75-6h-2.1A6 6 0 0 1 12 18a5.96 5.96 0 0 1-4.22-1.78L11 13H3v8l3.35-3.35Z"/>
        </svg>
      `;
    }
    if (kind === "warning") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z"/>
        </svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M11 17h2v-6h-2v6Zm1-14a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm-1-10h2V7h-2v2Z"/>
      </svg>
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

  function tryPatchStreamingTranscript(snapshot) {
    const body = root.querySelector("[data-role='transcript']");
    if (!body) {
      return false;
    }

    const items = getTranscriptItems();
    let patched = false;
    const wasAtTail = isAtTranscriptTail(body);
    for (const item of items) {
      if (!item || item.kind !== "message" || item.role !== "assistant" || item.status !== "streaming") {
        continue;
      }
      if (extractPlan(item.text) || containsClarificationMarker(item.text)) {
        return false;
      }
      const node = transcriptItemNode(item.id);
      const markdownNode = node ? node.querySelector(".markdown-body") : null;
      if (!markdownNode) {
        return false;
      }
      const nextHtml = markdown(String(item.text || "Думаю"));
      if (markdownNode.innerHTML !== nextHtml) {
        markdownNode.innerHTML = nextHtml;
        patched = true;
      }
    }

    if (!patched) {
      return false;
    }

    if (state.stickToBottom || wasAtTail) {
      const end = root.querySelector("[data-role='transcript-end']");
      requestAnimationFrame(() => scrollTranscriptToBottom(body, end));
    } else {
      updateScrollToBottomButton(body);
      notifyReadToBottomIfNeeded(body, snapshot);
    }
    return true;
  }

  function transcriptItemNode(itemId) {
    if (!itemId) {
      return null;
    }
    return Array.from(root.querySelectorAll("[data-item-id]")).find((node) => node.dataset.itemId === itemId) || null;
  }

  function chatChromeSignature(snapshot) {
    const chat = snapshot.chat || {};
    const pendingApproval = chat.pendingApproval || {};
    const contextWindow = snapshot.contextWindow || {};
    return [
      chat.id || "",
      chat.title || "",
      chat.kind || "",
      chat.status || "",
      chat.activeRunMode || "",
      chat.accessMode || "",
      chat.modelId || "",
      chat.modelLabel || "",
      chat.effort || "",
      chat.speed || "",
      chat.rulesEnabled ? "rules-on" : "rules-off",
      chat.archivedAt || "",
      pendingApproval.id || "",
      snapshot.chatHeaderMode || "",
      snapshot.modelOptionsStatus || "",
      contextWindow.status || "",
      contextWindow.usedTokens ?? "",
      contextWindow.maxTokens ?? "",
      contextWindow.usedPercent ?? ""
    ].join("|");
  }

  function transcriptStructureSignature(snapshot) {
    const window = getTranscriptWindow();
    return [
      window.offset,
      window.totalCount,
      window.hasBefore ? "before" : "",
      window.hasAfter ? "after" : "",
      ...getTranscriptItems().map((item) => {
        const kind = item.kind || "message";
        if (kind === "message") {
          const role = item.role || "";
          const textShape = role === "assistant" && item.status === "streaming"
            ? "streaming"
            : String(item.text || "").length;
          return `${item.id}:message:${role}:${item.status || ""}:${textShape}:${item.completedAt || ""}`;
        }
        if (kind === "activity") {
          return `${item.id}:activity:${item.activityKind}:${item.status}:${item.label}:${String(item.outputPreview || "").length}:${item.updatedAt || ""}`;
        }
        if (kind === "turn-run") {
          return `${item.id}:turn-run:${item.status || ""}:${item.updatedAt || ""}:${item.completedAt || ""}:${(item.activityIds || []).join(",")}:${(item.worklogIds || []).join(",")}:${(item.compactionIds || []).join(",")}`;
        }
        if (kind === "worklog") {
          const children = Array.isArray(item.children) ? item.children : [];
          return `${item.id}:worklog:${item.operationKind}:${item.status}:${item.title}:${children.length}:${item.updatedAt || ""}:${children.map((child) => `${child.id}:${child.status}:${child.title}:${String(child.outputPreview || "").length}:${child.completedAt || ""}`).join(",")}`;
        }
        if (kind === "diff") {
          const files = Array.isArray(item.files) ? item.files : [];
          return `${item.id}:diff:${files.length}:${item.additions}:${item.deletions}:${item.updatedAt || ""}:${files.map((file) => `${file.path}:${file.additions}:${file.deletions}:${String(file.diff || "").length}`).join(",")}`;
        }
        if (kind === "plan") {
          return `${item.id}:plan:${String(item.markdown || "").length}:${item.updatedAt || ""}`;
        }
        if (kind === "clarification") {
          const options = Array.isArray(item.options) ? item.options : [];
          return `${item.id}:clarification:${String(item.question || "").length}:${options.length}:${item.updatedAt || ""}`;
        }
        if (kind === "compaction") {
          return `${item.id}:compaction:${item.label || ""}`;
        }
        if (kind === "connection") {
          return `${item.id}:connection:${item.message || ""}:${item.status || ""}:${item.attempt || ""}`;
        }
        if (kind === "error") {
          return `${item.id}:error:${item.message || ""}:${item.details || ""}`;
        }
        return `${item.id}:${kind}`;
      })
    ].join("|");
  }

  function transcriptSignature(snapshot) {
    const window = getTranscriptWindow();
    return [
      window.offset,
      window.totalCount,
      window.hasBefore ? "before" : "",
      window.hasAfter ? "after" : "",
      ...getTranscriptItems().map((item) => {
        const kind = item.kind || "message";
        if (kind === "message") {
          return `${item.id}:message:${item.role}:${String(item.text || "").length}:${item.status || ""}:${item.completedAt || ""}`;
        }
        if (kind === "activity") {
          return `${item.id}:activity:${item.activityKind}:${item.status}:${item.label}:${String(item.outputPreview || "").length}:${item.updatedAt || ""}`;
        }
        if (kind === "turn-run") {
          return `${item.id}:turn-run:${item.status || ""}:${item.updatedAt || ""}:${item.completedAt || ""}:${(item.activityIds || []).join(",")}:${(item.worklogIds || []).join(",")}:${(item.compactionIds || []).join(",")}`;
        }
        if (kind === "worklog") {
          const children = Array.isArray(item.children) ? item.children : [];
          return `${item.id}:worklog:${item.operationKind}:${item.status}:${item.title}:${children.length}:${item.updatedAt || ""}:${children.map((child) => `${child.id}:${child.status}:${child.title}:${String(child.outputPreview || "").length}:${child.completedAt || ""}`).join(",")}`;
        }
        if (kind === "diff") {
          const files = Array.isArray(item.files) ? item.files : [];
          return `${item.id}:diff:${files.length}:${item.additions}:${item.deletions}:${item.updatedAt || ""}:${files.map((file) => `${file.path}:${file.additions}:${file.deletions}:${String(file.diff || "").length}`).join(",")}`;
        }
        if (kind === "plan") {
          return `${item.id}:plan:${String(item.markdown || "").length}:${item.updatedAt || ""}`;
        }
        if (kind === "clarification") {
          const options = Array.isArray(item.options) ? item.options : [];
          return `${item.id}:clarification:${String(item.question || "").length}:${options.length}:${item.updatedAt || ""}`;
        }
        if (kind === "compaction") {
          return `${item.id}:compaction:${item.label || ""}`;
        }
        if (kind === "connection") {
          return `${item.id}:connection:${item.message || ""}:${item.status || ""}:${item.attempt || ""}`;
        }
        if (kind === "error") {
          return `${item.id}:error:${item.message || ""}:${item.details || ""}`;
        }
        return `${item.id}:${kind}`;
      })
    ].join("|");
  }

  function isNearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 160;
  }

  function isAtTranscriptTail(element) {
    return isNearBottom(element) && !(state.transcriptWindow && state.transcriptWindow.hasAfter);
  }

  function captureTranscriptAnchor(body) {
    if (!body) {
      return null;
    }
    const bodyRect = body.getBoundingClientRect();
    const items = Array.from(body.querySelectorAll("[data-item-id]"));
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom >= bodyRect.top + 1) {
        return {
          id: item.dataset.itemId || "",
          offset: rect.top - bodyRect.top
        };
      }
    }
    return null;
  }

  function restoreTranscriptAnchor(body, anchor) {
    if (!body || !anchor || !anchor.id) {
      return false;
    }
    const item = Array.from(body.querySelectorAll("[data-item-id]")).find((candidate) => candidate.dataset.itemId === anchor.id);
    if (!item) {
      return false;
    }
    const bodyRect = body.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    body.scrollTop += rect.top - bodyRect.top - anchor.offset;
    return true;
  }

  function markTranscriptUserNavigation(direction) {
    state.lastTranscriptUserNavigationAt = Date.now();
    state.lastTranscriptNavigationDirection = direction || "both";
  }

  function wasRecentTranscriptUserNavigation() {
    return Date.now() - state.lastTranscriptUserNavigationAt < 900;
  }

  function maybeRequestTranscriptWindow(body, options) {
    const windowState = state.transcriptWindow;
    if (!body || !windowState || !state.snapshot || !state.snapshot.chat) {
      return;
    }
    const userInitiated = Boolean(options && options.userInitiated);
    if (!userInitiated) {
      return;
    }

    const direction = options && options.direction ? options.direction : "both";
    const nearBottom = isNearBottom(body);
    const canLoadBefore = direction !== "after" && (!nearBottom || direction === "before");
    if (canLoadBefore && body.scrollTop < TRANSCRIPT_LOAD_THRESHOLD && windowState.hasBefore && !state.loadingBefore) {
      const beforeItemId = windowState.firstItemId || windowState.items?.[0]?.id;
      if (beforeItemId) {
        state.loadingBefore = true;
        state.pendingScrollAnchor = captureTranscriptAnchor(body);
        vscode.postMessage({
          type: "command",
          command: "chat.transcript.loadBefore",
          payload: { beforeItemId, count: TRANSCRIPT_PAGE_SIZE }
        });
      }
    }

    const distanceToBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (direction !== "before" && distanceToBottom < TRANSCRIPT_LOAD_THRESHOLD && windowState.hasAfter && !state.loadingAfter && !state.scrollToBottomAfterWindow) {
      const afterItemId = windowState.lastItemId || windowState.items?.[windowState.items.length - 1]?.id;
      if (afterItemId) {
        state.loadingAfter = true;
        state.pendingScrollAnchor = captureTranscriptAnchor(body);
        vscode.postMessage({
          type: "command",
          command: "chat.transcript.loadAfter",
          payload: { afterItemId, count: TRANSCRIPT_PAGE_SIZE }
        });
      }
    }
  }

  function restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged, anchor) {
    if (state.scrollToBottomAfterWindow || shouldStickToBottom) {
      state.scrollToBottomAfterWindow = false;
      scrollTranscriptToBottom(body, end);
      return;
    }

    if (!restoreTranscriptAnchor(body, anchor)) {
      body.scrollTop = Math.min(previousScrollTop, body.scrollHeight);
    }
    if (transcriptChanged) {
      state.stickToBottom = isAtTranscriptTail(body);
    }
  }

  function scrollTranscriptToBottom(body, end, smooth) {
    state.suppressScrollEvents = true;
    const behavior = smooth ? "smooth" : "auto";
    if (typeof body.scrollTo === "function") {
      body.scrollTo({ top: body.scrollHeight, behavior });
    } else {
      body.scrollTop = body.scrollHeight;
    }
    if (end && typeof end.scrollIntoView === "function") {
      end.scrollIntoView({ block: "end", behavior });
    }
    const settle = () => {
      body.scrollTop = body.scrollHeight;
      if (end && typeof end.scrollIntoView === "function") {
        end.scrollIntoView({ block: "end" });
      }
      state.stickToBottom = true;
      state.suppressScrollEvents = false;
      updateScrollToBottomButton(body);
    };
    if (smooth) {
      window.setTimeout(settle, 260);
    } else {
      requestAnimationFrame(settle);
    }
  }

  function updateScrollToBottomButton(body) {
    syncComposerHeight();
    if (!body) {
      return;
    }
    const hasOverflow = body.scrollHeight - body.clientHeight > 24;
    const hasAfter = Boolean(state.transcriptWindow && state.transcriptWindow.hasAfter);
    const visible = hasAfter || (hasOverflow && !isNearBottom(body));
    state.showScrollToBottom = visible;
    const button = root.querySelector("[data-role='scroll-to-bottom']");
    if (button) {
      button.classList.toggle("visible", visible);
    }
  }

  function syncComposerHeight() {
    const app = root.querySelector(".app");
    const footer = root.querySelector(".composer");
    if (!app || !footer) {
      return;
    }
    app.style.setProperty("--composer-height", `${Math.ceil(footer.getBoundingClientRect().height)}px`);
  }

  function syncLiveDurationTimer() {
    updateLiveDurationNodes();
    const hasLiveNodes = Boolean(root.querySelector("[data-live-duration]"));
    if (hasLiveNodes && !state.liveDurationTimer) {
      state.liveDurationTimer = window.setInterval(updateLiveDurationNodes, 1000);
    }
    if (!hasLiveNodes && state.liveDurationTimer) {
      window.clearInterval(state.liveDurationTimer);
      state.liveDurationTimer = 0;
    }
  }

  function updateLiveDurationNodes() {
    root.querySelectorAll("[data-live-duration]").forEach((node) => {
      const mode = node.dataset.liveDuration || "";
      const createdAt = node.dataset.createdAt || "";
      if (mode === "turn-running" || mode === "assistant-streaming") {
        node.textContent = turnRunningLabel(createdAt);
        return;
      }
      if (mode === "activity-time") {
        node.textContent = elapsedLabel(createdAt);
      }
    });
  }

  function notifyReadToBottomIfNeeded(body, snapshot) {
    if (!snapshot.chat.hasUnread || !isNearBottom(body) || (state.transcriptWindow && state.transcriptWindow.hasAfter)) {
      return;
    }
    const readSignal = `${snapshot.chat.id}:${snapshot.chat.updatedAt}`;
    if (state.lastReadSignal === readSignal) {
      return;
    }
    state.lastReadSignal = readSignal;
    vscode.postMessage({ type: "command", command: "chat.readToBottom" });
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

  function containsClarificationMarker(text) {
    return /<codex_clarification>/i.test(String(text || ""));
  }

  function normalizeCodeLanguage(language) {
    const value = String(language || "").trim().toLowerCase();
    if (!value) return "";
    if (["yml", "yaml"].includes(value)) return "yaml";
    if (["json", "jsonc"].includes(value)) return "json";
    if (["ts", "tsx", "js", "jsx", "javascript", "typescript"].includes(value)) return value.startsWith("ts") || value === "typescript" ? "typescript" : "javascript";
    if (["sh", "bash", "shell", "zsh"].includes(value)) return "shell";
    if (["ps1", "powershell", "pwsh"].includes(value)) return "powershell";
    if (["xbsl", "bsl", "1c", "1c-element", "element"].includes(value)) return "xbsl";
    if (["diff", "patch"].includes(value)) return "diff";
    return value.replace(/[^a-z0-9_-]/g, "");
  }

  function languageFromPath(path) {
    const value = String(path || "").toLowerCase();
    if (value.endsWith(".yaml") || value.endsWith(".yml")) return "yaml";
    if (value.endsWith(".json") || value.endsWith(".jsonc")) return "json";
    if (value.endsWith(".ts") || value.endsWith(".tsx")) return "typescript";
    if (value.endsWith(".js") || value.endsWith(".jsx")) return "javascript";
    if (value.endsWith(".ps1")) return "powershell";
    if (value.endsWith(".sh") || value.endsWith(".bash") || value.endsWith(".zsh")) return "shell";
    if (value.endsWith(".xbsl") || value.endsWith(".bsl")) return "xbsl";
    return "";
  }

  function wordPattern(words) {
    return `(^|[^\\p{L}\\p{N}_])(${words.join("|")})(?=$|[^\\p{L}\\p{N}_])`;
  }

  function highlightRules(language) {
    const lang = normalizeCodeLanguage(language);
    const xbslControls = ["абстрактный", "импорт", "иначе\\s+если", "если", "иначе", "пока", "для", "по", "из", "до", "вниз", "шаг", "попытка", "поймать", "вконце", "прервать", "продолжить", "выбросить", "возврат", "не", "и", "или", "как", "это", "этот", "когда", "выбор", "новый"];
    const xbslDeclarations = ["метод", "структура", "перечисление", "контракт", "исключение"];
    const xbslModifiers = ["пер", "знч", "обз", "исп", "конст", "статический"];
    if (lang === "xbsl") {
      return [
        { className: "comment", regex: /\/\/.*$/gu },
        { className: "string", regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu },
        { className: "annotation", regex: /@[A-ZА-ЯЁa-zа-яё_][A-ZА-ЯЁa-zа-яё0-9_]*/gu },
        { className: "function", regex: new RegExp(wordPattern(["метод"]) + "\\s+([\\p{L}_][\\p{L}\\p{N}_]*)", "giu"), group: 3 },
        { className: "type", regex: new RegExp(wordPattern(["структура", "перечисление", "контракт", "исключение"]) + "\\s+([\\p{L}_][\\p{L}\\p{N}_]*)", "giu"), group: 3 },
        { className: "keyword", regex: new RegExp(wordPattern(xbslControls), "giu"), group: 2 },
        { className: "declaration", regex: new RegExp(wordPattern(xbslDeclarations), "giu"), group: 2 },
        { className: "modifier", regex: new RegExp(wordPattern(xbslModifiers), "giu"), group: 2 },
        { className: "constant", regex: new RegExp(wordPattern(["Истина", "Ложь", "Неопределено", "ничто", "неизвестно", "никогда", "Авто"]), "gu"), group: 2 },
        { className: "number", regex: /\b\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?\b/gu },
        { className: "type", regex: /(:\s*)([A-ZА-ЯЁa-zа-яё_][A-ZА-ЯЁa-zа-яё0-9_]*(?:(?:::|\.)[A-ZА-ЯЁa-zа-яё_][A-ZА-ЯЁa-zа-яё0-9_]*)*)/gu, group: 2 },
        { className: "function", regex: /([A-ZА-ЯЁa-zа-яё_][A-ZА-ЯЁa-zа-яё0-9_]*)(?=\s*\()/gu }
      ];
    }
    if (lang === "yaml") {
      return [
        { className: "comment", regex: /#.*$/gu },
        { className: "string", regex: /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/gu },
        { className: "property", regex: /^(\s*-?\s*)([A-ZА-ЯЁa-zа-яё0-9_.-]+)(?=\s*:)/gu, group: 2 },
        { className: "constant", regex: /\b(true|false|null|yes|no|on|off)\b/giu },
        { className: "number", regex: /(^|[^\w.-])(-?\d+(?:\.\d+)?)(?=$|[^\w.-])/gu, group: 2 }
      ];
    }
    if (lang === "json") {
      return [
        { className: "property", regex: /"(?:\\.|[^"\\])*"(?=\s*:)/gu },
        { className: "string", regex: /"(?:\\.|[^"\\])*"/gu },
        { className: "constant", regex: /\b(true|false|null)\b/gu },
        { className: "number", regex: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/giu }
      ];
    }
    if (lang === "typescript" || lang === "javascript") {
      return [
        { className: "comment", regex: /\/\/.*$/gu },
        { className: "string", regex: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu },
        { className: "keyword", regex: /\b(async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|interface|let|new|private|protected|public|return|static|switch|throw|try|type|typeof|var|void|while|yield)\b/gu },
        { className: "constant", regex: /\b(true|false|null|undefined)\b/gu },
        { className: "number", regex: /\b\d+(?:\.\d+)?\b/gu },
        { className: "function", regex: /([A-Za-z_$][\w$]*)(?=\s*\()/gu }
      ];
    }
    if (lang === "shell" || lang === "powershell") {
      return [
        { className: "comment", regex: /#.*$/gu },
        { className: "string", regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu },
        { className: "variable", regex: /\$[A-Za-z_][\w-]*/gu },
        { className: "keyword", regex: /\b(if|then|else|fi|for|do|done|while|function|param|process|begin|end)\b/giu },
        { className: "property", regex: /(^|\s)(--?[A-Za-z][\w-]*)(?=$|\s|=)/gu, group: 2 },
        { className: "number", regex: /\b\d+(?:\.\d+)?\b/gu }
      ];
    }
    return [];
  }

  function collectHighlightRanges(line, rules) {
    const ranges = [];
    for (const rule of rules) {
      const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
      const regex = new RegExp(rule.regex.source, flags);
      let match;
      while ((match = regex.exec(line))) {
        const group = rule.group || 0;
        const text = match[group] || "";
        if (!text) {
          if (regex.lastIndex === match.index) regex.lastIndex += 1;
          continue;
        }
        const start = match.index + String(match[0]).indexOf(text);
        const end = start + text.length;
        const overlaps = ranges.some((range) => start < range.end && end > range.start);
        if (!overlaps) {
          ranges.push({ start, end, className: rule.className });
        }
        if (regex.lastIndex === match.index) regex.lastIndex += 1;
      }
    }
    return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  }

  function highlightCodeLine(line, language) {
    const rules = highlightRules(language);
    if (!rules.length || !line) {
      return escapeHtml(line);
    }
    const ranges = collectHighlightRanges(line, rules);
    if (!ranges.length) {
      return escapeHtml(line);
    }
    let cursor = 0;
    let html = "";
    for (const range of ranges) {
      if (range.start < cursor) continue;
      html += escapeHtml(line.slice(cursor, range.start));
      html += `<span class="syntax-token token-${range.className}">${escapeHtml(line.slice(range.start, range.end))}</span>`;
      cursor = range.end;
    }
    html += escapeHtml(line.slice(cursor));
    return html;
  }

  function highlightCode(value, language) {
    const lang = normalizeCodeLanguage(language);
    if (lang === "diff") {
      return renderDiff(value);
    }
    return String(value || "")
      .split("\n")
      .map((line) => highlightCodeLine(line, lang))
      .join("\n");
  }

  function markdown(value) {
    const text = String(value || "");
    if (!text.trim()) {
      return "";
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let list = [];
    let inCode = false;
    let codeLines = [];
    let codeLanguage = "";
    let table = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${markdownInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      html.push(`<ul>${list.map((item) => `<li>${markdownInline(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    const flushTable = () => {
      if (!table.length) return;
      const rendered = renderMarkdownTable(table);
      if (rendered) {
        html.push(rendered);
      } else {
        html.push(...table.map((row) => `<p>${markdownInline(row.trim())}</p>`));
      }
      table = [];
    };
    const flushCode = () => {
      const lang = normalizeCodeLanguage(codeLanguage);
      const languageClass = lang ? ` language-${escapeAttribute(lang)}` : "";
      html.push(`<pre class="code-block${languageClass}"><code>${highlightCode(codeLines.join("\n"), lang)}</code></pre>`);
      codeLines = [];
      codeLanguage = "";
    };

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (inCode) {
          flushCode();
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          flushTable();
          inCode = true;
          codeLanguage = line.trim().slice(3).trim().split(/\s+/)[0] || "";
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        flushTable();
        continue;
      }
      if (isPotentialMarkdownTableLine(line)) {
        flushParagraph();
        flushList();
        table.push(line);
        continue;
      }
      flushTable();
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(4, heading[1].length + 2);
        html.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        list.push(bullet[1]);
        continue;
      }
      const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (numbered) {
        flushParagraph();
        list.push(numbered[1]);
        continue;
      }
      paragraph.push(line.trim());
    }
    if (inCode) flushCode();
    flushParagraph();
    flushList();
    flushTable();
    return html.join("");
  }

  function isPotentialMarkdownTableLine(line) {
    const value = String(line || "").trim();
    return value.includes("|") && !value.startsWith("```");
  }

  function splitMarkdownTableRow(line) {
    let value = String(line || "").trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    const cells = [];
    let cell = "";
    let escaped = false;
    for (const char of value) {
      if (escaped) {
        cell += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        cell += char;
        escaped = true;
        continue;
      }
      if (char === "|") {
        cells.push(cell.trim());
        cell = "";
        continue;
      }
      cell += char;
    }
    cells.push(cell.trim());
    return cells;
  }

  function parseMarkdownTableSeparator(line) {
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 2 || !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))) {
      return undefined;
    }
    return cells.map((cell) => {
      const value = cell.replace(/\s+/g, "");
      if (value.startsWith(":") && value.endsWith(":")) return "center";
      if (value.endsWith(":")) return "right";
      return "left";
    });
  }

  function renderMarkdownTable(rows) {
    if (rows.length < 2) return "";
    const align = parseMarkdownTableSeparator(rows[1]);
    if (!align) return "";
    const header = splitMarkdownTableRow(rows[0]);
    const bodyRows = rows.slice(2).filter((row) => row.trim()).map(splitMarkdownTableRow);
    const columnCount = Math.max(header.length, align.length, ...bodyRows.map((row) => row.length));
    if (columnCount < 2) return "";
    const cellAlignClass = (index) => align[index] ? ` align-${align[index]}` : "";
    const normalizeCells = (cells) => Array.from({ length: columnCount }, (_unused, index) => cells[index] || "");
    return `
      <div class="markdown-table-wrap">
        <table>
          <thead>
            <tr>${normalizeCells(header).map((cell, index) => `<th class="${cellAlignClass(index)}">${markdownInline(cell)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${bodyRows.map((row) => `<tr>${normalizeCells(row).map((cell, index) => `<td class="${cellAlignClass(index)}">${markdownInline(cell)}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function markdownInline(value) {
    return String(value || "")
      .split(/(`[^`]+`)/g)
      .map((part) => {
        if (!part) return "";
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        }
        return markdownInlineText(part);
      })
      .join("");
  }

  function markdownInlineText(value) {
    return escapeHtml(value)
      .replace(/\[([^\]\n]+)\]\(([^)\s]+(?:\s+&quot;[^&]*&quot;)?)\)/g, (_match, label, target) => {
        const cleanTarget = String(target || "").replace(/\s+&quot;[^&]*&quot;$/, "");
        return `<button class="markdown-link-button" type="button" data-command="markdown.openLink" data-target="${escapeAttribute(decodeHtmlEntities(cleanTarget))}">${label}</button>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function decodeHtmlEntities(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#96;/g, "`");
  }

  function renderDiff(diff, filePath) {
    const language = normalizeCodeLanguage(languageFromPath(filePath));
    return String(diff || "")
      .split("\n")
      .map((line) => {
        const css = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : "context";
        if (css === "hunk" || line.startsWith("+++") || line.startsWith("---")) {
          return `<span class="diff-line ${css}">${escapeHtml(line || " ")}</span>`;
        }
        const prefix = /^[+\- ]/.test(line) ? line[0] : "";
        const body = prefix ? line.slice(1) : line;
        return `<span class="diff-line ${css}">${prefix ? `<span class="diff-prefix">${escapeHtml(prefix)}</span>` : ""}<span class="diff-content">${highlightCode(body || " ", language)}</span></span>`;
      })
      .join("");
  }

  function activityIcon(kind) {
    const path = kind === "search"
      ? "M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24-1.4 1.4-4.24-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"
      : kind === "file"
        ? "M6 2h8l5 5v15H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm7 2H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h11V8h-4V4Z"
        : kind === "reasoning"
          ? "M12 2a7 7 0 0 1 4 12.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26A7 7 0 0 1 12 2Zm-2 19h4v2h-4v-2Z"
          : "M4 4h16v16H4V4Zm2 2v12h12V6H6Zm2 3 4 3-4 3v-2l2-1-2-1V9Zm5 6h4v1.5h-4V15Z";
    return `<svg class="activity-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
  }

  function isHiddenActivity(item) {
    const label = String(item.label || "").trim();
    return (
      label === "userMessage"
      || label === "agentMessage"
      || label === "hookPrompt"
      || label === "contextCompaction"
      || label === "plan"
      || (item.activityKind === "unknown" && /^userMessage\b/i.test(label))
      || item.activityKind === "unknown"
      || (item.activityKind === "reasoning" && item.status === "completed" && !String(item.summary || "").trim() && !String(item.outputPreview || "").trim())
    );
  }

  function activityLabelHtml(item) {
    if (item.status === "running" && item.activityKind === "turn") {
      return `<span data-live-duration="turn-running" data-created-at="${escapeAttribute(item.createdAt || "")}">${escapeHtml(turnRunningLabel(item.createdAt))}</span>`;
    }
    if (item.status === "completed" && item.activityKind === "turn") {
      return escapeHtml(turnCompletedLabel(item));
    }
    if (item.status === "error" && item.activityKind === "turn") {
      return escapeHtml("Завершено с ошибкой");
    }
    return escapeHtml(normalizeActivityLabel(item));
  }

  function activityTimeHtml(item) {
    if (item.activityKind === "turn") {
      return "";
    }
    if (item.status === "running") {
      return `<span class="activity-time" data-live-duration="activity-time" data-created-at="${escapeAttribute(item.createdAt || "")}">${escapeHtml(elapsedLabel(item.createdAt))}</span>`;
    }
    const duration = durationLabel(item.createdAt, item.completedAt || item.updatedAt, { hideZero: true });
    return duration ? `<span class="activity-time">${escapeHtml(duration)}</span>` : "";
  }

  function normalizeActivityLabel(item) {
    const label = String(item.label || "").trim();
    if (item.activityKind === "command") {
      const command = formatCommandSummary(item.command || label);
      if (item.status === "completed") {
        return command ? `Выполнена команда ${command}` : "Выполнена команда";
      }
      if (item.status === "error") {
        return command ? `Команда завершилась с ошибкой: ${command}` : "Команда завершилась с ошибкой";
      }
      return command ? `Выполняется ${command}` : "Выполняется команда";
    }
    if (item.status === "completed") {
      if (item.activityKind === "file") return item.path ? `Изменён ${item.path}` : "Изменены файлы";
      if (item.activityKind === "search") return item.summary || "Выполнен поиск";
      if (item.activityKind === "reasoning") return item.summary || "Думал";
      if (item.activityKind === "context") return item.summary || "Контекст обработан";
      if (item.activityKind === "tool") return item.summary || "Инструмент выполнен";
    }
    if (item.status === "error") {
      return label || "Действие завершилось с ошибкой";
    }
    return label || "Действие Codex";
  }

  function activityOutputPreviewHtml(item) {
    const preview = safeActivityOutputPreview(item);
    return preview ? `<pre class="activity-output">${escapeHtml(preview)}</pre>` : "";
  }

  function isActivityExpandable(item) {
    if (!item || item.activityKind === "turn") {
      return false;
    }
    const details = Array.isArray(item.details) ? item.details.filter(Boolean) : [];
    return Boolean(details.length || item.command || item.path || item.summary || safeActivityOutputPreview(item));
  }

  function isActivityExpanded(activityId) {
    return Boolean(activityId && state.expandedActivities[activityId]);
  }

  function toggleActivity(activityId) {
    if (!activityId) {
      return;
    }
    if (state.expandedActivities[activityId]) {
      delete state.expandedActivities[activityId];
    } else {
      state.expandedActivities[activityId] = true;
    }
    render();
  }

  function activityDetailsHtml(item) {
    const details = Array.isArray(item.details) && item.details.length
      ? item.details
      : [activityDetailFromItem(item)];
    const visible = details
      .filter(Boolean)
      .slice(0, 12);
    if (!visible.length) {
      return "";
    }
    if (visible.length === 1 && visible[0].activityKind === "command") {
      return activityCommandDetailHtml(visible[0]);
    }
    return `
      <div class="activity-details">
        ${visible.map(activityDetailLineHtml).join("")}
      </div>
    `;
  }

  function activityDetailLineHtml(detail) {
    const kind = detail.activityKind || "tool";
    const summary = activityDetailSummary(detail);
    const output = safeActivityDetailOutputPreview(detail);
    return `
      <div class="activity-detail-line ${escapeAttribute(kind)}">
        ${activityIcon(kind)}
        <div class="activity-detail-body">
          <div class="activity-detail-title">${escapeHtml(activityDetailTitle(detail))}</div>
          ${summary ? `<div class="activity-detail-summary">${escapeHtml(summary)}</div>` : ""}
          ${output ? `<pre class="activity-detail-output">${escapeHtml(output)}</pre>` : ""}
        </div>
      </div>
    `;
  }

  function activityCommandDetailHtml(detail) {
    const command = stripCommandLabelPrefix(detail.command || detail.label || "");
    const output = safeActivityDetailOutputPreview(detail);
    return `
      <div class="activity-details">
        <div class="activity-shell-card">
          <div class="activity-shell-kicker">Shell</div>
          <pre class="activity-shell-output">${escapeHtml(command ? `$ ${command}` : "$ команда")}${output ? `\n\n${escapeHtml(output)}` : "\n\nНет вывода"}</pre>
          <div class="activity-shell-status">${detail.status === "error" ? "Ошибка" : "✓ Успех"}</div>
        </div>
      </div>
    `;
  }

  function activityDetailTitle(detail) {
    if (detail.activityKind === "command") {
      const command = formatCommandSummary(detail.command || detail.label);
      return command ? `Запущен ${command}` : "Запущена команда";
    }
    if (detail.activityKind === "search") {
      return detail.label || "Выполнен поиск";
    }
    if (detail.activityKind === "file") {
      return detail.path ? `Изменён ${detail.path}` : detail.label || "Изменены файлы";
    }
    if (detail.activityKind === "reasoning") {
      return detail.label || "Думаю";
    }
    return detail.label || "Действие Codex";
  }

  function activityDetailSummary(detail) {
    const parts = [];
    if (detail.path && detail.activityKind !== "file") {
      parts.push(`Путь: ${detail.path}`);
    }
    if (detail.summary && detail.summary !== detail.label) {
      parts.push(detail.summary);
    }
    return parts.join("\n");
  }

  function safeActivityDetailOutputPreview(detail) {
    const preview = String(detail.outputPreview || "").trim();
    if (!preview || looksLikeMojibake(preview)) {
      return "";
    }
    return preview.length > 2000 ? `${preview.slice(0, 2000)}\n...` : preview;
  }

  function safeActivityOutputPreview(item) {
    const preview = String(item.outputPreview || "").trim();
    if (!preview) {
      return "";
    }
    if (item.activityKind === "command") {
      return "";
    }
    if (looksLikeMojibake(preview)) {
      return "";
    }
    return preview.length > 2000 ? `${preview.slice(0, 2000)}\n...` : preview;
  }

  function looksLikeMojibake(text) {
    const sample = text.slice(0, 2000);
    const matches = sample.match(/(?:Р.|С.|Ð|Ñ|Â|�)/g) || [];
    return matches.length >= 6 || matches.length / Math.max(sample.length, 1) > 0.025;
  }

  function formatCommandSummary(command) {
    const raw = stripCommandLabelPrefix(String(command || "").trim());
    if (!raw) {
      return "";
    }
    const powershell = extractPowerShellCommand(raw);
    const summary = powershell ? `PowerShell: ${simplifyShellCommand(powershell)}` : simplifyShellCommand(raw);
    return shortenMiddle(summary, 120);
  }

  function stripCommandLabelPrefix(value) {
    return value
      .replace(/^Выполняется\s+/i, "")
      .replace(/^Выполнен[ао]?\s+(?:команда\s+)?/i, "")
      .replace(/^Команда завершилась с ошибкой:\s*/i, "")
      .trim();
  }

  function extractPowerShellCommand(command) {
    const normalized = command.replace(/\\"/g, '"');
    if (!/powershell(?:\.exe)?/i.test(normalized) || !/\s-Command\s/i.test(normalized)) {
      return "";
    }
    const quoted = normalized.match(/\s-Command\s+(['"])([\s\S]*?)\1/i);
    if (quoted && quoted[2]) {
      return quoted[2].trim();
    }
    const plain = normalized.match(/\s-Command\s+([\s\S]*)$/i);
    return plain?.[1]?.trim() || "";
  }

  function simplifyShellCommand(command) {
    return command
      .replace(/^(['"])([\s\S]*)\1$/, "$2")
      .replace(/\s+/g, " ")
      .replace(/\bGet-Content\s+-Raw\b/ig, "Get-Content")
      .trim();
  }

  function shortenMiddle(value, maxLength) {
    if (value.length <= maxLength) {
      return value;
    }
    const head = Math.max(20, Math.floor((maxLength - 3) * 0.58));
    const tail = Math.max(12, maxLength - head - 3);
    return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
  }

  function turnRunningLabel(createdAt) {
    const elapsed = elapsedLabel(createdAt);
    return elapsed ? `Работает уже ${elapsed}` : "Работает";
  }

  function turnCompletedLabel(item) {
    const duration = durationLabel(item.createdAt, item.completedAt || item.updatedAt, { hideZero: true });
    return duration ? `Работал на протяжении ${duration}` : "Работал";
  }

  function messageDurationHtml(item) {
    if (item.status === "streaming") {
      return `<span data-live-duration="assistant-streaming" data-created-at="${escapeAttribute(item.createdAt || "")}">${escapeHtml(turnRunningLabel(item.createdAt))}</span>`;
    }
    return item.durationMs ? `<span>${escapeHtml(`Работал на протяжении ${formatDuration(item.durationMs)}`)}</span>` : "";
  }

  function elapsedLabel(createdAt) {
    const start = Date.parse(createdAt || "");
    if (!Number.isFinite(start)) return "";
    return formatDuration(Date.now() - start);
  }

  function durationLabel(createdAt, completedAt, options) {
    const start = Date.parse(createdAt || "");
    const end = Date.parse(completedAt || "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
    if (options && options.hideZero && end - start < 1000) return "";
    return formatDuration(end - start);
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }

  function formatFilesCount(count) {
    if (count % 10 === 1 && count % 100 !== 11) return `${count} файл`;
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return `${count} файла`;
    return `${count} файлов`;
  }

  function connectionStatusLabel(item) {
    if (item.status === "failed") return "Соединение не восстановлено";
    if (item.status === "recovered") return "Соединение восстановлено";
    return item.attempt && item.maxAttempts ? `Повторное подключение... ${item.attempt}/${item.maxAttempts}` : "Повторное подключение...";
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
