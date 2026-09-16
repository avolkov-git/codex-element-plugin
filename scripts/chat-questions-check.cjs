const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { compile, createFixture } = require("./chat-ui-fixture.cjs");

const chatId = "chat-a";
const composerDraft = "Composer draft independent of question answers";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const commands = (f, name) => f.inbound.filter(message => message.type === "command" && message.command === name);
const nativePanel = (page, id) => page.locator(`.inline-questions[data-request-id="${id}"]`);
const questionPanel = (page, id) => page.locator(`.inline-questions[data-question-id="${id}"]`);
const messageRow = (page, id) => page.locator(`.message[data-item-id="${id}"]`);

async function until(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(20);
  }
  assert.fail(`Timed out: ${label}`);
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function nativeRequest(id, questions) {
  return { id, requestId: id, chatId, threadId: "thread-a", turnId: "turn-a", itemId: `${id}-item`,
    isBlocking: true, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), questions };
}

function setNative(f, requests, primary = requests[0] ?? null) {
  f.data.meta.pendingUserInputs = requests;
  f.data.meta.pendingUserInput = primary;
  f.data.meta.chat.pendingUserInput = null;
}

function questionMessage(id, questions) {
  return { kind: "message", id, role: "assistant", status: "complete", createdAt: new Date().toISOString(),
    text: "Уточнение по проекту", questions };
}

async function bottom(page) {
  const jump = page.getByRole("button", { name: "К последнему сообщению", exact: true });
  if (await jump.isVisible()) await jump.click();
  else await page.locator("[data-role=transcript]").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await settle(page);
}

async function showItem(page, f, item) {
  f.data.items[f.data.items.length - 1] = item;
  await f.flush();
  await bottom(page);
  await page.locator(`.virtual-row[data-row-id="${item.id}"]`).waitFor();
}

async function observeSavedState(page) {
  await page.evaluate(() => {
    let current = window.fixtureState;
    window.questionSavedStates = [structuredClone(current)];
    Object.defineProperty(window, "fixtureState", {
      configurable: true,
      get: () => current,
      set(value) { current = value; window.questionSavedStates.push(structuredClone(value)); }
    });
  });
}

async function assertPrivate(page, values) {
  const states = await page.evaluate(() => JSON.stringify(window.questionSavedStates));
  for (const value of values) assert.ok(!states.includes(value), `question answer leaked to VSCode saved state: ${value}`);
}

async function assertInline(page, archived = false) {
  assert.equal(await page.getByRole("dialog").count(), 0, "questions never open a modal");
  assert.equal(await page.locator(".app").evaluate(node => node.inert), false, "questions do not make the app inert");
  if (archived) {
    await page.locator(".archived-footer").waitFor();
    assert.equal(await page.evaluate(() => window.fixtureState.drafts?.["chat-a"]?.text), composerDraft, "archiving preserves the composer draft");
  } else assert.equal(await page.locator("[data-role=prompt-input]").inputValue(), composerDraft, "question replies preserve the composer");
}

async function assertFits(page) {
  const failures = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".inline-questions, .inline-questions button, .inline-questions input, .question-title, .question-answer, .question-error")];
    return nodes.filter(node => node.getClientRects().length).flatMap(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1
        ? [`${node.className}: ${Math.round(rect.left)}..${Math.round(rect.right)}; ${node.scrollWidth}/${node.clientWidth}`] : [];
    });
  });
  assert.deepEqual(failures, [], "inline question text and controls fit the viewport");
}

