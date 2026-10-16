import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { Monitor, Pause, Play, CircleAlert, MousePointer2 } from "lucide-react";
import type { BrowserViewerFrame, BrowserViewerPointer, BrowserViewerState } from "../../src/browserViewerProtocol";
import { contentRect, modifiers, pointInFrame, textInputs, ViewerInputQueue } from "./input";

declare const acquireVsCodeApi: () => { postMessage(message: object): void };
let host: ReturnType<typeof acquireVsCodeApi>;
const initial: BrowserViewerState = { type: "browser.viewer.state", sessionId: "", status: "idle", message: "Подключение к просмотру браузера…", pages: [], selectedPageId: "", controlId: "", pageRevision: 0 };
const navigationKeys = new Set(["Enter", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function App() {
  const [state, setState] = useState(initial);
  const current = useRef(initial);
  const [frame, setFrame] = useState<BrowserViewerFrame>();
  const decoded = useRef<BrowserViewerFrame | undefined>(undefined);
  const [frameReady, setFrameReady] = useState(false);
  const acknowledged = useRef(false);
  const [imageError, setImageError] = useState(false);
  const [inputError, setInputError] = useState("");
  const [cursor, setCursor] = useState<{ kind: "move" | "click"; x: number; y: number }>();
  const [focusBounds, setFocusBounds] = useState<BrowserViewerPointer["bounds"]>();
  const [controlRequested, setControlRequested] = useState(false);
  const requested = useRef(false);
  const activeControl = useRef("");
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const controlButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const generation = useRef(0);
  const composition = useRef("");
  const compositionCommit = useRef("");
  const grantTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function release(notify = false) {
    const wasRequested = requested.current;
    requested.current = false; activeControl.current = "";
    clearTimeout(grantTimeout.current);
    queue.current!.clear();
    composition.current = ""; compositionCommit.current = "";
    if (keyboard.current) { keyboard.current.value = ""; keyboard.current.blur(); }
    setKeyboardFocused(false); setControlRequested(false);
    if (notify && wasRequested) host.postMessage({ type: "viewer.control", sessionId: current.current.sessionId, pageId: current.current.selectedPageId, enabled: false });
  }

  function failInput(message: string) { setInputError(message); release(true); }
  const queue = useRef<ViewerInputQueue | null>(null);
  if (!queue.current) queue.current = new ViewerInputQueue(message => host.postMessage(message), failInput);

  function canControl() {
    return requested.current && !!activeControl.current && activeControl.current === current.current.controlId && current.current.status === "live" && acknowledged.current && !document.hidden;
  }

  function clearFrame() {
    generation.current++; decoded.current = undefined; acknowledged.current = false;
    setFrame(undefined); setFrameReady(false); setCursor(undefined); setFocusBounds(undefined); setImageError(false);
  }

  function invalidateAcknowledgement() {
    generation.current++; acknowledged.current = false; setFrameReady(false);
  }

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage.current!);
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (value?.type === "browser.viewer.readyRequest") {
        host.postMessage({ type: "viewer.ready", visible: !document.hidden });
      } else if (value?.type === "browser.viewer.state") {
        const next = value as BrowserViewerState;
        const previous = current.current;
        const scopeChanged = next.sessionId !== previous.sessionId || next.selectedPageId !== previous.selectedPageId || next.pageRevision !== previous.pageRevision;
        if (scopeChanged || next.status === "idle") { clearFrame(); setInputError(""); }
        if (next.status !== "live") invalidateAcknowledgement();
        if (scopeChanged || next.status !== "live" || next.inputError || (activeControl.current && next.controlId !== activeControl.current)) release();
        current.current = next; setState(next);
        if (requested.current && next.controlId && !activeControl.current && acknowledged.current && !document.hidden) {
          activeControl.current = next.controlId;
          clearTimeout(grantTimeout.current);
          queue.current!.activate({ sessionId: next.sessionId, pageId: next.selectedPageId, controlId: next.controlId });
          keyboard.current?.focus({ preventScroll: true });
        }
      } else if (value?.type === "browser.viewer.frameClear") {
        if (value.sessionId !== current.current.sessionId || value.pageId !== current.current.selectedPageId) return;
        release(true); clearFrame();
      } else if (value?.type === "browser.viewer.pointer") {
        const next = value as BrowserViewerPointer;
        if (next.sessionId !== current.current.sessionId || next.pageId !== current.current.selectedPageId) return;
        if (next.kind === "clear") { setCursor(undefined); setFocusBounds(undefined); return; }
        if (!decoded.current || ![next.x, next.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return;
        const bounds = next.bounds;
        const validBounds = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(n => Number.isFinite(n) && n >= 0 && n <= 1);
        if (next.kind === "move" || next.kind === "click") setCursor({ kind: next.kind, x: next.x, y: next.y });
        if (next.kind === "focus" || bounds) setFocusBounds(validBounds ? { ...bounds, width: Math.min(bounds.width, 1 - bounds.x), height: Math.min(bounds.height, 1 - bounds.y) } : undefined);
      } else if (value?.type === "browser.viewer.inputResult") {
        queue.current!.result(value);
      } else if (value?.type === "browser.viewer.frame") {
        const next = value as BrowserViewerFrame;
        if (next.sessionId !== current.current.sessionId || next.pageId !== current.current.selectedPageId || next.pageRevision !== current.current.pageRevision || typeof next.data !== "string" || next.data.length > 512 * 1024) return;
        const epoch = generation.current;
        const image = new Image(); image.src = `data:image/jpeg;base64,${next.data}`;
        let valid = false;
        void image.decode().then(() => {
          if (generation.current === epoch && current.current.status === "live" && !document.hidden) {
            valid = true;
            decoded.current = { ...next, width: image.naturalWidth, height: image.naturalHeight };
            setFrame(decoded.current); setImageError(false);
          }
        }).catch(() => {
          if (generation.current === epoch) { acknowledged.current = false; setFrameReady(false); setImageError(true); setCursor(undefined); setFocusBounds(undefined); release(true); }
        }).finally(() => {
          requestAnimationFrame(() => {
            host.postMessage({ type: "viewer.ack", sessionId: next.sessionId, pageId: next.pageId, sequence: next.sequence });
            if (valid && generation.current === epoch) { acknowledged.current = true; setFrameReady(true); }
          });
        });
      }
    };
    const visibility = () => {
      if (document.hidden) { release(true); invalidateAcknowledgement(); }
      host.postMessage({ type: document.hidden ? "viewer.visibility" : "viewer.ready", visible: !document.hidden });
    };
    window.addEventListener("message", receive);
    document.addEventListener("visibilitychange", visibility);
    host.postMessage({ type: "viewer.ready", visible: !document.hidden });
    return () => {
      generation.current++; queue.current!.clear(); clearTimeout(grantTimeout.current); observer.disconnect();
      window.removeEventListener("message", receive); document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function point(event: { clientX: number; clientY: number }) {
    const image = decoded.current, element = stage.current;
    if (!canControl() || !image || !element) return;
    const rect = element.getBoundingClientRect();
    return pointInFrame(event.clientX, event.clientY, rect, contentRect(rect.width, rect.height, image.width, image.height));
  }

  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      const position = point(event);
      if (!position) return;
      event.preventDefault(); event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      queue.current!.enqueue({ kind: "wheel", ...position, deltaX: Math.max(-2000, Math.min(2000, event.deltaX * unit)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY * unit)) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  function click(event: MouseEvent<HTMLElement>) {
    const position = point(event);
    if (!position) return;
    event.preventDefault(); event.stopPropagation();
    keyboard.current?.focus({ preventScroll: true });
    queue.current!.enqueue({ kind: "click", ...position, button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", clickCount: event.detail >= 2 ? 2 : 1, modifiers: modifiers(event) });
  }

  function sendText(text: string) {
    if (!canControl() || !text) return;
    const inputs = textInputs(text);
    if (!inputs) { failInput("Текст слишком длинный или содержит неподдерживаемые символы. Управление отключено."); return; }
    queue.current!.enqueue(...inputs);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!canControl() || event.key === "Escape") return;
    event.stopPropagation();
    if (composition.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    compositionCommit.current = "";
    const altGraph = event.getModifierState("AltGraph") || (event.ctrlKey && event.altKey && !event.metaKey);
    const primary = (event.ctrlKey || event.metaKey) && !altGraph;
    const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (primary && letter === "v") return; // Paste supplies local Unicode, never a remote clipboard read.
    if (navigationKeys.has(event.key) || (primary && ["a", "z", "y"].includes(letter))) {
      event.preventDefault();
      queue.current!.enqueue({ kind: "key", key: navigationKeys.has(event.key) ? event.key : letter, modifiers: modifiers(event) });
    } else if (primary) event.preventDefault();
  }

  const page = state.pages.find(item => item.id === state.selectedPageId);
  const suspended = state.status === "paused" || state.status === "error";
  const toggleLabel = suspended || imageError ? "Возобновить просмотр" : "Приостановить просмотр";
  const controlling = controlRequested && !!state.controlId && state.controlId === activeControl.current;
  const controlLabel = controlRequested ? "Отключить управление" : "Включить управление";
  const error = inputError || state.inputError;
  const status = imageError ? "Не удалось показать кадр. Возобновите просмотр." : error || state.message;
  const rect = frame && contentRect(stageSize.width, stageSize.height, frame.width, frame.height);
  return <main className="browser-viewer" onKeyDown={event => {
    if (event.key === "Escape" && requested.current) {
      event.preventDefault(); event.stopPropagation(); release(true); controlButton.current?.focus({ preventScroll: true });
    }
  }}>
    <header className="viewer-toolbar">
      <Monitor size={18} aria-hidden="true" />
      <select aria-label="Страница браузера агента" disabled={!state.pages.length} value={state.selectedPageId} onChange={event => {
        release(true); clearFrame();
        host.postMessage({ type: "viewer.select", sessionId: state.sessionId, pageId: event.target.value });
      }}>
        {!state.pages.length && <option value="">Браузер агента</option>}
        {state.pages.map(item => <option key={item.id} value={item.id}>{item.title || item.url || "Страница"}</option>)}
      </select>
      <button ref={controlButton} className="viewer-icon-button" title={`${controlLabel}. Esc: отключить управление и освободить клавиатуру`} aria-label={controlLabel} aria-pressed={controlRequested} disabled={!page || state.status !== "live" || !frameReady || imageError} onClick={() => {
        if (requested.current) { release(true); return; }
        setInputError(""); requested.current = true; setControlRequested(true);
        grantTimeout.current = setTimeout(() => failInput("Не удалось включить управление. Попробуйте снова."), 10_000);
        host.postMessage({ type: "viewer.control", sessionId: state.sessionId, pageId: state.selectedPageId, enabled: true });
      }}><MousePointer2 size={18} aria-hidden="true" /></button>
      <button className="viewer-icon-button" title={toggleLabel} aria-label={toggleLabel} disabled={!page} onClick={() => {
        release(true); invalidateAcknowledgement();
        host.postMessage({ type: "viewer.pause", sessionId: state.sessionId, paused: !suspended && !imageError });
      }}>
        {suspended || imageError ? <Play size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}
      </button>
      <span className="viewer-readonly">{controlling ? "Управление" : controlRequested ? "Подключение…" : "Только просмотр"}</span>
    </header>
    <div className="viewer-address" title={page?.url}>{page?.url || "Нет открытой страницы"}</div>
    <section ref={stage} className={`viewer-stage${controlling ? " viewer-controlling" : ""}${keyboardFocused ? " viewer-keyboard-focused" : ""}`} aria-label="Изображение браузера агента"
      onMouseMove={event => { const position = point(event); if (position) queue.current!.enqueue({ kind: "move", ...position }); }}
      onMouseDown={event => { if (point(event)) { event.preventDefault(); keyboard.current?.focus({ preventScroll: true }); } }}
      onClick={click} onAuxClick={click} onContextMenu={event => { if (point(event)) event.preventDefault(); }}>
      {frame ? <img className="viewer-frame" alt="Текущая страница браузера агента" src={`data:image/jpeg;base64,${frame.data}`} draggable={false} /> : <div className="viewer-empty"><Monitor size={32} aria-hidden="true" /><p>{page ? "Ожидание изображения страницы…" : status}</p></div>}
      {rect && (cursor || focusBounds) && <div className="viewer-pointer-layer" aria-hidden="true" style={rect}>
        {focusBounds && <span className="viewer-focus-bounds" style={{ left: `${focusBounds.x * 100}%`, top: `${focusBounds.y * 100}%`, width: `${focusBounds.width * 100}%`, height: `${focusBounds.height * 100}%` }} />}
        {cursor && <span className={`viewer-pointer viewer-pointer-${cursor.kind}`} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}><MousePointer2 size={20} /></span>}
      </div>}
      <textarea ref={keyboard} className="viewer-keyboard-proxy" aria-label="Клавиатура браузера агента" tabIndex={controlling ? 0 : -1} readOnly={!controlling} autoComplete="off" autoCapitalize="off" spellCheck={false}
        onFocus={() => setKeyboardFocused(true)} onBlur={() => { setKeyboardFocused(false); composition.current = ""; if (keyboard.current) keyboard.current.value = ""; }}
        onKeyDown={keyDown} onKeyUp={event => { if (canControl()) event.stopPropagation(); }}
        onPaste={event => { event.preventDefault(); event.stopPropagation(); sendText(event.clipboardData.getData("text/plain")); event.currentTarget.value = ""; }}
        onCompositionStart={() => { composition.current = canControl() ? activeControl.current : ""; compositionCommit.current = ""; }}
        onCompositionEnd={event => {
          const text = event.currentTarget.value || event.data;
          if (composition.current && composition.current === activeControl.current) { sendText(text); compositionCommit.current = text; }
          composition.current = ""; event.currentTarget.value = "";
        }}
        onInput={event => {
          const native = event.nativeEvent as InputEvent;
          if (composition.current || native.isComposing) return;
          const text = event.currentTarget.value;
          const duplicateComposition = compositionCommit.current && native.data === compositionCommit.current && (!text || text === compositionCommit.current);
          compositionCommit.current = "";
          if (!duplicateComposition) sendText(text);
          event.currentTarget.value = "";
        }} />
    </section>
    <footer className={`viewer-status${state.status === "error" || imageError || error ? " viewer-error" : ""}`} role="status">
      {state.status === "error" || imageError || error ? <CircleAlert size={14} aria-hidden="true" /> : <span className={`viewer-indicator ${state.status}`} aria-hidden="true" />}
      <span>{status}</span>
    </footer>
  </main>;
}

const runtimeWindow = window as Window & { __codexElementAppReady?: boolean };
if (!runtimeWindow.__codexElementAppReady) {
  host = acquireVsCodeApi();
  runtimeWindow.__codexElementAppReady = true;
  createRoot(document.getElementById("root")!).render(<App />);
}
