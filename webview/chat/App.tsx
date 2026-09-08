import { useState, useSyncExternalStore } from "react";
import { Search, FileDiff, Play, PanelsTopLeft, GitFork, ChevronDown, ChevronUp, BookOpen, Check, LoaderCircle } from "lucide-react";
import { command, store } from "./bridge";
import { IconButton, Modal } from "./controls";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { FeaturePanel, type FeatureView } from "./Features";
import { Approval, NativeQuestions } from "./Questions";

export function App() {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [feature, setFeature] = useState<FeatureView | null>(null);
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
  const question = meta.pendingUserInput ?? chat.pendingUserInput;
  return <><main className="app">
    <header className={`header ${expanded ? "header-expanded" : "header-collapsed"}`}>
      <div className="header-main"><h1 title={chat.title}>{chat.title}</h1>{expanded && <div className="header-context"><span>{chat.kind === "project" ? "Проект" : "Общий диалог"}</span><button className="text-link" onClick={() => toggle("context")}>{meta.projectContext.label || meta.docs.label || "Контекст"}</button><label><input type="checkbox" checked={chat.rulesEnabled} onChange={() => command(chat.id, "chat.rules.toggle")} />Правила</label></div>}</div>
      <div className="header-actions"><span className={`chat-status ${chat.status}`} title={statusLabels[chat.status]}>{chat.status === "running" ? <LoaderCircle size={14} className="spin" /> : chat.status === "idle" ? <Check size={14} /> : null}<span>{statusLabels[chat.status]}</span></span>
        <IconButton icon={expanded ? ChevronUp : ChevronDown} label={expanded ? "Свернуть заголовок" : "Развернуть заголовок"} onClick={() => command(chat.id, "chat.header.toggle")} />
      </div>
    </header>
    <nav className="chat-navigation" aria-label="Действия диалога">
      <IconButton icon={Search} label="Поиск по истории" aria-pressed={feature === "history"} onClick={() => toggle("history")} />
      <IconButton icon={FileDiff} label="Проверить изменения" aria-pressed={feature === "review"} onClick={() => toggle("review")} />
      <IconButton icon={Play} label="Действия проекта" aria-pressed={feature === "project"} onClick={() => toggle("project")} />
      <IconButton icon={PanelsTopLeft} label="Артефакты браузера" aria-pressed={feature === "browser"} onClick={() => toggle("browser")} />
      <IconButton icon={BookOpen} label="Контекст проекта" aria-pressed={feature === "context"} onClick={() => toggle("context")} />
      <IconButton icon={GitFork} label="Разветвить диалог" disabled={chat.status !== "idle"} onClick={() => { setForkTitle(chat.title); setError(""); setFork(true); }} />
    </nav>
    <div className={`chat-stage${feature ? " has-feature" : ""}`}>
      <Transcript key={chat.id} view={view} />
      {feature && <FeaturePanel key={`${chat.id}:${feature}`} kind={feature} chatId={chat.id} close={() => setFeature(null)} />}
    </div>
    <Composer key={chat.id} meta={meta} />
  </main>
  {question ? <NativeQuestions key={question.id} request={question} /> : chat.pendingApproval ? <Approval key={chat.pendingApproval.id} approval={chat.pendingApproval} chatId={chat.id} /> : null}
  {fork && !question && !chat.pendingApproval && <Modal title="Разветвить диалог" onCancel={busy ? undefined : () => setFork(false)}><form onSubmit={event => {
    event.preventDefault(); setBusy(true); setError("");
    void store.request("chat.fork", { title: forkTitle }, chat.id).then(result => {
      if (result?.ok === false) throw new Error(result.message || "Не удалось разветвить диалог.");
      setFork(false);
    }).catch(reason => setError(reason instanceof Error ? reason.message : "Не удалось разветвить диалог.")).finally(() => setBusy(false));
  }}><label>Название<input aria-label="Название нового диалога" value={forkTitle} maxLength={200} onChange={event => setForkTitle(event.target.value)} /></label><p>Новый диалог использует ту же рабочую область. Файлы не изолируются.</p>{error && <p className="error-text" role="alert">{error}</p>}<div className="dialog-actions"><button className="primary" disabled={busy || !forkTitle.trim()} type="submit">Создать диалог</button></div></form></Modal>}
  </>;
}
