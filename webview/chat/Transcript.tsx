import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, ExternalLink, File, FileDiff, LoaderCircle, Terminal, Check, CircleAlert, Copy, Lightbulb } from "lucide-react";
import type { ChatTranscriptItem, ChatTurnRunTranscriptItem } from "../../src/types";
import { command, saved, store, vscode, type ChatView } from "./bridge";
import { BoundedText, IconButton } from "./controls";
import { Markdown } from "./Markdown";

const operational = (item: ChatTranscriptItem) => ["activity", "worklog", "diff", "compaction"].includes(item.kind);
const groupedOperation = (item: ChatTranscriptItem) => ["activity", "worklog", "compaction"].includes(item.kind) && (!("status" in item) || item.status !== "running");
const labels = { running: "Выполняется", completed: "Завершено", error: "Ошибка" };
const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
  return `${Math.floor(seconds / 3600)} ч ${Math.floor(seconds % 3600 / 60)} мин`;
}
function Elapsed({ createdAt, completedAt, running, prefix = "" }: { createdAt: string; completedAt?: string; running: boolean; prefix?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const end = completedAt ? Date.parse(completedAt) : running ? now : Date.parse(createdAt);
  return <span className="elapsed">{prefix}{formatElapsed(Math.max(0, end - Date.parse(createdAt)))}</span>;
}

function Operation({ item, chatId }: { item: ChatTranscriptItem; chatId: string }) {
  const [page, setPage] = useState(0);
  const [opened, setOpened] = useState(false);
  const [detail, setDetail] = useState<ChatTranscriptItem>();
  const [notice, setNotice] = useState("");
  const info = item as ChatTranscriptItem & { detailAvailable?: boolean; detailCount?: number };
  const id = item.id;
  const updatedAt = "updatedAt" in item ? item.updatedAt : undefined;
  const status = "status" in item ? item.status : undefined;
  useEffect(() => {
    if (!info.detailAvailable || !opened) return;
    const requestId = `${id}:${page}:${Date.now()}`;
    let timer: ReturnType<typeof setTimeout>;
    setNotice("Загрузка…"); setDetail(undefined);
    const dispose = store.onEvent(event => {
      if (event.event !== "chat.item.detail" || event.chatId !== chatId || event.payload?.requestId !== requestId) return;
      clearTimeout(timer);
      if (event.payload.item) { setDetail(event.payload.item); setNotice(""); }
      else setNotice("Операция больше недоступна.");
    });
    command(chatId, "chat.item.load", { id, requestId, offset: page * 20 });
    timer = setTimeout(() => setNotice("Нет ответа. Закройте и откройте операцию повторно."), 10000);
    return () => { clearTimeout(timer); dispose(); };
  }, [id, chatId, page, opened, info.detailAvailable, updatedAt, status]);
  const detailCount = info.detailCount;
  const start = info.detailAvailable ? 0 : page * 20;
  item = detail ?? item;
  if (item.kind === "worklog") return <details className="worklog" onToggle={event => { if (event.target === event.currentTarget) setOpened(event.currentTarget.open); }}><summary>{item.operationKind === "reasoning" ? <Lightbulb size={15} /> : <Terminal size={15} />}<span>{item.operationKind === "reasoning" ? `Размышления: ${item.title}` : item.title}</span><span className={`row-status ${item.status}`}>{labels[item.status]} <Elapsed createdAt={item.createdAt} completedAt={item.completedAt} running={item.status === "running"} /></span></summary>
    {item.summary && <p>{item.summary}</p>}
    {notice && <p role="status">{notice}</p>}
    {item.children.slice(start, start + 20).map(child => <details key={child.id} className="operation-child"><summary>{child.kind === "reasoning" && <Lightbulb size={13} />}<span className="operation-title">{child.title}</span><span>{labels[child.status]} <Elapsed createdAt={child.createdAt} completedAt={child.completedAt} running={child.status === "running"} /></span></summary>
      {child.path && <button className="text-link" onClick={() => command(chatId, "markdown.openLink", { target: child.path })}>{child.path}</button>}
      <BoundedText>{[child.command, child.query, child.argumentsPreview, child.outputPreview].filter(Boolean).join("\n")}</BoundedText>
    </details>)}
    <Pager page={page} total={detailCount ?? item.children.length} size={20} setPage={setPage} />
  </details>;
  if (item.kind === "activity") return <details className="activity" onToggle={event => { if (event.target === event.currentTarget) setOpened(event.currentTarget.open); }}><summary>{item.activityKind === "reasoning" ? <Lightbulb size={15} /> : <Terminal size={15} />}<span>{item.activityKind === "reasoning" ? `Размышления: ${item.label}` : item.label}</span><span className={`row-status ${item.status}`}>{labels[item.status]} <Elapsed createdAt={item.createdAt} completedAt={item.completedAt} running={item.status === "running"} /></span></summary>
    {notice && <p role="status">{notice}</p>}
    {item.path && <button className="text-link" onClick={() => command(chatId, "markdown.openLink", { target: item.path })}>{item.path}</button>}
    <BoundedText>{[item.command, item.summary, item.outputPreview].filter(Boolean).join("\n")}</BoundedText>
    {item.details?.slice(start, start + 20).map((detail, index) => <details key={index}><summary>{detail.label}</summary><BoundedText>{[detail.command, detail.path, detail.summary, detail.outputPreview].filter(Boolean).join("\n")}</BoundedText></details>)}
    <Pager page={page} total={detailCount ?? item.details?.length ?? 0} size={20} setPage={setPage} />
  </details>;
  if (item.kind === "diff") return <section className="diff-block"><div className="diff-summary"><FileDiff size={16} /><strong>{item.title}</strong><span className="added">+{item.additions}</span><span className="removed">-{item.deletions}</span></div>
    {item.files.slice(start, start + 20).map((file, relativeIndex) => <details key={`${file.path}-${relativeIndex}`} className="diff-file" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary><span className="file-path">{file.path}</span><span className="added">+{file.additions}</span><span className="removed">-{file.deletions}</span>
      <IconButton icon={ExternalLink} label={`Открыть diff ${file.path}`} onClick={event => { event.preventDefault(); command(chatId, "diff.openNative", { diffId: item.id, fileIndex: page * 20 + relativeIndex }); }} /></summary>
      <BoundedText>{notice || file.diff || "Diff недоступен."}</BoundedText>
    </details>)}<Pager page={page} total={detailCount ?? item.files.length} size={20} setPage={value => { setOpened(true); setPage(value); }} />
  </section>;
  if (item.kind === "compaction") return <div className="compaction"><span>{item.label}</span></div>;
  return null;
}

function Pager({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (value: number) => void }) {
  return total > size ? <div className="pager"><IconButton icon={ArrowLeft} label="Предыдущая страница" disabled={!page} onClick={() => setPage(page - 1)} /><span>{page * size + 1}–{Math.min(total, (page + 1) * size)} / {total}</span><IconButton icon={ArrowRight} label="Следующая страница" disabled={(page + 1) * size >= total} onClick={() => setPage(page + 1)} /></div> : null;
}

function Turn({ item, chatId }: { item: ChatTurnRunTranscriptItem; chatId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [window, setWindow] = useState<{ items: ChatTranscriptItem[]; totalCount: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!expanded) return;
    const requestId = `${item.id}:${offset}:${Date.now()}`;
    let timer: ReturnType<typeof setTimeout>;
    setWindow(null); setError("");
    const dispose = store.onEvent(event => {
      if (event.event !== "chat.turn.window" || event.chatId !== chatId || event.payload?.requestId !== requestId) return;
      clearTimeout(timer);
      if (event.payload.window) setWindow(event.payload.window); else setError("Журнал операций недоступен.");
    });
    command(chatId, "chat.turn.load", { requestId, turnId: item.turnId, offset });
    timer = setTimeout(() => setError("Журнал не загружен. Закройте и откройте его повторно."), 10000);
    return () => { clearTimeout(timer); dispose(); };
  }, [expanded, offset, chatId, item.id, item.turnId, item.status, item.updatedAt]);
  const count = Object.values(item.counts ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  return <section className="turn-run"><button className="turn-run-line" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
    {item.status === "running" ? <LoaderCircle className="spin" size={15} /> : item.status === "error" ? <CircleAlert size={15} /> : <Check size={15} />}
    <span><Elapsed createdAt={item.createdAt} completedAt={item.completedAt} running={item.status === "running"} prefix={item.status === "running" ? "Работает уже " : item.status === "error" ? "Работа прервана через " : "Работал на протяжении "} />{count ? ` · ${count} операций` : ""}</span>
  </button>{expanded && <div className="turn-children">
    {window ? <>{window.items.slice(0, 40).filter(child => child.kind !== "diff" && operational(child)).map(child => <Operation key={child.id} item={child} chatId={chatId} />)}
      {!window.items.length && <p className="muted">Нет операций.</p>}
      <Pager page={Math.floor(offset / 40)} total={window.totalCount} size={40} setPage={page => setOffset(page * 40)} /></> : <p role="status">{error || "Загрузка операций…"}</p>}
  </div>}</section>;
}

const TranscriptRow = memo(function TranscriptRow({ item, chatId, syntheticTurn }: { item?: ChatTranscriptItem; chatId: string; syntheticTurn?: ChatTurnRunTranscriptItem }) {
  if (syntheticTurn) return <><Turn item={syntheticTurn} chatId={chatId} />{item && (syntheticTurn.status === "running" || !groupedOperation(item)) && <Operation item={item} chatId={chatId} />}</>;
  if (!item) return <div className="history-placeholder" aria-label="Загрузка сообщения" />;
  if (item.kind === "message") return <article className={`message message-${item.role}`} data-item-id={item.id}>
    <div className="message-meta"><span>{item.role === "assistant" ? "Codex" : item.role === "user" ? "Вы" : "Система"}</span><time>{time(item.createdAt)}</time>
      <IconButton icon={Copy} label="Копировать сообщение" onClick={() => command(chatId, "clipboard.write", { text: item.text })} /></div>
    <Markdown text={item.text} chatId={chatId} streaming={item.status === "streaming"} />
    {!!item.attachments?.length && <div className="message-attachments">{item.attachments.map(attachment => <button key={attachment.id} className="message-attachment" onClick={() => command(chatId, "chat.attachment.open", { attachment })}><File size={14} />{attachment.name}</button>)}</div>}
    {item.durationMs !== undefined && <span className="message-duration">{Math.round(item.durationMs / 1000)} с</span>}
  </article>;
  if (item.kind === "turn-run") return <Turn item={item} chatId={chatId} />;
  if (operational(item)) return <Operation item={item} chatId={chatId} />;
  if (item.kind === "plan") return <section className="plan-block"><Markdown text={item.markdown} chatId={chatId} /><div className="plan-actions"><button onClick={() => command(chatId, "chat.plan.revise", { planText: item.markdown })}>Изменить план</button><button className="primary" onClick={() => command(chatId, "chat.plan.implement", { planText: item.markdown })}>Реализовать</button></div></section>;
  if (item.kind === "clarification") return <section className="clarification"><Markdown text={item.question} chatId={chatId} /><div className="clarification-options">{item.options.map((option, index) => <button key={index} onClick={() => command(chatId, "chat.send", { prompt: option.answer, mode: "planning" })}><strong>{option.title}</strong>{option.description && <span>{option.description}</span>}</button>)}</div></section>;
  if (item.kind === "connection") return <div className={`connection-state ${item.status}`} role="status">{item.message}{item.attempt ? ` (${item.attempt}/${item.maxAttempts ?? "?"})` : ""}</div>;
  if (item.kind === "error") return <div className="error-state" role="alert"><p>{item.message}</p>{item.details && <details><summary>Подробности</summary><BoundedText>{item.details}</BoundedText></details>}</div>;
  return null;
});

export function Transcript({ view }: { view: ChatView }) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(saved.anchors?.[view.chatId]?.following ?? !view.meta?.chat.hasUnread);
  const [showBottom, setShowBottom] = useState(!following.current);
  const [pinned, setPinned] = useState<number[]>([]);
  const pinnedRows = useRef(new Map<number, ChatTranscriptItem>());
  const firstByTurn = useMemo(() => {
    const result = new Map<string, number>();
    const parents = new Set([...view.rows.values()].filter(item => item.kind === "turn-run").map(item => item.id));
    for (const [index, item] of view.rows) {
      if (!["activity", "worklog", "compaction"].includes(item.kind) || !("turnId" in item) || !item.turnId) continue;
      const parent = view.turns.get(item.turnId);
      if (parent && !parents.has(parent.id)) result.set(item.turnId, Math.min(result.get(item.turnId) ?? Infinity, index));
    }
    return result;
  }, [view.rows, view.turns]);
  const hidden = useCallback((index: number) => {
    const item = view.rows.get(index);
    return !!item && groupedOperation(item) && "turnId" in item && !!item.turnId && !!view.turns.get(item.turnId)
      && view.turns.get(item.turnId)?.status !== "running" && firstByTurn.get(item.turnId) !== index;
  }, [view.rows, view.turns, firstByTurn]);
  const getKey = useCallback((index: number) => `${view.chatId}:${index}`, [view.chatId]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: view.total, getScrollElement: () => ref.current, getItemKey: getKey,
    estimateSize: index => hidden(index) ? 0 : 108, overscan: 8,
    anchorTo: "end", followOnAppend: following.current, scrollEndThreshold: 64,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range).filter(index => !hidden(index)), ...pinned])].sort((a, b) => a - b)
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => following.current || item.start < (instance.scrollOffset ?? 0);
  useLayoutEffect(() => {
    for (const index of view.rows.keys()) if (hidden(index) && !pinned.includes(index)) virtualizer.resizeItem(index, 0);
  }, [view.rows, hidden, pinned, virtualizer]);
  const initialized = useRef(false);
  useEffect(() => store.onEvent(event => {
    if (event.event === "chat.jump" && event.chatId === view.chatId && Number.isSafeInteger(event.payload?.offset)) {
      following.current = false; setShowBottom(true); store.setViewport(event.payload.offset);
      virtualizer.scrollToIndex(Math.min(event.payload.offset, view.total - 1), { align: "start" });
    }
  }), [view.chatId, view.total, virtualizer]);
  useLayoutEffect(() => {
    if (!view.total || initialized.current) return;
    initialized.current = true;
    const anchor = saved.anchors?.[view.chatId];
    if (anchor && !anchor.following) {
      virtualizer.scrollToIndex(Math.min(anchor.index, view.total - 1), { align: "start" });
      if (anchor.offset && ref.current) ref.current.scrollTop += anchor.offset;
      store.setViewport(anchor.index);
    } else virtualizer.scrollToIndex(view.total - 1, { align: "end" });
  }, [view.total, view.chatId, virtualizer]);
  useEffect(() => {
    const element = ref.current!;
    const select = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        if (pinnedRows.current.size) { pinnedRows.current.clear(); setPinned([]); store.pin([]); }
        return;
      }
      const range = selection.getRangeAt(0);
      const indices = Array.from(element.querySelectorAll<HTMLElement>("[data-index]")).filter(node => range.intersectsNode(node)).map(node => Number(node.dataset.index));
      if (!indices.length) return;
      following.current = false; setShowBottom(true);
      for (const index of indices) { const item = store.getSnapshot().rows.get(index); if (item && !pinnedRows.current.has(index)) pinnedRows.current.set(index, item); }
      setPinned(indices); store.pin(indices);
    };
    document.addEventListener("selectionchange", select);
    const resize = new ResizeObserver(() => {
      if (following.current && !document.getSelection()?.toString()) element.scrollTop = element.scrollHeight;
    });
    const content = element.firstElementChild;
    if (content) resize.observe(content);
    return () => { document.removeEventListener("selectionchange", select); resize.disconnect(); store.pin([]); };
  }, []);
  useLayoutEffect(() => {
    if (following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [view.revision]);
  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems.find(item => item.end > (virtualizer.scrollOffset ?? 0));
  useEffect(() => {
    if (first) store.setViewport(first.index);
  }, [first?.index]);
  const readSignal = useRef("");
  const scroll = () => {
    const element = ref.current!;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (!document.getSelection()?.toString()) following.current = near;
    setShowBottom(!near);
    if (first) {
      saved.anchors ??= {};
      saved.anchors[view.chatId] = { index: first.index, offset: element.scrollTop - first.start, following: following.current };
    }
    if (near && readSignal.current !== view.meta?.chat.updatedAt) {
      readSignal.current = view.meta?.chat.updatedAt ?? "";
      command(view.chatId, "chat.readToBottom");
    }
  };
  useEffect(() => () => { vscode.setState(saved); }, []);
  return <div className="transcript-region"><div ref={ref} className="body" data-role="transcript" tabIndex={0} aria-label="История диалога"
    onScroll={scroll} onWheel={event => { if (event.deltaY < 0) { following.current = false; setShowBottom(true); } }}
    onTouchStart={() => { following.current = false; }} onKeyDown={event => { if (["PageUp", "Home", "ArrowUp"].includes(event.key)) following.current = false; }}>
    <div className="virtual-transcript" style={{ height: virtualizer.getTotalSize() }}>
      {virtualItems.map(row => {
        const item = pinnedRows.current.get(row.index) ?? view.rows.get(row.index);
        const parent = item && "turnId" in item && item.turnId && firstByTurn.get(item.turnId) === row.index ? view.turns.get(item.turnId) : undefined;
        const hide = hidden(row.index) && !pinnedRows.current.has(row.index);
        return <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} data-row-id={item?.id} className={`virtual-row${hide ? " hidden-row" : ""}`} style={{ transform: `translateY(${row.start}px)` }}>
          {!hide && <TranscriptRow item={item} chatId={view.chatId} syntheticTurn={parent} />}
        </div>;
      })}
    </div>
    {!view.total && <div className="empty-transcript">Новый диалог</div>}
  </div>{showBottom && <IconButton className="scroll-to-bottom" icon={ArrowDown} label="К последнему сообщению" onClick={() => {
    following.current = true; store.setViewport(Math.max(0, view.total - 100));
    virtualizer.scrollToIndex(Math.max(0, view.total - 1), { align: "end" }); setShowBottom(false);
  }} />}</div>;
}