// Exercise the real manager routes, holding mock handler results until the test releases them.
function installReplies(page, f) {
  const pending = [];
  const nativeName = "chat.userInput.respond";
  const asyncName = "chat.question.respond";
  const receive = (name, args) => {
    const message = structuredClone(commands(f, name).at(-1));
    assert.ok(message, `handler called without inbound ${name}`);
    assert.equal(message.chatId, chatId);
    const payload = message.payload;
    assert.deepEqual(args, name === nativeName ? [chatId, payload.id, payload.response]
      : [chatId, payload.messageId, payload.questionId, payload.answer], "manager forwards the public command to its handler");
    return new Promise(resolve => pending.push({ message, resolve, claimed: false, released: false }));
  };
  f.manager.handlers.resolveUserInput = async (...args) => {
    f.calls.push(["userInput", ...args]);
    return receive(nativeName, args);
  };
  f.manager.handlers.respondToQuestion = async (...args) => {
    f.calls.push(["question", ...args]);
    const accepted = await receive(asyncName, args);
    return { messageId: args[1], questionId: args[2], accepted, ...(accepted ? {} : { error: "Тестовый отказ. Повторите ответ." }) };
  };
  const persistAnswer = async call => {
    const { messageId, questionId, answer } = call.message.payload;
    const item = f.data.items.find(item => item.id === messageId);
    assert.ok(item, "accepted answer belongs to an existing fixture item");
    if (item.kind === "clarification") {
      assert.equal(questionId, item.id);
      item.answer = answer;
    } else {
      const question = item.questions.find(question => question.id === questionId);
      assert.ok(question, "accepted answer belongs to an existing question");
      question.answer = answer;
    }
    await f.flush();
  };
  return {
    transport: "ChatPanelManager with controlled respondToQuestion / resolveUserInput handlers",
    async take(name) {
      const call = await until(() => pending.find(call => !call.claimed && call.message.command === name), `${name} reaches handler`);
      call.claimed = true;
      return call;
    },
    async finish(call, accepted = true, persist = true) {
      const start = f.outbound.length;
      call.released = true;
      call.resolve(accepted);
      const native = call.message.command === nativeName;
      const result = await until(() => f.outbound.slice(start).find(event => event.type === "event"
        && event.event === (native ? "chat.userInput.result" : "chat.question.result")
        && (native ? event.payload.id === call.message.payload.id
          : event.payload.messageId === call.message.payload.messageId && event.payload.questionId === call.message.payload.questionId)), "matching question ACK");
      assert.equal(result.chatId, chatId);
      assert.equal(result.payload.accepted, accepted);
      await settle(page);
      // Update the authoritative graph after ACK, retaining answers to sibling questions.
      if (accepted && persist && !native) await persistAnswer(call);
      return result;
    },
    persistAnswer,
    async dispose() {
      for (const call of pending) if (!call.released) { call.released = true; call.resolve(false); }
      await settle(page);
    }
  };
}

function assertCommand(call, name, payload) {
  assert.deepEqual(call.message, { type: "command", chatId, command: name, payload });
}

async function resolved(panel, answer) {
  await panel.getByRole("status").filter({ hasText: answer }).waitFor();
  assert.equal(await panel.locator("form").count(), 0, "resolved async question has a summary, not an editable form");
  assert.equal(await panel.locator(".question-answer svg").count(), 1, "resolved answer has a check icon");
}

