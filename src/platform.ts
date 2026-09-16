import * as fs from "fs";
import * as path from "path";

export type RuntimeExecutableKind = "pe" | "elf" | "macho" | "git-lfs-pointer" | "text" | "unknown" | "missing";

export interface RuntimeExecutableResolution {
  readonly path: string;
  readonly platformId: string;
  readonly executableName: string;
  readonly candidates: readonly string[];
  readonly legacy: boolean;
}

export interface RuntimeExecutableValidation {
  readonly ok: boolean;
  readonly message: string;
  readonly summary: RuntimeExecutableSummary;
}

export interface RuntimeExecutableSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly size: number;
  readonly mtime?: string;
  readonly kind: RuntimeExecutableKind;
  readonly arch: string;
  readonly mode: string;
  readonly executable: boolean;
}

export function hostPlatformId(): string {
  return `${process.platform}-${process.arch}`;
}

export function runtimeExecutableName(): string {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function pathEnvKey(env: NodeJS.ProcessEnv = process.env): "PATH" | "Path" {
  if (process.platform !== "win32") {
    return "PATH";
  }
  return Object.prototype.hasOwnProperty.call(env, "Path") ? "Path" : "PATH";
}

export function normalizePathEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "win32") {
    return;
  }

  const value = env.Path ?? env.PATH;
  delete env.Path;
  delete env.PATH;
  if (value) {
    env.Path = value;
  }
}

export function resolveBundledRuntimeExecutable(extensionRoot: string): RuntimeExecutableResolution {
  const executableName = runtimeExecutableName();
  const platformId = hostPlatformId();
  const candidates = [
    path.join(extensionRoot, "bin", platformId, executableName),
    ...legacyRuntimeCandidates(extensionRoot)
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  const selectedPath = existing ?? candidates[0];
  return {
    path: selectedPath,
    platformId,
    executableName,
    candidates,
    legacy: legacyRuntimeCandidates(extensionRoot).includes(selectedPath)
  };
}

export function validateRuntimeExecutable(resolution: RuntimeExecutableResolution): RuntimeExecutableValidation {
  const summary = summarizeRuntimeExecutable(resolution.path);
  if (!summary.exists) {
    return {
      ok: false,
      message: [
        `Bundled Codex runtime не найден для платформы ${resolution.platformId}.`,
        `Ожидаемый файл: ${resolution.path}.`,
        `Проверенные кандидаты: ${resolution.candidates.join("; ")}`
      ].join(" "),
      summary
    };
  }
  if (!summary.isFile) {
    return {
      ok: false,
      message: `Bundled Codex runtime не является файлом: ${resolution.path}.`,
      summary
    };
  }
  if (summary.kind === "git-lfs-pointer") {
    return {
      ok: false,
      message: "Bundled Codex runtime является Git LFS pointer. В поставку нужен реальный бинарник, выполните git lfs pull перед копированием plugin.",
      summary
    };
  }

  const expectedKind = expectedRuntimeKind();
  if (expectedKind && summary.kind !== expectedKind) {
    return {
      ok: false,
      message: `Bundled Codex runtime не соответствует платформе ${resolution.platformId}: найден ${summary.kind}, ожидался ${expectedKind}.`,
      summary
    };
  }

  if (process.platform !== "win32" && !summary.executable) {
    return {
      ok: false,
      message: `Bundled Codex runtime не имеет executable bit: ${resolution.path}. Для Unix-поставки нужен chmod 755.`,
      summary
    };
  }

  const expectedArch = expectedRuntimeArch();
  if (expectedArch && summary.arch && summary.arch !== "unknown" && summary.arch !== "universal" && summary.arch !== expectedArch) {
    return {
      ok: false,
      message: `Bundled Codex runtime имеет архитектуру ${summary.arch}, но текущая платформа требует ${expectedArch}.`,
      summary
    };
  }

  const hostName = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const hostPath = path.join(path.dirname(resolution.path), hostName);
  const host = summarizeRuntimeExecutable(hostPath);
  if (!host.isFile || host.kind !== expectedKind || (process.platform !== "win32" && !host.executable)
    || (expectedArch && host.arch !== expectedArch && host.arch !== "universal")) {
    return {
      ok: false,
      message: `Поставка Codex неполная или повреждена: компонент ${hostName} отсутствует или не подходит для ${resolution.platformId}. Без него не работают вызовы инструментов через Code Mode, включая MCP. Переустановите полный каталог плагина. Ожидаемый файл: ${hostPath}.`,
      summary
    };
  }

  return { ok: true, message: "", summary };
}

export function summarizeRuntimeExecutable(filePath: string): RuntimeExecutableSummary {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return {
        path: filePath,
        exists: true,
        isFile: false,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind: "unknown",
        arch: "unknown",
        mode: modeString(stat.mode),
        executable: false
      };
    }
    const header = readFileHeader(filePath, 512);
    const kind = detectExecutableKind(header);
    return {
      path: filePath,
      exists: true,
      isFile: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind,
      arch: detectExecutableArch(header, kind),
      mode: modeString(stat.mode),
      executable: process.platform === "win32" ? true : Boolean(stat.mode & 0o111)
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      isFile: false,
      size: 0,
      kind: "missing",
      arch: "unknown",
      mode: "-",
      executable: false
    };
  }
}

