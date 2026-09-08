import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";

export interface WebviewHtmlOptions {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  scriptPath: string;
  preloadScriptPaths?: string[];
  stylePath: string;
  title: string;
  rootData?: Record<string, string>;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const nonce = createNonce();
  const scriptUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.scriptPath));
  const preloadScriptUris = (options.preloadScriptPaths ?? []).map((scriptPath) =>
    options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, scriptPath))
  );
  const styleUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.stylePath));
  const inlineScript = readExtensionFile(options.extensionUri, options.scriptPath);
  const inlinePreloads = (options.preloadScriptPaths ?? []).map((scriptPath) =>
    readExtensionFile(options.extensionUri, scriptPath)
  );
  const inlineStyle = readExtensionFile(options.extensionUri, options.stylePath);
  const rootData = Object.entries(options.rootData ?? {})
    .map(([key, value]) => `data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join(" ");
  const fallbackBootstrap = inlineScript && inlinePreloads.every((source) => source !== undefined)
    ? renderFallbackBootstrap(nonce, [...inlinePreloads as string[], inlineScript], inlineStyle ?? "")
    : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeAttribute(options.webview.cspSource)} data:; style-src ${escapeAttribute(options.webview.cspSource)} 'unsafe-inline'; script-src ${escapeAttribute(options.webview.cspSource)} 'nonce-${nonce}'; worker-src blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; }
    .webview-fallback { padding: 14px; color: #444; }
    .webview-fallback-card { border: 1px solid #d0d0d0; border-radius: 8px; padding: 12px; background: #f7f7f7; }
    .webview-fallback-title { font-weight: 700; margin-bottom: 8px; }
  </style>
  <title>${escapeHtml(options.title)}</title>
</head>
<body>
  <div id="root" ${rootData}>${renderFallback(options.title)}</div>
  ${fallbackBootstrap}
  <link rel="stylesheet" href="${escapeAttribute(styleUri.toString())}">
  ${preloadScriptUris.map((uri) => `<script defer nonce="${nonce}" src="${escapeAttribute(uri.toString())}"></script>`).join("\n  ")}
  <script defer nonce="${nonce}" src="${escapeAttribute(scriptUri.toString())}"></script>
</body>
</html>`;
}

function renderFallbackBootstrap(nonce: string, inlineScripts: string[], inlineStyle: string): string {
  return `<script nonce="${nonce}">
    window.__codexElementAppReady = window.__codexElementAppReady === true;
    window.__codexElementWebviewAssetMode = "external";
    var codexElementInlineStarted = false;
    window.__codexElementRunInlineFallback = function () {
      if (window.__codexElementAppReady || codexElementInlineStarted) {
        return;
      }
      codexElementInlineStarted = true;
      window.__codexElementWebviewAssetMode = "inline fallback";
      var style = document.createElement("style");
      style.setAttribute("data-codex-element-inline-fallback", "true");
      style.textContent = ${escapeScriptEnd(JSON.stringify(inlineStyle))};
      document.head.appendChild(style);
      ${inlineScripts.map((source) => `(function () {\n${escapeScriptEnd(source)}\n})();`).join("\n")}
    };
    window.setTimeout(window.__codexElementRunInlineFallback, 700);
  </script>`;
}

function readExtensionFile(extensionUri: vscode.Uri, relativePath: string): string | undefined {
  try {
    return fs.readFileSync(vscode.Uri.joinPath(extensionUri, relativePath).fsPath, "utf8");
  } catch {
    return undefined;
  }
}

function renderFallback(title: string): string {
  return `
    <main class="webview-fallback">
      <section class="webview-fallback-card">
        <div class="webview-fallback-title">${escapeHtml(title)}</div>
        <div>Codex загружается...</div>
      </section>
    </main>
  `;
}

function escapeScriptEnd(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function createNonce(): string {
  return randomBytes(24).toString("base64");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
