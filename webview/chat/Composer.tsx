import { memo, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ArrowUp, ArrowDown, Paperclip, Upload, FolderOpen, BookMarked, FileText, Square, ListPlus, CornerUpRight, X, Sparkles, RefreshCw, Pencil, RotateCcw, LockKeyhole, LockKeyholeOpen, ChevronDown, Check } from "lucide-react";
import type { ChatBridgeMeta } from "../../src/chatPanelManager";
import type { SkillOption } from "../../src/types";
import { command, emptyDraft, saved, saveDraft, store, type Draft } from "./bridge";
import { IconButton, Popover } from "./controls";
import { cancelUpload, uploadFiles, uploadRevision, uploadsForChat, uploadSubscribe } from "./uploads";

function ComposerSelect({ label, caption, icon, options, value, onChange, onOpen, footer, className = "" }: { label: string; caption: string; icon?: ReactNode; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; onOpen?: () => void; footer?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <button ref={anchor} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} className={`composer-select ${className}`} title={`${label}: ${caption}`} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); onOpen?.(); setOpen(true); }
    }}>{icon}<span>{caption}</span></button>
    {open && anchor.current && <Popover anchor={anchor.current} label={label} className="selector-popover" onClose={() => setOpen(false)}>
      <div className="selector-menu-title">{label}</div>
      <div id={id} role="listbox" aria-label={label}>{options.map(option => <button type="button" key={option.value} role="option" aria-selected={option.value === value} className="selector-option" onClick={() => { onChange(option.value); setOpen(false); anchor.current?.focus({ preventScroll: true }); }}><span>{option.label}</span>{option.value === value && <Check size={15} />}</button>)}</div>
      {footer}
    </Popover>}
  </>;
}
const effortLabels: Record<string, string> = { none: "Без рассуждений", minimal: "Минимальный", low: "Низкий", medium: "Средний", high: "Высокий", xhigh: "Очень высокий", max: "Максимальный", ultra: "Предельный" };
const accessLabels: Record<string, string> = { "read-only": "Только чтение", "workspace-write": "Рабочая область", "danger-full-access": "Полный доступ" };
const queueLabels: Record<string, string> = { dispatching: "Отправляется", failed: "Ошибка отправки", blocked: "Ожидает подтверждения", uncertain: "Отправка не подтверждена" };

