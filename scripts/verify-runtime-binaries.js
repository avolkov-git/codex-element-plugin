#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const binRoot = path.join(root, "bin");
const args = new Set(process.argv.slice(2));
const requireCurrent = args.has("--require-current");
const requireAll = args.has("--require-all");
const allowLfsPointer = args.has("--allow-lfs-pointer");

const targets = [
  { platformId: "win32-x64", legacyPlatformId: "windows-x86_64", executableName: "codex.exe", kind: "pe", arch: "x64", executableBit: false },
  { platformId: "win32-arm64", executableName: "codex.exe", kind: "pe", arch: "arm64", executableBit: false },
  { platformId: "linux-x64", executableName: "codex", kind: "elf", arch: "x64", executableBit: true },
  { platformId: "linux-arm64", executableName: "codex", kind: "elf", arch: "arm64", executableBit: true },
  { platformId: "darwin-x64", executableName: "codex", kind: "macho", arch: "x64", executableBit: true },
  { platformId: "darwin-arm64", executableName: "codex", kind: "macho", arch: "arm64", executableBit: true }
];

const currentPlatformId = `${process.platform}-${process.arch}`;
const errors = [];
const warnings = [];

for (const target of targets) {
  const candidatePaths = targetPaths(target);
  const existingPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
  const required = requireAll || (requireCurrent && target.platformId === currentPlatformId);

  if (!existingPath) {
    if (required) {
      errors.push(`missing runtime for ${target.platformId}: expected ${candidatePaths.join(" or ")}`);
    }
    continue;
  }

  validateRuntimeFile(existingPath, target);
}

if (warnings.length) {
  for (const warning of warnings) {
    console.warn(`WARN ${warning}`);
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  process.exit(1);
}

console.log("Runtime binary preflight passed.");

function targetPaths(target) {
  const paths = [path.join(binRoot, target.platformId, target.executableName)];
  if (target.legacyPlatformId) {
    paths.push(path.join(binRoot, target.legacyPlatformId, target.executableName));
  }
  return paths;
}

function validateRuntimeFile(filePath, target) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    errors.push(`${filePath} is not a file`);
    return;
  }

  const header = readHeader(filePath);
  const kind = detectKind(header);
  if (kind === "git-lfs-pointer") {
    const message = `${filePath} is a Git LFS pointer, not a runtime binary`;
    if (allowLfsPointer) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
    return;
  }

  if (kind !== target.kind) {
    errors.push(`${filePath} has kind=${kind}, expected ${target.kind}`);
  }

  const arch = detectArch(header, kind);
  if (arch !== "unknown" && arch !== "universal" && arch !== target.arch) {
    errors.push(`${filePath} has arch=${arch}, expected ${target.arch}`);
  }

  if (target.executableBit && !(stat.mode & 0o111)) {
    errors.push(`${filePath} is missing executable bit; expected chmod 755`);
  }
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function detectKind(header) {
  const textPrefix = header.subarray(0, Math.min(header.length, 128)).toString("utf8");
  if (textPrefix.startsWith("version https://git-lfs.github.com/spec/v1")) {
    return "git-lfs-pointer";
  }
  if (header[0] === 0x4d && header[1] === 0x5a) {
    return "pe";
  }
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return "elf";
  }
  if (isMachO(header)) {
    return "macho";
  }
  return "unknown";
}

function detectArch(header, kind) {
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

function readPeArch(header) {
  if (header.length < 70 || header[0] !== 0x4d || header[1] !== 0x5a) {
    return "unknown";
  }
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset + 6 > header.length) {
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

function readElfArch(header) {
  if (header.length < 20) {
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

function readMachOArch(header) {
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
  return `0x${cpuType.toString(16)}`;
}

function isMachO(header) {
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