async function nativeCases(page, f, replies, shot) {
  const input = page.locator("[data-role=prompt-input]");
  await input.fill(composerDraft);
  await input.evaluate(node => { window.questionComposer = node; });
  const single = nativeRequest("native-single", [{ id: "environment", header: "Среда", question: "Где проверить изменение?", isOther: true, isSecret: false,
    options: [{ label: "Тестовый сервер", description: "Изолированное окружение проекта" }, { label: "Локальная среда", description: "Текущая машина" }] }]);
  const waiting = nativeRequest("native-waiting", [{ id: "comment", header: "Комментарий", question: "Что учесть при проверке?", isOther: false, isSecret: false, options: null }]);
  setNative(f, [single, waiting]);
  await f.flush();
  await nativePanel(page, single.id).waitFor();
  assert.equal(await page.locator(".inline-questions[data-request-id]").count(), 2, "pending list is shown once without duplicating its primary request");
  await assertInline(page);
  assert.equal(await input.evaluate(node => node === window.questionComposer && node === document.activeElement), true, "native questions do not steal focus or replace the composer");
  const choice = nativePanel(page, single.id).getByRole("button", { name: "Тестовый сервер", exact: false });
  await choice.evaluate(node => { node.click(); node.click(); });
  const direct = await replies.take("chat.userInput.respond");
  await settle(page);
  assert.equal(commands(f, "chat.userInput.respond").length, 1, "single choice submits once, without a grouped submit");
  assert.equal(await choice.isDisabled(), true, "native choice is disabled until ACK");
  assertCommand(direct, "chat.userInput.respond", { id: single.id, response: { answers: { environment: { answers: ["Тестовый сервер"] } } } });
  await replies.finish(direct);
  await nativePanel(page, single.id).getByText("Ответ отправлен", { exact: true }).waitFor();
  assert.equal(await choice.isDisabled(), true, "accepted native choice cannot be sent again");
  assert.equal(await nativePanel(page, waiting.id).getByLabel("Комментарий: ответ", { exact: true }).isEnabled(), true, "another native request remains answerable");

  const grouped = nativeRequest("native-grouped", [
    { id: "target", header: "Назначение", question: "Выберите назначение или укажите своё", isOther: true, isSecret: false,
      options: [{ label: "Staging", description: "Проверочная среда" }, { label: "Production", description: "Рабочая среда" }] },
    { id: "secret", header: "Токен", question: "Временный токен для проверки", isOther: false, isSecret: true, options: null }
  ]);
  setNative(f, [grouped]); await f.flush(); await bottom(page);
  const panel = nativePanel(page, grouped.id);
  const submit = panel.getByRole("button", { name: "Ответить", exact: true });
  const count = commands(f, "chat.userInput.respond").length;
  assert.equal(await submit.isDisabled(), true);
  await panel.getByRole("button", { name: "Staging", exact: false }).click();
  assert.equal(await panel.getByRole("button", { name: "Staging", exact: false }).getAttribute("aria-pressed"), "true");
  await panel.getByRole("button", { name: "Production", exact: false }).click();
  assert.equal(await panel.getByRole("button", { name: "Staging", exact: false }).getAttribute("aria-pressed"), "false");
  assert.equal(await panel.getByRole("button", { name: "Production", exact: false }).getAttribute("aria-pressed"), "true");
  assert.equal(commands(f, "chat.userInput.respond").length, count, "multi-question choices do not submit early");
  const own = panel.getByRole("button", { name: "Свой ответ", exact: true });
  await own.click(); assert.equal(await own.getAttribute("aria-expanded"), "true");
  const custom = "private-native-custom-target";
  const secret = "private-native-secret-token";
  await panel.getByLabel("Назначение: ответ", { exact: true }).fill(custom);
  assert.equal(await submit.isDisabled(), true, "all native questions must be filled");
  const token = panel.getByLabel("Токен: ответ", { exact: true });
  await token.fill(secret);
  assert.equal(await token.getAttribute("type"), "password");
  assert.equal(await token.getAttribute("autocomplete"), "off");
  f.data.items.at(-1).text += " Native draft stream update."; await f.flush();
  assert.equal(await token.inputValue(), secret);
  assert.equal(await panel.getByLabel("Назначение: ответ", { exact: true }).inputValue(), custom);
  await input.fill(`${composerDraft} `); await input.fill(composerDraft);
  await assertPrivate(page, [custom, secret]);
  await shot("native-grouped");
  await submit.evaluate(node => { node.click(); node.click(); });
  const groupCall = await replies.take("chat.userInput.respond"); await settle(page);
  assert.equal(commands(f, "chat.userInput.respond").length, count + 1, "busy grouped submit cannot duplicate a response");
  assertCommand(groupCall, "chat.userInput.respond", { id: grouped.id, response: { answers: { target: { answers: [custom] }, secret: { answers: [secret] } } } });
  await replies.finish(groupCall);
  await panel.getByText("Ответ отправлен", { exact: true }).waitFor();
  await assertPrivate(page, [custom, secret]);

  const expired = nativeRequest("native-expired", [{ id: "late", header: "Поздний ответ", question: "Вопрос с ограниченным временем", isOther: false, isSecret: false, options: null }]);
  setNative(f, [], expired); await f.flush(); await bottom(page);
  const expiredPanel = nativePanel(page, expired.id);
  const late = expiredPanel.getByLabel("Поздний ответ: ответ", { exact: true });
  await late.fill("private-expired-native-draft");
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  f.data.meta.pendingUserInput = null; f.data.meta.chat.pendingUserInput = expired;
  await f.flush();
  await expiredPanel.getByRole("alert").filter({ hasText: "Время ответа истекло" }).waitFor();
  assert.equal(await late.isDisabled(), true);
  assert.equal(await late.inputValue(), "private-expired-native-draft");
  const expiredSubmit = expiredPanel.getByRole("button", { name: "Ответить", exact: true });
  assert.equal(await expiredSubmit.isDisabled(), true);
  const beforeExpiryClick = commands(f, "chat.userInput.respond").length;
  await expiredSubmit.evaluate(node => node.click()); await settle(page);
  assert.equal(commands(f, "chat.userInput.respond").length, beforeExpiryClick, "expired native request never submits");
  await assertPrivate(page, ["private-expired-native-draft"]);
  await shot("native-expired");
  setNative(f, []); await f.flush();
}

