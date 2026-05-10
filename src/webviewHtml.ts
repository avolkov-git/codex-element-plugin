import * as vscode from "vscode";

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
  const rootData = Object.entries(options.rootData ?? {})
    .map(([key, value]) => `data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.webview.cspSource} data:; style-src ${options.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>${escapeHtml(options.title)}</title>
</head>
<body>
  <div id="root" ${rootData}></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

