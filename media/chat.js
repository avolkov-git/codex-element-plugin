(function () {
  if (window.__codexElementAppReady) {
    return;
  }
  window.__codexElementAppReady = true;
  const assetMode = window.__codexElementWebviewAssetMode || "external";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const TRANSCRIPT_INITIAL_WINDOW_SIZE = 120;
  const TRANSCRIPT_PAGE_SIZE = 40;
  const TRANSCRIPT_MAX_RENDERED_ITEMS = 120;
  const TRANSCRIPT_ACTIVE_SCROLL_BUFFER_ITEMS = 200;
  const TRANSCRIPT_LOAD_THRESHOLD = 640;
  const TRANSCRIPT_SCROLL_IDLE_MS = 520;
  const ATTACHMENT_MAX_COUNT = 10;
  const ATTACHMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;
  const ATTACHMENT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const ATTACHMENT_UPLOAD_CHUNK_BYTES = 512 * 1024;
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
    skillOptions: [],
    skillsStatus: "idle",
    skillsError: "",
    selectedSkillsByChat: Object.create(null),
    attachmentsByChat: Object.create(null),
    pendingAttachmentUploads: Object.create(null),
    attachmentsStatus: "idle",
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
    pendingTranscriptWindowRequest: null,
    pendingTranscriptWindowTimer: 0,
    transcriptWindowTrimTimer: 0,
    nextTranscriptWindowRequestId: 1,
    scrollToBottomAfterWindow: false,
    lastTranscriptUserNavigationAt: 0,
    lastTranscriptNavigationDirection: "after",
    lastTranscriptScrollTop: 0,
    lastTranscriptStructureSignature: "",
    lastChromeSignature: "",
    allowStreamingPatch: false,
    bindCommandButtons: null
  };

  const syntaxHighlightObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          enhanceSyntaxHighlighting(node);
        }
      }
    }
  });
  syntaxHighlightObserver.observe(root, { childList: true, subtree: true });
  window.addEventListener("codex-xbsl-highlighter-ready", () => {
    enhanceSyntaxHighlighting(root);
  });

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
      const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
      state.notice = payload ? String(payload.message || "") : String(message.payload || "");
      if (payload && typeof payload.restorePrompt === "string" && state.snapshot && state.snapshot.chat) {
        setDraft(state.snapshot.chat.id, payload.restorePrompt);
      }
      if (payload && Array.isArray(payload.restoreAttachments) && state.snapshot && state.snapshot.chat) {
        setAttachments(state.snapshot.chat.id, payload.restoreAttachments);
      }
      render();
    }
    if (message.type === "event" && message.event === "chat.attachments.selected") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const chatId = typeof payload.chatId === "string" ? payload.chatId : state.snapshot && state.snapshot.chat ? state.snapshot.chat.id : "";
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : Array.isArray(message.payload) ? message.payload : [];
      if (chatId) {
        setAttachments(chatId, attachments);
      }
      state.attachmentsStatus = "idle";
      render();
    }
    if (message.type === "event" && message.event === "chat.attachments.error") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      state.attachmentsStatus = "idle";
      state.notice = String(payload.message || message.payload || "Не удалось прикрепить файл.");
      render();
    }
    if (message.type === "event" && message.event === "chat.attachment.upload.ready") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const uploadId = typeof payload.uploadId === "string" ? payload.uploadId : "";
      const pending = state.pendingAttachmentUploads[uploadId];
      if (pending) {
        pending.status = "uploading";
        void sendNextAttachmentChunk(uploadId);
      }
    }
    if (message.type === "event" && message.event === "chat.attachment.upload.chunkAccepted") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const uploadId = typeof payload.uploadId === "string" ? payload.uploadId : "";
      const pending = state.pendingAttachmentUploads[uploadId];
      if (pending) {
        pending.offset = Number(payload.receivedBytes) || pending.offset;
        pending.chunkIndex = Number(payload.chunkIndex) + 1;
        updatePendingAttachmentProgress(uploadId);
        void sendNextAttachmentChunk(uploadId);
      }
    }
    if (message.type === "event" && message.event === "chat.attachment.upload.completed") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const uploadId = payload.attachment && typeof payload.attachment.id === "string" ? payload.attachment.id : "";
      const pending = state.pendingAttachmentUploads[uploadId];
      const chatId = typeof payload.chatId === "string" ? payload.chatId : pending ? pending.chatId : "";
      if (uploadId) {
        delete state.pendingAttachmentUploads[uploadId];
      }
      if (chatId && payload.attachment) {
        setAttachments(chatId, [...getAttachments(chatId), payload.attachment]);
      }
      render();
    }
    if (message.type === "event" && message.event === "chat.attachment.upload.error") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const uploadId = typeof payload.uploadId === "string" ? payload.uploadId : "";
      if (uploadId) {
        delete state.pendingAttachmentUploads[uploadId];
      }
      state.notice = String(payload.message || "Не удалось загрузить файл.");
      render();
    }
    if (message.type === "event" && message.event === "chat.context.details") {
      state.contextDetails = message.payload || null;
      state.contextPopup = state.contextDetails && state.contextDetails.kind ? state.contextDetails.kind : state.contextPopup;
      state.contextDetailsLoading = false;
      render();
    }
    if (message.type === "event" && message.event === "chat.skills.options") {
      state.skillOptions = Array.isArray(message.payload) ? message.payload : [];
      state.skillsStatus = "ready";
      state.skillsError = "";
      reconcileSelectedSkills();
      render();
    }
    if (message.type === "event" && message.event === "chat.skills.error") {
      state.skillsStatus = "error";
      state.skillsError = String(message.payload || "Не удалось загрузить навыки.");
      render();
    }
    if (message.type === "event" && message.event === "chat.transcript.window") {
      const appliedMode = applyTranscriptWindowEvent(message.payload || {});
      if (appliedMode && patchTranscriptWindowDom(appliedMode)) {
        return;
      }
      if (appliedMode) {
        render();
      }
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
      clearPendingTranscriptWindowRequest();
      clearTranscriptWindowTrimTimer();
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
      clearPendingTranscriptWindowRequest();
      clearTranscriptWindowTrimTimer();
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
      return null;
    }
    if (payload.chatId && payload.chatId !== state.snapshot.chat.id) {
      return null;
    }

    const pendingRequest = state.pendingTranscriptWindowRequest;
    if (
      mode !== "tail"
      && payload.requestId
      && (!pendingRequest || payload.requestId !== pendingRequest.id)
    ) {
      return null;
    }

    if (mode === "tail" || !state.transcriptWindow) {
      state.transcriptWindow = incoming;
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingScrollAnchor = null;
      clearPendingTranscriptWindowRequest();
      state.scrollToBottomAfterWindow = mode === "tail";
      state.stickToBottom = true;
      state.showScrollToBottom = false;
      return "tail";
    }

    if (mode === "before") {
      state.pendingScrollAnchor = captureTranscriptAnchor(root.querySelector("[data-role='transcript']"), "before") || pendingRequest?.anchor || null;
      state.transcriptWindow = mergeTranscriptBefore(state.transcriptWindow, incoming);
      state.loadingBefore = false;
      clearPendingTranscriptWindowRequest();
      return "before";
    }

    if (mode === "after") {
      state.pendingScrollAnchor = captureTranscriptAnchor(root.querySelector("[data-role='transcript']"), "after") || pendingRequest?.anchor || null;
      state.transcriptWindow = mergeTranscriptAfter(state.transcriptWindow, incoming);
      state.loadingAfter = false;
      clearPendingTranscriptWindowRequest();
      return "after";
    }
    return null;
  }

  function transcriptBodyContents() {
    return `
      ${renderTranscriptWindow(getTranscriptWindow())}
      ${state.notice ? `<div class="event">${escapeHtml(state.notice)}</div>` : ""}
      <div class="transcript-end" data-role="transcript-end"></div>
    `;
  }

  function patchTranscriptWindowDom(mode, options) {
    const body = root.querySelector("[data-role='transcript']");
    const snapshot = state.snapshot;
    if (!body || !snapshot || !snapshot.chat || typeof state.bindCommandButtons !== "function") {
      return false;
    }

    const previousScrollTop = body.scrollTop;
    const anchor = state.pendingScrollAnchor || captureTranscriptAnchor(body, mode);
    state.suppressScrollEvents = true;
    body.innerHTML = transcriptBodyContents();
    state.bindCommandButtons(body);

    const end = body.querySelector("[data-role='transcript-end']");
    if (mode === "tail" || state.scrollToBottomAfterWindow) {
      state.scrollToBottomAfterWindow = false;
      body.scrollTop = body.scrollHeight;
      state.stickToBottom = true;
    } else if (!restoreTranscriptAnchor(body, anchor)) {
      body.scrollTop = mode === "before" ? 0 : Math.min(previousScrollTop, body.scrollHeight);
    }

    state.pendingScrollAnchor = null;
    state.lastTranscriptScrollTop = body.scrollTop;
    state.lastTranscriptSignature = transcriptSignature(snapshot);
    state.lastTranscriptStructureSignature = transcriptStructureSignature(snapshot);
    requestAnimationFrame(() => {
      state.suppressScrollEvents = false;
      state.lastTranscriptScrollTop = body.scrollTop;
      notifyReadToBottomIfNeeded(body, snapshot);
      updateScrollToBottomButton(body);
      if (!options || options.prefetch !== false) {
        maybeRequestTranscriptWindow(body, {
          userInitiated: wasRecentTranscriptUserNavigation(),
          direction: state.lastTranscriptNavigationDirection
        });
      }
      scheduleTranscriptWindowTrim(body);
    });
    return true;
  }

  function normalizeTranscriptWindow(raw) {
    let items = Array.isArray(raw && raw.items) ? raw.items.filter(Boolean) : [];
    let offset = typeof raw?.offset === "number" && Number.isFinite(raw.offset) ? Math.max(0, raw.offset) : 0;
    if (items.length > TRANSCRIPT_MAX_RENDERED_ITEMS) {
      const removeCount = items.length - TRANSCRIPT_MAX_RENDERED_ITEMS;
      items = items.slice(removeCount);
      offset += removeCount;
    }
    const firstItemId = items[0]?.id;
    const lastItemId = items[items.length - 1]?.id;
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
    if (!incomingItems.length) {
      return buildClientTranscriptWindow(
        currentItems,
        current.offset || 0,
        Math.max(current.totalCount || 0, incoming.totalCount || 0),
        incoming.hasBefore && incoming.offset === current.offset,
        current.hasAfter
      );
    }
    let items = [...incomingItems, ...currentItems];
    let offset = incoming.offset || 0;
    let hasBefore = incoming.hasBefore;
    let hasAfter = current.hasAfter;
    if (items.length > TRANSCRIPT_ACTIVE_SCROLL_BUFFER_ITEMS) {
      items = items.slice(0, TRANSCRIPT_ACTIVE_SCROLL_BUFFER_ITEMS);
      hasAfter = true;
    }
    return buildClientTranscriptWindow(items, offset, Math.max(current.totalCount || 0, incoming.totalCount || 0), hasBefore, hasAfter);
  }

  function mergeTranscriptAfter(current, incoming) {
    const currentItems = Array.isArray(current.items) ? current.items : [];
    const known = new Set(currentItems.map((item) => item.id));
    const incomingItems = (incoming.items || []).filter((item) => item && !known.has(item.id));
    if (!incomingItems.length) {
      return buildClientTranscriptWindow(
        currentItems,
        current.offset || 0,
        Math.max(current.totalCount || 0, incoming.totalCount || 0),
        current.hasBefore,
        incoming.hasAfter
      );
    }
    let items = [...currentItems, ...incomingItems];
    let offset = current.offset || 0;
    let hasBefore = current.hasBefore;
    let hasAfter = incoming.hasAfter;
    if (items.length > TRANSCRIPT_ACTIVE_SCROLL_BUFFER_ITEMS) {
      const removeCount = items.length - TRANSCRIPT_ACTIVE_SCROLL_BUFFER_ITEMS;
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
      clearPendingTranscriptWindowRequest();
      clearTranscriptWindowTrimTimer();
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
        <section class="body" data-role="transcript">${transcriptBodyContents()}</section>
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
        const currentScrollTop = body.scrollTop;
        if (state.suppressScrollEvents) {
          state.lastTranscriptScrollTop = currentScrollTop;
          return;
        }
        const delta = currentScrollTop - state.lastTranscriptScrollTop;
        if (Math.abs(delta) > 1) {
          markTranscriptUserNavigation(delta < 0 ? "before" : "after");
        }
        state.lastTranscriptScrollTop = currentScrollTop;
        state.stickToBottom = isAtTranscriptTail(body);
        maybeRequestTranscriptWindow(body, {
          userInitiated: wasRecentTranscriptUserNavigation(),
          direction: state.lastTranscriptNavigationDirection
        });
        scheduleTranscriptWindowTrim(body);
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
          scheduleTranscriptWindowTrim(body);
          notifyReadToBottomIfNeeded(body, snapshot);
          updateScrollToBottomButton(body);
        });
      });
      body.addEventListener("pointerdown", () => {
        state.lastTranscriptScrollTop = body.scrollTop;
      });
      requestAnimationFrame(() => {
        state.suppressScrollEvents = true;
        restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged, state.pendingScrollAnchor || previousAnchor);
        state.pendingScrollAnchor = null;
        state.lastTranscriptScrollTop = body.scrollTop;
        requestAnimationFrame(() => {
          state.suppressScrollEvents = false;
        });
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

    state.bindCommandButtons = (scope) => scope.querySelectorAll("[data-command]").forEach((button) => {
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
        if (command === "chat.attachments.toggle") {
          toggleMenu("attachments");
          return;
        }
        if (command === "chat.attachments.pick") {
          closeMenus();
          state.attachmentsStatus = "picking";
          vscode.postMessage({
            type: "command",
            command,
            payload: { attachments: getAttachments(snapshot.chat.id) }
          });
          render();
          return;
        }
        if (command === "chat.attachments.localPick") {
          state.openMenu = null;
          state.openModelSubmenu = null;
          const picker = root.querySelector("[data-role='local-attachment-input']");
          if (picker) {
            picker.click();
          }
          return;
        }
        if (command === "chat.attachment.upload.cancel") {
          cancelPendingAttachment(button.dataset.uploadId || "");
          return;
        }
        if (command === "chat.attachment.remove") {
          const attachment = getAttachments(snapshot.chat.id).find((candidate) => candidate.id === (button.dataset.attachmentId || ""));
          removeAttachment(snapshot.chat.id, button.dataset.attachmentId || "");
          if (attachment && attachment.source === "upload") {
            vscode.postMessage({ type: "command", command: "chat.attachment.discard", payload: { attachment } });
          }
          render();
          return;
        }
        if (command === "chat.attachment.open") {
          const attachment = findAttachment(snapshot, button.dataset.attachmentId || "", button.dataset.itemId || "");
          if (attachment) {
            vscode.postMessage({ type: "command", command, payload: { attachment } });
          }
          return;
        }
        if (command === "chat.send" || command === "chat.queue.add" || command === "chat.steer") {
          const input = root.querySelector("[data-role='prompt-input']");
          const prompt = input ? input.value : "";
          const attachments = getAttachments(snapshot.chat.id);
          if (getPendingAttachmentUploads(snapshot.chat.id).length) {
            state.notice = "Дождитесь завершения загрузки файлов.";
            render();
            return;
          }
          if (!prompt.trim() && !attachments.length) {
            state.notice = "Введите сообщение или прикрепите файл.";
            render();
            return;
          }
          if (input) {
            input.value = "";
          }
          setDraft(snapshot.chat.id, "");
          clearAttachments(snapshot.chat.id);
          const sendMode = isPlanningArmed(snapshot.chat.id) || getActiveClarification(snapshot) ? "planning" : "normal";
          const skills = command === "chat.steer" ? [] : getSelectedSkills(snapshot.chat.id);
          setPlanningArmed(snapshot.chat.id, false);
          if (command !== "chat.steer") {
            clearSelectedSkills(snapshot.chat.id);
          }
          state.notice = "";
          state.stickToBottom = true;
          vscode.postMessage({ type: "command", command, payload: { prompt, mode: sendMode, skills, attachments } });
          return;
        }
        if (command === "chat.queue.remove") {
          vscode.postMessage({
            type: "command",
            command,
            payload: { messageId: button.dataset.messageId || "" }
          });
          return;
        }
        if (command === "chat.queue.move") {
          vscode.postMessage({
            type: "command",
            command,
            payload: {
              messageId: button.dataset.messageId || "",
              direction: button.dataset.direction === "up" ? "up" : "down"
            }
          });
          return;
        }
        if (command === "chat.queue.edit") {
          const messageId = button.dataset.messageId || "";
          const queued = Array.isArray(snapshot.chat.queuedMessages) ? snapshot.chat.queuedMessages : [];
          const message = queued.find((candidate) => candidate.id === messageId);
          if (!message) {
            return;
          }
          setDraft(snapshot.chat.id, message.text || "");
          setAttachments(snapshot.chat.id, Array.isArray(message.attachments) ? message.attachments : []);
          if (Array.isArray(message.skills) && message.skills.length) {
            state.selectedSkillsByChat[snapshot.chat.id] = message.skills.map((skill) => ({ name: skill.name, path: skill.path }));
          } else {
            clearSelectedSkills(snapshot.chat.id);
          }
          setPlanningArmed(snapshot.chat.id, message.mode === "planning");
          closeMenus();
          vscode.postMessage({
            type: "command",
            command: "chat.queue.remove",
            payload: { messageId }
          });
          snapshot.chat.queuedMessages = queued.filter((candidate) => candidate.id !== messageId);
          render();
          requestAnimationFrame(() => {
            const prompt = root.querySelector("[data-role='prompt-input']");
            if (prompt) {
              prompt.focus();
              prompt.setSelectionRange(prompt.value.length, prompt.value.length);
            }
          });
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
        if (command === "chat.skills.toggle") {
          toggleMenu("skills");
          loadSkillsIfNeeded(false);
          return;
        }
        if (command === "chat.followup.toggle") {
          toggleMenu("followup");
          return;
        }
        if (command === "chat.skills.reload") {
          state.skillsStatus = "loading";
          state.skillsError = "";
          render();
          loadSkillsIfNeeded(true);
          return;
        }
        if (command === "chat.skill.toggle") {
          toggleSelectedSkill(snapshot.chat.id, button.dataset.skillName || "", button.dataset.skillPath || "");
          render();
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
    state.bindCommandButtons(root);

    const textarea = root.querySelector("[data-role='prompt-input']");
    if (textarea) {
      resizePromptInput(textarea);
      textarea.addEventListener("input", () => {
        const wasEmpty = !getDraft(snapshot.chat.id).trim();
        setDraft(snapshot.chat.id, textarea.value);
        resizePromptInput(textarea);
        const isEmpty = !textarea.value.trim();
        if (wasEmpty !== isEmpty) {
          render();
        } else {
          syncComposerHeight();
        }
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.shiftKey && (event.metaKey || event.ctrlKey) && snapshot.chat.status === "running") {
          event.preventDefault();
          const steer = root.querySelector("[data-command='chat.steer']");
          if (steer && !steer.disabled) {
            steer.click();
          }
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const send = root.querySelector("[data-command='chat.queue.add']") || root.querySelector("[data-command='chat.send']");
          if (send && !send.disabled) {
            send.click();
          }
        }
      });
      textarea.addEventListener("paste", (event) => {
        const files = filesFromDataTransfer(event.clipboardData);
        if (!files.length) {
          return;
        }
        event.preventDefault();
        startLocalAttachmentUploads(snapshot.chat.id, files, "clipboard");
      });
    }

    const localAttachmentInput = root.querySelector("[data-role='local-attachment-input']");
    if (localAttachmentInput) {
      localAttachmentInput.addEventListener("change", () => {
        const files = Array.from(localAttachmentInput.files || []);
        localAttachmentInput.value = "";
        startLocalAttachmentUploads(snapshot.chat.id, files, "picker");
      });
    }

    const composerBox = root.querySelector(".composer-box");
    if (composerBox) {
      composerBox.addEventListener("dragenter", (event) => {
        if (!hasFileTransfer(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        composerBox.classList.add("attachment-drag-active");
      });
      composerBox.addEventListener("dragover", (event) => {
        if (!hasFileTransfer(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "copy";
        }
      });
      composerBox.addEventListener("dragleave", (event) => {
        if (!composerBox.contains(event.relatedTarget)) {
          composerBox.classList.remove("attachment-drag-active");
        }
      });
      composerBox.addEventListener("drop", (event) => {
        const files = filesFromDataTransfer(event.dataTransfer);
        composerBox.classList.remove("attachment-drag-active");
        if (!files.length) {
          return;
        }
        event.preventDefault();
        startLocalAttachmentUploads(snapshot.chat.id, files, "drop");
      });
    }
  }

  function composerFooter(snapshot) {
    return `
      <footer class="composer">
        <div class="composer-stack">
          ${queueDock(snapshot)}
          ${clarificationDock(snapshot)}
          <div class="composer-box">
            ${attachmentTray(snapshot.chat.id)}
            <textarea data-role="prompt-input" rows="1" placeholder="${snapshot.chat.status === "running" ? "Добавьте рекомендацию или сообщение в очередь" : "Напишите задачу для Codex"}">${escapeHtml(getDraft(snapshot.chat.id))}</textarea>
            <div class="composer-actions${snapshot.chat.activeRunMode === "planning" ? " planning-active" : ""}">
              <div class="composer-left">
                ${attachmentButton(snapshot)}
                ${accessSelector(snapshot.chat.accessMode)}
                ${planningSelector(snapshot)}
              </div>
              <div class="composer-right">
                ${contextWindowIndicator(snapshot.contextWindow)}
                ${modelSelector(snapshot)}
                ${effortSelector(snapshot)}
                ${speedSelector(snapshot)}
                ${skillsSelector(snapshot)}
                <div class="chips">
                  ${snapshot.chat.kind === "project" ? projectChips(snapshot) : `<span class="context-note">Без проектного контекста</span>`}
                </div>
                ${sendOrStopButton(snapshot)}
              </div>
            </div>
          </div>
        </div>
      </footer>
    `;
  }

  function attachmentButton(snapshot) {
    const pendingCount = getPendingAttachmentUploads(snapshot.chat.id).length;
    const count = getAttachments(snapshot.chat.id).length + pendingCount;
    const disabled = state.attachmentsStatus === "picking" || count >= ATTACHMENT_MAX_COUNT;
    const title = count >= ATTACHMENT_MAX_COUNT ? `Достигнут лимит: ${ATTACHMENT_MAX_COUNT} вложений` : "Добавить вложение";
    return `
      <div class="attachment-selector composer-selector${state.openMenu === "attachments" ? " open" : ""}">
        <button class="composer-icon-button attachment-trigger" type="button" data-command="chat.attachments.toggle" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(title)}" aria-haspopup="menu" aria-expanded="${state.openMenu === "attachments" ? "true" : "false"}" ${disabled ? "disabled" : ""}>
          ${state.attachmentsStatus === "picking" ? spinnerIcon() : paperclipIcon()}
          ${count ? `<span class="attachment-trigger-count" aria-hidden="true">${count}</span>` : ""}
        </button>
        <div class="selector-menu attachment-source-menu" role="menu">
          <button class="selector-option attachment-source-option" type="button" data-command="chat.attachments.pick" role="menuitem">
            ${folderSourceIcon()}
            <span><strong>Из проекта</strong><small>Файл или папка из workspace</small></span>
          </button>
          <button class="selector-option attachment-source-option" type="button" data-command="chat.attachments.localPick" role="menuitem">
            ${uploadSourceIcon()}
            <span><strong>С компьютера</strong><small>Загрузить один или несколько файлов</small></span>
          </button>
          <div class="attachment-source-hint">Файлы также можно перетащить или вставить из буфера</div>
        </div>
        <input class="attachment-file-input" data-role="local-attachment-input" type="file" multiple tabindex="-1" aria-hidden="true">
      </div>
    `;
  }

  function attachmentTray(chatId) {
    const attachments = getAttachments(chatId);
    const pending = getPendingAttachmentUploads(chatId);
    if (!attachments.length && !pending.length) {
      return "";
    }
    return `
      <div class="attachment-tray" role="list" aria-label="Вложения сообщения" aria-live="polite">
        ${pending.map((upload) => `
          <div class="attachment-pill pending" role="listitem" data-upload-progress-id="${escapeAttribute(upload.uploadId)}">
            <div class="attachment-pending-copy">
              ${spinnerIcon()}
              <span class="attachment-copy">
                <strong>${escapeHtml(upload.name || "Файл")}</strong>
                <span data-role="attachment-upload-progress">${escapeHtml(formatUploadProgress(upload))}</span>
              </span>
            </div>
            <button class="attachment-remove" type="button" data-command="chat.attachment.upload.cancel" data-upload-id="${escapeAttribute(upload.uploadId)}" title="Отменить загрузку" aria-label="Отменить загрузку ${escapeAttribute(upload.name || "файла")}">${removeIcon()}</button>
          </div>
        `).join("")}
        ${attachments.map((attachment) => `
          <div class="attachment-pill ${escapeAttribute(attachment.kind || "file")}" role="listitem">
            <button class="attachment-open" type="button" data-command="chat.attachment.open" data-attachment-id="${escapeAttribute(attachment.id)}" title="Открыть ${escapeAttribute(attachment.displayPath || attachment.name)}">
              ${attachmentTypeIcon(attachment.kind)}
              <span class="attachment-copy">
                <strong>${escapeHtml(attachment.name || "Файл")}</strong>
                <span>${escapeHtml(attachment.displayPath || attachment.path || "")}</span>
              </span>
            </button>
            <button class="attachment-remove" type="button" data-command="chat.attachment.remove" data-attachment-id="${escapeAttribute(attachment.id)}" title="Убрать вложение" aria-label="Убрать ${escapeAttribute(attachment.name || "вложение")}">${removeIcon()}</button>
          </div>
        `).join("")}
      </div>
    `;
  }

  function queueDock(snapshot) {
    const queued = Array.isArray(snapshot.chat.queuedMessages) ? snapshot.chat.queuedMessages : [];
    if (!queued.length) {
      return "";
    }
    return `
      <section class="queue-dock" aria-label="Очередь сообщений">
        <div class="queue-dock-title">
          ${queueIcon()}
          <span>${queued.length} ${pluralize(queued.length, "сообщение в очереди", "сообщения в очереди", "сообщений в очереди")}</span>
        </div>
        ${queued.map((message, index) => `
          <div class="queue-message">
            <span class="queue-message-index">${index + 1}</span>
            <span class="queue-message-text">${escapeHtml(message.text || "Только вложения")}</span>
            ${Array.isArray(message.attachments) && message.attachments.length ? `<span class="queue-message-attachments">${paperclipIcon()} ${message.attachments.length}</span>` : ""}
            ${Array.isArray(message.skills) && message.skills.length ? `<span class="queue-message-skills">${message.skills.length} ${pluralize(message.skills.length, "навык", "навыка", "навыков")}</span>` : ""}
            <div class="queue-message-actions">
              <button class="queue-action" type="button" data-command="chat.queue.move" data-message-id="${escapeAttribute(message.id)}" data-direction="up" title="Переместить выше" aria-label="Переместить сообщение выше" ${index === 0 ? "disabled" : ""}>${moveUpIcon()}</button>
              <button class="queue-action" type="button" data-command="chat.queue.move" data-message-id="${escapeAttribute(message.id)}" data-direction="down" title="Переместить ниже" aria-label="Переместить сообщение ниже" ${index === queued.length - 1 ? "disabled" : ""}>${moveDownIcon()}</button>
              <button class="queue-action" type="button" data-command="chat.queue.edit" data-message-id="${escapeAttribute(message.id)}" title="Редактировать" aria-label="Редактировать сообщение">${editIcon()}</button>
              <button class="queue-action queue-remove" type="button" data-command="chat.queue.remove" data-message-id="${escapeAttribute(message.id)}" title="Убрать из очереди" aria-label="Убрать сообщение из очереди">${removeIcon()}</button>
            </div>
          </div>
        `).join("")}
      </section>
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

  function getAttachments(chatId) {
    const attachments = chatId ? state.attachmentsByChat[chatId] : undefined;
    return Array.isArray(attachments) ? attachments.map((attachment) => ({ ...attachment })) : [];
  }

  function setAttachments(chatId, attachments) {
    if (!chatId) {
      return;
    }
    const normalized = Array.isArray(attachments)
      ? attachments.filter((attachment) => attachment && typeof attachment.path === "string").slice(0, 10)
      : [];
    if (normalized.length) {
      state.attachmentsByChat[chatId] = normalized.map((attachment) => ({ ...attachment }));
    } else {
      delete state.attachmentsByChat[chatId];
    }
  }

  function clearAttachments(chatId) {
    delete state.attachmentsByChat[chatId];
  }

  function removeAttachment(chatId, attachmentId) {
    setAttachments(chatId, getAttachments(chatId).filter((attachment) => attachment.id !== attachmentId));
  }

  function findAttachment(snapshot, attachmentId, itemId) {
    const composerAttachment = getAttachments(snapshot.chat.id).find((attachment) => attachment.id === attachmentId);
    if (composerAttachment) {
      return composerAttachment;
    }
    const items = state.transcriptWindow && Array.isArray(state.transcriptWindow.items)
      ? state.transcriptWindow.items
      : snapshot.transcriptWindow && Array.isArray(snapshot.transcriptWindow.items)
        ? snapshot.transcriptWindow.items
        : [];
    const item = items.find((candidate) => candidate.id === itemId);
    return item && Array.isArray(item.attachments)
      ? item.attachments.find((attachment) => attachment.id === attachmentId)
      : undefined;
  }

  function getPendingAttachmentUploads(chatId) {
    return Object.values(state.pendingAttachmentUploads)
      .filter((upload) => upload && upload.chatId === chatId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function startLocalAttachmentUploads(chatId, files, origin) {
    const candidates = Array.isArray(files) ? files.filter((file) => file && typeof file.slice === "function") : [];
    if (!chatId || !candidates.length) {
      return;
    }
    const used = getAttachments(chatId).length + getPendingAttachmentUploads(chatId).length;
    const remaining = Math.max(0, ATTACHMENT_MAX_COUNT - used);
    if (!remaining) {
      state.notice = `К сообщению можно прикрепить не больше ${ATTACHMENT_MAX_COUNT} объектов.`;
      render();
      return;
    }

    const accepted = [];
    const rejected = [];
    candidates.slice(0, remaining).forEach((file, index) => {
      const image = isImageFile(file);
      const maxBytes = image ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_FILE_BYTES;
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
        rejected.push(`${file.name || "Файл"}: лимит ${image ? "20" : "50"} МБ`);
        return;
      }
      const uploadId = createClientUploadId();
      const name = attachmentUploadName(file, origin, index);
      state.pendingAttachmentUploads[uploadId] = {
        uploadId,
        chatId,
        name,
        file,
        sizeBytes: file.size,
        mimeType: file.type || "application/octet-stream",
        offset: 0,
        chunkIndex: 0,
        status: "preparing",
        createdAt: Date.now()
      };
      accepted.push(uploadId);
    });

    if (candidates.length > remaining) {
      rejected.push(`Добавлены первые ${remaining} объектов из-за лимита вложений`);
    }
    if (rejected.length) {
      state.notice = rejected.join(". ");
    } else {
      state.notice = "";
    }
    if (!accepted.length) {
      render();
      return;
    }
    render();
    accepted.forEach((uploadId) => {
      const upload = state.pendingAttachmentUploads[uploadId];
      vscode.postMessage({
        type: "command",
        command: "chat.attachment.upload.start",
        payload: {
          uploadId,
          chatId,
          name: upload.name,
          sizeBytes: upload.sizeBytes,
          mimeType: upload.mimeType
        }
      });
    });
  }

  async function sendNextAttachmentChunk(uploadId) {
    const upload = state.pendingAttachmentUploads[uploadId];
    if (!upload || upload.status === "reading") {
      return;
    }
    if (upload.offset >= upload.sizeBytes) {
      upload.status = "finishing";
      updatePendingAttachmentProgress(uploadId);
      vscode.postMessage({ type: "command", command: "chat.attachment.upload.complete", payload: { uploadId } });
      return;
    }

    upload.status = "reading";
    try {
      const end = Math.min(upload.offset + ATTACHMENT_UPLOAD_CHUNK_BYTES, upload.sizeBytes);
      const bytes = await upload.file.slice(upload.offset, end).arrayBuffer();
      if (state.pendingAttachmentUploads[uploadId] !== upload) {
        return;
      }
      upload.status = "uploading";
      vscode.postMessage({
        type: "command",
        command: "chat.attachment.upload.chunk",
        payload: {
          uploadId,
          chunkIndex: upload.chunkIndex,
          data: arrayBufferToBase64(bytes)
        }
      });
    } catch (error) {
      cancelPendingAttachment(uploadId, false);
      state.notice = error instanceof Error ? error.message : "Не удалось прочитать локальный файл.";
      render();
    }
  }

  function cancelPendingAttachment(uploadId, notifyServer = true) {
    if (!uploadId || !state.pendingAttachmentUploads[uploadId]) {
      return;
    }
    delete state.pendingAttachmentUploads[uploadId];
    if (notifyServer) {
      vscode.postMessage({ type: "command", command: "chat.attachment.upload.cancel", payload: { uploadId } });
    }
    render();
  }

  function updatePendingAttachmentProgress(uploadId) {
    const upload = state.pendingAttachmentUploads[uploadId];
    const row = root.querySelector(`[data-upload-progress-id="${escapeCssValue(uploadId)}"]`);
    const label = row && row.querySelector("[data-role='attachment-upload-progress']");
    if (upload && label) {
      label.textContent = formatUploadProgress(upload);
    }
  }

  function formatUploadProgress(upload) {
    if (upload.status === "preparing") {
      return "Подготовка...";
    }
    if (upload.status === "finishing") {
      return "Сохраняется...";
    }
    const percent = upload.sizeBytes > 0 ? Math.min(100, Math.round(upload.offset / upload.sizeBytes * 100)) : 100;
    return `Загрузка ${percent}% · ${formatAttachmentBytes(upload.sizeBytes)}`;
  }

  function formatAttachmentBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) {
      return `${bytes} Б`;
    }
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} КБ`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} МБ`;
  }

  function filesFromDataTransfer(transfer) {
    if (!transfer || !transfer.files) {
      return [];
    }
    return Array.from(transfer.files).filter((file) => file && typeof file.slice === "function");
  }

  function hasFileTransfer(transfer) {
    return Boolean(transfer && Array.from(transfer.types || []).includes("Files"));
  }

  function isImageFile(file) {
    return String(file.type || "").toLowerCase().startsWith("image/") || /\.(gif|jpe?g|png|webp)$/i.test(file.name || "");
  }

  function attachmentUploadName(file, origin, index) {
    const name = String(file.name || "").trim();
    if (origin === "clipboard" && (!name || /^image\.(png|jpe?g|webp)$/i.test(name))) {
      const suffix = index ? ` ${index + 1}` : "";
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ".png";
      return `Снимок из буфера${suffix}${extension}`;
    }
    return name || `Локальный файл ${index + 1}`;
  }

  function createClientUploadId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `upload-${window.crypto.randomUUID()}`;
    }
    return `upload-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }

  function arrayBufferToBase64(value) {
    const bytes = new Uint8Array(value);
    const parts = [];
    const batchSize = 0x8000;
    for (let index = 0; index < bytes.length; index += batchSize) {
      parts.push(String.fromCharCode(...bytes.subarray(index, Math.min(index + batchSize, bytes.length))));
    }
    return btoa(parts.join(""));
  }

  function escapeCssValue(value) {
    return window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
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

  function loadSkillsIfNeeded(forceReload) {
    if (!forceReload && (state.skillsStatus === "ready" || state.skillsStatus === "loading")) {
      return;
    }
    state.skillsStatus = "loading";
    state.skillsError = "";
    render();
    vscode.postMessage({
      type: "command",
      command: "chat.skills.load",
      payload: { forceReload: Boolean(forceReload) }
    });
  }

  function getSelectedSkills(chatId) {
    const selected = state.selectedSkillsByChat[chatId];
    return Array.isArray(selected) ? selected.map((skill) => ({ name: skill.name, path: skill.path })) : [];
  }

  function clearSelectedSkills(chatId) {
    delete state.selectedSkillsByChat[chatId];
  }

  function toggleSelectedSkill(chatId, name, path) {
    if (!name || !path) {
      return;
    }
    const current = getSelectedSkills(chatId);
    const existingIndex = current.findIndex((skill) => skill.name === name && skill.path === path);
    if (existingIndex >= 0) {
      current.splice(existingIndex, 1);
    } else if (current.length < 8) {
      current.push({ name, path });
    }
    if (current.length) {
      state.selectedSkillsByChat[chatId] = current;
    } else {
      clearSelectedSkills(chatId);
    }
  }

  function reconcileSelectedSkills() {
    const allowed = new Set(state.skillOptions.map((skill) => `${skill.name}\0${skill.path}`));
    Object.keys(state.selectedSkillsByChat).forEach((chatId) => {
      const filtered = getSelectedSkills(chatId).filter((skill) => allowed.has(`${skill.name}\0${skill.path}`));
      if (filtered.length) {
        state.selectedSkillsByChat[chatId] = filtered;
      } else {
        clearSelectedSkills(chatId);
      }
    });
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

  function sendOrStopButton(snapshot) {
    const chat = snapshot.chat;
    const hasDraft = Boolean(getDraft(chat.id).trim() || getAttachments(chat.id).length);
    const hasPendingUploads = getPendingAttachmentUploads(chat.id).length > 0;
    const cancellable = chat.status === "running" || chat.status === "waitingApproval" || chat.status === "cancelling";
    if (!cancellable) {
      return `
        <button class="composer-submit" type="button" data-command="chat.send" title="${hasPendingUploads ? "Дождитесь загрузки файлов" : "Отправить"}" aria-label="${hasPendingUploads ? "Файлы загружаются" : "Отправить сообщение"}" ${hasDraft && !hasPendingUploads ? "" : "disabled"}>
          ${sendIcon()}
        </button>
      `;
    }
    const stopping = chat.status === "cancelling";
    return `
      <div class="running-send-actions">
        ${hasDraft && !hasPendingUploads && !stopping ? followUpSubmitControl(chat) : ""}
        <button class="composer-stop${stopping ? " stopping" : ""}" type="button" data-command="chat.cancel" title="${stopping ? "Останавливается" : "Остановить"}" aria-label="${stopping ? "Запрос останавливается" : "Остановить текущий запрос"}" ${stopping ? "disabled" : ""}>
          ${stopIcon()}
        </button>
      </div>
    `;
  }

  function followUpSubmitControl(chat) {
    const canSteer = chat.status === "running";
    return `
      <div class="followup-selector composer-selector${state.openMenu === "followup" ? " open" : ""}">
        <button class="composer-submit followup-primary" type="button" data-command="chat.queue.add" title="Добавить в очередь" aria-label="Добавить сообщение в очередь">
          ${sendIcon()}
        </button>
        ${canSteer ? `
          <button class="followup-menu-trigger" type="button" data-command="chat.followup.toggle" title="Выбрать способ отправки" aria-label="Выбрать способ отправки" aria-haspopup="menu" aria-expanded="${state.openMenu === "followup" ? "true" : "false"}">
            ${compactChevronIcon()}
          </button>
          <div class="selector-menu followup-menu" role="menu">
            <button class="selector-option followup-option selected" type="button" data-command="chat.queue.add" role="menuitem">
              ${queueIcon()}
              <span class="followup-option-copy">
                <span class="followup-option-title">В очередь</span>
                <span class="followup-option-description">Выполнить после текущего запроса</span>
              </span>
              <span class="followup-check">✓</span>
            </button>
            <button class="selector-option followup-option" type="button" data-command="chat.steer" role="menuitem">
              ${steerIcon()}
              <span class="followup-option-copy">
                <span class="followup-option-title">Как рекомендацию</span>
                <span class="followup-option-description">Уточнить текущий запрос</span>
              </span>
            </button>
          </div>
        ` : ""}
      </div>
    `;
  }

  function sendIcon() {
    return `
      <svg class="composer-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 3.5c.38 0 .76.15 1.05.44l6 6a1.5 1.5 0 0 1-2.1 2.12l-3.45-3.44v8.88a1.5 1.5 0 0 1-3 0V8.62l-3.45 3.44a1.5 1.5 0 1 1-2.1-2.12l6-6c.29-.29.67-.44 1.05-.44Z"/>
      </svg>
    `;
  }

  function paperclipIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.3-9.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function folderSourceIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2-2h9v12a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function uploadSourceIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L7.8 8.2M12 4l4.2 4.2M5 14.5v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function attachmentTypeIcon(kind) {
    if (kind === "folder") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
    }
    if (kind === "image") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor"/><path d="m5 17 4.5-4 3 2.5 2.5-2 4 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  }

  function spinnerIcon() {
    return `<svg class="attachment-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity=".24"/><path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }

  function stopIcon() {
    return `
      <svg class="composer-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>
      </svg>
    `;
  }

  function compactChevronIcon() {
    return `
      <svg class="compact-chevron-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="currentColor" d="M4.3 6.1a1 1 0 0 1 1.4 0L8 8.4l2.3-2.3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 0 1 0-1.4Z"/>
      </svg>
    `;
  }

  function queueIcon() {
    return `
      <svg class="queue-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M5 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4-2h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2ZM5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4-2h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2ZM5 20.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4-2h10a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2Z"/>
      </svg>
    `;
  }

  function steerIcon() {
    return `
      <svg class="queue-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M18.7 4.3a1 1 0 0 1 0 1.4L8.4 16H14a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1V9a1 1 0 1 1 2 0v5.6L17.3 4.3a1 1 0 0 1 1.4 0Z"/>
      </svg>
    `;
  }

  function moveUpIcon() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 3.2 3.7 7.5a1 1 0 1 0 1.4 1.4L7 7v5.8a1 1 0 1 0 2 0V7l1.9 1.9a1 1 0 0 0 1.4-1.4L8 3.2Z"/></svg>`;
  }

  function moveDownIcon() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m8 12.8 4.3-4.3a1 1 0 0 0-1.4-1.4L9 9V3.2a1 1 0 1 0-2 0V9L5.1 7.1a1 1 0 0 0-1.4 1.4L8 12.8Z"/></svg>`;
  }

  function editIcon() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.9 1.6a1.7 1.7 0 0 1 2.5 2.5l-8.7 8.7-3.4.9.9-3.4 8.7-8.7Zm-7 9.7-.3 1.1 1.1-.3 7.8-7.8-1.1-1.1-7.5 8.1Z"/></svg>`;
  }

  function removeIcon() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.3 4.3a1 1 0 0 1 1.4 0L8 6.6l2.3-2.3a1 1 0 1 1 1.4 1.4L9.4 8l2.3 2.3a1 1 0 0 1-1.4 1.4L8 9.4l-2.3 2.3a1 1 0 0 1-1.4-1.4L6.6 8 4.3 5.7a1 1 0 0 1 0-1.4Z"/></svg>`;
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
    const automatic = options.find((option) => option.id === null) || { id: null, label: "Авто" };
    const runtimeModels = options.filter((option) => option.id !== null);
    const topModels = runtimeModels.slice(0, 3);
    const otherModels = runtimeModels.slice(topModels.length);
    const activeLabel = snapshot.chat.modelLabel || "Авто";
    const visibleModels = [automatic, ...topModels];
    return `
      <div class="model-selector composer-selector${state.openMenu === "model" ? " open" : ""}">
        <button class="selector-trigger model-trigger" type="button" data-command="chat.model.toggle" aria-label="Модель" aria-haspopup="menu">
          <span>${escapeHtml(shortModelLabel(activeLabel))}</span>
        </button>
        <div class="selector-menu model-menu" role="menu">
          <div class="selector-menu-title">Модель</div>
          ${visibleModels.map((option) => {
            const selected = isModelSelected(snapshot.chat, option);
            return `
              <button class="selector-option model-option${selected ? " selected" : ""}" type="button" data-command="chat.model.set" data-model-id="${escapeAttribute(option.id || "")}" data-model-label="${escapeAttribute(option.label)}" role="menuitem" title="${escapeAttribute(option.description || option.label)}">
                ${option.id !== null && option.isDefault ? boltIcon() : ""}
                <span>${escapeHtml(option.label)}</span>
                ${selected ? `<span class="access-check">✓</span>` : ""}
              </button>
            `;
          }).join("")}
          ${otherModels.length ? `
            <button class="selector-option model-option submenu-option${state.openModelSubmenu === "other" ? " selected" : ""}" type="button" data-command="chat.model.submenu.toggle" role="menuitem" aria-haspopup="menu">
              <span>Другие модели</span>
              <span class="submenu-chevron">›</span>
            </button>
          ` : ""}
          ${snapshot.modelOptionsStatus === "loading" ? `<div class="selector-hint">Загружаем список моделей...</div>` : ""}
          ${state.openModelSubmenu === "other" ? `
            <div class="selector-submenu model-submenu" role="menu">
              ${otherModels.map((option) => {
                const selected = isModelSelected(snapshot.chat, option);
                return `
                  <button class="selector-option model-option${selected ? " selected" : ""}" type="button" data-command="chat.model.set" data-model-id="${escapeAttribute(option.id || "")}" data-model-label="${escapeAttribute(option.label)}" role="menuitem" title="${escapeAttribute(option.description || option.label)}">
                    <span>${escapeHtml(option.label)}</span>
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

  function effortSelector(snapshot) {
    const model = selectedModelOption(snapshot);
    const fallbackValues = ["low", "medium", "high", "xhigh"];
    const supported = Array.isArray(model && model.supportedEfforts) && model.supportedEfforts.length
      ? model.supportedEfforts
      : fallbackValues.map((value) => ({ value, description: "" }));
    const options = supported.map((option) => ({
      value: option.value,
      label: effortLabel(option.value),
      description: option.description || ""
    }));
    const active = options.find((option) => option.value === snapshot.chat.effort)
      || options.find((option) => option.value === (model && model.defaultEffort))
      || options[0]
      || { value: "medium", label: "Средний", description: "" };
    return `
      <div class="effort-selector composer-selector${state.openMenu === "effort" ? " open" : ""}">
        <button class="selector-trigger effort-trigger" type="button" data-command="chat.effort.toggle" aria-label="Интеллект" aria-haspopup="menu">
          <span>${escapeHtml(active.label)}</span>
        </button>
        <div class="selector-menu effort-menu" role="menu">
          <div class="selector-menu-title">Интеллект</div>
          ${options.map((option) => `
            <button class="selector-option effort-option${option.value === active.value ? " selected" : ""}" type="button" data-command="chat.effort.set" data-effort="${escapeAttribute(option.value)}" role="menuitem" title="${escapeAttribute(option.description)}">
              <span>${escapeHtml(option.label)}</span>
              ${option.value === active.value ? `<span class="access-check">✓</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function speedSelector(snapshot) {
    const model = selectedModelOption(snapshot);
    const tier = Array.isArray(model && model.serviceTiers) ? model.serviceTiers[0] : null;
    const options = [
      { value: "standard", label: "Стандартный", displayLabel: "Стандартный", description: "Стандартная скорость и расход" },
      ...(tier ? [{ value: "fast", label: tier.label || "Быстрый", displayLabel: "x1.5", description: tier.description || "Повышенная скорость и расход" }] : [])
    ];
    const active = options.find((option) => option.value === snapshot.chat.speed) || options[0];
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

  function skillsSelector(snapshot) {
    const selected = getSelectedSkills(snapshot.chat.id);
    const selectedKeys = new Set(selected.map((skill) => `${skill.name}\0${skill.path}`));
    const options = Array.isArray(state.skillOptions) ? state.skillOptions : [];
    const loading = state.skillsStatus === "loading";
    return `
      <div class="skills-selector composer-selector${state.openMenu === "skills" ? " open" : ""}">
        <button class="selector-trigger skills-trigger${selected.length ? " selected" : ""}" type="button" data-command="chat.skills.toggle" aria-label="Навыки для следующего сообщения${selected.length ? `: выбрано ${selected.length}` : ""}" aria-haspopup="menu">
          <span class="skills-trigger-icon" aria-hidden="true">✦</span>
          <span>${selected.length ? `Навыки · ${selected.length}` : "Навыки"}</span>
        </button>
        <div class="selector-menu skills-menu" role="menu">
          <div class="skills-menu-header">
            <div>
              <div class="selector-menu-title">Навыки</div>
              <div class="selector-menu-subtitle">Для следующего сообщения</div>
            </div>
            <button class="skills-reload" type="button" data-command="chat.skills.reload" title="Обновить навыки" aria-label="Обновить навыки" ${loading ? "disabled" : ""}>↻</button>
          </div>
          ${loading ? `<div class="selector-hint">Загружаем навыки...</div>` : ""}
          ${state.skillsStatus === "error" ? `<div class="selector-hint error">${escapeHtml(state.skillsError || "Не удалось загрузить навыки.")}</div>` : ""}
          ${state.skillsStatus === "ready" && !options.length ? `<div class="selector-hint">Доступных навыков нет. Добавьте их в профиль Codex или workspace.</div>` : ""}
          ${options.map((skill) => {
            const key = `${skill.name}\0${skill.path}`;
            const checked = selectedKeys.has(key);
            const disabled = !checked && selected.length >= 8;
            return `
              <button class="selector-option skill-option${checked ? " selected" : ""}" type="button" data-command="chat.skill.toggle" data-skill-name="${escapeAttribute(skill.name)}" data-skill-path="${escapeAttribute(skill.path)}" role="menuitemcheckbox" aria-checked="${checked ? "true" : "false"}" ${disabled ? "disabled" : ""}>
                <span class="skill-option-check" aria-hidden="true">${checked ? "✓" : ""}</span>
                <span class="skill-option-text">
                  <span class="skill-option-title">${escapeHtml(skill.displayName || skill.name)}</span>
                  <span class="skill-option-description">${escapeHtml(skill.shortDescription || skill.description || skill.name)}</span>
                </span>
              </button>
            `;
          }).join("")}
          ${selected.length >= 8 ? `<div class="selector-hint">Можно выбрать до 8 навыков.</div>` : ""}
        </div>
      </div>
    `;
  }

  function modelOptions(snapshot) {
    return Array.isArray(snapshot.modelOptions) && snapshot.modelOptions.length
      ? snapshot.modelOptions
      : [{ id: null, label: "Авто", description: "Модель по умолчанию Codex" }];
  }

  function selectedModelOption(snapshot) {
    const options = modelOptions(snapshot);
    if (snapshot.chat.modelId) {
      return options.find((option) => option.id === snapshot.chat.modelId) || options.find((option) => option.id === null);
    }
    return options.find((option) => option.id === null) || options.find((option) => option.isDefault) || options[0];
  }

  function effortLabel(value) {
    return ({
      minimal: "Минимальный",
      low: "Низкий",
      medium: "Средний",
      high: "Высокий",
      xhigh: "Очень высокий",
      max: "Максимальный",
      ultra: "Ультра"
    })[value] || value;
  }

  function isModelSelected(chat, option) {
    const chatId = chat.modelId || "";
    const optionId = option.id || "";
    const chatShort = shortModelLabel(chat.modelLabel || "").toLowerCase();
    const optionShort = shortModelLabel(option.label || "").toLowerCase();
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
    const window = windowState && Array.isArray(windowState.items)
      ? windowState
      : normalizeTranscriptWindow(windowState);
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
      __anchorIds: items.map((item) => item.id).filter(Boolean),
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
      const attachments = userMessageAttachments(item);
      return `
        <article class="transcript-item user-message" data-item-id="${escapeAttribute(item.id)}">
          <div class="user-bubble">
            ${text ? `<div class="user-message-text">${markdownInline(text)}</div>` : ""}
            ${attachments}
          </div>
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

  function userMessageAttachments(item) {
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    if (!attachments.length) {
      return "";
    }
    return `
      <div class="message-attachments" role="list" aria-label="Вложения сообщения">
        ${attachments.map((attachment) => `
          <button class="message-attachment" type="button" role="listitem" data-command="chat.attachment.open" data-item-id="${escapeAttribute(item.id)}" data-attachment-id="${escapeAttribute(attachment.id)}" title="Открыть ${escapeAttribute(attachment.displayPath || attachment.name)}">
            ${attachmentTypeIcon(attachment.kind)}
            <span>
              <strong>${escapeHtml(attachment.name || "Файл")}</strong>
              <small>${escapeHtml(attachment.displayPath || attachment.path || "")}</small>
            </span>
          </button>
        `).join("")}
      </div>
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
      <article class="transcript-item activity-row ${escapeAttribute(item.status || "completed")} ${expandable ? "expandable" : ""} ${expanded ? "expanded" : ""}" data-item-id="${escapeAttribute(item.id)}"${transcriptAnchorKeysAttribute(item)}>
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
      child.server ? ["MCP-сервер", child.server] : null,
      child.tool ? ["Инструмент", child.tool] : null,
      child.source ? ["Источник", worklogSourceLabel(child.source)] : null,
      typeof child.resultCount === "number" ? ["Результатов", String(child.resultCount)] : null,
      child.argumentsPreview ? ["Аргументы", child.argumentsPreview] : null
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

  function topLevelTranscriptItems(body) {
    if (!body) {
      return [];
    }
    return Array.from(body.children).filter((item) => item.matches && item.matches(".transcript-item[data-item-id]"));
  }

  function transcriptElementAnchorKeys(item) {
    if (!item) {
      return [];
    }
    const keys = [item.dataset.itemId || ""];
    const encodedKeys = String(item.dataset.anchorKeys || "").split(" ").filter(Boolean);
    for (const encodedKey of encodedKeys) {
      try {
        keys.push(decodeURIComponent(encodedKey));
      } catch {
        // Ignore malformed compatibility metadata and keep the primary item id.
      }
    }
    return [...new Set(keys.filter(Boolean))];
  }

  function transcriptAnchorKeysAttribute(item) {
    const ids = Array.isArray(item && item.__anchorIds) ? item.__anchorIds.filter(Boolean) : [];
    return ids.length
      ? ` data-anchor-keys="${escapeAttribute(ids.map((id) => encodeURIComponent(id)).join(" "))}"`
      : "";
  }

  function captureTranscriptAnchor(body, mode) {
    if (!body) {
      return null;
    }
    const bodyRect = body.getBoundingClientRect();
    const items = topLevelTranscriptItems(body);
    const firstVisibleIndex = items.findIndex((item) => item.getBoundingClientRect().bottom >= bodyRect.top + 1);
    if (firstVisibleIndex < 0) {
      return null;
    }
    const startIndex = Math.max(0, firstVisibleIndex - 1);
    const candidates = items.slice(startIndex, Math.min(items.length, firstVisibleIndex + 9)).map((item) => {
      const rect = item.getBoundingClientRect();
      return {
        keys: transcriptElementAnchorKeys(item),
        offset: rect.top - bodyRect.top
      };
    }).filter((candidate) => candidate.keys.length > 0);
    return candidates.length ? {
      mode: mode || "preserve",
      candidates,
      scrollTop: body.scrollTop
    } : null;
  }

  function restoreTranscriptAnchor(body, anchor) {
    if (!body || !anchor || !Array.isArray(anchor.candidates)) {
      return false;
    }
    const items = topLevelTranscriptItems(body);
    for (const candidate of anchor.candidates) {
      const candidateKeys = new Set(Array.isArray(candidate.keys) ? candidate.keys : []);
      const item = items.find((element) => transcriptElementAnchorKeys(element).some((key) => candidateKeys.has(key)));
      if (!item) {
        continue;
      }
      const bodyRect = body.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      body.scrollTop += rect.top - bodyRect.top - candidate.offset;
      return true;
    }
    return false;
  }

  function markTranscriptUserNavigation(direction) {
    state.lastTranscriptUserNavigationAt = Date.now();
    state.lastTranscriptNavigationDirection = direction || "both";
  }

  function wasRecentTranscriptUserNavigation() {
    return Date.now() - state.lastTranscriptUserNavigationAt < 1600;
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
    if (state.pendingTranscriptWindowRequest || state.loadingBefore || state.loadingAfter) {
      return;
    }

    const direction = options && options.direction === "before" ? "before" : "after";
    const threshold = Math.max(TRANSCRIPT_LOAD_THRESHOLD, Math.min(960, Math.round(body.clientHeight * 0.8)));
    if (direction === "before" && body.scrollTop < threshold && windowState.hasBefore) {
      const beforeItemId = windowState.firstItemId || windowState.items?.[0]?.id;
      if (beforeItemId) {
        requestTranscriptWindow(body, "before", {
          beforeItemId,
          beforeOffset: windowState.offset || 0,
          count: TRANSCRIPT_PAGE_SIZE
        });
      }
      return;
    }

    const distanceToBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (direction === "after" && distanceToBottom < threshold && windowState.hasAfter && !state.scrollToBottomAfterWindow) {
      const afterItemId = windowState.lastItemId || windowState.items?.[windowState.items.length - 1]?.id;
      if (afterItemId) {
        requestTranscriptWindow(body, "after", {
          afterItemId,
          afterOffset: (windowState.offset || 0) + Math.max(0, (windowState.items?.length || 1) - 1),
          count: TRANSCRIPT_PAGE_SIZE
        });
      }
    }
  }

  function requestTranscriptWindow(body, mode, payload) {
    const requestId = `transcript-window-${state.nextTranscriptWindowRequestId++}`;
    state.loadingBefore = mode === "before";
    state.loadingAfter = mode === "after";
    state.pendingTranscriptWindowRequest = {
      id: requestId,
      mode,
      anchor: captureTranscriptAnchor(body, mode)
    };
    setTranscriptSentinelLoading(body, mode, true);
    if (state.pendingTranscriptWindowTimer) {
      window.clearTimeout(state.pendingTranscriptWindowTimer);
    }
    state.pendingTranscriptWindowTimer = window.setTimeout(() => {
      if (!state.pendingTranscriptWindowRequest || state.pendingTranscriptWindowRequest.id !== requestId) {
        return;
      }
      state.loadingBefore = false;
      state.loadingAfter = false;
      state.pendingTranscriptWindowRequest = null;
      state.pendingTranscriptWindowTimer = 0;
      setTranscriptSentinelLoading(root.querySelector("[data-role='transcript']"), mode, false);
    }, 8000);
    vscode.postMessage({
      type: "command",
      command: mode === "before" ? "chat.transcript.loadBefore" : "chat.transcript.loadAfter",
      payload: { ...payload, requestId }
    });
  }

  function scheduleTranscriptWindowTrim(body) {
    clearTranscriptWindowTrimTimer();
    const items = state.transcriptWindow && Array.isArray(state.transcriptWindow.items)
      ? state.transcriptWindow.items
      : [];
    if (!body || items.length <= TRANSCRIPT_MAX_RENDERED_ITEMS) {
      return;
    }
    state.transcriptWindowTrimTimer = window.setTimeout(() => {
      state.transcriptWindowTrimTimer = 0;
      if (state.pendingTranscriptWindowRequest || state.loadingBefore || state.loadingAfter) {
        scheduleTranscriptWindowTrim(root.querySelector("[data-role='transcript']"));
        return;
      }
      trimTranscriptWindowAroundViewport(root.querySelector("[data-role='transcript']"));
    }, TRANSCRIPT_SCROLL_IDLE_MS);
  }

  function clearTranscriptWindowTrimTimer() {
    if (!state.transcriptWindowTrimTimer) {
      return;
    }
    window.clearTimeout(state.transcriptWindowTrimTimer);
    state.transcriptWindowTrimTimer = 0;
  }

  function trimTranscriptWindowAroundViewport(body) {
    const current = state.transcriptWindow;
    const items = current && Array.isArray(current.items) ? current.items : [];
    if (!body || items.length <= TRANSCRIPT_MAX_RENDERED_ITEMS) {
      return;
    }

    const anchor = captureTranscriptAnchor(body, "preserve");
    const anchorKeys = new Set(anchor?.candidates?.[0]?.keys || []);
    let visibleIndex = items.findIndex((item) => anchorKeys.has(item.id));
    if (visibleIndex < 0) {
      visibleIndex = Math.min(items.length - 1, Math.max(0, Math.round((body.scrollTop / Math.max(1, body.scrollHeight)) * items.length)));
    }

    const reserveBefore = state.lastTranscriptNavigationDirection === "before" ? 24 : 88;
    const maxStart = Math.max(0, items.length - TRANSCRIPT_MAX_RENDERED_ITEMS);
    const start = Math.min(maxStart, Math.max(0, visibleIndex - reserveBefore));
    const end = Math.min(items.length, start + TRANSCRIPT_MAX_RENDERED_ITEMS);
    if (start === 0 && end === items.length) {
      return;
    }

    state.pendingScrollAnchor = anchor;
    state.transcriptWindow = buildClientTranscriptWindow(
      items.slice(start, end),
      (current.offset || 0) + start,
      current.totalCount || items.length,
      Boolean(current.hasBefore || start > 0),
      Boolean(current.hasAfter || end < items.length)
    );
    patchTranscriptWindowDom("preserve", { prefetch: false });
  }

  function clearPendingTranscriptWindowRequest() {
    if (state.pendingTranscriptWindowTimer) {
      window.clearTimeout(state.pendingTranscriptWindowTimer);
      state.pendingTranscriptWindowTimer = 0;
    }
    state.pendingTranscriptWindowRequest = null;
  }

  function setTranscriptSentinelLoading(body, mode, loading) {
    if (!body) {
      return;
    }
    const sentinel = body.querySelector(`[data-role='transcript-${mode}']`);
    if (!sentinel) {
      return;
    }
    sentinel.classList.toggle("loading", loading);
    sentinel.textContent = loading
      ? (mode === "before" ? "Загружаем предыдущие сообщения" : "Загружаем следующие сообщения")
      : (mode === "before" ? "Загрузить предыдущие сообщения" : "Ниже есть новые сообщения");
  }

  function restoreTranscriptScroll(body, end, previousScrollTop, shouldStickToBottom, transcriptChanged, anchor) {
    if (state.scrollToBottomAfterWindow || shouldStickToBottom) {
      state.scrollToBottomAfterWindow = false;
      scrollTranscriptToBottom(body, end);
      return;
    }

    if (!restoreTranscriptAnchor(body, anchor)) {
      body.scrollTop = anchor && anchor.mode === "before"
        ? 0
        : Math.min(previousScrollTop, body.scrollHeight);
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

  function resizePromptInput(textarea) {
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const minHeight = 62;
    const maxHeight = Math.min(220, Math.max(120, Math.floor(window.innerHeight * 0.32)));
    textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
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
        { className: "function", regex: /([A-ZА-ЯЁa-zа-яё_][A-ZА-ЯЁa-zа-яё0-9_]*)(?=\s*\()/gu },
        { className: "punctuation", regex: /[()[\]{},;]/gu }
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
      const highlightAttribute = lang ? ` data-highlight-language="${escapeAttribute(lang)}"` : "";
      html.push(`<pre class="code-block${languageClass}"${highlightAttribute}><code>${highlightCode(codeLines.join("\n"), lang)}</code></pre>`);
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

  function enhanceSyntaxHighlighting(scope) {
    const highlighter = window.codexXbslHighlighter;
    if (!highlighter || !scope || typeof scope.querySelectorAll !== "function") {
      return;
    }
    const blocks = [];
    if (scope.matches && scope.matches("pre.code-block[data-highlight-language]")) {
      blocks.push(scope);
    }
    blocks.push(...scope.querySelectorAll("pre.code-block[data-highlight-language]"));
    for (const block of blocks) {
      if (block.dataset.highlightState) {
        continue;
      }
      const language = block.dataset.highlightLanguage || "";
      if (!highlighter.supports(language)) {
        block.dataset.highlightState = "unsupported";
        continue;
      }
      const code = block.querySelector("code");
      if (!code) {
        block.dataset.highlightState = "fallback";
        continue;
      }
      const source = code.textContent || "";
      block.dataset.highlightState = "pending";
      highlighter.highlight(source, language).then((highlightedHtml) => {
        if (!block.isConnected || !code.isConnected || (code.textContent || "") !== source) {
          return;
        }
        code.innerHTML = highlightedHtml;
        block.dataset.highlightEngine = "xbsl-io";
        block.dataset.highlightState = "ready";
      }).catch((error) => {
        block.dataset.highlightState = "fallback";
        console.warn("[codex-element] XBSL/YAML highlighting fallback", error);
      });
    }
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

  function pluralize(count, one, few, many) {
    if (count % 10 === 1 && count % 100 !== 11) return one;
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return few;
    return many;
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
