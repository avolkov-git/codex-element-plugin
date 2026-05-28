const fs = require("fs");
const path = require("path");

const targets = [
  { platformId: "win32-x64", legacyPlatformId: "windows-x86_64", executableName: "codex.exe", kind: "pe", arch: "x64", executableBit: false },
  { platformId: "win32-arm64", executableName: "codex.exe", kind: "pe", arch: "arm64", executableBit: false },
  { platformId: "linux-x64", legacyPlatformId: "linux-x86_64", executableName: "codex", kind: "elf", arch: "x64", executableBit: true },
  { platformId: "linux-arm64", executableName: "codex", kind: "elf", arch: "arm64", executableBit: true },
  { platformId: "darwin-x64", executableName: "codex", kind: "macho", arch: "x64", executableBit: true },
  { platformId: "darwin-arm64", legacyPlatformId: "macos-aarch64", executableName: "codex", kind: "macho", arch: "arm64", executableBit: true }
];

function targetForPlatform(platformId) {
  return targets.find((target) => target.platformId === platformId || target.legacyPlatformId === platformId);
}

function targetPaths(root, target) {
  const binRoot = path.join(root, "bin");
  const paths = [path.join(binRoot, target.platformId, target.executableName)];
  if (target.legacyPlatformId) {
    paths.push(path.join(binRoot, target.legacyPlatformId, target.executableName));
  }
  return paths;
}

function resolveRuntime(root, platformId) {
  const target = targetForPlatform(platformId);
  if (!target) {
    return {
      target: undefined,
      candidates: [],
      selectedPath: "",
      existingPath: "",
      legacy: false
    };
  }
  const candidates = targetPaths(root, target);
  const existingPath = candidates.find((candidate) => fs.existsSync(candidate)) || "";
  const selectedPath = existingPath || candidates[0];
  return {
    target,
    candidates,
    selectedPath,
    existingPath,
    legacy: Boolean(existingPath && target.legacyPlatformId && existingPath.includes(`${path.sep}${target.legacyPlatformId}${path.sep}`))
  };
}

function validateRuntimeFile(filePath, target, options = {}) {
  const errors = [];
  const warnings = [];
  const summary = summarizeRuntimeFile(filePath);
  if (!summary.exists) {
    if (options.required) {
      errors.push(`missing runtime for ${target.platformId}: expected ${filePath}`);
    }
    return { errors, warnings, summary };
  }

  if (!summary.isFile) {
    errors.push(`${filePath} is not a file`);
    return { errors, warnings, summary };
  }

  if (summary.kind === "git-lfs-pointer") {
    const message = `${filePath} is a Git LFS pointer, not a runtime binary`;
    if (options.allowLfsPointer) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
    return { errors, warnings, summary };
  }

  if (summary.kind !== target.kind) {
    errors.push(`${filePath} has kind=${summary.kind}, expected ${target.kind}`);
  }

  if (summary.arch !== "unknown" && summary.arch !== "universal" && summary.arch !== target.arch) {
    errors.push(`${filePath} has arch=${summary.arch}, expected ${target.arch}`);
  }

  if (target.executableBit && !summary.executable) {
    errors.push(`${filePath} is missing executable bit; expected chmod 755`);
  }

  return { errors, warnings, summary };
}

function summarizeRuntimeFile(filePath) {
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
    const header = readHeader(filePath);
    const kind = detectKind(header);
    return {
      path: filePath,
      exists: true,
      isFile: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind,
      arch: detectArch(header, kind),
      mode: modeString(stat.mode),
      executable: Boolean(stat.mode & 0o111)
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      isFile: false,
      size: 0,
      mtime: "",
      kind: "missing",
      arch: "unknown",
      mode: "-",
      executable: false
    };
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

function modeString(mode) {
  return `0${(mode & 0o777).toString(8)}`;
}

module.exports = {
  resolveRuntime,
  targetForPlatform,
  targetPaths,
  targets,
  validateRuntimeFile
};
