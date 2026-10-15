import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Monitor, Pause, Play, CircleAlert } from "lucide-react";
import type { BrowserViewerFrame, BrowserViewerState } from "../../src/browserViewerProtocol";

declare const acquireVsCodeApi: () => { postMessage(message: object): void };
let host: ReturnType<typeof acquireVsCodeApi>;
const initial: BrowserViewerState = { type: "browser.viewer.state", sessionId: "", status: "idle", message: "Подключение к просмотру браузера…", pages: [], selectedPageId: "" };

function App() {
  const [state, setState] = useState(initial);
  const current = useRef(initial);
  const [frame, setFrame] = useState<BrowserViewerFrame>();
  const [imageError, setImageError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (value?.type === "browser.viewer.readyRequest") {
        host.postMessage({ type: "viewer.ready", visible: !document.hidden });
      } else if (value?.type === "browser.viewer.state") {
        const next = value as BrowserViewerState;
        if (next.sessionId !== current.current.sessionId || next.selectedPageId !== current.current.selectedPageId || next.status === "idle") {
          generation.current++; setFrame(undefined); setImageError(false);
        }
        current.current = next; setState(next);
      } else if (value?.type === "browser.viewer.frame") {
        const next = value as BrowserViewerFrame;
        if (next.sessionId !== current.current.sessionId || next.pageId !== current.current.selectedPageId || typeof next.data !== "string" || next.data.length > 512 * 1024) return;
        const epoch = generation.current;
        const image = new Image(); image.src = `data:image/jpeg;base64,${next.data}`;
        void image.decode().then(() => {
          if (generation.current === epoch) { setFrame(next); setImageError(false); }
        }).catch(() => { if (generation.current === epoch) setImageError(true); }).finally(() => {
          requestAnimationFrame(() => host.postMessage({ type: "viewer.ack", sessionId: next.sessionId, pageId: next.pageId, sequence: next.sequence }));
        });
      }
    };
    const visibility = () => host.postMessage({ type: document.hidden ? "viewer.visibility" : "viewer.ready", visible: !document.hidden });
    window.addEventListener("message", receive);
    document.addEventListener("visibilitychange", visibility);
    host.postMessage({ type: "viewer.ready", visible: !document.hidden });
    return () => { generation.current++; window.removeEventListener("message", receive); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const page = state.pages.find(item => item.id === state.selectedPageId);
  const suspended = state.status === "paused" || state.status === "error";
  const toggleLabel = suspended || imageError ? "Возобновить просмотр" : "Приостановить просмотр";
  const status = imageError ? "Не удалось показать кадр. Возобновите просмотр." : state.message;
  return <main className="browser-viewer">
    <header className="viewer-toolbar">
      <Monitor size={18} aria-hidden="true" />
      <select aria-label="Страница браузера агента" disabled={!state.pages.length} value={state.selectedPageId} onChange={event => host.postMessage({ type: "viewer.select", sessionId: state.sessionId, pageId: event.target.value })}>
        {!state.pages.length && <option value="">Браузер агента</option>}
        {state.pages.map(item => <option key={item.id} value={item.id}>{item.title || item.url || "Страница"}</option>)}
      </select>
      <button className="viewer-icon-button" title={toggleLabel} aria-label={toggleLabel} disabled={!page} onClick={() => host.postMessage({ type: "viewer.pause", sessionId: state.sessionId, paused: !suspended && !imageError })}>
        {suspended || imageError ? <Play size={18} /> : <Pause size={18} />}
      </button>
      <span className="viewer-readonly">Только просмотр</span>
    </header>
    <div className="viewer-address" title={page?.url}>{page?.url || "Нет открытой страницы"}</div>
    <section className="viewer-stage" aria-label="Изображение браузера агента">
      {frame ? <img className="viewer-frame" alt="Текущая страница браузера агента" src={`data:image/jpeg;base64,${frame.data}`} draggable={false} /> : <div className="viewer-empty"><Monitor size={32} aria-hidden="true" /><p>{page ? "Ожидание изображения страницы…" : status}</p></div>}
    </section>
    <footer className={`viewer-status${state.status === "error" || imageError ? " viewer-error" : ""}`} role="status">
      {state.status === "error" || imageError ? <CircleAlert size={14} aria-hidden="true" /> : <span className={`viewer-indicator ${state.status}`} aria-hidden="true" />}
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
