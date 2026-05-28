# Unix Smoke Checklist

Цель проверки: подтвердить, что deploy-каталог `Codex for 1C: Element` запускается на Unix-стенде под тем же системным пользователем, под которым работает Element, без `sudo`, без записи в системные каталоги и без изменения системного `PATH`.

Эта проверка закрывает то, что нельзя доказать локально на macOS/Windows:

- runtime binary реально исполняется на целевой системе;
- каталог плагина читается и searchable для сервисного пользователя;
- `configRoot` доступен на запись или может быть создан сервисным пользователем;
- `CODEX_HOME`, `HOME`, `XDG_*` будут указывать в user-writable область;
- файловая система не смонтирована с `noexec` для runtime binary;
- `rg` найден или понятно отсутствует.

## Что подготовить

- Скопированный deploy payload в каталог `/plugins` Element.
- Реальный Unix runtime в deploy payload:
  - Linux x64: `bin/linux-x64/codex`;
  - macOS arm64: `bin/darwin-arm64/codex`.
- Writable config root для пользователя Element. Рекомендуемый Linux-вариант: `/var/lib/codex-element`, если администратор заранее создал каталог и выдал права сервисному пользователю. Без этого можно использовать другой user-writable каталог.
- Workspace root Element, если он уже известен.

## Команда Linux x64

Запускать от имени пользователя, под которым работает Element:

```bash
node scripts/unix-smoke-check.js \
  --platform linux-x64 \
  --plugin-root /path/to/element/plugins/codex \
  --config-root /var/lib/codex-element \
  --workspace-root /path/to/workspace
```

Если `rg` установлен отдельно:

```bash
node scripts/unix-smoke-check.js \
  --platform linux-x64 \
  --plugin-root /path/to/element/plugins/codex \
  --config-root /var/lib/codex-element \
  --workspace-root /path/to/workspace \
  --rg-path /path/to/rg
```

## Команда macOS arm64

```bash
node scripts/unix-smoke-check.js \
  --platform darwin-arm64 \
  --plugin-root /path/to/element/plugins/codex \
  --config-root "$HOME/Library/Application Support/CodexElement" \
  --workspace-root /path/to/workspace
```

## Что считается успехом

В выводе должно быть:

```text
Codex Unix smoke check: PASS
runtimeKind=elf arch=x64 executable=yes
runtimeVersion=ok ...
configRoot=...
codexHome=...
```

Для macOS вместо `elf arch=x64` ожидается `macho arch=arm64`.

Warning про отсутствие `rg` не блокирует запуск Codex, но означает, что поиск по проекту может быть медленнее или чаще уходить в shell fallback.

## Типовые ошибки

`runtime --version failed to start: EACCES`

Runtime файл не исполняется текущим пользователем или каталог смонтирован с `noexec`. Проверить executable bit и mount options.

`runtime --version exited with code ...`

Файл запускается, но бинарник не подходит к системе или не хватает runtime-зависимостей. Для Linux x64 текущий ожидаемый бинарник должен быть ELF x64.

`configRoot is not writable and nearest existing parent is not writable`

Сервисный пользователь не может создать или записать config root. Нужно выбрать другой `--config-root` или попросить администратора создать каталог и выдать права этому пользователю.

`plugin root is not readable/searchable`

Element видит каталог `/plugins`, но сервисный пользователь не может прочитать или пройти по нему. Нужно исправить права на deploy-каталог.

`current platform differs from target`

Скрипт запущен не на целевой платформе. Это нормально для локального dry-run, но настоящий smoke нужно запускать на target host.

## Что этот smoke не проверяет

- Авторизацию ChatGPT/device code.
- Доступ к proxy.
- Полный `codex app-server` lifecycle.
- SELinux/AppArmor/systemd policy beyond обычных filesystem/process ошибок.
- Корректность работы Element UI.

Эти проверки идут следующим слоем после успешного Unix smoke.
