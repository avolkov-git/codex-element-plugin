import { useCallback, useState, useSyncExternalStore } from "react";
import { Search, FileDiff, Play, PanelsTopLeft, GitFork, ChevronDown, ChevronRight, BookOpen } from "lucide-react";
import { command, store } from "./bridge";
import { IconButton, Modal } from "./controls";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { FeaturePanel, type FeatureView } from "./Features";
import { Approval } from "./Questions";

export function App() {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [feature, setFeature] = useState<FeatureView | null>(null);
  const [contextSection, setContextSection] = useState<"project" | "docs" | undefined>();
  const openContext = useCallback((section: "project" | "docs") => { setContextSection(section); setFeature("context"); }, []);
  const [fork, setFork] = useState(false);
  const [forkTitle, setForkTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const meta = view.meta;
  if (!meta) return <main className="app empty-app"><h1>Codex</h1><p className="muted">{view.revision ? "Выберите диалог или создайте новый." : "Загрузка диалога…"}</p></main>;
  const chat = meta.chat;
  const expanded = meta.chatHeaderMode === "expanded";
  const toggle = (kind: FeatureView) => setFeature(feature === kind ? null : kind);
  const statusLabels = { idle: "Готов", running: "Выполняется", waitingApproval: "Ожидает разрешения", cancelling: "Останавливается", error: "Ошибка" };
  const runtimeLabels = { notStarted: "сервер Codex не запущен", starting: "сервер Codex запускается", running: "сервер Codex работает", error: "ошибка сервера Codex" };
  const question = meta.pendingUserInputs?.length || meta.pendingUserInput || chat.pendingUserInput;
  return <><main className="app">
    <header className={`header ${expanded ? "header-expanded" : "header-collapsed"}`}>
      <div className="header-main">{expanded ? <>
        <div className="eyebrow">{chat.kind === "project" ? "Проектный чат" : "Общий чат"}</div>
        <h1 className="title">{chat.title}</h1>
        <div className="meta">Учётная запись: {meta.auth.accountLabel || "не подключена"} · {runtimeLabels[meta.runtime.status]}</div>
      </> : <h1 className="compact-title-line" title={chat.title}><span className="compact-chat-title">{chat.title}</span><span className="compact-chat-kind">, {chat.kind === "project" ? "проектный чат" : "общий чат"}</span></h1>}</div>
      <div className="header-actions">
        {expanded && <span className={`chat-status ${chat.status}`}>{chat.archivedAt ? "Архив" : statusLabels[chat.status]}</span>}
        <nav className="chat-navigation" aria-label="Действия диалога">
      <IconButton icon={Search} label="Поиск по истории" aria-pressed={feature === "history"} onClick={() => toggle("history")} />
      <IconButton icon={FileDiff} label="Проверить изменения" aria-pressed={feature === "review"} onClick={() => toggle("review")} />
      <IconButton icon={Play} label="Действия проекта" aria-pressed={feature === "project"} onClick={() => toggle("project")} />
      <IconButton icon={PanelsTopLeft} label="Артефакты браузера" aria-pressed={feature === "browser"} onClick={() => toggle("browser")} />
      <IconButton icon={BookOpen} label="Контекст проекта" aria-pressed={feature === "context"} onClick={() => toggle("context")} />
      <IconButton icon={GitFork} label="Разветвить диалог" disabled={chat.status !== "idle"} onClick={() => { setForkTitle(chat.title); setError(""); setFork(true); }} />
        </nav>
        <IconButton className="header-toggle" icon={expanded ? ChevronDown : ChevronRight} label={expanded ? "Свернуть заголовок" : "Развернуть заголовок"} aria-expanded={expanded} onClick={() => command(chat.id, "chat.header.toggle")} />
      </div>
    </header>
    <div className={`chat-stage${feature ? " has-feature" : ""}`}>
      <Transcript key={chat.id} view={view} />
      {feature && <FeaturePanel key={`${chat.id}:${feature}`} kind={feature} chatId={chat.id} rulesEnabled={chat.rulesEnabled} contextSection={contextSection} close={() => setFeature(null)} />}
    </div>
    <Composer key={chat.id} meta={meta} onContext={openContext} />
  </main>
  {chat.pendingApproval && <Approval key={chat.pendingApproval.id} approval={chat.pendingApproval} chatId={chat.id} />}
  {fork && !question && !chat.pendingApproval && <Modal title="Разветвить диалог" onCancel={busy ? undefined : () => setFork(false)}><form onSubmit={event => {
    event.preventDefault(); setBusy(true); setError("");
    void store.request("chat.fork", { title: forkTitle }, chat.id).then(result => {
      if (result?.ok === false) throw new Error(result.message || "Не удалось разветвить диалог.");
      setFork(false);
    }).catch(reason => setError(reason instanceof Error ? reason.message : "Не удалось разветвить диалог.")).finally(() => setBusy(false));
  }}><label>Название<input aria-label="Название нового диалога" value={forkTitle} maxLength={200} onChange={event => setForkTitle(event.target.value)} /></label><p>Новый диалог использует ту же рабочую область. Файлы не изолируются.</p>{error && <p className="error-text" role="alert">{error}</p>}<div className="dialog-actions"><button className="primary" disabled={busy || !forkTitle.trim()} type="submit">Создать диалог</button></div></form></Modal>}
  </>;
}
