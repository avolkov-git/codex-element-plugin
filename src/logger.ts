import * as vscode from "vscode";

export class Logger {
  private readonly output = vscode.window.createOutputChannel("Codex");

  info(message: string): void {
    this.append("info", message);
  }

  warn(message: string): void {
    this.append("warn", message);
  }

  error(message: string): void {
    this.append("error", message);
  }

  show(): void {
    this.output.show();
  }

  dispose(): void {
    this.output.dispose();
  }

  private append(level: "info" | "warn" | "error", message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] [${level}] ${redact(message)}`);
  }
}

export function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(password|token|secret|api[_-]?key)=([^\s&]+)/gi, "$1=***")
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1***:***@");
}