async function asyncCases(page, f, replies, shot) {
  const text = questionMessage("message-text", [{ id: "text-question", title: "Как назвать новый модуль?", options: null }]);
  const contextPrefix = "Проверка затрагивает общий модуль проекта.";
  text.text = `${contextPrefix}\n\n${text.questions[0].title}`;
  await showItem(page, f, text);
  assert.equal(await messageRow(page, text.id).locator(".inline-questions").count(), 1);
  const panel = questionPanel(page, "text-question");
  const context = messageRow(page, text.id).locator(".question-message-context");
  await context.getByText(contextPrefix, { exact: true }).waitFor();
  assert.ok((await context.boundingBox()).y < (await panel.boundingBox()).y, "additional message context remains above the question form");
  const input = panel.getByLabel("Как назвать новый модуль?: ответ", { exact: true });
  const submit = panel.getByRole("button", { name: "Ответить", exact: true });
  await input.fill("   "); assert.equal(await submit.isDisabled(), true);
  const draft = "private-async-text-draft";
  await input.fill(draft);
  await submit.evaluate(node => { node.click(); node.click(); });
  const first = await replies.take("chat.question.respond"); await settle(page);
  assertCommand(first, "chat.question.respond", { messageId: text.id, questionId: "text-question", answer: draft });
  assert.equal(commands(f, "chat.question.respond").length, 1, "duplicate synchronous submit is ignored while busy");
  assert.equal(await input.isDisabled(), true);
  await f.panel.webview.postMessage({ type: "event", event: "chat.question.result", chatId: "chat-b", payload: { messageId: text.id, questionId: "text-question", accepted: true } });
  await settle(page);
  assert.equal(await input.isDisabled(), true, "another chat's ACK cannot unlock this question");
  assert.equal(await input.inputValue(), draft);
  const failure = await replies.finish(first, false);
  await panel.getByRole("alert").filter({ hasText: failure.payload.error }).waitFor();
  assert.equal(await input.inputValue(), draft, "rejected ACK preserves the draft for retry");
  assert.equal(await submit.isEnabled(), true);
  await assertPrivate(page, [draft]); await shot("async-error");
  await submit.click();
  const retry = await replies.take("chat.question.respond");
  assert.deepEqual(retry.message, first.message, "retry sends the same answer and identifiers");
  await replies.finish(retry, true, false);
  await resolved(panel, "Ответ отправлен");
  await f.flush(); await resolved(panel, "Ответ отправлен");
  await replies.persistAnswer(retry);
  await resolved(panel, draft);
  assert.equal(text.questions[0].answer, draft);

  const multi = questionMessage("message-multiple", [
    { id: "direct-choice", title: "Как проверить изменение в изолированной среде проекта?", options: ["Полная проверка проекта", "Только изменённый модуль"] },
    { id: "independent-text", title: "Какие данные использовать?", options: null }
  ]);
  multi.questionThreadId = "separate-thread-metadata";
  const echo = multi.questions.flatMap(question => [question.title, ...(question.options ?? []).map(option => `- ${option}`)]);
  multi.text = `\r\n${echo.map(line => `  ${line}  `).join("\r\n\r\n")}\r\n`;
  await showItem(page, f, multi);
  assert.equal(await messageRow(page, multi.id).locator(".inline-questions[data-question-id]").count(), 2);
  assert.equal(await messageRow(page, multi.id).locator(".question-message-context").count(), 0, "only an exact normalized title/options echo is omitted");
  multi.text = `Выбираем режим без публикации.\n\n${multi.text}`;
  await f.flush();
  const retained = messageRow(page, multi.id).locator(".question-message-context");
  await retained.getByText("Выбираем режим без публикации.", { exact: true }).waitFor();
  assert.equal(await retained.locator("li").count(), 0, "a trailing metadata echo is replaced by controls without duplicating its choices");
  assert.equal(await retained.getByRole("button").count(), 0, "context bullets are not parsed as interactive choices");
  multi.text += "\n\nПубликация требует отдельного подтверждения.";
  await f.flush();
  await retained.getByText("Публикация требует отдельного подтверждения.", { exact: true }).waitFor();
  assert.equal(await retained.locator("li").count(), 2, "text with information after the questions is retained in full");
  const choices = questionPanel(page, "direct-choice");
  const sibling = questionPanel(page, "independent-text");
  const before = commands(f, "chat.question.respond").length;
  const option = choices.getByRole("button", { name: "Полная проверка проекта", exact: true });
  await option.evaluate(node => { node.click(); node.click(); });
  const choiceCall = await replies.take("chat.question.respond");
  assertCommand(choiceCall, "chat.question.respond", { messageId: multi.id, questionId: "direct-choice", answer: "Полная проверка проекта" });
  assert.equal(await option.isDisabled(), true);
  await choices.getByRole("button", { name: "Только изменённый модуль", exact: true }).evaluate(node => node.click());
  const siblingInput = sibling.getByLabel("Какие данные использовать?: ответ", { exact: true });
  assert.equal(await siblingInput.isDisabled(), true, "one answer is dispatched per chat, matching the runtime start/steer lock");
  await replies.finish(choiceCall);
  await resolved(choices, "Полная проверка проекта");
  assert.equal(await siblingInput.isEnabled(), true, "the next question is answerable after ACK");
  const siblingDraft = "private-independent-answer";
  await siblingInput.fill(siblingDraft);
  await shot("async-multiple");
  await sibling.getByRole("button", { name: "Ответить", exact: true }).click();
  const siblingCall = await replies.take("chat.question.respond"); await settle(page);
  assert.equal(commands(f, "chat.question.respond").length, before + 2, "each async question submits independently, with no busy duplicate");
  assertCommand(siblingCall, "chat.question.respond", { messageId: multi.id, questionId: "independent-text", answer: siblingDraft });
  await f.panel.webview.postMessage({ type: "event", event: "chat.question.result", chatId,
    payload: { messageId: multi.id, questionId: "direct-choice", accepted: true } });
  await settle(page);
  assert.equal(await siblingInput.isDisabled(), true, "another question's repeated ACK does not resolve the pending answer");
  await replies.finish(siblingCall);
  await resolved(choices, "Полная проверка проекта");
  await resolved(sibling, siblingDraft);
  assert.deepEqual(multi.questions.map(question => question.answer), ["Полная проверка проекта", siblingDraft]);
  await f.flush();
  await resolved(choices, "Полная проверка проекта");
  await assertPrivate(page, [draft, siblingDraft]);
}

