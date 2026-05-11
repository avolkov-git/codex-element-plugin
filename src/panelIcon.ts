import * as vscode from "vscode";

export function getCodexPanelIconPath(context: vscode.ExtensionContext): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "codex-panel-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "codex-panel-dark.svg")
  };
}
