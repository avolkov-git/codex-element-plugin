import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { command, store } from "./bridge";
import { IconButton } from "./controls";
import { FallbackCode, normalizeLanguage } from "./fallback";

type Highlighter = { supports(language: string): boolean; highlight(code: string, language: string, options?: { blockId: string; version: number }): Promise<string>; cancel?(id: string): void; dispose?(): void };
const RenderContext = createContext({ chatId: "", streaming: false });

export function safeTarget(raw: string): string {
  let value: string;
  try { value = decodeURI(raw).trim(); } catch { return ""; }
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("//") || value.startsWith("\\\\")) return "";
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return url.username || url.password ? "" : value; } catch { return ""; }
  }
  if (/^file:\/\//i.test(value)) {
    try { const url = new URL(value); return !url.host || url.host === "localhost" ? value : ""; } catch { return ""; }
  }
  if (/^[a-z]:[\\/]/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  return value;
}

function Code({ code, language }: { code: string; language: string }) {
  language = normalizeLanguage(language);
  const { chatId, streaming } = useContext(RenderContext);
  const blockId = useId();
  const version = useRef(0);
  const [highlighted, setHighlighted] = useState<{ code: string; html: string }>();
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(0);
  useEffect(() => {
    const listener = () => setReady(value => value + 1);
    window.addEventListener("codex-xbsl-highlighter-ready", listener);
    return () => window.removeEventListener("codex-xbsl-highlighter-ready", listener);
  }, []);
  useEffect(() => {
    const api = (window as Window & { codexXbslHighlighter?: Highlighter }).codexXbslHighlighter;
    const current = ++version.current;
    if (!api?.supports(language) || code.length > 64000) return;
    const timer = setTimeout(() => {
      void api.highlight(code, language, { blockId, version: current }).then(html => {
        if (version.current === current) setHighlighted({ code, html });
      }).catch(() => { /* Plain text remains usable when the worker is unavailable or cancelled. */ });
    }, streaming ? 180 : 0);
    return () => { clearTimeout(timer); version.current++; api.cancel?.(blockId); };
  }, [code, language, streaming, ready, blockId]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  useEffect(() => store.onEvent(event => {
    if (event.event === "clipboard.result" && event.payload?.requestId === blockId) setCopied(event.payload.ok === true);
  }), [blockId]);
  return <div className="code-block" data-highlight-language={language} data-highlight-engine={highlighted?.code === code ? "xbsl-io" : "fallback"}><div className="code-toolbar"><span>{language || "text"}</span>
    <IconButton icon={copied ? Check : Copy} label={copied ? "Скопировано" : "Копировать код"} onClick={() => {
      command(chatId, "clipboard.write", { text: code, requestId: blockId });
    }} /></div><pre>{highlighted?.code === code
      ? <code className="xbsl-highlighted" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      : <FallbackCode code={code} language={language} />}</pre></div>;
}

const components: Components = {
  a({ href, children }) {
    const { chatId } = useContext(RenderContext);
    const target = safeTarget(href ?? "");
    return target ? <a href={target} onClick={event => { event.preventDefault(); command(chatId, "markdown.openLink", { target }); }}>{children}</a> : <span>{children}</span>;
  },
  img({ alt, src }) {
    const { chatId } = useContext(RenderContext);
    const target = safeTarget(src ?? "");
    // Do not fetch model-authored remote images or expose local paths to an image server.
    return target ? <button className="text-link" onClick={() => command(chatId, "markdown.openLink", { target })}>{alt || "Изображение"}</button> : <span>{alt}</span>;
  },
  pre({ children }) { return <>{children}</>; },
  code({ children, className, node }) {
    const code = String(children ?? "");
    const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
    const block = !!language || code.includes("\n") || (node?.position?.end.line ?? 0) > (node?.position?.start.line ?? 0);
    return block ? <Code code={code.replace(/\n$/, "")} language={language} /> : <code className="inline-code">{children}</code>;
  },
  table({ children }) { return <div className="markdown-table-scroll"><table>{children}</table></div>; }
};
const plugins = [remarkGfm];
export const Markdown = memo(function Markdown({ text, chatId, streaming = false }: { text: string; chatId: string; streaming?: boolean }) {
  const [display, setDisplay] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  // A single streaming message is parsed at a bounded rate; settled siblings are memoized.
  useEffect(() => {
    if (!streaming) { setDisplay(text); return; }
    const timer = setInterval(() => setDisplay(latest.current), 120);
    return () => clearInterval(timer);
  }, [streaming]);
  useEffect(() => { if (!streaming) setDisplay(text); }, [text, streaming]);
  const context = useMemo(() => ({ chatId, streaming }), [chatId, streaming]);
  return <RenderContext.Provider value={context}><div className="markdown">
    <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml urlTransform={url => safeTarget(url)}>{streaming ? display : text}</ReactMarkdown>
  </div></RenderContext.Provider>;
});
