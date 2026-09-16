import * as fs from "fs";
import * as path from "path";
import { contained, digest, FeatureError, opaqueId, redactPreview, safeFile } from "./featureSafety";

const MAX_PREVIEW_BYTES = 24 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_VISITED = 2000;
const TTL_MS = 15 * 60_000;

export interface BrowserArtifactItem {
  id: string;
  name: string;
  kind: "image" | "console" | "network" | "data";
  size: number;
  modifiedAt: string;
  previewAvailable: boolean;
}

export interface BrowserArtifactPreview {
  kind: "image" | "text" | "summary" | "unavailable";
  text?: string;
  dataUrl?: string;
  mimeType?: string;
  truncated: boolean;
  redacted: boolean;
  message?: string;
}

interface ArtifactRecord {
  item: BrowserArtifactItem;
  relative: string;
  root: string;
  scope: string;
  chatId: string;
  fingerprint: string;
  expires: number;
}

function fingerprint(stat: fs.Stats): string {
  return digest(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
}

function classify(name: string): BrowserArtifactItem["kind"] | undefined {
  if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return "image";
  if (/\.har$/i.test(name)) return "network";
  if (/\.(txt|log)$/i.test(name)) return "console";
  if (/\.json$/i.test(name) && !/(?:config|storage[-_]?state|cookies|credentials|secrets)/i.test(name)) return "data";
  return undefined;
}

export class FeatureBrowserArtifacts {
  private readonly records = new Map<string, ArtifactRecord>();

  clear(): void { this.records.clear(); }

  async list(scope: string, root: string | undefined, chatId: string, assertContext: () => void): Promise<{ items: BrowserArtifactItem[]; truncated: boolean }> {
    this.prune();
    if (!root) return { items: [], truncated: false };
    root = this.validateRoot(scope, root, true);
    if (!fs.existsSync(root)) return { items: [], truncated: false };
    const items: BrowserArtifactItem[] = [];
    const directories = [{ relative: "", depth: 0 }];
    let visited = 0;
    while (directories.length && items.length < MAX_FILES && visited < MAX_VISITED) {
      const next = directories.shift()!;
      const directory = next.relative ? safeFile(root, next.relative) : root;
      const iterator = await fs.promises.opendir(directory);
      for await (const entry of iterator) {
        assertContext();
        if (++visited > MAX_VISITED || items.length >= MAX_FILES) break;
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const relative = next.relative ? `${next.relative}/${entry.name}` : entry.name;
        let file: string;
        try { file = safeFile(root, relative); } catch { continue; }
        if (entry.isDirectory()) {
          if (next.depth < 4) directories.push({ relative, depth: next.depth + 1 });
          continue;
        }
        const kind = classify(entry.name);
        if (!entry.isFile() || !kind) continue;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1) continue;
        const id = opaqueId();
        const item: BrowserArtifactItem = {
          id, name: redactPreview(relative).slice(0, 240), kind, size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          previewAvailable: kind !== "image" || (stat.size <= MAX_IMAGE_BYTES && /\.(png|jpe?g)$/i.test(entry.name))
        };
        this.records.set(id, { item, relative, root, scope, chatId, fingerprint: fingerprint(stat), expires: Date.now() + TTL_MS });
        items.push(item);
      }
    }
    this.prune();
    return { items: items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), truncated: items.length >= MAX_FILES || visited >= MAX_VISITED || directories.length > 0 };
  }

  open(id: string, scope: string, root: string | undefined, chatId: string): { artifact: BrowserArtifactItem; preview: BrowserArtifactPreview } {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scope !== scope || record.chatId !== chatId || !root || this.validateRoot(scope, root) !== record.root) {
      throw new FeatureError("blocked", "Артефакт недоступен в текущем сеансе. Обновите список.");
    }
    const file = safeFile(record.root, record.relative);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || fingerprint(stat) !== record.fingerprint) {
        throw new FeatureError("conflict", "Артефакт изменился. Обновите список перед открытием.");
      }
      if (record.item.kind === "image" && !record.item.previewAvailable) return { artifact: record.item, preview: { kind: "unavailable", truncated: true, redacted: false, message: "Предпросмотр доступен для изображений PNG и JPEG допустимого размера. Остальные изображения остаются в списке; серверные пути не раскрываются." } };
      const limit = record.item.kind === "image" ? MAX_IMAGE_BYTES : record.item.kind === "console" ? MAX_PREVIEW_BYTES : MAX_JSON_BYTES;
      if (stat.size > limit && record.item.kind !== "console") {
        return { artifact: record.item, preview: { kind: "unavailable", truncated: true, redacted: false, message: "Артефакт слишком велик для предпросмотра. Исходный файл и серверный путь не раскрываются." } };
      }
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      let count = 0;
      while (count < buffer.length) {
        const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count !== buffer.length || fingerprint(fs.fstatSync(fd)) !== record.fingerprint) throw new FeatureError("conflict", "Артефакт изменился во время чтения предпросмотра.");
      return { artifact: record.item, preview: preview(record.item.kind, buffer, stat.size > limit) };
    } finally { fs.closeSync(fd); }
  }

  private validateRoot(scope: string, root: string, allowMissing = false): string {
    const relative = path.relative(scope, root).split(path.sep).join("/");
    if (!path.isAbsolute(root) || !relative || !contained(scope, root)) throw new FeatureError("blocked", "Артефакты браузера должны находиться в отдельном каталоге текущего пользователя и проекта.");
    const resolved = safeFile(scope, relative);
    if (allowMissing && !fs.existsSync(resolved)) return resolved;
    if (!fs.statSync(resolved).isDirectory()) throw new FeatureError("blocked", "Каталог артефактов браузера недоступен.");
    return resolved;
  }

  private prune(): void {
    for (const [id, record] of this.records) {
      if (record.expires < Date.now() || this.records.size > 200) this.records.delete(id);
    }
  }
}

