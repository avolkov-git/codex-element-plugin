import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as tls from "tls";
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
    const tempRoot = path.join(toolsRoot, `.tmp-${process.pid}-${Date.now()}`);
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

      progress(75, "install", "Устанавливаем ripgrep в каталог Codex Element");
      await fs.promises.rm(platformRoot, { recursive: true, force: true });
      await fs.promises.mkdir(platformRoot, { recursive: true });
      const finalPath = path.join(platformRoot, ripgrepExecutableName());
      await fs.promises.copyFile(executable, finalPath);
      if (process.platform !== "win32") {
        await fs.promises.chmod(finalPath, 0o755);
      }

      progress(88, "verify", "Проверяем rg --version");
      const probe = await probeRipgrepExecutable(finalPath);
      if (!probe.ok) {
        throw new Error(probe.message || "Установленный rg не прошел проверку.");
      }

      this.settings.saveInstalledRipgrepPath(finalPath, probe.version || version);
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
  const raw = (release.tag_name || release.name || "latest").trim();
  return raw.replace(/^v/i, "") || "latest";
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
  await runProcess("tar", ["-xzf", archivePath, "-C", extractRoot]);
}

async function extractZipArchive(archivePath: string, extractRoot: string): Promise<void> {
  await runProcess("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "& {",
      "param([string]$ArchivePath, [string]$ExtractRoot)",
      "$ErrorActionPreference = 'Stop';",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
      "if ([string]::IsNullOrWhiteSpace($ArchivePath)) { throw 'ArchivePath is empty.' }",
      "if ([string]::IsNullOrWhiteSpace($ExtractRoot)) { throw 'ExtractRoot is empty.' }",
      "if (!(Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw \"Archive not found: $ArchivePath\" }",
      "New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null;",
      "Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force",
      "}"
    ].join(" "),
    archivePath,
    extractRoot
  ]);
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

function runProcess(command: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} превысил таймаут.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.stderr.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} завершился с кодом ${code ?? "-"}. ${output}`.trim()));
    });
  });
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
