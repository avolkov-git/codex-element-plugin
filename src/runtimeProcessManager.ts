import { ChildProcessWithoutNullStreams, spawn } from "child_process";

export interface RuntimeStartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdout: (line: string) => void;
  onStderr: (line: string) => void;
  onError?: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class RuntimeProcessManager {
  private child: ChildProcessWithoutNullStreams | null = null;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  start(options: RuntimeStartOptions): number {
    if (this.child && !this.child.killed) {
      throw new Error("Codex backend уже запущен.");
    }

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: "pipe"
    });

    this.child = child;
    let exitHandled = false;
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitHandled) {
        return;
      }
      exitHandled = true;
      this.child = null;
      options.onExit(code, signal);
    };

    wireLineStream(child.stdout, options.onStdout);
    wireLineStream(child.stderr, options.onStderr);
    child.once("error", (error) => {
      options.onError?.(error);
      options.onStderr(error.message);
      handleExit(null, null);
    });
    child.once("exit", (code, signal) => {
      handleExit(code, signal);
    });

    return child.pid ?? 0;
  }

  writeLine(line: string): void {
    const child = this.child;
    if (!child || child.killed || child.stdin.destroyed) {
      throw new Error("Codex backend не запущен.");
    }
    child.stdin.write(`${line}\n`);
  }

  async stop(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, timeoutMs);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  dispose(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }
}

function wireLineStream(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        onLine(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      onLine(buffer);
    }
  });
}