export function formatRuntimeExecutableSummary(summary: RuntimeExecutableSummary): string {
  return [
    `path=${summary.path}`,
    `exists=${summary.exists ? "yes" : "no"}`,
    `isFile=${summary.isFile ? "yes" : "no"}`,
    `size=${summary.size}`,
    `mtime=${summary.mtime ?? "-"}`,
    `kind=${summary.kind}`,
    `arch=${summary.arch || "unknown"}`,
    `mode=${summary.mode}`,
    `executable=${summary.executable ? "yes" : "no"}`
  ].join("; ");
}

function legacyRuntimeCandidates(extensionRoot: string): string[] {
  if (process.platform === "win32" && process.arch === "x64") {
    return [path.join(extensionRoot, "bin", "windows-x86_64", "codex.exe")];
  }
  return [];
}

function expectedRuntimeKind(): RuntimeExecutableKind | undefined {
  if (process.platform === "win32") {
    return "pe";
  }
  if (process.platform === "linux") {
    return "elf";
  }
  if (process.platform === "darwin") {
    return "macho";
  }
  return undefined;
}

function expectedRuntimeArch(): string {
  if (process.arch === "x64") {
    return "x64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  if (process.arch === "ia32") {
    return "x86";
  }
  return "";
}

function detectExecutableKind(header: Buffer): RuntimeExecutableKind {
  const textPrefix = header.subarray(0, Math.min(header.length, 128)).toString("utf8");
  if (textPrefix.startsWith("version https://git-lfs.github.com/spec/v1")) {
    return "git-lfs-pointer";
  }
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
    return "pe";
  }
  if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return "elf";
  }
  if (isMachO(header)) {
    return "macho";
  }
  if (/^[\x09\x0a\x0d\x20-\x7e]+$/u.test(textPrefix)) {
    return "text";
  }
  return "unknown";
}

function detectExecutableArch(header: Buffer, kind: RuntimeExecutableKind): string {
  if (kind === "pe") {
    return readPeArch(header);
  }
  if (kind === "elf") {
    return readElfArch(header);
  }
  if (kind === "macho") {
    return readMachOArch(header);
  }
  return "unknown";
}

function readPeArch(header: Buffer): string {
  if (header.length < 70 || header[0] !== 0x4d || header[1] !== 0x5a) {
    return "unknown";
  }
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset + 6 > header.length) {
    return "unknown";
  }
  if (header[peOffset] !== 0x50 || header[peOffset + 1] !== 0x45 || header[peOffset + 2] !== 0 || header[peOffset + 3] !== 0) {
    return "unknown";
  }
  const machine = header.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) {
    return "x64";
  }
  if (machine === 0xaa64) {
    return "arm64";
  }
  if (machine === 0x14c) {
    return "x86";
  }
  return `0x${machine.toString(16)}`;
}

function readElfArch(header: Buffer): string {
  if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
    return "unknown";
  }
  const littleEndian = header[5] !== 2;
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
  if (machine === 0x3e) {
    return "x64";
  }
  if (machine === 0xb7) {
    return "arm64";
  }
  if (machine === 0x03) {
    return "x86";
  }
  return `0x${machine.toString(16)}`;
}

function readMachOArch(header: Buffer): string {
  if (header.length < 8) {
    return "unknown";
  }
  const magicBe = header.readUInt32BE(0);
  const magicLe = header.readUInt32LE(0);
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf || magicLe === 0xcafebabe || magicLe === 0xcafebabf) {
    return "universal";
  }
  const littleEndian = magicLe === 0xfeedface || magicLe === 0xfeedfacf;
  const bigEndian = magicBe === 0xfeedface || magicBe === 0xfeedfacf;
  if (!littleEndian && !bigEndian) {
    return "unknown";
  }
  const cpuType = littleEndian ? header.readInt32LE(4) : header.readInt32BE(4);
  if (cpuType === 0x01000007) {
    return "x64";
  }
  if (cpuType === 0x0100000c) {
    return "arm64";
  }
  if (cpuType === 7) {
    return "x86";
  }
  return `0x${cpuType.toString(16)}`;
}

function isMachO(header: Buffer): boolean {
  if (header.length < 4) {
    return false;
  }
  const magicBe = header.readUInt32BE(0);
  const magicLe = header.readUInt32LE(0);
  return [
    0xfeedface,
    0xfeedfacf,
    0xcafebabe,
    0xcafebabf
  ].includes(magicBe) || [
    0xfeedface,
    0xfeedfacf,
    0xcafebabe,
    0xcafebabf
  ].includes(magicLe);
}

function readFileHeader(filePath: string, length: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}
