import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

export class FeatureError extends Error {
  constructor(readonly status: "blocked" | "conflict" | "unsupported" | "error" | "timeout", message: string) {
    super(message);
  }
}

export function opaqueId(): string {
  return randomBytes(18).toString("hex");
}

export function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function safeRelative(value: string): string {
  if (!value || value.length > 2048 || path.isAbsolute(value) || /^[a-z]:/i.test(value)
      || /[\\\x00-\x1f\x7f]/.test(value)
      || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new FeatureError("blocked", "Путь находится за пределами доступных файлов проекта.");
  }
  return value;
}

// Reject every symlink component, including a missing leaf's existing parents.
export function safeFile(root: string, relative: string): string {
  safeRelative(relative);
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
        throw new FeatureError("blocked", "Путь содержит символическую ссылку или файл вместо родительского каталога. Такие пути не поддерживаются.");
      }
      if (!contained(root, fs.realpathSync(current))) {
        throw new FeatureError("blocked", "Файл находится за пределами доступной области.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return current;
}

export function readRegular(file: string, maxBytes: number): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) {
      throw new FeatureError("unsupported", "Поддерживаются только обычные файлы допустимого размера без жёстких ссылок.");
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new FeatureError("conflict", "Файл изменился во время чтения. Обновите список и повторите действие.");
    }
    return buffer.subarray(0, count);
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function deadline<T>(operation: PromiseLike<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FeatureError("timeout", "Element не ответил вовремя. Отправленная команда IDE не отменена и ещё может завершиться.")), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function plainText(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  if (buffer.includes(0) || !Buffer.from(text, "utf8").equals(buffer)) {
    throw new FeatureError("unsupported", "Текстовое сравнение не поддерживает двоичные файлы и файлы с кодировкой, отличной от UTF-8.");
  }
  return text;
}

export function redactPreview(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)\b[^\r\n]*/gi, "[redacted credential field]")
    .replace(/\b(?:Bearer|Basic)\s+[a-z\d+/=._-]+/gi, "[redacted authorization]")
    .replace(/\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d_]{16,}|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)\b/gi, "[redacted token]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
