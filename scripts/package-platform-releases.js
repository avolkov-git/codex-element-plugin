#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const {
  targetForPlatform,
  targetPaths,
  validateRuntimeFile
} = require("./runtime-preflight-lib");

const sourceRoot = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputRoot = path.resolve(args.output || path.resolve(sourceRoot, "..", "codex-plugin-release"));
const fallbackRuntimeRoot = path.resolve(args.runtimeRoot || path.resolve(sourceRoot, "..", "codex-plugin-deploy"));
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
const releaseTargets = [
  { platformId: "win32-x64", extension: "zip" },
  { platformId: "linux-x64", extension: "tar.gz" }
];

if (args.help) {
  printHelp();
  process.exit(0);
}

main();

function main() {
  validateOutputRoot();
  requireTool("zip");
  requireTool("unzip");
  requireTool("tar");

  fs.mkdirSync(outputRoot, { recursive: true });
  const workingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-element-release-${manifest.version}.`));
  const artifacts = [];

  try {
    for (const releaseTarget of releaseTargets) {
      artifacts.push(buildReleaseTarget(workingRoot, releaseTarget));
    }
    writeChecksums(artifacts);
    writeReleaseReadme(artifacts);
  } finally {
    fs.rmSync(workingRoot, { recursive: true, force: true });
  }

  console.log(`Platform release packages created: ${outputRoot}`);
  for (const artifact of artifacts) {
    console.log(`- ${path.basename(artifact.path)} (${formatBytes(artifact.size)})`);
  }
}

function buildReleaseTarget(workingRoot, releaseTarget) {
  const platformRoot = path.join(workingRoot, releaseTarget.platformId);
  const payloadRoot = path.join(platformRoot, "codex-plugins");
  const runtimeRoot = selectRuntimeRoot(releaseTarget.platformId);
  const archiveName = `codex-plugins-${manifest.version}-${releaseTarget.platformId}.${releaseTarget.extension}`;
  const archivePath = path.join(outputRoot, archiveName);

  runNodeScript("stage-deploy-payload.js", [
    "--target", payloadRoot,
    "--platform", releaseTarget.platformId,
    "--platform-only",
    "--runtime-root", runtimeRoot,
    "--strict"
  ]);
  assertPayloadVersion(payloadRoot);

  fs.rmSync(archivePath, { force: true });
  if (releaseTarget.extension === "zip") {
    runCommand("zip", ["-X", "-q", "-r", archivePath, "codex-plugins"], platformRoot);
  } else {
    runCommand("tar", ["-czf", archivePath, "codex-plugins"], platformRoot);
  }

  verifyArchive(workingRoot, releaseTarget, archivePath);
  const buffer = fs.readFileSync(archivePath);
  return {
    path: archivePath,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}

function selectRuntimeRoot(platformId) {
  const target = targetForPlatform(platformId);
  for (const root of [sourceRoot, fallbackRuntimeRoot]) {
    const candidate = targetPaths(root, target).find((item) => fs.existsSync(item));
    if (!candidate) {
      continue;
    }
    const validation = validateRuntimeFile(candidate, target);
    if (!validation.errors.length) {
      return root;
    }
  }
  throw new Error(`No valid ${platformId} runtime found in ${sourceRoot} or ${fallbackRuntimeRoot}.`);
}

function verifyArchive(workingRoot, releaseTarget, archivePath) {
  const verificationRoot = path.join(workingRoot, `verify-${releaseTarget.platformId}`);
  fs.mkdirSync(verificationRoot, { recursive: true });
  if (releaseTarget.extension === "zip") {
    runCommand("unzip", ["-q", archivePath, "-d", verificationRoot], sourceRoot);
  } else {
    runCommand("tar", ["-xzf", archivePath, "-C", verificationRoot], sourceRoot);
  }
  runNodeScript("verify-deploy-payload.js", [
    "--root", path.join(verificationRoot, "codex-plugins"),
    "--platform", releaseTarget.platformId,
    "--platform-only",
    "--strict"
  ]);
}

function assertPayloadVersion(payloadRoot) {
  const payloadManifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, "package.json"), "utf8"));
  if (payloadManifest.version !== manifest.version) {
    throw new Error(`Staged payload version ${payloadManifest.version} does not match release version ${manifest.version}.`);
  }
}

function writeChecksums(artifacts) {
  const body = `${artifacts.map((artifact) => `${artifact.sha256}  ${path.basename(artifact.path)}`).join("\n")}\n`;
  fs.writeFileSync(path.join(outputRoot, "SHA256SUMS.txt"), body, "utf8");
}

function writeReleaseReadme(artifacts) {
  const lines = [
    `# Codex for 1C: Element ${manifest.version}`,
    "",
    "Один исходный проект выпускается двумя platform-specific архивами:",
    "",
    ...artifacts.map((artifact) => `- \`${path.basename(artifact.path)}\``),
    "",
    "Выбирайте архив по операционной системе сервера Element, а не компьютера с браузером.",
    "После распаковки скопируйте каталог `codex-plugins` в `/plugins` сервера Element.",
    "Проверяйте SHA-256 по `SHA256SUMS.txt`.",
    ""
  ];
  fs.writeFileSync(path.join(outputRoot, "README_RELEASE.md"), lines.join("\n"), "utf8");
}

function validateOutputRoot() {
  if (outputRoot === sourceRoot || isInside(outputRoot, sourceRoot)) {
    throw new Error(`Release output must be outside the source checkout: ${outputRoot}`);
  }
  if (path.parse(outputRoot).root === outputRoot) {
    throw new Error(`Refusing to write release artifacts into filesystem root: ${outputRoot}`);
  }
}

function runNodeScript(scriptName, scriptArgs) {
  runCommand(process.execPath, [path.join(sourceRoot, "scripts", scriptName), ...scriptArgs], sourceRoot);
}

function runCommand(command, commandArgs, cwd) {
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function requireTool(command) {
  const result = childProcess.spawnSync(command, ["--help"], { encoding: "utf8", stdio: "ignore" });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error(`Release packaging requires '${command}' in PATH.`);
  }
}

function parseArgs(rawArgs) {
  const result = { output: "", runtimeRoot: "", help: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--output" || arg === "--runtime-root") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a path value.`);
      }
      result[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      result.output = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--runtime-root=")) {
      result.runtimeRoot = arg.slice("--runtime-root=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function printHelp() {
  console.log(`Usage: node scripts/package-platform-releases.js [options]

Options:
  --output <path>        Artifact directory. Defaults to ../codex-plugin-release.
  --runtime-root <path>  Fallback root with real runtime binaries.
  --help                 Show this help.
`);
}
