import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, ArrowDown, Paperclip, Upload, FolderOpen, Square, ListPlus, CornerUpRight, X, WandSparkles, RefreshCw, Pencil, RotateCcw } from "lucide-react";
import type { ChatBridgeMeta } from "../../src/chatPanelManager";
import type { SkillOption } from "../../src/types";
import { command, emptyDraft, saved, saveDraft, store, type Draft } from "./bridge";
import { IconButton } from "./controls";
import { cancelUpload, uploadFiles, uploadRevision, uploadsForChat, uploadSubscribe } from "./uploads";

export const Composer = memo(function Composer({ meta }: { meta: ChatBridgeMeta }) {
  const chatId = meta.chat.id;
  const [draft, setDraft] = useState<Draft>(() => saved.drafts?.[chatId] ?? emptyDraft());
  const current = useRef(draft); current.current = draft;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"attachments" | "skills" | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillsStatus, setSkillsStatus] = useState("idle");
  const [skillsFilter, setSkillsFilter] = useState("");
  const [notice, setNotice] = useState("");
  useSyncExternalStore(uploadSubscribe, uploadRevision);
  const uploads = uploadsForChat(chatId);
  const update = (value: Draft) => { current.current = value; saveDraft(chatId, value); setDraft(value); };
  useEffect(() => store.onEvent(event => {
    const origin = event.chatId ?? event.payload?.chatId;
    if (origin && origin !== chatId) return;
    if (event.event === "draft.changed") setDraft(saved.drafts?.[chatId] ?? emptyDraft());
    if (event.event === "chat.error" || event.event === "chat.attachments.error" || event.event === "chat.attachment.upload.error") {
      setNotice(typeof event.payload === "string" ? event.payload : event.payload?.message ?? "Ошибка.");
      const payload = event.payload;
      if (typeof payload?.restorePrompt === "string") {
        const existing = current.current;
        update({ ...existing, text: existing.text ? `${existing.text}\n\n${payload.restorePrompt}` : payload.restorePrompt,
          attachments: [...new Map([...existing.attachments, ...(payload.restoreAttachments ?? [])].map(item => [item.id, item])).values()].slice(0, 10) });
      }
    }
    if (event.event === "chat.attachments.selected") update({ ...current.current, attachments: event.payload.attachments ?? [] });
    if (event.event === "chat.skills.options") { setSkills(event.payload); setSkillsStatus("ready"); }
    if (event.event === "chat.skills.error") { setNotice(String(event.payload)); setSkillsStatus("error"); }
    if (event.event === "chat.plan.reviseDraft") {
      update({ ...current.current, text: "Измени план: ", planning: true }); textarea.current?.focus();
    }
  }), [chatId]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(null); textarea.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(200, Math.max(64, input.scrollHeight))}px`; }
  }, [draft.text]);
  const active = ["running", "waitingApproval", "cancelling"].includes(meta.chat.status);
  const send = (name: "chat.send" | "chat.queue.add" | "chat.steer") => {
    if (uploads.length || (!draft.text.trim() && !draft.attachments.length)) return;
    command(chatId, name, { prompt: draft.text, attachments: draft.attachments, mode: draft.planning ? "planning" : "normal", skills: draft.skills });
    update(emptyDraft()); setNotice(""); textarea.current?.focus();
  };
  const addFiles = (files: File[]) => { const error = uploadFiles(chatId, files); if (error) setNotice(error); };
  const selectedModel = meta.modelOptions.find(model => model.id === meta.chat.modelId);
  const efforts = selectedModel?.supportedEfforts?.map(value => value.value) ?? ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (meta.chat.archivedAt) return <footer className="archived-footer"><span>Диалог в архиве</span><button className="primary" onClick={() => command(chatId, "chat.restore")}>Восстановить</button></footer>;
  return <footer className="composer-footer">
    {!!meta.chat.queuedMessages.length && <ol className="queue-list" aria-label="Очередь сообщений">{meta.chat.queuedMessages.map((item, index) => {
      const state = (item as typeof item & { dispatchState?: string; dispatchError?: string });
      return <li key={item.id}><div className="queued-text"><span>{item.text || "Вложения"}</span>{state.dispatchError && <span className="error-text">{state.dispatchError}</span>}{state.dispatchState && state.dispatchState !== "queued" && <small>{state.dispatchState}</small>}</div>
        {state.dispatchState === "failed" && <IconButton icon={RotateCcw} label="Повторить отправку" onClick={() => command(chatId, "chat.queue.retry", { messageId: item.id })} />}
        <IconButton icon={Pencil} label="Изменить сообщение" disabled={state.dispatchState === "dispatching"} onClick={() => {
          update({ ...draft, text: draft.text ? `${draft.text}\n${item.text}` : item.text, attachments: [...draft.attachments, ...(item.attachments ?? [])].slice(0, 10), planning: item.mode === "planning", skills: item.skills ?? [] });
          command(chatId, "chat.queue.remove", { messageId: item.id }); textarea.current?.focus();
        }} />
        <IconButton icon={ArrowUp} label="Выше в очереди" disabled={!index || state.dispatchState === "dispatching"} onClick={() => command(chatId, "chat.queue.move", { messageId: item.id, direction: "up" })} />
        <IconButton icon={ArrowDown} label="Ниже в очереди" disabled={index === meta.chat.queuedMessages.length - 1 || state.dispatchState === "dispatching"} onClick={() => command(chatId, "chat.queue.move", { messageId: item.id, direction: "down" })} />
        <IconButton icon={X} label="Удалить из очереди" disabled={state.dispatchState === "dispatching"} onClick={() => command(chatId, "chat.queue.remove", { messageId: item.id })} />
      </li>;
    })}</ol>}
    {notice && <div className="composer-notice" role="alert"><span>{notice}</span><IconButton icon={X} label="Закрыть уведомление" onClick={() => setNotice("")} /></div>}
    <div className="composer" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } }}>
      {(!!draft.attachments.length || !!uploads.length || !!draft.skills.length) && <div className="composer-attachments">
        {draft.attachments.map(attachment => <div className="attachment-chip" key={attachment.id}><button className="text-link" title={attachment.displayPath} onClick={() => command(chatId, "chat.attachment.open", { attachment })}>{attachment.name}</button><IconButton icon={X} label={`Удалить ${attachment.name}`} onClick={() => { update({ ...draft, attachments: draft.attachments.filter(value => value.id !== attachment.id) }); command(chatId, "chat.attachment.discard", { attachment }); }} /></div>)}
        {uploads.map(upload => <div className="attachment-chip" key={upload.id}><span>{upload.name}</span><progress max={upload.file.size || 1} value={upload.offset} aria-label={`Загрузка ${upload.name}`} /><IconButton icon={X} label={`Отменить загрузку ${upload.name}`} onClick={() => cancelUpload(upload.id)} /></div>)}
        {draft.skills.map(skill => <div className="attachment-chip" key={skill.path}><WandSparkles size={14} /><span>{skill.name}</span><IconButton icon={X} label={`Удалить навык ${skill.name}`} onClick={() => update({ ...draft, skills: draft.skills.filter(value => value.path !== skill.path) })} /></div>)}
      </div>}
      <textarea ref={textarea} data-role="prompt-input" aria-label="Сообщение Codex" placeholder="Сообщение Codex" value={draft.text} rows={3} maxLength={200000}
        onChange={event => update({ ...draft, text: event.target.value })}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addFiles(files); } }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); send(active ? event.metaKey || event.ctrlKey ? "chat.steer" : "chat.queue.add" : "chat.send");
          }
        }} />
      <div className="composer-toolbar"><div className="composer-tools" ref={menuRef}>
        <IconButton icon={Paperclip} label="Прикрепить файл" aria-expanded={menu === "attachments"} onClick={() => setMenu(menu === "attachments" ? null : "attachments")} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {menu === "attachments" && <div className="composer-popover"><button onClick={() => { command(chatId, "chat.attachments.pick", { attachments: draft.attachments }); setMenu(null); }}><FolderOpen size={16} />Из проекта</button><button onClick={() => { fileInput.current?.click(); setMenu(null); }}><Upload size={16} />С компьютера</button></div>}
        <IconButton icon={WandSparkles} label="Навыки" aria-expanded={menu === "skills"} onClick={() => { setMenu(menu === "skills" ? null : "skills"); if (skillsStatus === "idle") { setSkillsStatus("loading"); command(chatId, "chat.skills.load"); } }} />
        {menu === "skills" && <div className="composer-popover skills-popover"><div className="panel-toolbar"><input aria-label="Найти навык" placeholder="Найти навык" value={skillsFilter} onChange={event => setSkillsFilter(event.target.value)} /><IconButton icon={RefreshCw} label="Обновить навыки" onClick={() => { setSkillsStatus("loading"); command(chatId, "chat.skills.load", { forceReload: true }); }} /></div>
          {skillsStatus === "loading" ? <p role="status">Загрузка…</p> : skills.filter(skill => `${skill.displayName} ${skill.name}`.toLowerCase().includes(skillsFilter.toLowerCase())).slice(0, 100).map(skill => {
            const checked = draft.skills.some(value => value.path === skill.path);
            return <label key={skill.path} title={skill.description}><input type="checkbox" checked={checked} disabled={!skill.enabled || (!checked && draft.skills.length >= 8)} onChange={() => update({ ...draft, skills: checked ? draft.skills.filter(value => value.path !== skill.path) : [...draft.skills, { name: skill.name, path: skill.path }] })} /><span>{skill.displayName || skill.name}<small>{skill.shortDescription}</small></span></label>;
          })}{skillsStatus === "ready" && !skills.length && <p>Навыков нет.</p>}
        </div>}
        <label className="planning-control"><input type="checkbox" checked={draft.planning} onChange={event => update({ ...draft, planning: event.target.checked })} />План</label>
      </div><div className="composer-send">
        {active && <><IconButton icon={ListPlus} label="Добавить в очередь" disabled={!!uploads.length || (!draft.text.trim() && !draft.attachments.length)} onClick={() => send("chat.queue.add")} /><IconButton icon={CornerUpRight} label="Направить текущий запрос" disabled={!!uploads.length || meta.chat.status === "cancelling" || (!draft.text.trim() && !draft.attachments.length)} onClick={() => send("chat.steer")} /></>}
        {active ? <IconButton className="stop-button" icon={Square} label="Остановить текущий запрос" disabled={meta.chat.status === "cancelling"} onClick={() => command(chatId, "chat.cancel")} /> : <IconButton className="primary send-button" icon={ArrowUp} label="Отправить сообщение" disabled={!!uploads.length || (!draft.text.trim() && !draft.attachments.length)} onClick={() => send("chat.send")} />}
      </div></div>
    </div>
    <div className="composer-options">
      <select aria-label="Режим доступа" value={meta.chat.accessMode} onChange={event => command(chatId, "chat.access.set", { accessMode: event.target.value })}><option value="read-only">Только чтение</option><option value="workspace-write">Рабочая область</option><option value="danger-full-access">Полный доступ</option></select>
      <select aria-label="Модель" value={meta.chat.modelId ?? ""} onFocus={() => { if (meta.modelOptionsStatus === "idle") command(chatId, "chat.models.load"); }} onChange={event => { const model = meta.modelOptions.find(value => (value.id ?? "") === event.target.value); if (model) command(chatId, "chat.model.set", { modelId: model.id, modelLabel: model.label }); }}>
        {!meta.modelOptions.some(model => model.id === meta.chat.modelId) && <option value={meta.chat.modelId ?? ""}>{meta.chat.modelLabel}</option>}{meta.modelOptions.map(model => <option key={model.id ?? "default"} value={model.id ?? ""}>{model.label}</option>)}
      </select><IconButton icon={RefreshCw} label="Обновить модели" disabled={meta.modelOptionsStatus === "loading"} onClick={() => command(chatId, "chat.models.load", { forceReload: true })} />
      <select aria-label="Интеллект" value={meta.chat.effort} onChange={event => command(chatId, "chat.effort.set", { effort: event.target.value })}>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>
      <select aria-label="Скорость" value={meta.chat.speed} onChange={event => command(chatId, "chat.speed.set", { speed: event.target.value })}><option value="standard">Стандартная</option><option value="fast">Быстрая</option></select>
      <span className="context-usage" title={meta.contextWindow.message}>{meta.contextWindow.status === "compacting" ? "Сжатие контекста" : meta.contextWindow.usedPercent !== null ? `Контекст ${Math.round(meta.contextWindow.usedPercent)}%` : ""}</span>
    </div>
  </footer>;
});
