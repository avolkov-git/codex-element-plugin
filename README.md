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

Unix-поставка должна сохранять executable bit:

```bash
chmod 755 bin/linux-x64/codex
chmod 755 bin/linux-arm64/codex
chmod 755 bin/darwin-x64/codex
chmod 755 bin/darwin-arm64/codex
```

Плагин не меняет системный `PATH` и не требует `sudo`: все пользовательские данные пишутся в user-writable config root, а tool paths добавляются только в окружение дочернего процесса `codex app-server`.
