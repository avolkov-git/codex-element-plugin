#!/usr/bin/env node
"use strict";
// Operator-only export: an old login-named directory does not prove ownership.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  if (!args.get("--source") || !args.get("--binding")) throw new Error("Usage: node scripts/export-legacy-history.js --source OLD/chats.json --binding PROJECT/import-target.json --confirm-owner USER_ID --confirm-project PROJECT_NAME");
  const source = path.resolve(args.get("--source"));
  const bindingPath = path.resolve(args.get("--binding"));
  if (fs.statSync(bindingPath).size > 16384) throw new Error("Invalid import target size");
  const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
  if (binding.schema !== "codex-element-import-target-v1" || !/^ide-[a-f0-9]{32}$/.test(binding.scope?.userKey) || !/^project-[a-f0-9]{32}$/.test(binding.scope?.projectKey)
    || binding.owner?.userId !== args.get("--confirm-owner") || binding.scope?.projectName !== args.get("--confirm-project")) throw new Error("Confirm the exact IDE user ID and project name from the trusted import-target.json.");
  if (fs.statSync(source).size > 128 * 1024 * 1024) throw new Error("Legacy history exceeds 128 MiB");
  const raw = fs.readFileSync(source, "utf8");
  const history = JSON.parse(raw);
  if (history.version !== 1 || !Array.isArray(history.chats) || !history.transcripts || typeof history.transcripts !== "object") throw new Error("Source is not a version 1 chat history. No file written.");
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  const destination = path.join(path.dirname(bindingPath), "imports", `legacy-${fingerprint}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ schema: "codex-element-history-export-v1", scope: binding.scope, owner: binding.owner, sourceSha256: fingerprint, history });
  fs.writeFileSync(destination, `${payload}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Prepared ${history.chats.length} chats for the confirmed owner/project: ${destination}`);
  console.log("The source history and authentication files were not changed. Refresh the migration list in Codex.");
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
