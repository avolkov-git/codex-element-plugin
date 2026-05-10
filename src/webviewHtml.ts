import * as vscode from "vscode";
import * as fs from "fs";

export interface WebviewHtmlOptions {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  scriptPath: string;
  stylePath: string;
  title: string;
  rootData?: Record<string, string>;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const nonce = createNonce();
  const scriptUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.scriptPath));
  const styleUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.stylePath));
  const inlineScript = readExtensionFile(options.extensionUri, options.scriptPath);
  const inlineStyle = readExtensionFile(options.extensionUri, options.stylePath);
  const rootData = Object.entries(options.rootData ?? {})
    .map(([key, value]) => `data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join(" ");
  const fallbackBootstrap = inlineScript
    ? renderFallbackBootstrap(nonce, inlineScript, inlineStyle ?? "")
    : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.webview.cspSource} data:; style-src ${options.webview.cspSource} 'unsafe-inline'; script-src ${options.webview.cspSource} 'nonce-${nonce}' 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
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
  <script defer src="${scriptUri}"></script>
</body>
</html>`;
}

function renderFallbackBootstrap(nonce: string, inlineScript: string, inlineStyle: string): string {
  return `<script nonce="${nonce}">
    window.__codexElementAppReady = false;
    window.__codexElementWebviewAssetMode = "external";
    window.__codexElementRunInlineFallback = function () {
      if (window.__codexElementAppReady) {
        return;
      }
      window.__codexElementWebviewAssetMode = "inline fallback";
      var style = document.createElement("style");
      style.setAttribute("data-codex-element-inline-fallback", "true");
      style.textContent = ${JSON.stringify(inlineStyle)};
      document.head.appendChild(style);
      ${escapeScriptEnd(inlineScript)}
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
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
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
