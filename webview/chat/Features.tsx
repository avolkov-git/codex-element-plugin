import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, MessageSquarePlus, Play, RefreshCw, Search, Undo2, X, Check, Download } from "lucide-react";
import { command, saved, store, vscode } from "./bridge";
import { BoundedText, IconButton, Modal } from "./controls";

export type FeatureView = "history" | "review" | "project" | "browser" | "context";
interface FeatureItem { id: string; title?: string; path?: string; name?: string; label?: string; excerpt?: string; chatId?: string; itemId?: string; createdAt?: string; revision?: string; canStage?: boolean; canRevert?: boolean; available?: boolean; reason?: string; size?: number; kind?: string; change?: string; profileId?: string; workspaceId?: string; chatCount?: number; updatedAt?: string }
interface FeatureResult { ok?: boolean; command?: string; status?: string; message?: string; items?: FeatureItem[]; nextOffset?: number | null; preview?: unknown; artifact?: { name?: string }; review?: { id: string; path: string; revision: string; before: { text: string }; after: { text: string } }; index?: number; chatId?: string }
const titles = { history: "История", review: "Изменения", project: "Действия проекта", browser: "Артефакты браузера", context: "Контекст" };

export function FeaturePanel({ kind, chatId, close }: { kind: FeatureView; chatId: string; close: () => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FeatureItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [migration, setMigration] = useState(false);
  const [preview, setPreview] = useState<unknown>();
  const [review, setReview] = useState<FeatureResult["review"]>();
  const [confirmation, setConfirmation] = useState<{ command: string; item: FeatureItem; label: string }>();
  const [commentItem, setCommentItem] = useState<FeatureItem>();
  const [comment, setComment] = useState("");
  const [line, setLine] = useState(1);
  const [sendToChat, setSendToChat] = useState(false);
  const generation = useRef(0);
  const invoke = async (name: string, payload?: unknown): Promise<FeatureResult> => {
    const result = await store.request(name, payload, chatId) as FeatureResult;
    if (result?.ok === false) throw new Error(result.message || "Действие недоступно.");
    return result ?? {};
  };
  const load = async (next?: number, importing = migration) => {
    const id = ++generation.current;
    setBusy(true); setNotice(""); setReview(undefined); setPreview(undefined);
    try {
      const name = kind === "history" ? importing ? "history.migration.list" : "history.search" : kind === "review" ? "review.list" : kind === "project" ? "project.actions" : "browser.artifacts.list";
      const result = await invoke(name, { query, offset: next, limit: 50 });
      if (generation.current !== id) return;
      setItems((result.items ?? []).slice(0, 100)); setCursor(result.nextOffset ?? null); setNotice(result.message ?? "");
    } catch (error) { if (generation.current === id) setNotice(error instanceof Error ? error.message : "Не удалось загрузить список."); }
    finally { if (generation.current === id) setBusy(false); }
  };
  useEffect(() => {
    if (kind !== "context") void load();
    return () => { generation.current++; };
  }, [kind, chatId]);
  useEffect(() => store.onEvent(event => {
    if (kind === "context" && event.event === "chat.context.details" && (!event.chatId || event.chatId === chatId)) { setPreview(event.payload); setBusy(false); }
  }), [kind, chatId]);
  const action = async (name: string, payload: unknown) => {
    setBusy(true); setNotice("");
    try {
      const result = await invoke(name, payload);
      if (name === "history.jump" && Number.isSafeInteger(result.index)) {
        const targetChat = result.chatId ?? chatId;
        saved.anchors ??= {}; saved.anchors[targetChat] = { index: result.index!, offset: 0, following: false };
        vscode.setState(saved);
        store.receive({ type: "event", event: "chat.jump", chatId: targetChat, payload: { offset: result.index } });
      }
      if (result.review) setReview(result.review);
      if (result.preview !== undefined) setPreview(result.preview);
      setNotice(result.message ?? "");
      if (["review.stage", "review.revert", "project.action.run"].includes(name)) await load();
      if (name === "review.comment") { setCommentItem(undefined); setComment(""); }
      if (name === "history.migration.import") await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Действие не выполнено."); }
    finally { setBusy(false); setConfirmation(undefined); }
  };
  const name = (item: FeatureItem) => item.title || item.label || item.path || item.name || item.id;
  return <aside className="feature-panel" aria-label={titles[kind]}>
    <div className="panel-heading"><h2>{titles[kind]}</h2><IconButton icon={X} label="Закрыть панель" onClick={close} /></div>
    {kind === "history" && !migration && <form className="panel-toolbar" onSubmit={event => { event.preventDefault(); void load(); }}><input autoFocus aria-label="Поиск по истории" placeholder="Поиск по истории" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} /><IconButton icon={Search} label="Найти" type="submit" disabled={busy} /></form>}
    {kind === "history" && <div className="panel-toolbar"><button aria-pressed={!migration} disabled={busy} onClick={() => { setMigration(false); void load(undefined, false); }}>Диалоги</button><button aria-pressed={migration} disabled={busy} onClick={() => { setMigration(true); void load(undefined, true); }}>Перенос истории</button></div>}
    {kind === "history" && migration && <div className="panel-toolbar"><IconButton icon={RefreshCw} label="Обновить список" disabled={busy} onClick={() => void load()} /><button disabled={busy} onClick={() => void action("history.migration.help", {})}>Открыть инструкцию</button></div>}
    {kind !== "context" && kind !== "history" && <div className="panel-toolbar"><IconButton icon={RefreshCw} label="Обновить список" disabled={busy} onClick={() => void load()} /></div>}
    {kind === "context" && <div className="panel-toolbar"><button onClick={() => { setBusy(true); command(chatId, "chat.context.projectDetails"); }}>Проект</button><button onClick={() => { setBusy(true); command(chatId, "chat.context.docsDetails"); }}>Документация</button><button onClick={() => command(chatId, "chat.rules.open")}>Правила</button></div>}
    {notice && <p className="feature-notice" role="status">{notice}</p>}{busy && <p role="status">Загрузка…</p>}
    <div className="feature-content">
      {items.map((item, index) => <div className="feature-item" key={`${item.id ?? item.itemId}-${index}`}>
        <div className="feature-item-main"><strong>{name(item)}</strong>{item.excerpt && <p>{item.excerpt}</p>}{item.reason && <small>{item.reason}</small>}{item.change && <small>{item.change}</small>}{item.kind && <small>{item.kind}{item.size === undefined ? "" : ` · ${Math.round(item.size / 1024)} КБ`}</small>}</div>
        <div className="feature-item-actions">
          {kind === "history" && (migration ? <><span>{item.chatCount ?? 0} диалогов · {item.updatedAt ?? ""}</span><IconButton icon={Download} label="Перенести историю" disabled={busy} onClick={() => void action("history.migration.import", { id: item.id })} /></> : <IconButton icon={ArrowRight} label="Перейти к сообщению" disabled={busy} onClick={() => void action("history.jump", { chatId: item.chatId, itemId: item.itemId })} />)}
          {kind === "review" && <>
            <IconButton icon={ExternalLink} label="Открыть изменения" disabled={busy} onClick={() => void action("review.open", { id: item.id })} />
            <IconButton icon={MessageSquarePlus} label="Комментировать изменение" disabled={busy || !item.revision} onClick={() => { setCommentItem(item); setLine(1); setComment(""); setSendToChat(false); }} />
            <IconButton icon={Check} label="Добавить в индекс" disabled={busy || !item.canStage} title={item.canStage ? "Добавить в индекс" : item.reason || "Недоступно"} onClick={() => setConfirmation({ command: "review.stage", item, label: "Добавить в индекс" })} />
            <IconButton icon={Undo2} label="Отменить изменение" disabled={busy || !item.canRevert} title={item.canRevert ? "Отменить изменение" : item.reason || "Недоступно"} onClick={() => setConfirmation({ command: "review.revert", item, label: "Отменить изменение" })} />
          </>}
          {kind === "project" && <IconButton icon={Play} label={`Запустить: ${name(item)}`} disabled={busy || !item.available} onClick={() => setConfirmation({ command: "project.action.run", item, label: name(item) })} />}
          {kind === "browser" && <IconButton icon={ExternalLink} label="Открыть артефакт" disabled={busy} onClick={() => void action("browser.artifacts.open", { id: item.id })} />}
        </div>
      </div>)}
      {!busy && !items.length && kind !== "context" && !notice && <p className="muted">Нет результатов.</p>}
      {cursor !== null && <button disabled={busy} onClick={() => void load(cursor)}>Следующая страница</button>}
      {review && <section className="review-preview"><h3>{review.path}</h3><details><summary>До изменения</summary><BoundedText>{review.before.text}</BoundedText></details><details open><summary>После изменения</summary><BoundedText>{review.after.text}</BoundedText></details></section>}
      {preview !== undefined && <ArtifactPreview value={preview} />}
    </div>
    {confirmation && <Modal title={confirmation.label} onCancel={busy ? undefined : () => setConfirmation(undefined)}><p className="file-path">{name(confirmation.item)}</p>{confirmation.command === "review.revert" && <p>Изменение файла будет отменено. Несохранённый текст и ревизия проверяются перед выполнением.</p>}<div className="dialog-actions"><button disabled={busy} onClick={() => setConfirmation(undefined)}>Отмена</button><button className="primary" disabled={busy} onClick={() => void action(confirmation.command, { id: confirmation.item.id, revision: confirmation.item.revision, confirmed: true })}>{confirmation.label}</button></div></Modal>}
    {commentItem && <Modal title="Комментарий к изменению" onCancel={busy ? undefined : () => setCommentItem(undefined)}><form onSubmit={event => { event.preventDefault(); void action("review.comment", { id: commentItem.id, revision: commentItem.revision, line, text: comment, sendToChat }); }}><p className="file-path">{name(commentItem)}</p><label>Строка<input type="number" min={1} max={10000000} value={line} onChange={event => setLine(Math.max(1, Number(event.target.value) || 1))} /></label><textarea aria-label="Комментарий" required maxLength={20000} value={comment} onChange={event => setComment(event.target.value)} /><label className="question-option"><input type="checkbox" checked={sendToChat} onChange={event => setSendToChat(event.target.checked)} />Отправить в диалог</label><div className="dialog-actions"><button className="primary" disabled={busy || !comment.trim()} type="submit">Добавить комментарий</button></div></form></Modal>}
  </aside>;
}

function ArtifactPreview({ value }: { value: unknown }) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const data = typeof value === "string" ? value : object?.dataUrl ?? object?.text ?? object?.content;
  if (typeof data === "string" && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data) && data.length <= 6 * 1024 * 1024) return <img className="artifact-image" src={data} alt="Артефакт браузера" />;
  return <BoundedText>{typeof data === "string" ? data : JSON.stringify(value, null, 2)}</BoundedText>;
}
