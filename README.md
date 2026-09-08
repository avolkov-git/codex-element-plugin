# Codex for 1C: Element

[![License](https://img.shields.io/badge/license-MIT-d68048?style=flat-square)](LICENSE)

Плагин для Theia IDE, который добавляет Codex в среду разработки 1C: Элемент. Runtime работает через поставляемый вместе с плагином [codex app-server](https://github.com/openai/codex).
Подробнее про `codex app-server` [тут](https://developers.openai.com/codex/app-server) и [тут](https://github.com/openai/codex/tree/main/codex-rs/app-server)

- Версия этой ветки: `1.0.0-rc`, кандидат для тестирования в 1C Element 9.2.4-6.
- Текущая версия Codex CLI/app-server: `0.153.4`
- Готовые поставки: Windows x64 и Linux x64
- Исходный проект также содержит runtime-матрицу для Windows, Linux и macOS на x64 и arm64
- [Релизы](https://github.com/avolkov-git/codex-element-plugin/releases)

Инструкции для этой сборки: [проверка и перенос данных RC](docs/1.0.0-rc-testing.md). Стабильная ветка `master` остается на 0.1.89.

## Возможности

### Чаты и выполнение задач

- Проектные и общие чаты с отдельной историей и настройками модели.
- Режимы доступа `Только чтение`, `Подтверждение` и `Полный доступ`.
- Режим планирования с уточняющими вопросами и карточкой готового плана.
- Остановка активного запроса, очередь сообщений и отправка рекомендации в текущий turn.
- Popup подтверждения для операций, которым требуется разрешение.
- Архивирование, восстановление и полное удаление чатов.
- Поиск по всей истории проекта, переход к сообщению и ответвление диалога.
- История пользователя IDE в рамках имени проекта, независимо от экземпляра приложения и пути workspace.

### Контекст

- Индекс проекта с поиском по файлам, чанкам и символам.
- Поиск по нормализованной документации и server docs.
- Правила проекта из `.local-codex/rules.md`.
- Базовые правила языка 1C: Element из поставки плагина.
- Контекст открытого файла, выделения и ошибок IDE (диагностик).

Контекст проекта используется в проектных чатах. В общем чате запросите его отдельно.

### Transcript

- Markdown, таблицы, блоки кода и подсветка XBSL/YAML (ограниченная).
- Ссылки на файлы workspace с переходом к строке и колонке.
- Сгруппированный журнал поисков, команд, чтения и изменений.
- Карточки diff с просмотром отдельных файлов и открытием нативного diff editor.
- Вложения из workspace, локального компьютера, drag-and-drop и буфера обмена.
- React-чат с виртуализацией, пакетными обновлениями и сохранением позиции при поступлении ответа.
- Просмотр полных Git-ревизий, комментарии, подготовка к коммиту и отмена выбранного изменения с проверкой актуальности файла.

### Интеграции

- Локальные STDIO и удаленные HTTP MCP-серверы.
- OAuth и bearer token через переменную окружения.
- Навыки Codex с включением для пользователя IDE и прикреплением к сообщению.
- Настраиваемый proxy для app-server и загрузки управляемых инструментов.
- Управляемый Playwright MCP с собственными Node.js и Chromium для проверки web-приложений с сервера Element.

## Установка

1. Откройте страницу [Releases](https://github.com/avolkov-git/codex-element-plugin/releases).
2. Выберите архив по операционной системе сервера Element:
   - Windows x64: `codex-plugins-1.0.0-rc-win32-x64.zip`;
   - Linux x64: `codex-plugins-1.0.0-rc-linux-x64.tar.gz`.
3. Сверьте SHA-256 с `SHA256SUMS.txt`.
4. Распакуйте архив.
5. Поместите каталог `codex-plugins` в каталог `/plugins` сервера Element.
6. Обновите страницу с открытой IDE.

Оба архива собраны из одного проекта и имеют одну версию плагина. Каждый архив содержит runtime только своей платформы, поэтому Windows-сервер не загружает Linux/macOS-бинарники, а Linux-сервер — Windows/macOS-бинарники. Администратору не нужно устанавливать Codex CLI в системный `PATH`.

## Первый запуск

1. Откройте Codex в activity bar.
2. Дождитесь проверки пользователя и проекта через Console Element, затем авторизуйтесь в Codex через Device Code или API key.
3. При закрытом сетевом контуре настройте proxy в `Codex: Настройки`.
4. Укажите каталог нормализованной документации, если сервер не предоставляет его сам.
5. Установите `ripgrep` из настроек, если его нет на сервере.

## Настройки

Откройте команду `Codex: Настройки`.

### Proxy

Плагин принимает HTTP proxy с хостом и портом. Логин и пароль хранятся вне webview. Proxy применяется к дочернему процессу app-server и к загрузке управляемого `ripgrep`.

### Документация

Поле нормализованной документации принимает legacy JSONL, manifest-based corpus, generic JSONL и каталоги с Markdown или текстовыми файлами. Плагин читает corpus при запросе, а не при activation.

### MCP-серверы

Настройки пользовательских MCP хранятся в `CODEX_HOME` подтвержденного пользователя IDE. Для bearer token укажите имя переменной окружения процесса Element. Не вводите значение токена в настройки плагина. Наименование сервера не должно содержать пробелы.

Если локальный 1C Element MCP доступен по `codexElement.elementMcpUrl`, плагин вне диалога передаёт ему временный
контекст текущей IDE: параметры Console, `1C.applicationId`, открытые workspace folders и безопасную часть результата штатной команды
`g5rt.team.status`. Репозиторные credentials и текст последнего commit не передаются. MCP сам находит
`Project.yaml`/`Проект.yaml`; когда проектов несколько, окончательный корень выбирает пользователь. По
`1C.applicationId` MCP может прочитать точную карточку опубликованного приложения, к которому привязана IDE.

### Навыки

Плагин получает список через `skills/list`. Переключатель задает доступность навыка. Composer прикрепляет выбранные навыки к следующему сообщению.

### Браузерное тестирование

Платформенная поставка включает официальный `@playwright/mcp`, Node.js и headless Chromium. В настройках укажите URL приложения, доступный с сервера Element, и разрешенные origins. Плагин хранит эти настройки для пользователя и проекта, а при запуске создает отдельную browser-сессию. Он задает временное имя MCP через параметры app-server и отключает прежнюю общую запись `codex-element-browser`. Отдельный порт, `npx`, системный Node.js и `sudo` не требуются.

Вызовы инструментов этого встроенного MCP подтверждаются автоматически без модального окна, но только для активного turn и точного имени управляемого сервера. Пользовательские MCP-серверы, команды и изменения файлов не получают это разрешение.

Это серверный браузер, а не вкладка пользователя: он не наследует cookies открытой IDE. Для приложений с отдельной авторизацией нужен тестовый вход, доступный из browser-сессии. Origin allowlist снижает риск случайных переходов, но не является полноценной границей безопасности. В контейнере без Chromium sandbox опцию его отключения необходимо включать явно.

### Ripgrep

Плагин может найти существующий `rg`, принять путь к нему или установить managed-копию в `<configRoot>/server/tools/ripgrep/`. Каталог инструмента добавляется в окружение app-server. Плагин не меняет системный `PATH` и не требует `sudo`.

## Данные и безопасность

Плагин хранит данные вне каталога установки. Порядок выбора config root:

1. `CODEX_ELEMENT_CONFIG_ROOT`.
2. Настройка `codexElement.configRoot`.
3. `%PROGRAMDATA%/CodexElement` на Windows.
4. `XDG_STATE_HOME`, `~/.local/state/codex-element` или другой user-writable каталог на Unix.
5. Global storage IDE.

История, `CODEX_HOME`, вложения и настройки лежат внутри config root. Пользователя IDE плагин проверяет через Console `/api/v2/me`. Имя и пространство проекта получает через `/api/v2/projects/{id}`. При недоступности этих данных он не выбирает произвольный старый профиль.

История хранится в `<configRoot>/users/<userKey>/projects/<projectKey>/chats.json`. Ключи учитывают сервер, пользователя, пространство и имя проекта. Приложение и путь workspace не определяют каталог истории. Плагин сохраняет резервную копию `.bak`, отказывается перезаписывать поврежденную историю и сохраняет конкурирующую правку одного чата в отдельный `.conflict-*.json`.

Для переноса истории 0.1.89 администратор подтверждает владельца и проект, затем подготавливает архив скриптом `scripts/export-legacy-history.js`. Перенос доступен в панели истории; [порядок переноса и откат](docs/1.0.0-rc-testing.md). Одного совпадения логина недостаточно.

Локальные файлы из браузерной части IDE передаются чанками в `attachments/<chatId>/` внутри каталога пользователя и проекта. Плагин принимает до 10 вложений на сообщение, до 50 МБ на файл и до 20 МБ на изображение. Удаление чата очищает его managed-вложения.

Имена каталогов не заменяют ACL сервера: процессы с одним OS-пользователем могут иметь доступ ко всем его файлам. Для недоверенных арендаторов администратор должен разделить процессы и права хранения. Плагин не переносит учетные данные из старых произвольных профилей.

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

Extension host написан на TypeScript. Исходники чата находятся в `webview/chat/` (React/TypeScript); сборка включает зависимости в локальный `media/chat.js`. CDN и отдельный frontend-сервер не нужны.

```bash
npm ci
npm run build
npm run check
```

Дополнительные проверки:

```bash
npm run check:markdown-links
npm run check:transcript-window
npm run check:history
npm run check:identity
npm run check:chat-ui
node scripts/rc-runtime-check.js
node scripts/rc-features-check.js
node --test tests/service-reliability.test.cjs tests/browser-highlighter.test.cjs
npm run eval:context
node --check media/chat.js
node --check media/sidebar.js
node --check media/settings.js
git diff --check
```

UI-тесты запускают установленный Chrome. Для поставляемого Playwright Chromium выполните `npx playwright install chromium` и задайте `CODEX_TEST_BROWSER_CHANNEL=bundled`. Workflow `rc-quality.yml` проверяет чат и хранение истории при push/PR; скриншоты и метрики сохраняются в artifact. Проверка точной оболочки Element требует пути `ELEMENT_WEBVIEW_PRE` к каталогу `ide/theia/products/browser-app/lib/webview/pre` установленного бандла. Без него этот отдельный тест пропускается.

Основные каталоги:

```text
src/        extension host и сервисы
webview/    React-чат и worker подсветки
media/      собранные webview assets, sidebar и настройки
dist/       результат TypeScript build
resources/  иконки и базовый контекст
scripts/    preflight, staging, smoke и fixture checks
docs/       протокол и эксплуатационные инструкции
bin/        platform runtime
```

## Runtime и Git LFS

Плагин ожидает Codex CLI/app-server `0.153.4` для каждой платформы:

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
node scripts/stage-deploy-payload.js --target ../codex-plugin-deploy-1.0.0-rc/win32-x64/codex-plugins --platform win32-x64 --platform-only --browser-runtime-root ../local-codex-temp/browser-runtime --strict
```

Для RC используйте отдельный target. Обычные команды ниже работают со стабильным каталогом `../codex-plugin-deploy`; не запускайте их из RC-ветки при подготовке тестовой поставки:

```bash
npm run deploy:stage
npm run deploy:stage:strict
npm run preflight:deploy
```

## Сборка platform-specific релизов

Один исходный проект выпускается двумя архивами с общей версией:

```bash
npm run build
node scripts/package-platform-releases.js --output ../codex-plugin-release/1.0.0-rc --browser-runtime-root ../local-codex-temp/browser-runtime
```

Перед локальной platform-specific упаковкой подготовьте browser runtime на целевой ОС. Кросс-компиляция browser runtime не поддерживается: Windows payload собирается на Windows, Linux payload — на Linux.

```bash
node scripts/prepare-browser-runtime.js --root ../codex-browser-runtime --platform linux-x64
node scripts/package-platform-releases.js \
  --platform linux-x64 \
  --browser-runtime-root ../codex-browser-runtime
```

GitHub Actions делает это матрицей на `windows-latest` и `ubuntu-latest`, затем объединяет архивы, checksums и release notes.

Команда собирает и повторно распаковывает оба архива, запускает строгий preflight и создает в указанном `--output`:

```text
codex-plugins-1.0.0-rc-win32-x64.zip
codex-plugins-1.0.0-rc-linux-x64.tar.gz
SHA256SUMS.txt
README_RELEASE.md
```

Внутри каждого архива находится каталог `codex-plugins`. Проверка `--platform-only` запрещает попадание runtime другой операционной системы в platform-specific поставку.

### Автоматический выпуск

Workflow `.github/workflows/release-platforms.yml` использует ту же команду упаковки. Ручной запуск workflow создает проверяемый artifact без публикации. Push тега, совпадающего с версией `package.json`, например `v0.1.87`, автоматически создает GitHub Release и прикладывает оба архива, `SHA256SUMS.txt` и `README_RELEASE.md`.

CI загружает из Git LFS только `win32-x64` и `linux-x64`. Остальная runtime-матрица не скачивается для этого релиза.

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

- [Контракт Codex app-server 0.153.4 и проверка совместимости](docs/app-server-0.153.4.md)
- [Unix smoke checklist](docs/unix-smoke-checklist.md)

Проект распространяется по [лицензии MIT](LICENSE). Copyright (c) 2026 Alexandr Volkov.