async function historyCases(page, f, replies, shot) {
  const archived = questionMessage("message-archived", [
    { id: "already-answered", title: "Сохранённый вопрос", options: ["Прежний вариант"], answer: "Сохранённый ответ" },
    { id: "archived-choice", title: "Новый выбор", options: ["Нельзя отправить"] },
    { id: "archived-text", title: "Новый текст", options: null }
  ]);
  f.data.meta.chat.archivedAt = new Date().toISOString();
  await showItem(page, f, archived);
  await resolved(questionPanel(page, "already-answered"), "Сохранённый ответ");
  const choice = questionPanel(page, "archived-choice").getByRole("button", { name: "Нельзя отправить", exact: true });
  assert.equal(await choice.isDisabled(), true);
  assert.equal(await questionPanel(page, "archived-text").getByLabel("Новый текст: ответ", { exact: true }).isDisabled(), true);
  const before = commands(f, "chat.question.respond").length;
  await choice.evaluate(node => node.click()); await settle(page);
  assert.equal(commands(f, "chat.question.respond").length, before, "archived questions cannot submit");
  await shot("archived");
  f.data.meta.chat.archivedAt = null; await f.flush();
  assert.equal(await choice.isEnabled(), true, "restoring a chat enables unanswered questions");
  await resolved(questionPanel(page, "already-answered"), "Сохранённый ответ");

  const clarification = { kind: "clarification", id: "clarification-choice", question: "С чего начать проверку?", createdAt: new Date().toISOString(),
    options: [{ title: "Проверить типы", answer: "Проверь типы перед изменением", description: "Локальная проверка проекта" }] };
  await showItem(page, f, clarification);
  const clarificationPanel = questionPanel(page, clarification.id);
  await clarificationPanel.getByRole("button", { name: "Проверить типы", exact: false }).click();
  const choiceCall = await replies.take("chat.question.respond");
  assertCommand(choiceCall, "chat.question.respond", { messageId: clarification.id, questionId: clarification.id, answer: clarification.options[0].answer });
  await replies.finish(choiceCall); await resolved(clarificationPanel, clarification.options[0].answer);
  const freeClarification = { ...clarification, id: "clarification-text", options: [] };
  delete freeClarification.answer;
  await showItem(page, f, freeClarification);
  const freePanel = questionPanel(page, freeClarification.id);
  const value = "private-clarification-answer";
  await freePanel.getByLabel(`${freeClarification.question}: ответ`, { exact: true }).fill(value);
  await freePanel.getByRole("button", { name: "Ответить", exact: true }).click();
  const textCall = await replies.take("chat.question.respond");
  assertCommand(textCall, "chat.question.respond", { messageId: freeClarification.id, questionId: freeClarification.id, answer: value });
  await replies.finish(textCall); await resolved(freePanel, value);
  assert.equal(commands(f, "chat.send").length, 0, "clarifications use question responses, never a new chat prompt");
  await assertPrivate(page, [value]);

  const markdown = { kind: "message", id: "ordinary-markdown", role: "assistant", status: "complete", createdAt: new Date().toISOString(),
    text: "Какой вариант подходит?\n\n- Первый вариант\n- Второй вариант\n\n1. Проверить типы\n2. Выполнить тесты" };
  await showItem(page, f, markdown);
  const row = messageRow(page, markdown.id);
  assert.equal(await row.locator(".markdown li").count(), 4);
  assert.equal(await row.locator(".inline-questions, .markdown button, input").count(), 0, "plain Markdown bullets never become interactive questions");
  const beforeBullet = commands(f, "chat.question.respond").length;
  await row.getByText("Первый вариант", { exact: true }).click(); await settle(page);
  assert.equal(commands(f, "chat.question.respond").length, beforeBullet);
  await shot("plain-markdown");
}