function preview(kind: BrowserArtifactItem["kind"], buffer: Buffer, truncated: boolean): BrowserArtifactPreview {
  if (kind === "image") {
    const mimeType = imageType(buffer);
    if (!mimeType) throw new FeatureError("unsupported", "Артефакт не содержит изображение поддерживаемого формата.");
    return { kind: "image", dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`, mimeType, truncated: false, redacted: false, message: "Содержимое скриншота не скрывается. На нём могут быть конфиденциальные данные приложения." };
  }
  const text = buffer.toString("utf8");
  if (kind === "console") {
    const limited = truncated ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text;
    return { kind: "text", text: redactPreview(limited).slice(0, MAX_PREVIEW_BYTES), truncated, redacted: true, message: "Типовые поля с секретами и параметры URL удалены. Текст приложения всё ещё может содержать конфиденциальные данные. Показан ограниченный предпросмотр, а не исходный лог." };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { kind: "unavailable", truncated: false, redacted: true, message: "Некорректный формат артефакта. Исходное содержимое не отображается." };
  }
  const data = asObject(parsed);
  const log = asObject(data.log);
  const entries = Array.isArray(log.entries) ? log.entries : undefined;
  if (entries) {
    const lines = entries.slice(0, 100).map((value) => {
      const item = asObject(value);
      const request = asObject(item.request);
      const response = asObject(item.response);
      let origin = "[invalid URL]";
      try { const url = new URL(String(request.url)); if (/^https?:$/.test(url.protocol)) origin = url.origin; } catch { /* Omit malformed URLs. */ }
      const method = typeof request.method === "string" && /^[A-Z]{1,12}$/.test(request.method) ? request.method : "HTTP";
      const status = typeof response.status === "number" && Number.isFinite(response.status) ? response.status : "?";
      return `${method} ${origin}  ${status}`;
    });
    return { kind: "summary", text: lines.join("\n"), truncated: entries.length > 100, redacted: true, message: "Показана только сводка сетевых запросов. Заголовки, cookies, пути, параметры и содержимое запросов и ответов скрыты." };
  }
  return { kind: "summary", text: Array.isArray(parsed) ? `Структурированный артефакт: записей ${parsed.length}.` : "Структурированный артефакт браузера.", truncated: false, redacted: true, message: "Поля JSON могут содержать секреты, поэтому исходное содержимое не отображается." };
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function imageType(value: Buffer): string | undefined {
  if (value.length >= 24 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (value.readUInt32BE(8) !== 13 || value.toString("ascii", 12, 16) !== "IHDR") throw new FeatureError("unsupported", "Повреждён заголовок изображения PNG.");
    let offset = 8;
    while (offset + 12 <= value.length) {
      const length = value.readUInt32BE(offset);
      if (length > value.length - offset - 12) break;
      if (value.toString("ascii", offset + 4, offset + 8) === "acTL") throw new FeatureError("unsupported", "Предпросмотр анимированных изображений не поддерживается.");
      offset += length + 12;
    }
    const width = value.readUInt32BE(16), height = value.readUInt32BE(20);
    if (!width || !height || width * height > 24_000_000) throw new FeatureError("unsupported", "Размеры изображения превышают ограничение для предпросмотра.");
    return "image/png";
  }
  if (value.length > 3 && value[0] === 0xff && value[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < value.length) {
      if (value[offset++] !== 0xff) break;
      while (value[offset] === 0xff) offset++;
      const marker = value[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > value.length) break;
      const length = value.readUInt16BE(offset);
      if (length < 2 || offset + length > value.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        const height = value.readUInt16BE(offset + 3), width = value.readUInt16BE(offset + 5);
        if (!width || !height || width * height > 24_000_000) throw new FeatureError("unsupported", "Размеры изображения превышают ограничение для предпросмотра.");
        return "image/jpeg";
      }
      offset += length;
    }
  }
  return undefined;
}
