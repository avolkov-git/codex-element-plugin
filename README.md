# Codex for 1C: Element

[![License](https://img.shields.io/badge/license-MIT-d68048?style=flat-square)](LICENSE)

Плагин для Theia IDE, который добавляет Codex в среду разработки 1C: Элемент. Runtime работает через поставляемый вместе с плагином [codex app-server](https://github.com/openai/codex).
Подробнее про `codex app-server` [тут](https://developers.openai.com/codex/app-server) и [тут](https://github.com/openai/codex/tree/main/codex-rs/app-server)

- Текущая версия плагина: `0.1.79`
- Текущая версия Codex CLI/app-server: `0.144.5`
- Поддерживаемые платформы: Windows, Linux и macOS на x64 и arm64
- [Релизы](https://github.com/avolkov-git/codex-element-plugin/releases)

## Возможности

### Чаты и выполнение задач

- Проектные и общие чаты с отдельной историей и настройками модели.
- Режимы доступа `Только чтение`, `Подтверждение` и `Полный доступ`.
- Режим планирования с уточняющими вопросами и карточкой готового плана.
- Остановка активного запроса, очередь сообщений и отправка рекомендации в текущий turn.
- Popup подтверждения для операций, которым требуется разрешение.
- Архивирование, восстановление и полное удаление чатов.

### Контекст

- Индекс проекта с поиском по файлам, чанкам и символам.
- Поиск по нормализованной документации и server docs.
- Правила проекта из `.local-codex/rules.md`.
- Базовые правила языка 1C: Element из поставки плагина.
- Контекст открытого файла, выделения и ошибок IDE (диагностик).

Контекст проекта используется только в проектных чатах, для использования в общем чате надо явно запросить полечение проектного контекста. 

### Transcript

- Markdown, таблицы, блоки кода и подсветка XBSL/YAML (ограниченная).
- Ссылки на файлы workspace с переходом к строке и колонке.
- Сгруппированный журнал поисков, команд, чтения и изменений.
- Карточки diff с просмотром отдельных файлов и открытием нативного diff editor.
- Вложения из workspace, локального компьютера, drag-and-drop и буфера обмена.

### Интеграции

- Локальные STDIO и удаленные HTTP MCP-серверы.
- OAuth и bearer token через переменную окружения.
- Навыки Codex с включением на уровне профиля и прикреплением к сообщению.
- Настраиваемый proxy для app-server и загрузки управляемых инструментов.

## Установка

1. Откройте страницу [Releases](https://github.com/avolkov-git/codex-element-plugin/releases).
2. Загрузите `codex-plugins-<version>.zip` или `codex-plugins-<version>.tar.gz`.
3. Сверьте SHA-256 с `SHA256SUMS.txt`.
4. Распакуйте архив.
5. Поместите каталог `codex-plugins` в каталог `/plugins` сервера Element.
6. Обновите страницу с открытой IDE.

Release-архив содержит runtime для всех поддерживаемых платформ. Администратору не нужно устанавливать Codex CLI в системный `PATH`.

## Первый запуск

1. Откройте Codex в activity bar.
2. Авторизуйтесь через Device Code.
3. При закрытом сетевом контуре настройте proxy в `Codex: Настройки`.
4. Укажите каталог нормализованной документации, если сервер не предоставляет его сам.
5. Для быстрого извлечения текста из документов можно установить `ripgrep` непосредственно из настроект.

## Настройки

Откройте команду `Codex: Настройки`.

### Proxy

Плагин принимает HTTP proxy с хостом и портом. Логин и пароль хранятся вне webview. Proxy применяется к дочернему процессу app-server и к загрузке управляемого `ripgrep`.

### Документация

Поле нормализованной документации принимает legacy JSONL, manifest-based corpus, generic JSONL и каталоги с Markdown или текстовыми файлами. Плагин читает corpus при запросе, а не при activation.

### MCP-серверы

Настройки MCP хранятся на уровне профиля. Для bearer token укажите имя переменной окружения процесса Element. Не вводите значение токена в настройки плагина. Наименование сервера не должно содержать пробелы.

### Навыки

Плагин получает список через `skills/list`. Переключатель задает доступность навыка. Composer прикрепляет выбранные навыки к следующему сообщению.

### Ripgrep

Плагин может найти существующий `rg`, принять путь к нему или установить managed-копию в `<configRoot>/server/tools/ripgrep/`. Каталог инструмента добавляется в окружение app-server. Плагин не меняет системный `PATH` и не требует `sudo`.

## Данные и безопасность

Плагин хранит данные вне каталога установки. Порядок выбора config root:

1. `CODEX_ELEMENT_CONFIG_ROOT`.
2. Настройка `codexElement.configRoot`.
3. `%PROGRAMDATA%/CodexElement` на Windows.
4. `XDG_STATE_HOME`, `~/.local/state/codex-element` или другой user-writable каталог на Unix.
5. Global storage IDE.

Профили, история, `CODEX_HOME`, вложения и настройки лежат внутри config root. Секреты proxy и авторизации не попадают в transcript. Плагин не пишет содержимое проекта, документации или диагностик в `Output: Codex`.

Локальные файлы из браузерной части IDE передаются чанками и сохраняются в `<configRoot>/attachments/<chatId>/`. Плагин принимает до 10 вложений на сообщение, до 50 МБ на файл и до 20 МБ на изображение. Удаление чата очищает его managed-вложения.

## Команды

| Команда | Назначение |
| --- | --- |
| `Codex: Открыть` | Открыть панель Codex |
| `Codex: Новый проектный чат` | Создать чат с проектным контекстом |
| `Codex: Новый общий чат` | Создать чат без автоматического контекста проекта |
| `Codex: Настройки` | Открыть настройки proxy, документации, MCP, навыков и инструментов |
| `Codex: Открыть правила проекта` | Создать или открыть `.local-codex/rules.md` |
| `Codex: Логи` | Открыть `Output: Codex` |
| `Codex: Открыть папку логов` | Открыть каталог файловых логов |
| `Codex: Экспортировать логи в workspace` | Скопировать логи в workspace для диагностики |
| `Codex: Проверить возможности app-server` | Запустить capability probe |
| `Объяснить файл` | Отправить активный файл в проектный чат |
| `Объяснить выделенный фрагмент` | Отправить выделенный код в проектный чат |

## Разработка

Плагин использует TypeScript для extension host и JavaScript/CSS для webview.

```bash
npm install
npm run check
npm run build
```

Дополнительные проверки:

```bash
npm run check:markdown-links
npm run check:transcript-window
npm run eval:context
node --check media/chat.js
node --check media/sidebar.js
node --check media/settings.js
git diff --check
```

Основные каталоги:

```text
src/        extension host и сервисы
media/      webview UI
dist/       результат TypeScript build
resources/  иконки и базовый контекст
scripts/    preflight, staging, smoke и fixture checks
docs/       протокол и эксплуатационные инструкции
bin/        platform runtime
```

## Runtime и Git LFS

Плагин ожидает Codex CLI/app-server `0.144.5` для каждой платформы:

```text
bin/
  win32-x64/codex.exe
  win32-arm64/codex.exe
  linux-x64/codex
  linux-arm64/codex
  darwin-x64/codex
  darwin-arm64/codex
```

Git хранит runtime через LFS. Рабочая копия без загруженного LFS-объекта содержит pointer длиной около 130 байт. Такой файл нельзя запускать или включать в release.

Проверьте runtime перед поставкой:

```bash
npm run preflight:runtime
npm run preflight:runtime:release
```

Legacy layout для старых Windows, Linux и macOS сборок поддерживается как источник staging. Release использует canonical layout из списка выше.

## Сборка deploy-каталога

Не копируйте рабочий Git-каталог в `/plugins`. Соберите payload без `.git`, `node_modules`, временных файлов и LFS pointers:

```bash
npm run deploy:stage:release
npm run preflight:deploy:release
```

Плагин создаст соседний каталог `../codex-plugin-deploy`. Для одной платформы доступны команды:

```bash
npm run deploy:stage
npm run deploy:stage:strict
npm run preflight:deploy
```

Передать отдельный каталог runtime можно через `--runtime-root`:

```bash
node scripts/stage-deploy-payload.js \
  --target ../codex-plugin-deploy \
  --platform linux-x64 \
  --runtime-root /path/to/runtime-root \
  --strict
```

Unix runtime должен иметь executable bit:

```bash
chmod 755 bin/linux-x64/codex
chmod 755 bin/linux-arm64/codex
chmod 755 bin/darwin-x64/codex
chmod 755 bin/darwin-arm64/codex
```

## Проверка Unix-поставки

Dry-run проверяет пути, переменные окружения и права без запуска runtime:

```bash
node scripts/simulate-runtime-env.js \
  --platform linux-x64 \
  --service-user \
  --empty-env \
  --plugin-root /path/to/staged/plugin \
  --config-root /var/lib/codex-element
```

Smoke-check запускает runtime и проверяет config root, `CODEX_HOME`, `HOME`, `XDG_*`, cwd и `rg`:

```bash
node scripts/unix-smoke-check.js \
  --platform linux-x64 \
  --plugin-root /path/to/element/plugins/codex-plugins \
  --config-root /var/lib/codex-element \
  --workspace-root /path/to/workspace
```

Checklist: [docs/unix-smoke-checklist.md](docs/unix-smoke-checklist.md).

## Диагностика

### `spawn UNKNOWN` или runtime не запускается

Проверьте размер и формат `bin/<platform>/codex`. Git LFS pointer не содержит executable-код. Запустите:

```bash
npm run preflight:runtime
```

На Unix проверьте executable bit, writable config root и отсутствие `noexec` на mount.

### Авторизация пропала после перезапуска IDE

Откройте sidebar Codex. Плагин запускает runtime для проверки account state при открытии sidebar или при отправке сообщения. Проверьте права системного пользователя на `<configRoot>/users/<profileId>/codex-home`.

### Codex сообщает, что `rg` не установлен

Откройте `Codex: Настройки`, укажите путь к `rg` или нажмите `Установить`. После изменения плагин перезапустит app-server с обновленным `PATH`.

### Нужны логи

Используйте `Codex: Логи` или `Codex: Экспортировать логи в workspace`. Файловое логирование пишет в `<configRoot>/logs`.

## Документация

- [Контракт Codex app-server 0.144.5](docs/app-server-0.144.5.md)
- [Unix smoke checklist](docs/unix-smoke-checklist.md)

Проект распространяется по [лицензии MIT](LICENSE). Copyright (c) 2026 Alexandr Volkov.
