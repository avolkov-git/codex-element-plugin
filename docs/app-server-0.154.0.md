# Codex app-server 0.154.0

## Scope and provenance

Runtime-only upgrade from 0.153.4 to **0.154.0** on all six bundled platforms.
All sixteen executables are from the same [official release](https://github.com/openai/codex/releases/tag/rust-v0.154.0):
six CLI binaries, six Code Mode hosts, and four Windows helpers. The existing
companion inventory is retained; helpers are refreshed, not carried over from 0.153.4.

Each downloaded archive was checked against the size and SHA-256 digest returned
by the [GitHub release API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.154.0)
before extraction. Extracted file sizes and hashes are pinned in
[`bin/runtime-manifest.json`](../bin/runtime-manifest.json). Preflight verifies
the actual files, not LFS pointers: PE/ELF/Mach-O format, architecture, executable
bits, size and SHA-256. No source build or unofficial distribution was used.

## Protocol compatibility

The new [0.154.0 fixture](../scripts/fixtures/app-server/0.154.0.json) was generated
by the pinned macOS arm64 executable using
`app-server generate-json-schema --experimental`. It records the executable
SHA-256. Older 0.144.5 and 0.153.4 fixtures are unchanged.

`scripts/app-server-protocol-check.js` passes against all three versions.
It runs the current TypeScript controller in memory, without rebuilding `dist`.
Coverage includes sixteen production request methods:

- `initialize`, `account/read`, `account/login/start`, `account/rateLimits/read`, `model/list`;
- `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `turn/interrupt`;
- `skills/list`, `skills/config/write`, `mcpServerStatus/list`, `config/mcpServer/reload`, `mcpServer/oauth/login`.

Additional request fixtures cover `thread/compact/start`, `account/logout`,
`config/read`, `config/value/write` and paginated `experimentalFeature/list`.
Approvals, MCP elicitation, native user-input requests/answers, async questions,
streaming, diffs, plans, compaction, token usage and completion/queue behavior
remain covered. The old full and fallback resume assertions and fork assertion
still require **`excludeTurns: true`**.

No incompatible changes were found for the exercised payloads. Relevant schema
changes from 0.153.4 are additive or permissive:

- `account/rateLimits/read` accepts optional params; omitting params still validates.
- Rate-limit responses add optional `ordinaryUsageAllowed` and `normalModelSlug`.
- Threads add optional `daybreakEnabled`, `environments` and `originator`.
- MCP status adds optional `toolsError`.
- Permissions approval `cwd` uses the legacy path-string type; existing absolute paths validate.
- Four `userVerification/*` requests are new and are not enabled or used by this upgrade.

This is compatibility evidence for the plugin's tested surface, not a guarantee
about every upstream method or every target OS.

## Native config semantics

All observations below come from the real 0.154.0 app-server in a disposable,
private `CODEX_HOME`, with file-only auth storage, isolated home directories,
no auth.json and no external model calls.

1. With **no config.toml**, `config/read({includeLayers:true})` still returns a
   user layer with `config: {}`, the future user config file path, and version
   `sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
2. `config/value/write` with `keyPath: "features.context_management.experimental_mode"`,
   `value: true`, `mergeStrategy: "upsert"`, the user file path and its
   `expectedVersion` creates the file. It returns `status: "ok"`, `filePath`,
   the new `version` and `overriddenMetadata: null`.
3. Reading again immediately returns the nested flag in both effective config
   and the user layer, with user origin metadata. A stale `expectedVersion`
   is rejected and leaves the saved value intact.
4. **In the same process**, `experimentalFeature/list` immediately reports
   `context_management.enabled: true`, both globally and with the ID of a
   thread loaded before the write. A fresh thread also reports true.
5. The file and enabled preference survive an app-server restart. Writing false
   updates the effective config and the global/loaded-thread feature listing.
6. The CLI form `-c features.context_management.experimental_mode=true` is
   accepted. With that override present, a user write of false returns
   **`status: "okOverridden"`**, `effectiveValue: true`, and an overriding
   `sessionFlags` layer. User config contains false, but effective config and
   feature/list remain true. Restarting without the override restores false.
7. **Follow pagination.** In the observed catalog, context_management was not
   on the first page even with `limit: 100`.

Feature/list describes the loaded preference; it does **not** prove that an
already-running session has activated experimental notes/history. Version
0.153.4 already accepted this CLI setting. The important 0.154.0 change is
[model capability gating at session startup, #43147](https://github.com/openai/codex/pull/43147).

The [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes notes and searchable history and requires ChatGPT Plus, Pro or Pro Lite.
The [0.154.0 startup implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/session/token_budget.rs)
also checks the starting model's `supports_experimental_context`, compatible
Codex backend routing and eligible ChatGPT auth; custom provider credentials do
not satisfy that path. The bundled Astra model advertises the capability.
Without real authentication/generation, actual feature activation was deliberately
not claimed or tested. Restarting a client runtime to apply a preference must
wait until active work has finished.

## Resume, fork and relocated cwd

The real-runtime smoke seeds over 9 MiB of synthetic response-item history and
compares the stored payloads after each operation. No real conversations are read.

| Operation | Top-level response.cwd | response.thread.cwd | History |
| --- | --- | --- | --- |
| Resume an already-loaded thread with a new cwd | Original cwd; override ignored | Original cwd | Same ID and all stored items retained |
| Restart app-server, then resume the same ID with a new cwd | **New cwd** | Original metadata cwd | Same ID and all stored items retained |
| Fork with a new cwd and excludeTurns | New cwd | Not used as active-session evidence | New ID; all original items retained in order |

Every production-style resume/fork uses `excludeTurns: true`, returns an empty
`thread.turns`, and is checked to remain below 64 KiB. A measured cold-resume
response was about 1.8 KiB despite more than 9 MiB of stored context. A fork may
append its own context message, so the check preserves the original sequence
without requiring byte-identical parent and fork rollout files.

Use top-level **response.cwd** for the effective resumed session, not the
historical `thread.cwd`. A hot resume is not a reliable way to apply a new cwd
or restart context activation. The missing-rollout error remains explicit and
is checked separately; no history reset is introduced.

The initial synthetic seed uses the `history` parameter and can echo a large
preview. It is test setup only, not a recommended production workaround:
subsequent checks use ID-based resume/fork and do not send the full history.

## Verification

Passed on macOS arm64:

```bash
node scripts/app-server-protocol-check.js
node scripts/app-server-smoke.js bin/darwin-arm64/codex
node scripts/verify-runtime-binaries.js --require-all
node --test tests/runtime-payload.test.cjs
bin/darwin-arm64/codex --version
bin/darwin-x64/codex --version
```

Both macOS CLI version commands returned `codex-cli 0.154.0`. The native smoke
checks initialize, paginated models/Astra, unauthenticated account, skills,
MCP status/reload, thread start, config layers/writes/conflicts, hot and cold
resume, fork, CLI override precedence and logout. Offline mode forbids
`turn/start` and rejects `--auth-home` unless explicitly paired with `--live`.
It checks the host binary format/architecture before spawning.

Packaging tests: **27 passed**, including exact six-platform/sixteen-file
inventory, every missing/stale executable, LFS handling, and rejection of
preserved 0.153.4 files under the new manifest. Staging tests operate only on
small temporary fixtures, not the real deploy directory.

The real `app-server -> code-mode-host -> MCP tools/call -> tool result` chain
also passed using local HTTP/MCP/Responses fixtures, no account and no external
model. `scripts/code-mode-mcp-smoke.cjs` now reads the expected version from the
runtime manifest; the persistent script also passed on 0.154.0.

Limitations: Linux execution was not tested because the Docker daemon was not
running. Windows executables were **not launched on macOS**. Linux and Windows
provenance, sizes, hashes, formats and architectures were verified statically.
No paid generation, real auth access, full build, shared deploy, commit or push.

`scripts/app-server-upgrade-smoke.js` now reads its target version from the
manifest. That separate authenticated migration test was not run. Existing
0.153.4 test fixtures and historical documentation remain available.

To reproduce the generated fixture using a native pinned binary:

```bash
node scripts/app-server-protocol-check.js --generate-fixture bin/darwin-arm64/codex
```

## Executable hashes

All entries below were computed from actual extracted executable bytes.
Every row belongs to official release **0.154.0**; non-macOS version attribution
is release/digest-based, not a claim of native execution.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `bin/win32-x64/codex.exe` | 298169136 | `be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde` |
| `bin/win32-x64/codex-command-runner.exe` | 8218416 | `a57ca8beb786a05f36c97309e8a716610c70ced9946dc1437bbbaf4566c0c403` |
| `bin/win32-x64/codex-windows-sandbox-setup.exe` | 15467312 | `ea27f90a0746e2464a829cd6e1de0dcafb77c8be603de899661e8c006ef33937` |
| `bin/win32-arm64/codex.exe` | 252148528 | `dc6d744d747a50f8caf7f08817e0ccc9b09781f6269dec3609e2f9fbe036233d` |
| `bin/win32-arm64/codex-command-runner.exe` | 7341360 | `463a1a872e61bb8d9576338833d4e5036d86e3c3914a9dfa3c0f36b48e0399a0` |
| `bin/win32-arm64/codex-windows-sandbox-setup.exe` | 13694256 | `0b53b105094c3cdaa0bf984556f964a362120292830ed8e78480c734e60ae77c` |
| `bin/linux-x64/codex` | 262858016 | `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022` |
| `bin/linux-arm64/codex` | 227482840 | `9b7c1c7abdc26fc3c4f47c77656a8e9121def5483dbae830ef1ee561758448a9` |
| `bin/darwin-x64/codex` | 239700064 | `b0e26f09819c4b27f621853800c29f95ac5d526ad9b88ab641de4db86835718d` |
| `bin/darwin-arm64/codex` | 222655232 | `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc` |
| `bin/win32-x64/codex-code-mode-host.exe` | 72496432 | `7b4987007702973dfeb49ec9a0c11f737488890e208ccb04f7a147769c4bb1f1` |
| `bin/win32-arm64/codex-code-mode-host.exe` | 67593520 | `1f33d0eaf0522bf067cdf1899c789194411c70fd1cc22eda4a46025c0835193f` |
| `bin/linux-x64/codex-code-mode-host` | 69431360 | `0c57be435e73b70d9106c850d751cd259a7f04da958a453d7ef59090d82b70f1` |
| `bin/linux-arm64/codex-code-mode-host` | 63381656 | `f31e1c5ffbbca7884aff2f0f8795d3da197f4aafb114033a399dfc17a5119031` |
| `bin/darwin-x64/codex-code-mode-host` | 65865664 | `c558d3ebbd3b810e6e30ef5bb90c50db4807f566073dbdd04f015659ec9dddf9` |
| `bin/darwin-arm64/codex-code-mode-host` | 62786144 | `426d73aaeb2aeef45e98b5add99e8ef9594a31673d281489bb2cb06b38c27423` |

## Archive hashes

These matched the official release asset digests before installation.

| Official artifact | SHA-256 |
| --- | --- |
| `codex-x86_64-pc-windows-msvc.exe.tar.gz` | `4e96740782869faff9d424806d4419afd2ee51ea5ece6cec462912b7098497a1` |
| `codex-command-runner-x86_64-pc-windows-msvc.exe.tar.gz` | `2f7f3a9dd2ffbdc201e87d7117531470a3e36066e0e6a8a28dd39dbb446c82e9` |
| `codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe.tar.gz` | `2d766c7f0985e4b9cfcca9f64ee67222c3a55debff6d9d97a3e1a10e3ea346ed` |
| `codex-aarch64-pc-windows-msvc.exe.tar.gz` | `c8eea016f66a5511bd50b181dcdc4c62f679d3e4b73e62051126386e1337478f` |
| `codex-command-runner-aarch64-pc-windows-msvc.exe.tar.gz` | `e1855aa33ad93250ce9cc0cc3182aefe07988043233f79461ad3f7034e7749b7` |
| `codex-windows-sandbox-setup-aarch64-pc-windows-msvc.exe.tar.gz` | `7aecf69c170a224bb48759522c9616ed4550771ac9a76a6437b5415375fb2840` |
| `codex-x86_64-unknown-linux-musl.tar.gz` | `d7e18b2597ae8f242f5f31ee9e90deef48dbc9edd634d9868fb6435d08c07f02` |
| `codex-aarch64-unknown-linux-musl.tar.gz` | `583b48df32804213bdcd338c2e5adb06b34340821fa757a726cc0a524fa33c27` |
| `codex-x86_64-apple-darwin.tar.gz` | `1219c837d8f813b493a424c125c0038b5d9ca16279bc6d3fe6ce037a3e18a6e7` |
| `codex-aarch64-apple-darwin.tar.gz` | `344310a0a591c1b192e04feff304321a69907c9498baaac331ca7e16ebcef9d7` |
| `codex-code-mode-host-x86_64-pc-windows-msvc.exe.tar.gz` | `656b475bb80d258e3244dc57a1556eb3ce2180791a649ced5e2c8e199c340891` |
| `codex-code-mode-host-aarch64-pc-windows-msvc.exe.tar.gz` | `e13bc956bcb9298602ff0bb72ee73ac27d5fdeb7e8290aead5b16ce817cd9c16` |
| `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` | `a68df7cca23c6da7cde175677df7de61c73a234add1333a1254b86d641af01f7` |
| `codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz` | `20aefa302c2022b496e32911bf954a5f76c7fd749c6bdb9fbd711e32b66dcbfa` |
| `codex-code-mode-host-x86_64-apple-darwin.tar.gz` | `a0fa6141e591f44dc2d86a589cfe797212317bfb9fa3a6c73131e4dbb93387fe` |
| `codex-code-mode-host-aarch64-apple-darwin.tar.gz` | `500ee2a02ea598ae519052e7d7d8e201d1db01986f30c214ef4143645dc86fad` |

## Sidecar changed files

- All sixteen `bin/<platform>/codex*` executables listed above.
- `bin/runtime-manifest.json`.
- `scripts/fixtures/app-server/0.154.0.json`.
- `scripts/app-server-protocol-check.js`.
- `scripts/app-server-smoke.js`.
- `tests/runtime-payload.test.cjs`.
- `docs/app-server-0.154.0.md`.

No changes were needed in runtime-preflight-lib, verify-runtime-binaries,
stage-deploy-payload or verify-deploy-payload: their existing companion-aware
checks already support this release. Pre-existing dirty work and concurrent
parent changes outside this list were not reverted or edited by the sidecar.
