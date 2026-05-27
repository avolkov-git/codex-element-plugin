import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RipgrepProbeResult {
  ok: boolean;
  path: string;
  version: string;
  message: string;
}

export interface RipgrepEnvPatchResult {
  env: NodeJS.ProcessEnv;
  ripgrepPath: string;
  warning: string;
}

const WINDOWS_SAFE_PATH_LENGTH = 30_000;

export function ripgrepExecutableName(): string {
  return process.platform === "win32" ? "rg.exe" : "rg";
}

export function normalizeRipgrepInput(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export async function resolveRipgrepExecutablePath(input: string): Promise<string> {
  const normalized = normalizeRipgrepInput(input);
  if (!normalized) {
    return "";
  }

  try {
    const stat = await fs.promises.stat(normalized);
    if (stat.isDirectory()) {
      return path.join(normalized, ripgrepExecutableName());
    }
  } catch {
    // The caller will report a validation error after probing the candidate.
  }

  return normalized;
}

export async function probeRipgrepExecutable(filePath: string, timeoutMs = 3000): Promise<RipgrepProbeResult> {
  const resolved = normalizeRipgrepInput(filePath);
  if (!resolved) {
    return {
      ok: false,
      path: "",
      version: "",
      message: "Путь до rg не задан."
    };
  }

  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) {
      return {
        ok: false,
        path: resolved,
        version: "",
        message: "Указанный путь не является файлом rg."
      };
    }
  } catch {
    return {
      ok: false,
      path: resolved,
      version: "",
      message: "Файл rg не найден."
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(resolved, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (result: RipgrepProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        path: resolved,
        version: "",
        message: "Проверка rg --version превысила таймаут."
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(0, 8000);
    });
    child.stderr.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(0, 8000);
    });
    child.once("error", (error) => {
      finish({
        ok: false,
        path: resolved,
        version: "",
        message: error.message || "Не удалось запустить rg."
      });
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      const version = output.match(/ripgrep\s+([^\s]+)/i)?.[1] ?? "";
      if (code === 0 && version) {
        finish({
          ok: true,
          path: resolved,
          version,
          message: `rg найден, версия ${version}.`
        });
        return;
      }
      finish({
        ok: false,
        path: resolved,
        version: "",
        message: "Команда rg --version завершилась с ошибкой."
      });
    });
  });
}

export function discoverRipgrepCandidates(): string[] {
  const candidates: string[] = [];
  const executable = ripgrepExecutableName();
  for (const dir of pathEnvEntries()) {
    candidates.push(path.join(dir, executable));
  }

  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || os.homedir();
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
    if (userProfile) {
      candidates.push(path.join(userProfile, ".cargo", "bin", "rg.exe"));
    }
    for (const root of programFiles) {
      candidates.push(
        path.join(root, "ripgrep", "rg.exe"),
        path.join(root, "Git", "usr", "bin", "rg.exe")
      );
    }
  } else {
    candidates.push(
      path.join(os.homedir(), ".cargo", "bin", "rg"),
      "/opt/homebrew/bin/rg",
      "/usr/local/bin/rg",
      "/usr/bin/rg",
      "/bin/rg"
    );
  }

  const seen = new Set<string>();
  return candidates
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || !fs.existsSync(candidate)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function buildRipgrepEnvPatch(ripgrepPath: string): NodeJS.ProcessEnv {
  return buildRipgrepEnvPatchResult(ripgrepPath).env;
}

export function buildRipgrepEnvPatchResult(ripgrepPath: string): RipgrepEnvPatchResult {
  const resolved = normalizeRipgrepInput(ripgrepPath);
  if (!resolved) {
    return { env: {}, ripgrepPath: "", warning: "" };
  }

  const executable = resolveRipgrepExecutablePathSync(resolved);
  if (!executable) {
    return {
      env: {},
      ripgrepPath: resolved,
      warning: "Настроенный путь до rg пропущен при запуске runtime: файл не найден или путь не является файлом."
    };
  }

  const dir = path.dirname(executable);
  const currentPath = process.env.Path || process.env.PATH || "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedDir = normalizePathForCompare(dir);
  const alreadyPresent = pathEntries.some((entry) => {
    return normalizePathForCompare(entry) === normalizedDir;
  });
  const env: NodeJS.ProcessEnv = {
    RIPGREP_PATH: executable
  };
  if (alreadyPresent) {
    return { env, ripgrepPath: executable, warning: "" };
  }

  const nextPath = [dir, ...pathEntries].join(path.delimiter);
  if (process.platform === "win32" && nextPath.length > WINDOWS_SAFE_PATH_LENGTH) {
    return {
      env,
      ripgrepPath: executable,
      warning: "Каталог rg не добавлен в PATH runtime: PATH слишком длинный. Авторизация и backend будут запущены без изменения PATH."
    };
  }
  const pathKey = runtimePathEnvKey();
  env[pathKey] = nextPath;
  return { env, ripgrepPath: executable, warning: "" };
}

function resolveRipgrepExecutablePathSync(input: string): string {
  const normalized = normalizeRipgrepInput(input);
  if (!normalized) {
    return "";
  }

  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
      const executable = path.join(normalized, ripgrepExecutableName());
      return fs.statSync(executable).isFile() ? executable : "";
    }
    return stat.isFile() ? normalized : "";
  } catch {
    return "";
  }
}

function normalizePathForCompare(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function runtimePathEnvKey(): "PATH" | "Path" {
  if (process.platform !== "win32") {
    return "PATH";
  }
  return Object.prototype.hasOwnProperty.call(process.env, "Path") ? "Path" : "PATH";
}

function pathEnvEntries(): string[] {
  const value = process.env.Path || process.env.PATH || "";
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
