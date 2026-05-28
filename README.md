# Codex for 1C: Element

Новый clean-room plugin project для 1C: Element.

Этот каталог является будущим deploy payload: его содержимое должно переноситься в `/plugins` серверного bundle Element.

На старте здесь нет кода старой версии. Разработка будет идти маленькими проверяемыми итерациями.

## Правила текущей версии

- Не запускать `codex.exe` на activation.
- Использовать webview sidebar с postMessage-состоянием.
- Чаты открывать в отдельных workspace webview panels.
- Поддерживать serializer для восстановления chat panels после reload.
- Хранить пользовательские данные вне plugin directory.
- Перед каждой итерацией фиксировать пользовательский план проверки.

## Runtime Binaries

Поставочный каталог должен содержать реальный `codex` runtime под целевую платформу. Git LFS pointer вместо бинарника считается ошибкой поставки.

Целевой layout:

```text
bin/
  win32-x64/codex.exe
  win32-arm64/codex.exe
  linux-x64/codex
  linux-arm64/codex
  darwin-x64/codex
  darwin-arm64/codex
```

Legacy Windows layout `bin/windows-x86_64/codex.exe` поддерживается для обратной совместимости.
Legacy Linux layout `bin/linux-x86_64/codex` также поддерживается как источник для staging, но canonical deploy layout остается `bin/linux-x64/codex`.
Legacy macOS layout `bin/macos-aarch64/codex` также поддерживается как источник для staging, но canonical deploy layout остается `bin/darwin-arm64/codex`.

Перед копированием в `/plugins`:

```bash
npm run preflight:runtime
```

Для release-пакета со всеми платформами:

```bash
npm run preflight:runtime:release
```

Для проверки уже разложенного staging-каталога:

```bash
node scripts/verify-runtime-binaries.js --platform linux-x64 --root /path/to/staged/plugin
```

Для dry-run проверки окружения без запуска `codex`:

```bash
node scripts/simulate-runtime-env.js --platform linux-x64 --service-user --empty-env --plugin-root /path/to/staged/plugin --config-root /var/lib/codex-element
```

Dry-run проверяет выбор runtime, config root, `CODEX_HOME`, `HOME/XDG_*`, `PATH`, `rg` patch и базовые права на каталоги. Script ничего не создает и не меняет.

Для реальной Unix-проверки уже скопированного `/plugins` payload под системным пользователем Element используйте smoke-check:

```bash
node scripts/unix-smoke-check.js \
  --platform linux-x64 \
  --plugin-root /path/to/element/plugins/codex \
  --config-root /var/lib/codex-element \
  --workspace-root /path/to/workspace
```

Smoke-check запускает `codex --version`, проверяет executable bit, права на config root, `CODEX_HOME`, `HOME/XDG_*`, runtime cwd и наличие `rg`. Подробный checklist: `docs/unix-smoke-checklist.md`.

## Deploy Payload Preflight

Перед копированием каталога плагина в `/plugins` нужно проверять не только runtime-бинарник, но и сам deploy payload:

```bash
npm run preflight:deploy
```

Для проверки staging-каталога под конкретную платформу:

```bash
node scripts/verify-deploy-payload.js --root /path/to/staged/plugin --platform linux-x64 --strict
```

Для release-пакета со всей платформенной матрицей:

```bash
npm run preflight:deploy:release
```

Deploy preflight проверяет:

- обязательные файлы плагина: `package.json`, `dist/extension.js`, `media/*`, базовый context и icon;
- `package.json.main` и согласованность версий `package.json` / `package-lock.json`;
- runtime-бинарники для выбранной платформы или всей матрицы;
- отсутствие deploy-мусора: `node_modules`, `.git`, `.tmp`, `coverage`, `.DS_Store`, `Thumbs.db`, `*.log`, `*.tmp`, `*.vsix`.

В dev-режиме `--allow-lfs-pointer` допускает Git LFS pointer как warning, чтобы можно было проверять текущую рабочую копию. В `--strict` pointer считается ошибкой: в реальной поставке в `/plugins` должны лежать настоящие executable-файлы.

## Deploy Staging

Рабочую git-копию не нужно копировать в `/plugins` напрямую. Сначала соберите чистый deploy-каталог:

```bash
npm run deploy:stage
```

По умолчанию payload собирается в соседний каталог:

```text
../codex-plugin-deploy
```

Script исключает `.git`, `node_modules`, `.DS_Store`, временные файлы, logs и VSIX-архивы. Если в deploy-каталоге уже лежали настоящие runtime-бинарники, script сохраняет их и не затирает Git LFS pointer из рабочей копии поверх валидного executable.

Для strict-сборки Windows x64:

```bash
npm run deploy:stage:strict
```

Для release-сборки всей платформенной матрицы:

```bash
npm run deploy:stage:release
```

Если реальные runtime-бинарники хранятся отдельно, передайте каталог с таким же `bin/<platform>/...` layout:

```bash
node scripts/stage-deploy-payload.js \
  --target ../codex-plugin-deploy \
  --platform win32-x64 \
  --runtime-root /path/to/real-runtime-root \
  --strict
```

До появления настоящего `codex.exe` dev-сборка может пройти только с warning про LFS pointer. Это не release-ready состояние.

Unix-поставка должна сохранять executable bit:

```bash
chmod 755 bin/linux-x64/codex
chmod 755 bin/linux-arm64/codex
chmod 755 bin/darwin-x64/codex
chmod 755 bin/darwin-arm64/codex
```

Плагин не меняет системный `PATH` и не требует `sudo`: все пользовательские данные пишутся в user-writable config root, а tool paths добавляются только в окружение дочернего процесса `codex app-server`.

## Ripgrep

`rg` является runtime tool, а не системной зависимостью плагина. Плагин поддерживает три сценария:

- найти уже установленный `rg` в `PATH` или стандартных user-local каталогах;
- принять ручной путь в `Codex: Настройки`;
- установить managed `rg` в `<configRoot>/server/tools/ripgrep/...`.

Managed install не пишет в `/usr`, `/opt`, `Program Files` или системный `PATH`. Каталог `rg` добавляется только в `PATH` дочернего процесса `codex app-server`, вместе с `RIPGREP_PATH`.

Распаковка release-архивов выполняется внутри Node.js:

- `.zip` без PowerShell/`Expand-Archive`;
- `.tar.gz` без внешнего `tar`.

Это важно для закрытых контуров, сервисных пользователей Linux и Windows-инсталляций без полноценного shell окружения. Если download с GitHub недоступен, пользовательский fallback - вручную указать путь к уже установленному `rg`.
