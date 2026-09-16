# Browser Testing Runtime

## Цель

Дать Codex возможность проверять web-приложения 1C: Element из того же серверного окружения, где работают plugin host и `codex app-server`. Browser runtime входит в платформенную поставку и не зависит от программ, установленных системным администратором.

## Состав

Каждый release-архив содержит только runtime своей платформы:

```text
browser/<platform>/
  runtime.json
  node/
  node_modules/@playwright/mcp/
  browsers/
```

`runtime.json` фиксирует версии и относительные пути к bundled Node.js, Playwright MCP launcher и Chromium. Strict deploy preflight проверяет manifest, наличие файлов, отсутствие Git LFS pointers и executable bit на Linux.

## Выполнение

Плагин задаёт временный MCP-сервер `codex-element-browser-<случайный идентификатор>` параметрами запуска app-server. Его конфигурация не сохраняется в общем профиле. Транспорт: локальный stdio.

```text
codex app-server -> bundled Node.js -> @playwright/mcp -> bundled Chromium
```

HTTP/SSE port не открывается. Chromium работает headless в isolated context. URL приложения открывается через `initPage`; артефакты сохраняются в каталоге `sessions/<сеанс>/browser/artifacts` внутри подтверждённой области пользователя и проекта, с ограничением общего размера.

### Приложение IDE

`ElementApplicationService` повторяет чтение адреса из `PaasClient.getApplicationInfo` бандла Element 9.2.4-6. Настройки `1C.server`, `1C.clientId`, `1C.clientSecret` задают подключение к Console; `1C.applicationId` определяет приложение. Плагин вызывает `GET /console/api/v2/applications/<id>` и использует поле `uri`. Внешний адрес IDE берётся через `com.e1c.g5rt.getCurrentPageLocation` и передаётся в `X-Forwarded-Host` / `X-Forwarded-Proto`, как в бандле. Если команда отсутствует, используются явная настройка `1C.serverExternalUri` или адрес Console. Команда открытия/публикации приложения не вызывается, внешний MCP не нужен.

Запросы выполняются при открытии настроек, сохранении включённого браузера и запуске runtime с включённым браузером, не при активации плагина. Изменения пользователя, сервера, проекта или приложения сбрасывают кэш; запоздалый ответ не может вернуть старое приложение. Привязка истории по пользователю, пространству и имени проекта не меняется. В файле `browser-settings.json` версии 2 сохраняются только `enabled` и `disableSandbox`; старые `baseUrl` и `allowedOrigins` игнорируются.

### Разрешения MCP

Tool-вызовы управляемого браузера подтверждаются плагином автоматически и не создают approval modal. Авторазрешение действует только при одновременном выполнении всех условий:

- имя сервера точно совпадает с временным именем текущего управляемого браузера;
- app-server пометил elicitation как `mcp_tool_call`;
- запрос не содержит интерактивных полей;
- `threadId` и `turnId` совпадают с активным видимым turn незархивированного чата.

Сторонние MCP-серверы, интерактивные elicitation-формы, shell-команды и изменения файлов этой политикой не подтверждаются. При невозможности надежно связать запрос с активным turn действует fail-closed отказ.

## Сетевая модель

Браузер видит сеть сервера Element. По решению владельца продукта плагин не задаёт `network.allowedOrigins` или `network.blockedOrigins` и не ограничивает пути. Доступны все вложенные страницы приложения, его внешние ресурсы и любые другие адреса, доступные с сервера. Автоматический URL приложения задаёт только стартовую страницу. Сетевая изоляция и права доступа настраиваются администраторами окружения; Chromium sandbox этой правкой не отключается.

## Контейнеры

Предпочтителен включенный Chromium sandbox. Если контейнер не предоставляет необходимые kernel capabilities/user namespaces, администратор может явно включить `Отключить Chromium sandbox`. Эта настройка добавляет `--no-sandbox` и `--disable-setuid-sandbox` и должна использоваться только для изолированного контейнера без доступа к чувствительным сетям.

## Авторизация приложения

Server-side browser не использует cookies пользовательской вкладки IDE. Для приложения, требующего входа, нужен один из вариантов:

- тестовая учетная запись и обычный login flow, выполняемый Codex;
- отдельный тестовый endpoint или одноразовая ссылка;
- в будущем — управляемый `storageState`, хранящийся в config root вне plugin payload.

Секреты нельзя помещать в settings, transcript или MCP arguments.

## Release

Browser runtime нельзя корректно собрать для другой ОС. Workflow использует отдельные Windows и Linux jobs:

1. Загружает Codex binary нужной платформы через Git LFS.
2. Устанавливает pinned `@playwright/mcp` и Chromium.
3. Копирует Node.js runner в browser payload.
4. Запускает Chromium smoke test; проверка из настроек также реально открывает локальную test-page и выявляет недостающие библиотеки, `noexec` и sandbox-ошибки.
5. Запускает strict staging/preflight.
6. Повторно распаковывает архив и проверяет payload.
7. Объединяет platform artifacts и рассчитывает SHA-256.

Версия Playwright MCP pinned в `scripts/prepare-browser-runtime.js`; обновление требует отдельной сборки и smoke test на обеих целевых ОС.