async function virtualCase(page, f, replies, shot) {
  const index = f.data.items.length - 2;
  const item = questionMessage("virtual-question-message", [{ id: "virtual-question", title: "Ответ после прокрутки", options: null }]);
  f.data.items[index] = item;
  f.data.items[index + 1] = { kind: "message", id: "stream-tail", role: "assistant", status: "streaming", createdAt: new Date().toISOString(), text: "Streaming tail" };
  f.data.meta.chat.status = "running";
  await f.flush(); await bottom(page);
  const panel = questionPanel(page, "virtual-question");
  const input = panel.getByLabel("Ответ после прокрутки: ответ", { exact: true });
  const draft = "private-virtual-question-draft";
  await input.fill(draft);
  await input.evaluate(node => { window.originalQuestionInput = node; });
  const jump = page.getByRole("button", { name: "К последнему сообщению", exact: true });
  await jump.waitFor();
  const focusDuringStream = [];
  for (let update = 0; update < 3; update++) {
    f.data.items[index + 1].text += ` focused-stream-${update}`; await f.flush();
    await messageRow(page, "stream-tail").getByText(new RegExp(`focused-stream-${update}`)).waitFor();
    focusDuringStream.push({ update, jumpVisible: await jump.isVisible(), inputFocused: await input.evaluate(node => node === document.activeElement) });
  }
  const leaveQuestion = async () => {
    await page.locator("[data-role=prompt-input]").focus();
    await page.locator("[data-role=transcript]").evaluate(node => {
      getSelection().removeAllRanges();
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -5000 }));
      node.scrollTop = 0;
    });
    await panel.waitFor({ state: "detached" });
  };
  await leaveQuestion();
  assert.equal(await page.evaluate(() => window.originalQuestionInput.isConnected), false, "question is really virtually unmounted, not just outside the viewport");
  for (let update = 0; update < 5; update++) { f.data.items[index + 1].text += ` streamed-${update}`; await f.flush(); }
  assert.equal(await panel.count(), 0, "offscreen streaming does not remount the question");
  assert.ok(await page.locator(".virtual-row").count() < 80, "question drafts do not pin the whole history");
  await assertPrivate(page, [draft]);
  await bottom(page); await input.waitFor();
  assert.equal(await input.inputValue(), draft, "draft survives unmount, streaming, and scroll back");
  assert.equal(await input.evaluate(node => node === window.originalQuestionInput), false, "draft was restored into a new input node");
  await panel.getByRole("button", { name: "Ответить", exact: true }).click();
  const call = await replies.take("chat.question.respond");
  assertCommand(call, "chat.question.respond", { messageId: item.id, questionId: "virtual-question", answer: draft });
  await leaveQuestion();
  const error = await replies.finish(call, false);
  f.data.items[index + 1].text += " after-offscreen-ack"; await f.flush();
  await bottom(page); await input.waitFor();
  assert.equal(await input.inputValue(), draft, "offscreen rejected ACK retains the draft");
  await panel.getByRole("alert").filter({ hasText: error.payload.error }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Ответить", exact: true }).isEnabled(), true, "offscreen ACK releases busy state for retry");
  await assertPrivate(page, [draft]); await shot("virtual-draft");
  assert.ok(focusDuringStream.every(sample => sample.jumpVisible && sample.inputFocused),
    `focused streaming must retain focus and expose the jump button: ${JSON.stringify(focusDuringStream)}`);
}

