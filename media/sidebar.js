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
    notice: "",
    projectExpanded: true,
    generalExpanded: true,
    archiveExpanded: false
  };
  const QR_GF_TABLES = buildGfTables();
  const QR_GF_EXP = QR_GF_TABLES.exp;
  const QR_GF_LOG = QR_GF_TABLES.log;

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
  window.setInterval(() => {
    if (state.snapshot && shouldShowWorkspace(state.snapshot)) {
      render();
    }
  }, 30000);
  render();

  function render() {
    const root = document.getElementById("root");
    const snapshot = state.snapshot;
    const workspaceVisible = snapshot && shouldShowWorkspace(snapshot);
    const showAuthFlow = snapshot && snapshot.auth.status !== "authenticated" && state.authMode !== "choose";
    root.innerHTML = `
      <main class="app">
        ${brand()}
        ${snapshot ? (workspaceVisible ? `${showAuthFlow ? authCard(snapshot) : ""}${chatSections(snapshot)}` : authCard(snapshot)) : loading()}
      </main>
    `;
    bind(root);
  }

  function shouldShowWorkspace(snapshot) {
    return snapshot.auth.status === "authenticated"
      || Boolean(snapshot.chats && snapshot.chats.length)
      || Boolean(snapshot.auth.profileLabel && snapshot.auth.profileLabel !== "-");
  }

  function brand() {
    return `
      <section class="brand">
        <div class="mark" aria-hidden="true">
          ${blossomIcon()}
        </div>
        <div>
          <div class="title">Codex</div>
          <div class="subtitle">Codex for 1C: Element</div>
        </div>
      </section>
    `;
  }

  function blossomIcon() {
    return `
      <svg class="brand-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" focusable="false">
        <path
          d="M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z"
          fill="currentColor"
        />
      </svg>
    `;
  }

  function penFieldIcon() {
    return iconSvg("M12.5,12h1.586c.936,0,1.814-.364,2.475-1.025l6.707-6.707c.473-.472.732-1.1.732-1.768s-.26-1.296-.732-1.768c-.975-.975-2.561-.975-3.535,0l-6.707,6.707c-.651.651-1.025,1.554-1.025,2.475v1.586c0,.276.224.5.5.5Zm.5-2.086c0-.658.267-1.302.732-1.768l6.707-6.707c.584-.585,1.537-.585,2.121,0,.283.283.439.66.439,1.061s-.156.777-.439,1.061l-6.707,6.707c-.472.472-1.1.732-1.768.732h-1.086v-1.086Zm-1,6.086c0-.552.448-1,1-1s1,.448,1,1-.448,1-1,1-1-.448-1-1Zm-7-1c.552,0,1,.448,1,1s-.448,1-1,1-1-.448-1-1,.448-1,1-1Zm5,1c0,.552-.448,1-1,1s-1-.448-1-1,.448-1,1-1,1,.448,1,1Zm14-3.5v6c0,2.481-2.019,4.5-4.5,4.5H4.5c-2.481,0-4.5-2.019-4.5-4.5v-6c0-2.481,2.019-4.5,4.5-4.5h5c.276,0,.5.224.5.5s-.224.5-.5.5h-5c-1.93,0-3.5,1.57-3.5,3.5v6c0,1.93,1.57,3.5,3.5,3.5h15c1.93,0,3.5-1.57,3.5-3.5v-6c0-1.246-.671-2.408-1.75-3.032-.239-.138-.321-.444-.183-.683s.446-.32.683-.182c1.388.802,2.25,2.296,2.25,3.897Z");
  }

  function collapseIcon(expanded) {
    return expanded
      ? iconSvg("M19.061,7.854a1.5,1.5,0,0,0-2.122,0l-4.586,4.585a.5.5,0,0,1-.707,0L7.061,7.854A1.5,1.5,0,0,0,4.939,9.975l4.586,4.586a3.5,3.5,0,0,0,4.95,0l4.586-4.586A1.5,1.5,0,0,0,19.061,7.854Z")
      : iconSvg("M15.75,9.525,11.164,4.939A1.5,1.5,0,0,0,9.043,7.061l4.586,4.585a.5.5,0,0,1,0,.708L9.043,16.939a1.5,1.5,0,0,0,2.121,2.122l4.586-4.586A3.505,3.505,0,0,0,15.75,9.525Z");
  }

  function pencilIcon() {
    return iconSvg("M22.94,1.061c-1.368-1.367-3.76-1.365-5.124,0L1.611,17.265c-1.039,1.04-1.611,2.421-1.611,3.89v2.346c0,.276,.224,.5,.5,.5H2.846c1.47,0,2.851-.572,3.889-1.611L22.86,6.265c.579-.581,.953-1.262,1.08-1.972,.216-1.202-.148-2.381-1-3.232ZM6.028,21.682c-.85,.851-1.979,1.318-3.182,1.318H1v-1.846c0-1.202,.468-2.332,1.318-3.183L15.292,4.999l3.709,3.709L6.028,21.682ZM22.956,4.116c-.115,.642-.5,1.138-.803,1.441l-2.444,2.444-3.709-3.709,2.525-2.525c.986-.988,2.718-.99,3.709,0,.617,.617,.88,1.473,.723,2.349Z");
  }

  function boxIcon() {
    return iconSvg("M19.5,0H4.5C2.019,0,0,2.019,0,4.5v1c0,.815,.397,1.532,1.002,1.989,0,.004-.002,.007-.002,.011v12c0,2.481,2.019,4.5,4.5,4.5h13c2.481,0,4.5-2.019,4.5-4.5V7.5s-.002-.007-.002-.011c.605-.457,1.002-1.175,1.002-1.989v-1c0-2.481-2.019-4.5-4.5-4.5Zm2.5,19.5c0,1.93-1.57,3.5-3.5,3.5H5.5c-1.93,0-3.5-1.57-3.5-3.5V7.949c.162,.033,.329,.051,.5,.051H21.5c.171,0,.338-.018,.5-.051v11.551Zm1-14c0,.827-.673,1.5-1.5,1.5H2.5c-.827,0-1.5-.673-1.5-1.5v-1c0-1.93,1.57-3.5,3.5-3.5h15c1.93,0,3.5,1.57,3.5,3.5v1Zm-7,7c0,.276-.224,.5-.5,.5h-7c-.276,0-.5-.224-.5-.5s.224-.5,.5-.5h7c.276,0,.5,.224,.5,.5Z");
  }

  function restoreIcon() {
    return iconSvg("m24,11.501v7.999c0,2.481-2.019,4.5-4.5,4.5H2.5c-.276,0-.5-.224-.5-.5s.224-.5,.5-.5h17c1.93,0,3.5-1.57,3.5-3.5v-7.999c0-.935-.364-1.814-1.025-2.475s-1.54-1.025-2.475-1.025h0l-18.401.004c.072.204.179.398.342.561l4.596,4.596c.195.195.195.512,0,.707-.098.098-.226.146-.354.146s-.256-.049-.354-.146L.732,9.273C.249,8.789.006,8.155.003,7.519c0-.005-.003-.009-.003-.014,0-.005.003-.009.003-.014.003-.636.246-1.271.73-1.754L5.329,1.141c.195-.195.512-.195.707,0s.195.512,0,.707L1.439,6.444c-.163.163-.269.357-.342.561l18.401-.004h0c1.202,0,2.332.468,3.182,1.318.851.85,1.318,1.98,1.318,3.182Z");
  }

  function trashIcon() {
    return iconSvg("m15.854,10.854l-3.146,3.146,3.146,3.146c.195.195.195.512,0,.707-.098.098-.226.146-.354.146s-.256-.049-.354-.146l-3.146-3.146-3.146,3.146c-.098.098-.226.146-.354.146s-.256-.049-.354-.146c-.195-.195-.195-.512,0-.707l3.146-3.146-3.146-3.146c-.195-.195-.195-.512,0-.707s.512-.195.707,0l3.146,3.146,3.146-3.146c.195-.195.512-.195.707,0s.195.512,0,.707Zm7.146-6.354c0,.276-.224.5-.5.5h-1.5c0,.015,0,.03-.002.046l-1.37,14.867c-.215,2.33-2.142,4.087-4.481,4.087h-6.272c-2.337,0-4.263-1.754-4.48-4.08l-1.392-14.873c-.001-.016-.002-.031-.002-.047h-1.5c-.276,0-.5-.224-.5-.5s.224-.5,.5-.5h5.028c.25-2.247,2.16-4,4.472-4h2c2.312,0,4.223,1.753,4.472,4h5.028c.276,0,.5.224.5.5Zm-15.464-.5h8.928c-.243-1.694-1.704-3-3.464-3h-2c-1.76,0-3.221,1.306-3.464,3Zm12.462,1H4.002l1.387,14.826c.168,1.81,1.667,3.174,3.484,3.174h6.272c1.82,0,3.318-1.366,3.485-3.179l1.366-14.821Z");
  }

  function iconSvg(path) {
    return `
      <svg class="inline-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="${path}" fill="currentColor"></path>
      </svg>
    `;
  }

  function loading() {
    return `<section class="panel"><div class="muted">Загрузка...</div></section>`;
  }

  function authCard(snapshot) {
    if (state.authMode === "device") {
      const challenge = snapshot.auth.deviceCode || {};
      const hasChallenge = Boolean(challenge.verificationUrl && challenge.userCode);
      return `
        <section class="auth-panel auth-flow">
          <div class="section-title">DEVICE CODE</div>
          <div class="auth-help">${escapeHtml(snapshot.auth.message || "Нажмите кнопку ниже, чтобы получить код авторизации.")}</div>
          ${hasChallenge ? `
            <div class="device-code-card">
              <div class="device-code-label">Код авторизации</div>
              <div class="code-box">${escapeHtml(challenge.userCode)}</div>
            </div>
            <div class="qr-card">
              ${renderQrSvg(challenge.verificationUrl)}
              <div class="qr-caption">Отсканируйте QR на устройстве с доступом к OpenAI</div>
            </div>
            <div class="url-box">${escapeHtml(challenge.verificationUrl)}</div>
            <div class="closed-contour-note">
              Если браузер в контуре не открывает OpenAI, используйте QR или скопируйте ссылку и код на устройство с интернетом. Element продолжит ждать завершение авторизации через настроенный proxy.
            </div>
            <div class="button-row">
              <button class="button secondary" data-command="auth.deviceCode.openUrl">Открыть в браузере</button>
              <button class="button secondary" data-command="auth.deviceCode.copyUrl">Скопировать ссылку</button>
              <button class="button secondary" data-command="auth.deviceCode.copyCode">Скопировать код</button>
              <button class="button secondary" data-command="auth.deviceCode.copyBundle">Скопировать все</button>
            </div>
          ` : ""}
          <button class="button" data-command="auth.deviceCode.start">${hasChallenge ? "Получить новый код" : "Получить Device Code"}</button>
          <button class="button secondary" data-mode="choose">Назад</button>
          ${notice()}
        </section>
      `;
    }

    if (state.authMode === "apiKey") {
      return `
        <section class="auth-panel auth-flow">
          <div class="section-title">API KEY</div>
          <div class="muted">${escapeHtml(snapshot.auth.message || "Введите API key. Ключ не попадет в логи.")}</div>
          <input class="input" type="password" data-role="api-key-input" placeholder="sk-..." autocomplete="off" />
          <button class="button" data-command="auth.apiKey.login">Сохранить и войти</button>
          <button class="button secondary" data-mode="choose">Назад</button>
          ${notice()}
        </section>
      `;
    }

    return `
      <section class="auth-panel">
        <div class="auth-heading">Для работы с CODEX необходимо авторизоваться используя ваш аккаунт OpenAI, для этого выберите способ авторизации:</div>
        <div class="button-stack">
          <button class="button" data-mode="device">DEVICE CODE</button>
          <button class="button secondary" data-mode="apiKey">API KEY</button>
          <div class="proxy-status">${escapeHtml(snapshot.proxy.label)}</div>
          <button class="button ghost" data-command="settings.proxy.open">НАСТРОИТЬ PROXY</button>
        </div>
        ${notice()}
      </section>
    `;
  }

  function chatSections(snapshot) {
    return `
      ${authStatusStrip(snapshot)}
      <button class="new-session" data-command="chat.createProject">
        <span class="new-session-plus">+</span>
        <span>Новый диалог</span>
      </button>
      ${chatSection("Проекты", "project", snapshot)}
      ${chatSection("Чаты", "general", snapshot)}
      ${archiveSection(snapshot)}
      ${notice()}
      ${rateLimits(snapshot)}
    `;
  }

  function authStatusStrip(snapshot) {
    if (snapshot.auth.status === "authenticated") {
      return "";
    }
    const hasKnownProfile = Boolean(snapshot.auth.profileLabel && snapshot.auth.profileLabel !== "-");
    const waitingForLazyCheck = hasKnownProfile
      && snapshot.runtime.status === "notStarted"
      && snapshot.auth.status === "notAuthenticated";
    if (waitingForLazyCheck) {
      return "";
    }

    const message = snapshot.auth.message || "Codex не авторизован.";
    const canStartLogin = snapshot.auth.status === "error"
      || (snapshot.runtime.status === "running" && snapshot.auth.status === "notAuthenticated");
    return `
      <section class="auth-strip${snapshot.auth.status === "error" ? " error" : ""}">
        <div>${escapeHtml(message)}</div>
        ${canStartLogin ? `
          <div class="auth-strip-actions">
            <button class="link-button" data-mode="device">DEVICE CODE</button>
            <button class="link-button" data-mode="apiKey">API KEY</button>
          </div>
        ` : ""}
      </section>
    `;
  }

  function chatSection(title, kind, snapshot) {
    const chats = snapshot.chats.filter((chat) => chat.kind === kind && !chat.archivedAt);
    const command = kind === "project" ? "chat.createProject" : "chat.createGeneral";
    const expanded = kind === "project" ? state.projectExpanded : state.generalExpanded;
    return `
      <section class="chat-section">
        <div class="section-title">
          <span>${title}</span>
          <span class="section-controls">
            <button class="small-button section-action" title="Создать чат" data-command="${command}">${penFieldIcon()}</button>
            <button class="small-button section-toggle" title="${expanded ? "Свернуть" : "Развернуть"}" data-command="group.toggle" data-group="${kind}" aria-expanded="${expanded ? "true" : "false"}">${collapseIcon(expanded)}</button>
          </span>
        </div>
        <div class="chat-list${expanded ? "" : " collapsed"}">
          ${chats.length ? chats.map((chat) => chatRow(chat, snapshot.activeChatId)).join("") : `<div class="empty">Чатов пока нет</div>`}
        </div>
      </section>
    `;
  }

  function archiveSection(snapshot) {
    const chats = snapshot.chats.filter((chat) => chat.archivedAt);
    return `
      <section class="chat-section archive-section">
        <div class="section-title archive-title">
          <span>Архив <span class="archive-count">${chats.length}</span></span>
          <span class="section-controls">
            <button class="small-button section-toggle" title="${state.archiveExpanded ? "Свернуть" : "Развернуть"}" data-command="group.toggle" data-group="archive" aria-expanded="${state.archiveExpanded ? "true" : "false"}">${collapseIcon(state.archiveExpanded)}</button>
          </span>
        </div>
        ${state.archiveExpanded ? `
          <div class="chat-list archive-list">
            ${chats.length ? chats.map((chat) => chatRow(chat, snapshot.activeChatId)).join("") : `<div class="empty">Чатов пока нет</div>`}
          </div>
        ` : ""}
      </section>
    `;
  }

  function chatRow(chat, activeChatId) {
    const active = chat.id === activeChatId ? " active" : "";
    const archived = chat.archivedAt ? " archived" : "";
    const chatId = escapeHtml(chat.id);
    return `
      <div class="chat-row${active}${archived}" role="button" tabindex="0" data-command="chat.open" data-chat-id="${chatId}">
        <span class="chat-title">${escapeHtml(chat.title)}</span>
        <span class="chat-right">
          <span class="chat-state">${chatState(chat)}</span>
          ${chat.archivedAt ? archivedChatActions(chatId) : activeChatActions(chatId)}
        </span>
      </div>
    `;
  }

  function activeChatActions(chatId) {
    return `
      <span class="chat-actions" aria-label="Действия чата">
        <button class="chat-action" title="Переименовать" data-command="chat.rename" data-chat-id="${chatId}">${pencilIcon()}</button>
        <button class="chat-action" title="Архивировать" data-command="chat.archive" data-chat-id="${chatId}">${boxIcon()}</button>
      </span>
    `;
  }

  function archivedChatActions(chatId) {
    return `
      <span class="chat-actions" aria-label="Действия архивного чата">
        <button class="chat-action" title="Восстановить" data-command="chat.restore" data-chat-id="${chatId}">${restoreIcon()}</button>
        <button class="chat-action delete" title="Удалить" data-command="chat.delete" data-chat-id="${chatId}">${trashIcon()}</button>
      </span>
    `;
  }

  function chatState(chat) {
    if (chat.status === "running" || chat.status === "cancelling") {
      return `<span class="chat-spinner" title="${chat.status === "cancelling" ? "Codex останавливается" : "Codex отвечает"}"></span>`;
    }
    if (chat.status === "waitingApproval") {
      return `<span class="chat-dot warning" title="Ожидает подтверждения"></span>`;
    }
    if (chat.status === "error") {
      return `<span class="chat-dot error" title="Ошибка"></span>`;
    }
    if (chat.hasUnread) {
      return `<span class="chat-dot unread" title="Есть непрочитанный ответ"></span>`;
    }
    return `<span class="chat-time">${escapeHtml(formatRelativeTime(chat.updatedAt))}</span>`;
  }

  function notice() {
    return state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : "";
  }

  function rateLimits(snapshot) {
    const limits = snapshot.rateLimits;
    if (!limits || limits.status !== "ready" || !Array.isArray(limits.rows) || !limits.rows.length) {
      return "";
    }

    return `
      <section class="rate-limits" aria-label="Остатки лимитов Codex">
        ${limits.rows.map((row) => rateLimitRow(row)).join("")}
      </section>
    `;
  }

  function rateLimitRow(row) {
    const label = row.kind === "secondary"
      ? "Еженедельно"
      : formatWindowDuration(row.windowDurationMins);
    const right = [
      formatRemainingPercent(row.remainingPercent),
      formatResetAt(row.resetsAt)
    ].filter(Boolean).join(" ");

    return `
      <div class="rate-limit-row">
        <span class="rate-limit-label">${escapeHtml(label)}</span>
        <span class="rate-limit-value">${escapeHtml(right)}</span>
      </div>
    `;
  }

  function renderQrSvg(value) {
    try {
      const matrix = createQrMatrix(String(value || ""));
      const quiet = 3;
      const size = matrix.length + quiet * 2;
      const cells = [];
      for (let y = 0; y < matrix.length; y += 1) {
        for (let x = 0; x < matrix.length; x += 1) {
          if (matrix[y][x]) {
            cells.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"></rect>`);
          }
        }
      }
      return `
        <svg class="qr-code" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR-код ссылки авторизации" shape-rendering="crispEdges" focusable="false">
          <rect x="0" y="0" width="${size}" height="${size}" class="qr-bg"></rect>
          <g class="qr-fg">${cells.join("")}</g>
        </svg>
      `;
    } catch {
      return `<div class="qr-fallback">QR недоступен для этой ссылки</div>`;
    }
  }

  function createQrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const versions = [
      { version: 1, size: 21, dataCodewords: 19, ecCodewords: 7, blocks: [19], align: [] },
      { version: 2, size: 25, dataCodewords: 34, ecCodewords: 10, blocks: [34], align: [6, 18] },
      { version: 3, size: 29, dataCodewords: 55, ecCodewords: 15, blocks: [55], align: [6, 22] },
      { version: 4, size: 33, dataCodewords: 80, ecCodewords: 20, blocks: [80], align: [6, 26] },
      { version: 5, size: 37, dataCodewords: 108, ecCodewords: 26, blocks: [108], align: [6, 30] },
      { version: 6, size: 41, dataCodewords: 136, ecCodewords: 18, blocks: [68, 68], align: [6, 34] },
      { version: 7, size: 45, dataCodewords: 156, ecCodewords: 20, blocks: [78, 78], align: [6, 22, 38] },
      { version: 8, size: 49, dataCodewords: 194, ecCodewords: 24, blocks: [97, 97], align: [6, 24, 42] },
      { version: 9, size: 53, dataCodewords: 232, ecCodewords: 30, blocks: [116, 116], align: [6, 26, 46] }
    ];
    const spec = versions.find((candidate) => 4 + 8 + bytes.length * 8 <= candidate.dataCodewords * 8);
    if (!spec) {
      throw new Error("QR payload is too long.");
    }

    const dataCodewords = encodeQrData(bytes, spec.dataCodewords);
    const allCodewords = interleaveQrBlocks(dataCodewords, spec.blocks, spec.ecCodewords);
    const base = buildQrBase(spec);
    const dataBits = codewordsToBits(allCodewords);
    placeQrData(base.modules, base.functionModules, dataBits);

    let bestModules = base.modules;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = cloneMatrix(base.modules);
      applyQrMask(candidate, base.functionModules, mask);
      drawQrFormatBits(candidate, base.functionModules, mask);
      const penalty = qrPenalty(candidate);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestModules = candidate;
      }
    }
    return bestModules;
  }

  function encodeQrData(bytes, dataCodewordCount) {
    const bits = [];
    pushBits(bits, 0x4, 4);
    pushBits(bits, bytes.length, 8);
    bytes.forEach((byte) => pushBits(bits, byte, 8));
    const capacityBits = dataCodewordCount * 8;
    pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j += 1) {
        value = (value << 1) | bits[i + j];
      }
      codewords.push(value);
    }
    for (let pad = 0; codewords.length < dataCodewordCount; pad += 1) {
      codewords.push(pad % 2 === 0 ? 0xec : 0x11);
    }
    return codewords;
  }

  function interleaveQrBlocks(dataCodewords, blockSizes, ecCodewords) {
    const blocks = [];
    let offset = 0;
    for (const size of blockSizes) {
      const data = dataCodewords.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: reedSolomonRemainder(data, ecCodewords) });
    }

    const result = [];
    const maxData = Math.max(...blocks.map((block) => block.data.length));
    for (let i = 0; i < maxData; i += 1) {
      for (const block of blocks) {
        if (i < block.data.length) {
          result.push(block.data[i]);
        }
      }
    }
    for (let i = 0; i < ecCodewords; i += 1) {
      for (const block of blocks) {
        result.push(block.ec[i]);
      }
    }
    return result;
  }

  function buildQrBase(spec) {
    const modules = Array.from({ length: spec.size }, () => Array(spec.size).fill(false));
    const functionModules = Array.from({ length: spec.size }, () => Array(spec.size).fill(false));
    const setFunction = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= spec.size || y >= spec.size) {
        return;
      }
      modules[y][x] = Boolean(dark);
      functionModules[y][x] = true;
    };

    drawFinderPattern(setFunction, 3, 3);
    drawFinderPattern(setFunction, spec.size - 4, 3);
    drawFinderPattern(setFunction, 3, spec.size - 4);
    for (let i = 8; i < spec.size - 8; i += 1) {
      setFunction(i, 6, i % 2 === 0);
      setFunction(6, i, i % 2 === 0);
    }
    for (const y of spec.align) {
      for (const x of spec.align) {
        if ((x <= 8 && y <= 8) || (x >= spec.size - 9 && y <= 8) || (x <= 8 && y >= spec.size - 9)) {
          continue;
        }
        drawAlignmentPattern(setFunction, x, y);
      }
    }
    setFunction(8, spec.version * 4 + 9, true);
    drawQrFormatBits(modules, functionModules, 0);
    if (spec.version >= 7) {
      drawQrVersionBits(modules, functionModules, spec.version);
    }
    return { modules, functionModules };
  }

  function drawFinderPattern(setFunction, cx, cy) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  function drawAlignmentPattern(setFunction, cx, cy) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, distance !== 1);
      }
    }
  }

  function placeQrData(modules, functionModules, bits) {
    const size = modules.length;
    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right -= 1;
      }
      for (let vert = 0; vert < size; vert += 1) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          if (!functionModules[y][x]) {
            modules[y][x] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
            bitIndex += 1;
          }
        }
      }
      upward = !upward;
    }
  }

  function applyQrMask(modules, functionModules, mask) {
    const size = modules.length;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!functionModules[y][x] && qrMaskBit(mask, x, y)) {
          modules[y][x] = !modules[y][x];
        }
      }
    }
  }

  function qrMaskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function drawQrFormatBits(modules, functionModules, mask) {
    const size = modules.length;
    const bits = getQrFormatBits(mask);
    const set = (x, y, index) => {
      modules[y][x] = ((bits >> index) & 1) !== 0;
      functionModules[y][x] = true;
    };

    for (let i = 0; i <= 5; i += 1) {
      set(8, i, i);
    }
    set(8, 7, 6);
    set(8, 8, 7);
    set(7, 8, 8);
    for (let i = 9; i < 15; i += 1) {
      set(14 - i, 8, i);
    }
    for (let i = 0; i < 8; i += 1) {
      set(size - 1 - i, 8, i);
    }
    for (let i = 8; i < 15; i += 1) {
      set(8, size - 15 + i, i);
    }
    modules[size - 8][8] = true;
  }

  function getQrFormatBits(mask) {
    const data = (1 << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if (((rem >> i) & 1) !== 0) {
        rem ^= 0x537 << (i - 10);
      }
    }
    return (((data << 10) | (rem & 0x3ff)) ^ 0x5412) & 0x7fff;
  }

  function drawQrVersionBits(modules, functionModules, version) {
    const size = modules.length;
    const bits = getQrVersionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      modules[b][a] = bit;
      modules[a][b] = bit;
      functionModules[b][a] = true;
      functionModules[a][b] = true;
    }
  }

  function getQrVersionBits(version) {
    let rem = version << 12;
    for (let i = 17; i >= 12; i -= 1) {
      if (((rem >> i) & 1) !== 0) {
        rem ^= 0x1f25 << (i - 12);
      }
    }
    return ((version << 12) | (rem & 0xfff)) & 0x3ffff;
  }

  function qrPenalty(modules) {
    const size = modules.length;
    let penalty = 0;
    for (let y = 0; y < size; y += 1) {
      penalty += linePenalty(modules[y]);
    }
    for (let x = 0; x < size; x += 1) {
      const column = [];
      for (let y = 0; y < size; y += 1) {
        column.push(modules[y][x]);
      }
      penalty += linePenalty(column);
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) {
          penalty += 3;
        }
      }
    }
    const patterns = ["10111010000", "00001011101"];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x <= size - 11; x += 1) {
        const value = modules[y].slice(x, x + 11).map((bit) => bit ? "1" : "0").join("");
        if (patterns.includes(value)) {
          penalty += 40;
        }
      }
    }
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y <= size - 11; y += 1) {
        let value = "";
        for (let i = 0; i < 11; i += 1) {
          value += modules[y + i][x] ? "1" : "0";
        }
        if (patterns.includes(value)) {
          penalty += 40;
        }
      }
    }
    const dark = modules.flat().filter(Boolean).length;
    penalty += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return penalty;
  }

  function linePenalty(line) {
    let penalty = 0;
    let runColor = line[0];
    let runLength = 1;
    for (let i = 1; i <= line.length; i += 1) {
      if (i < line.length && line[i] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) {
          penalty += 3 + runLength - 5;
        }
        runColor = line[i];
        runLength = 1;
      }
    }
    return penalty;
  }

  function reedSolomonRemainder(data, degree) {
    const generator = reedSolomonGenerator(degree);
    const result = Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i += 1) {
        result[i] ^= gfMultiply(generator[i], factor);
      }
    }
    return result;
  }

  function reedSolomonGenerator(degree) {
    let result = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = Array(result.length + 1).fill(0);
      for (let j = 0; j < result.length; j += 1) {
        next[j] ^= result[j];
        next[j + 1] ^= gfMultiply(result[j], gfPow(i));
      }
      result = next;
    }
    return result.slice(1);
  }

  function gfPow(power) {
    return QR_GF_EXP[power % 255];
  }

  function gfMultiply(a, b) {
    if (a === 0 || b === 0) {
      return 0;
    }
    return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
  }

  function buildGfTables() {
    const exp = Array(512).fill(0);
    const log = Array(256).fill(0);
    let value = 1;
    for (let i = 0; i < 255; i += 1) {
      exp[i] = value;
      log[value] = i;
      value <<= 1;
      if ((value & 0x100) !== 0) {
        value ^= 0x11d;
      }
    }
    for (let i = 255; i < exp.length; i += 1) {
      exp[i] = exp[i - 255];
    }
    return { exp, log };
  }

  function codewordsToBits(codewords) {
    const bits = [];
    codewords.forEach((codeword) => pushBits(bits, codeword, 8));
    return bits;
  }

  function pushBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  }

  function cloneMatrix(matrix) {
    return matrix.map((row) => row.slice());
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
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const command = button.dataset.command;
        if (command === "group.toggle") {
          toggleGroup(button.dataset.group);
          render();
          return;
        }
        let payload = button.dataset.chatId ? { chatId: button.dataset.chatId } : undefined;
        if (command === "auth.apiKey.login") {
          const input = root.querySelector("[data-role='api-key-input']");
          payload = { apiKey: input ? input.value : "" };
          if (input) {
            input.value = "";
          }
        }
        vscode.postMessage({ type: "command", command, payload });
      });
      if (button.classList.contains("chat-row")) {
        button.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          button.click();
        });
      }
    });
  }

  function toggleGroup(group) {
    if (group === "project") {
      state.projectExpanded = !state.projectExpanded;
      return;
    }
    if (group === "general") {
      state.generalExpanded = !state.generalExpanded;
      return;
    }
    if (group === "archive") {
      state.archiveExpanded = !state.archiveExpanded;
    }
  }

  function formatRelativeTime(value) {
    try {
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) {
        return "";
      }
      const elapsed = Math.max(0, Date.now() - timestamp);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const month = 30 * day;
      if (elapsed < minute) {
        return "сейчас";
      }
      if (elapsed < hour) {
        return `${Math.floor(elapsed / minute)}м`;
      }
      if (elapsed < day) {
        return `${Math.floor(elapsed / hour)}ч`;
      }
      if (elapsed < month) {
        return `${Math.floor(elapsed / day)}д`;
      }
      return `${Math.floor(elapsed / month)}мес`;
    } catch {
      return "";
    }
  }

  function formatWindowDuration(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return "Лимит";
    }
    if (minutes < 60) {
      return `${Math.round(minutes)}м`;
    }
    if (minutes < 24 * 60) {
      return `${Math.round(minutes / 60)}ч`;
    }
    return `${Math.round(minutes / (24 * 60))}д`;
  }

  function formatRemainingPercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) {
      return "";
    }
    return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }

  function formatResetAt(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "";
    }

    const reset = new Date(seconds * 1000);
    if (!Number.isFinite(reset.getTime())) {
      return "";
    }

    const now = new Date();
    if (
      reset.getFullYear() === now.getFullYear() &&
      reset.getMonth() === now.getMonth() &&
      reset.getDate() === now.getDate()
    ) {
      return `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
    }

    const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    return `${reset.getDate()} ${months[reset.getMonth()] || ""}`.trim();
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
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
