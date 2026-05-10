"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderWebviewHtml = renderWebviewHtml;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
function renderWebviewHtml(options) {
    const nonce = createNonce();
    const scriptUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.scriptPath));
    const styleUri = options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, options.stylePath));
    const inlineScript = readExtensionFile(options.extensionUri, options.scriptPath);
    const inlineStyle = readExtensionFile(options.extensionUri, options.stylePath);
    const rootData = Object.entries(options.rootData ?? {})
        .map(([key, value]) => `data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
        .join(" ");
    const styleTag = inlineStyle
        ? `<style>${inlineStyle}</style>`
        : `<link rel="stylesheet" href="${styleUri}">`;
    const scriptTag = inlineScript
        ? `<script nonce="${nonce}">${inlineScript}</script>`
        : `<script nonce="${nonce}" src="${scriptUri}"></script>`;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.webview.cspSource} data:; style-src ${options.webview.cspSource} 'unsafe-inline'; script-src ${options.webview.cspSource} 'nonce-${nonce}' 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
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
  ${scriptTag}
</body>
</html>`;
}
function readExtensionFile(extensionUri, relativePath) {
    try {
        return fs.readFileSync(vscode.Uri.joinPath(extensionUri, relativePath).fsPath, "utf8");
    }
    catch {
        return undefined;
    }
}
function renderFallback(title) {
    return `
    <main class="webview-fallback">
      <section class="webview-fallback-card">
        <div class="webview-fallback-title">${escapeHtml(title)}</div>
        <div>UI загружается. Если этот текст не исчезает, значит JavaScript webview не стартовал в Element.</div>
      </section>
    </main>
  `;
}
function createNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let value = "";
    for (let i = 0; i < 32; i += 1) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}
function escapeHtml(value) {
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
function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
}
//# sourceMappingURL=webviewHtml.js.map