export const Composer = memo(function Composer({ meta, onContext }: { meta: ChatBridgeMeta; onContext: (section: "project" | "docs") => void }) {
  const chatId = meta.chat.id;
  const [draft, setDraft] = useState<Draft>(() => saved.drafts?.[chatId] ?? emptyDraft());
  const current = useRef(draft); current.current = draft;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<"attachments" | "skills" | "followup" | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const toggleMenu = (name: typeof menu, anchor: HTMLElement) => { setMenu(menu === name ? null : name); setMenuAnchor(anchor); };
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
  useLayoutEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(220, Math.max(62, input.scrollHeight))}px`; }
  }, [draft.text]);
  const active = ["running", "waitingApproval", "cancelling"].includes(meta.chat.status);
  const send = (name: "chat.send" | "chat.queue.add" | "chat.steer") => {
    if (uploads.length || (!draft.text.trim() && !draft.attachments.length)) return;
    command(chatId, name, { prompt: draft.text, attachments: draft.attachments, mode: draft.planning ? "planning" : "normal", skills: draft.skills });
    update(emptyDraft()); setNotice(""); setMenu(null); textarea.current?.focus();
  };
  const addFiles = (files: File[]) => { const error = uploadFiles(chatId, files); if (error) setNotice(error); };
  const selectedModel = meta.modelOptions.find(model => model.id === meta.chat.modelId);
  const efforts = selectedModel?.supportedEfforts?.map(value => value.value) ?? ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (meta.chat.archivedAt) return <footer className="archived-footer"><span>Диалог в архиве</span><button className="primary" onClick={() => command(chatId, "chat.restore")}>Восстановить</button></footer>;
  return <footer className="composer-footer"><div className="composer-stack">
    {!!meta.chat.queuedMessages.length && <ol className="queue-list" aria-label="Очередь сообщений">{meta.chat.queuedMessages.map((item, index) => {
      const state = (item as typeof item & { dispatchState?: string; dispatchError?: string });
      return <li key={item.id}><div className="queued-text"><span>{item.text || "Вложения"}</span>{state.dispatchError && <span className="error-text">{state.dispatchError}</span>}{state.dispatchState && state.dispatchState !== "queued" && <small>{queueLabels[state.dispatchState] ?? "Ожидает отправки"}</small>}</div>
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
        {draft.skills.map(skill => <div className="attachment-chip" key={skill.path}><Sparkles size={14} /><span>{skill.name}</span><IconButton icon={X} label={`Удалить навык ${skill.name}`} onClick={() => update({ ...draft, skills: draft.skills.filter(value => value.path !== skill.path) })} /></div>)}
      </div>}
      <textarea ref={textarea} data-role="prompt-input" aria-label="Сообщение Codex" placeholder={active ? "Добавьте рекомендацию или сообщение в очередь" : "Напишите задачу для Codex"} value={draft.text} rows={1} maxLength={200000}
        onChange={event => update({ ...draft, text: event.target.value })}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addFiles(files); } }}
        onKeyDownCapture={event => {
          const key = event.key.toLowerCase();
          const selectAllKey = key === "a" || (event.code === "KeyA" && !/^[a-z]$/.test(key));
          if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && selectAllKey
            && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            // Keep select-all inside the input before the webview forwards shortcuts to its host.
            event.preventDefault(); event.stopPropagation(); event.currentTarget.select();
          }
        }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); send(active ? event.metaKey || event.ctrlKey ? "chat.steer" : "chat.queue.add" : "chat.send");
          }
        }} />
      <div className="composer-toolbar"><div className="composer-tools">
        <IconButton icon={Paperclip} label="Прикрепить файл" aria-haspopup="dialog" aria-expanded={menu === "attachments"} onClick={event => toggleMenu("attachments", event.currentTarget)} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {menu === "attachments" && menuAnchor && <Popover anchor={menuAnchor} label="Прикрепить файл" onClose={() => setMenu(null)}><button onClick={() => { command(chatId, "chat.attachments.pick", { attachments: draft.attachments }); setMenu(null); }}><FolderOpen size={16} />Из проекта</button><button onClick={() => { fileInput.current?.click(); setMenu(null); }}><Upload size={16} />С компьютера</button></Popover>}
        <ComposerSelect label="Режим доступа" caption={accessLabels[meta.chat.accessMode]} className={meta.chat.accessMode === "danger-full-access" ? "danger-access" : ""} icon={meta.chat.accessMode === "danger-full-access" ? <LockKeyholeOpen size={15} /> : <LockKeyhole size={15} />} value={meta.chat.accessMode} onChange={value => command(chatId, "chat.access.set", { accessMode: value })} options={Object.entries(accessLabels).map(([value, label]) => ({ value, label }))} />
        <label className="planning-control"><input type="checkbox" checked={draft.planning} onChange={event => update({ ...draft, planning: event.target.checked })} />План</label>
      </div><div className="composer-options">
        <span className={`context-usage ${meta.contextWindow.status}`} role="img" aria-label={meta.contextWindow.usedPercent === null ? "Размер контекста неизвестен" : `Использовано ${Math.round(meta.contextWindow.usedPercent)}% контекста`} title={meta.contextWindow.message || (meta.contextWindow.usedPercent === null ? "Размер контекста неизвестен" : `Использовано ${Math.round(meta.contextWindow.usedPercent)}% контекста`)} style={{ "--context-angle": `${Math.max(0, Math.min(100, meta.contextWindow.usedPercent ?? 0)) * 3.6}deg` } as CSSProperties}><span className="context-ring" /></span>
        <ComposerSelect label="Модель" caption={meta.chat.modelLabel} value={meta.chat.modelId ?? ""} onOpen={() => { if (meta.modelOptionsStatus === "idle") command(chatId, "chat.models.load"); }} onChange={value => { const model = meta.modelOptions.find(model => (model.id ?? "") === value); if (model) command(chatId, "chat.model.set", { modelId: model.id, modelLabel: model.label }); }}
          options={[...(!meta.modelOptions.some(model => model.id === meta.chat.modelId) ? [{ value: meta.chat.modelId ?? "", label: meta.chat.modelLabel }] : []), ...meta.modelOptions.map(model => ({ value: model.id ?? "", label: model.label }))]}
          footer={<button className="model-refresh" disabled={meta.modelOptionsStatus === "loading"} onClick={() => command(chatId, "chat.models.load", { forceReload: true })}><RefreshCw size={15} />{meta.modelOptionsStatus === "loading" ? "Загрузка моделей…" : "Обновить модели"}</button>} />
        <ComposerSelect label="Интеллект" caption={effortLabels[meta.chat.effort] ?? "По умолчанию"} value={meta.chat.effort} onChange={value => command(chatId, "chat.effort.set", { effort: value })} options={efforts.map(value => ({ value, label: effortLabels[value] ?? value }))} />
        <ComposerSelect label="Скорость" caption={meta.chat.speed === "fast" ? "Быстрый" : "Стандартный"} value={meta.chat.speed} onChange={value => command(chatId, "chat.speed.set", { speed: value })} options={[{ value: "standard", label: "Стандартный" }, { value: "fast", label: "Быстрый" }]} />
        <button type="button" className="skills-trigger" aria-haspopup="dialog" aria-expanded={menu === "skills"} onClick={event => { toggleMenu("skills", event.currentTarget); if (skillsStatus === "idle") { setSkillsStatus("loading"); command(chatId, "chat.skills.load"); } }}><Sparkles size={15} />Навыки</button>
        {menu === "skills" && menuAnchor && <Popover anchor={menuAnchor} label="Навыки" className="skills-popover" onClose={() => setMenu(null)}><div className="panel-toolbar"><input aria-label="Найти навык" placeholder="Найти навык" value={skillsFilter} onChange={event => setSkillsFilter(event.target.value)} /><IconButton icon={RefreshCw} label="Обновить навыки" onClick={() => { setSkillsStatus("loading"); command(chatId, "chat.skills.load", { forceReload: true }); }} /></div>
          {skillsStatus === "loading" ? <p role="status">Загрузка…</p> : skills.filter(skill => `${skill.displayName} ${skill.name}`.toLowerCase().includes(skillsFilter.toLowerCase())).slice(0, 100).map(skill => {
            const checked = draft.skills.some(value => value.path === skill.path);
            return <label key={skill.path} title={skill.description}><input type="checkbox" checked={checked} disabled={!skill.enabled || (!checked && draft.skills.length >= 8)} onChange={() => update({ ...draft, skills: checked ? draft.skills.filter(value => value.path !== skill.path) : [...draft.skills, { name: skill.name, path: skill.path }] })} /><span>{skill.displayName || skill.name}<small>{skill.shortDescription}</small></span></label>;
          })}{skillsStatus === "ready" && !skills.length && <p>Навыков нет.</p>}
        </Popover>}
        {meta.chat.kind === "project" && <div className="composer-context">
          <IconButton icon={FolderOpen} label="Файлы проекта" onClick={() => onContext("project")} />
          <IconButton icon={BookMarked} label="Документация проекта" onClick={() => onContext("docs")} />
          <IconButton icon={FileText} label="Правила проекта" onClick={() => command(chatId, "chat.rules.open")} />
        </div>}
      </div><div className="composer-send">
        {active && meta.chat.status !== "cancelling" && !uploads.length && (!!draft.text.trim() || !!draft.attachments.length) && <div className="followup-selector">
          <IconButton className="followup-primary" icon={ArrowUp} label="Добавить в очередь" onClick={() => send("chat.queue.add")} />
          <IconButton className="followup-trigger" icon={ChevronDown} label="Выбрать способ отправки" aria-haspopup="dialog" aria-expanded={menu === "followup"} onClick={event => toggleMenu("followup", event.currentTarget)} />
          {menu === "followup" && menuAnchor && <Popover anchor={menuAnchor} label="Способ отправки" onClose={() => setMenu(null)}><button onClick={() => send("chat.queue.add")}><ListPlus size={16} />В очередь</button><button aria-label="Направить текущий запрос" disabled={meta.chat.status !== "running"} onClick={() => send("chat.steer")}><CornerUpRight size={16} />Как рекомендацию</button></Popover>}
        </div>}
        {active ? <IconButton className="stop-button" icon={Square} label="Остановить текущий запрос" disabled={meta.chat.status === "cancelling"} onClick={() => command(chatId, "chat.cancel")} /> : <IconButton className="primary send-button" icon={ArrowUp} label="Отправить сообщение" disabled={!!uploads.length || (!draft.text.trim() && !draft.attachments.length)} onClick={() => send("chat.send")} />}
      </div></div>
    </div>
  </div></footer>;
});
