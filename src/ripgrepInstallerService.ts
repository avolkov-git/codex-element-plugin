import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as tls from "tls";
import * as zlib from "zlib";
import { Logger } from "./logger";
import { RuntimeProxySettings, SettingsService } from "./settingsService";
import { probeRipgrepExecutable, ripgrepExecutableName } from "./ripgrepUtils";

const RIPGREP_RELEASE_URL = "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest";
const DOWNLOAD_LIMIT_BYTES = 120 * 1024 * 1024;

export interface RipgrepInstallProgress {
  status: "idle" | "running" | "completed" | "error";
  percent: number;
  stage: string;
  message: string;
}

export interface RipgrepInstallResult {
  path: string;
  version: string;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  assets?: GitHubReleaseAsset[];
}

export class RipgrepInstallerService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger
  ) {}

  async install(options: { onProgress?: (progress: RipgrepInstallProgress) => void }): Promise<RipgrepInstallResult> {
    const progress = (percent: number, stage: string, message: string): void => {
      options.onProgress?.({ status: "running", percent, stage, message });
    };

    progress(5, "release", "Получаем информацию о последней версии ripgrep");
    const proxy = await this.settings.getRuntimeProxySettings();
    const release = await downloadJson<GitHubRelease>(RIPGREP_RELEASE_URL, proxy);
    const version = normalizeReleaseVersion(release);
    const asset = selectAsset(release);
    if (!asset.browser_download_url || !asset.name) {
      throw new Error("Не удалось выбрать release asset ripgrep для текущей платформы.");
    }

    const toolsRoot = path.join(this.settings.getConfigRoot(), "server", "tools", "ripgrep");
    const platformRoot = path.join(toolsRoot, version, platformKey());
    if (path.basename(asset.name) !== asset.name || /[\\\0]/.test(asset.name)) {
      throw new Error("Release asset ripgrep содержит небезопасное имя.");
    }
    await fs.promises.mkdir(toolsRoot, { recursive: true });
    const tempRoot = await fs.promises.mkdtemp(path.join(toolsRoot, ".tmp-"));
    const archivePath = path.join(tempRoot, asset.name);
    const extractRoot = path.join(tempRoot, "extract");
    await fs.promises.mkdir(extractRoot, { recursive: true });

    try {
      progress(20, "download", `Скачиваем ripgrep ${version}`);
      const archive = await downloadBuffer(asset.browser_download_url, proxy, DOWNLOAD_LIMIT_BYTES, {
        Accept: "application/octet-stream"
      });
      validateArchivePayload(archive, asset.name);
      await fs.promises.writeFile(archivePath, archive);

      progress(55, "extract", "Распаковываем ripgrep");
      await extractArchive(archivePath, extractRoot, asset.name);
      const executable = await findRipgrepExecutable(extractRoot);
      if (!executable) {
        throw new Error("В архиве ripgrep не найден исполняемый файл rg.");
      }

      progress(75, "install", "Подготавливаем новую установку ripgrep");
      const stagedPath = path.join(tempRoot, ripgrepExecutableName());
      const finalPath = path.join(platformRoot, ripgrepExecutableName());
      await fs.promises.copyFile(executable, stagedPath, fs.constants.COPYFILE_EXCL);
      if (process.platform !== "win32") {
        await fs.promises.chmod(stagedPath, 0o755);
      }

      progress(88, "verify", "Проверяем rg --version");
      const probe = await probeRipgrepExecutable(stagedPath);
      if (!probe.ok) {
        throw new Error(probe.message || "Установленный rg не прошел проверку.");
      }
      if (probe.version !== version) {
        throw new Error(`Версия rg ${probe.version || "неизвестна"} не соответствует release ${version}.`);
      }

      await publishRipgrep(toolsRoot, stagedPath, finalPath, () => {
        this.settings.saveInstalledRipgrepPath(finalPath, probe.version);
      });
      options.onProgress?.({
        status: "completed",
        percent: 100,
        stage: "completed",
        message: `ripgrep установлен, версия ${probe.version || version}.`
      });
      this.logger.info(`ripgrep installed: version=${probe.version || version}; path=${finalPath}.`);
      return { path: finalPath, version: probe.version || version };
    } catch (error) {
      options.onProgress?.({
        status: "error",
        percent: 0,
        stage: "error",
        message: error instanceof Error ? error.message : "Не удалось установить ripgrep."
      });
      throw error;
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function normalizeReleaseVersion(release: GitHubRelease): string {
  const version = (release.tag_name || release.name || "").trim().replace(/^v/i, "");
  if (!/^\d[\w.+-]*$/.test(version) || version.includes("..")) {
    throw new Error("Release ripgrep содержит некорректную версию.");
  }
  return version;
}

async function publishRipgrep(toolsRoot: string, stagedPath: string, finalPath: string, save: () => void): Promise<void> {
  const lockPath = path.join(toolsRoot, ".install.lock");
  const deadline = Date.now() + 20_000;
  let lock: fs.promises.FileHandle;
  for (;;) {
    try {
      lock = await fs.promises.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Другая установка ripgrep еще не завершена. Повторите операцию позже.");
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const backupPath = `${finalPath}.backup`;
    const backupStage = `${stagedPath}.backup`;
    let hasPrevious = false;
    try {
      const stats = await fs.promises.lstat(finalPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Установленный rg должен быть обычным файлом.");
      }
      await fs.promises.copyFile(finalPath, backupStage, fs.constants.COPYFILE_EXCL);
      await fs.promises.rename(backupStage, backupPath);
      hasPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const file = await fs.promises.open(stagedPath, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    // Same-filesystem rename keeps the old executable callable until the switch.
    // A Windows sharing violation is a failure, never a reason to delete it first.
    await fs.promises.rename(stagedPath, finalPath);
    try {
      save();
    } catch (error) {
      if (hasPrevious) {
        fs.copyFileSync(backupPath, stagedPath, fs.constants.COPYFILE_EXCL);
        fs.renameSync(stagedPath, finalPath);
      } else {
        fs.unlinkSync(finalPath);
      }
      throw error;
    }
  } finally {
    await lock.close();
    await fs.promises.unlink(lockPath);
  }
}

function selectAsset(release: GitHubRelease): GitHubReleaseAsset {
  const assets = release.assets ?? [];
  const candidates = assetNamePatterns();
  for (const pattern of candidates) {
    const asset = assets.find((item) => item.name ? pattern.test(item.name) : false);
    if (asset) {
      return asset;
    }
  }
  return {};
}

function assetNamePatterns(): RegExp[] {
  if (process.platform === "win32" && process.arch === "x64") {
    return [/x86_64-pc-windows-msvc\.zip$/i];
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return [/aarch64-apple-darwin\.tar\.gz$/i];
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return [/x86_64-apple-darwin\.tar\.gz$/i];
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return [/x86_64-unknown-linux-musl\.tar\.gz$/i, /x86_64-unknown-linux-gnu\.tar\.gz$/i];
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return [/aarch64-unknown-linux-musl\.tar\.gz$/i, /aarch64-unknown-linux-gnu\.tar\.gz$/i];
  }
  return [new RegExp(`${process.arch}.*${process.platform}.*\\.(zip|tar\\.gz)$`, "i")];
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

async function extractArchive(archivePath: string, extractRoot: string, assetName: string): Promise<void> {
  if (assetName.toLowerCase().endsWith(".zip")) {
    await extractZipArchive(archivePath, extractRoot);
    return;
  }
  if (assetName.toLowerCase().endsWith(".tar.gz")) {
    await extractTarGzArchive(archivePath, extractRoot);
    return;
  }
  throw new Error(`Неподдерживаемый формат архива ripgrep: ${assetName}.`);
}

async function extractZipArchive(archivePath: string, extractRoot: string): Promise<void> {
  const buffer = await fs.promises.readFile(archivePath);
  await extractZipBuffer(buffer, extractRoot);
}

async function extractTarGzArchive(archivePath: string, extractRoot: string): Promise<void> {
  const buffer = await fs.promises.readFile(archivePath);
  const tarBuffer = zlib.gunzipSync(buffer);
  await extractTarBuffer(tarBuffer, extractRoot);
}

async function extractZipBuffer(buffer: Buffer, extractRoot: string): Promise<void> {
  const entries = readZipCentralDirectory(buffer);
  for (const entry of entries) {
    const safePath = safeExtractPath(extractRoot, entry.name);
    if (!safePath) {
      continue;
    }
    if (entry.directory) {
      await fs.promises.mkdir(safePath, { recursive: true });
      continue;
    }
    const compressed = readZipEntryPayload(buffer, entry);
    const payload = inflateZipEntry(compressed, entry.compressionMethod, entry.name);
    await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
    await fs.promises.writeFile(safePath, payload);
  }
}

async function extractTarBuffer(buffer: Buffer, extractRoot: string): Promise<void> {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (isEmptyTarBlock(header)) {
      break;
    }

    const name = tarEntryName(header);
    const size = parseTarOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0);
    const safePath = safeExtractPath(extractRoot, name);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new Error("Архив ripgrep поврежден: tar entry выходит за пределы файла.");
    }

    if (safePath) {
      if (type === "5") {
        await fs.promises.mkdir(safePath, { recursive: true });
      } else if (type === "0" || type === "\0" || type === "") {
        await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
        await fs.promises.writeFile(safePath, buffer.subarray(dataStart, dataEnd));
      }
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

interface ZipEntry {
  name: string;
  directory: boolean;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipCentralDirectory(buffer: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset < 0) {
    throw new Error("Архив ripgrep поврежден: не найден ZIP central directory.");
  }

  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("Архив ripgrep поврежден: ZIP central directory выходит за пределы файла.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Архив ripgrep поврежден: некорректная ZIP file header запись.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new Error("Архив ripgrep поврежден: имя ZIP entry выходит за пределы файла.");
    }
    const nameBuffer = buffer.subarray(nameStart, nameEnd);
    const name = decodeZipName(nameBuffer, flags).replace(/\\/g, "/");
    entries.push({
      name,
      directory: name.endsWith("/"),
      compressionMethod,
      compressedSize,
      localHeaderOffset
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) {
    return -1;
  }
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function readZipEntryPayload(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Архив ripgrep поврежден: не найден local ZIP header для ${entry.name}.`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Архив ripgrep поврежден: данные ZIP entry ${entry.name} выходят за пределы файла.`);
  }
  return buffer.subarray(dataStart, dataEnd);
}

function inflateZipEntry(buffer: Buffer, compressionMethod: number, entryName: string): Buffer {
  if (compressionMethod === 0) {
    return buffer;
  }
  if (compressionMethod === 8) {
    return zlib.inflateRawSync(buffer);
  }
  throw new Error(`Архив ripgrep содержит неподдерживаемый ZIP compression method ${compressionMethod} для ${entryName}.`);
}

function decodeZipName(buffer: Buffer, flags: number): string {
  if (flags & 0x0800) {
    return buffer.toString("utf8");
  }
  return buffer.toString("utf8");
}

function isEmptyTarBlock(header: Buffer): boolean {
  for (const byte of header) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function tarEntryName(header: Buffer): string {
  const name = readNullTerminatedString(header.subarray(0, 100));
  const prefix = readNullTerminatedString(header.subarray(345, 500));
  return (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");
}

function parseTarOctal(buffer: Buffer): number {
  const raw = readNullTerminatedString(buffer).trim();
  return raw ? Number.parseInt(raw, 8) || 0 : 0;
}

function readNullTerminatedString(buffer: Buffer): string {
  const zero = buffer.indexOf(0);
  const end = zero >= 0 ? zero : buffer.length;
  return buffer.subarray(0, end).toString("utf8");
}

function safeExtractPath(root: string, entryName: string): string {
  const normalizedName = entryName.replace(/^\/+/, "");
  if (!normalizedName || normalizedName.includes("\0")) {
    return "";
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalizedName);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Архив ripgrep содержит небезопасный путь: ${entryName}.`);
  }
  return target;
}

function validateArchivePayload(buffer: Buffer, assetName: string): void {
  const lower = assetName.toLowerCase();
  if (lower.endsWith(".zip") && isZipPayload(buffer)) {
    return;
  }
  if (lower.endsWith(".tar.gz") && isGzipPayload(buffer)) {
    return;
  }
  const expected = lower.endsWith(".zip") ? "zip" : lower.endsWith(".tar.gz") ? "tar.gz" : "архив";
  throw new Error(
    `Скачанный файл ripgrep не похож на ${expected}. Проверьте доступ к GitHub через proxy.${payloadPreview(buffer)}`
  );
}

function isZipPayload(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }
  return buffer[0] === 0x50
    && buffer[1] === 0x4b
    && (
      (buffer[2] === 0x03 && buffer[3] === 0x04)
      || (buffer[2] === 0x05 && buffer[3] === 0x06)
      || (buffer[2] === 0x07 && buffer[3] === 0x08)
    );
}

function isGzipPayload(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function payloadPreview(buffer: Buffer): string {
  const preview = buffer
    .subarray(0, 160)
    .toString("utf8")
    .replace(/[^\x20-\x7eа-яА-ЯёЁ]+/g, " ")
    .trim();
  return preview ? ` Начало ответа: ${preview}` : "";
}

async function findRipgrepExecutable(root: string): Promise<string | undefined> {
  const executable = ripgrepExecutableName();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (!current || current.depth > 6) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: entryPath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name === executable) {
        return entryPath;
      }
    }
  }
  return undefined;
}

async function downloadJson<T>(url: string, proxy: RuntimeProxySettings): Promise<T> {
  const body = await downloadBuffer(url, proxy, 10 * 1024 * 1024, {
    Accept: "application/vnd.github+json"
  });
  return JSON.parse(body.toString("utf8")) as T;
}

function downloadBuffer(
  url: string,
  proxy: RuntimeProxySettings,
  maxBytes: number,
  headers: Record<string, string> = {},
  redirects = 0
): Promise<Buffer> {
  if (redirects > 5) {
    return Promise.reject(new Error("Слишком много redirect при скачивании ripgrep."));
  }

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const requestHeaders = {
      "User-Agent": "codex-element-plugin",
      ...headers
    };
    const handleResponse = (response: http.IncomingMessage): void => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const redirected = new URL(location, target).toString();
        downloadBuffer(redirected, proxy, maxBytes, headers, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Скачивание ripgrep завершилось HTTP ${status}.`));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error("Скачанный файл ripgrep слишком большой."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    };

    requestThroughProxyOrDirect(target, proxy, requestHeaders, handleResponse, reject);
  });
}

function requestThroughProxyOrDirect(
  target: URL,
  proxy: RuntimeProxySettings,
  headers: Record<string, string>,
  onResponse: (response: http.IncomingMessage) => void,
  onError: (error: Error) => void
): void {
  if (!proxy.url) {
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(target, { headers }, onResponse);
    request.once("error", onError);
    request.end();
    return;
  }

  const proxyUrl = new URL(proxy.url);
  if (target.protocol === "http:") {
    const request = http.request({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: "GET",
      path: target.toString(),
      headers: {
        ...headers,
        Host: target.host,
        ...proxyAuthorizationHeader(proxy)
      }
    }, onResponse);
    request.once("error", onError);
    request.end();
    return;
  }

  const connect = http.request({
    hostname: proxyUrl.hostname,
    port: Number(proxyUrl.port),
    method: "CONNECT",
    path: `${target.hostname}:${target.port || 443}`,
    headers: proxyAuthorizationHeader(proxy)
  });
  connect.once("connect", (response, socket) => {
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      socket.destroy();
      onError(new Error(`Proxy CONNECT вернул HTTP ${response.statusCode ?? "-"}.`));
      return;
    }
    const tlsSocket = tls.connect({
      socket,
      servername: target.hostname
    }, () => {
      const request = https.request({
        hostname: target.hostname,
        port: Number(target.port || 443),
        method: "GET",
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          Host: target.host
        },
        agent: false,
        createConnection: () => tlsSocket
      }, onResponse);
      request.once("error", onError);
      request.end();
    });
    tlsSocket.once("error", onError);
  });
  connect.once("error", onError);
  connect.end();
}

function proxyAuthorizationHeader(proxy: RuntimeProxySettings): Record<string, string> {
  if (!proxy.username) {
    return {};
  }
  const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}
