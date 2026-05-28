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