async function runScenario(browser, compiled, artifacts, scenario) {
  const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.width === 390 ? 844 : 850 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let f, replies;
  const prefix = `${scenario.width}-${scenario.dark ? "dark" : "light"}`;
  const shot = async name => {
    await settle(page); await assertInline(page, Boolean(f?.data.meta.chat.archivedAt)); await assertFits(page);
    await page.screenshot({ path: path.join(artifacts, `${prefix}-${name}.png`) });
  };
  try {
    f = await createFixture(page, compiled, { count: 240, dark: scenario.dark });
    replies = installReplies(page, f);
    await observeSavedState(page);
    await nativeCases(page, f, replies, shot);
    await asyncCases(page, f, replies, shot);
    await historyCases(page, f, replies, shot);
    await virtualCase(page, f, replies, shot);
    await assertInline(page);
    assert.deepEqual(errors, [], "no browser runtime errors");
    return { ...scenario, ok: true, transport: replies.transport,
      nativeResponses: commands(f, "chat.userInput.respond").length, asyncResponses: commands(f, "chat.question.respond").length };
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${prefix}-failure.png`) }).catch(() => {});
    error.message = `[${prefix}] ${error.message}`;
    throw error;
  } finally {
    if (replies) await replies.dispose();
    if (f) f.dispose();
    await page.close();
  }
}

async function main() {
  const compiled = await compile();
  const artifacts = process.env.CODEX_TEST_ARTIFACTS ? path.resolve(process.env.CODEX_TEST_ARTIFACTS)
    : await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-questions-"));
  await fs.mkdir(artifacts, { recursive: true });
  console.log(`Inline question UI artifacts: ${artifacts}`);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  try {
    const scenarios = [];
    for (const width of [390, 1100]) for (const dark of [false, true]) {
      try { scenarios.push(await runScenario(browser, compiled, artifacts, { width, dark })); }
      catch (error) {
        scenarios.push({ width, dark, ok: false, error: String(error.stack || error) });
        console.error(`${width}-${dark ? "dark" : "light"}: ${error.message}`);
      }
    }
    const report = { ok: scenarios.every(scenario => scenario.ok), scope: "inline question UI with controlled replies; not a real backend execution", scenarios, artifacts };
    await fs.writeFile(path.join(artifacts, "questions-results.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    assert.ok(report.ok, "inline question UI checks failed; see questions-results.json and failure screenshots");
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
