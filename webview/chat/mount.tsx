import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store, vscode } from "./bridge";
import { disposeUploads } from "./uploads";

class ChatErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Never include user text or native secret answers in diagnostics. */ }
  render() {
    if (this.state.error) return <main className="app empty-app"><h1>Codex</h1><p>Не удалось отобразить диалог. Черновик сохранён.</p><button onClick={() => { this.setState({ error: false }); vscode.postMessage({ type: "chat.resync" }); }}>Повторить</button></main>;
    return this.props.children;
  }
}
export function mount(): void {
  const root = createRoot(document.getElementById("root")!);
  const listener = (event: MessageEvent) => store.receive(event.data);
  const visibility = () => vscode.postMessage({ type: "chat.visibility", visible: document.visibilityState !== "hidden" });
  window.addEventListener("message", listener);
  document.addEventListener("visibilitychange", visibility);
  root.render(<ChatErrorBoundary><App /></ChatErrorBoundary>);
  vscode.postMessage({ type: "ready", assetMode: (window as any).__codexElementWebviewAssetMode || "external" });
  window.addEventListener("pagehide", () => {
    window.removeEventListener("message", listener); document.removeEventListener("visibilitychange", visibility);
    disposeUploads(); store.dispose(); root.unmount();
    (window as any).codexXbslHighlighter?.dispose?.();
  }, { once: true });
}
