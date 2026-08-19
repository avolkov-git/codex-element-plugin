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

Плагин регистрирует MCP-сервер `codex-element-browser` в профиле Codex. Транспорт — локальный stdio:

```text
codex app-server -> bundled Node.js -> @playwright/mcp -> bundled Chromium
```

HTTP/SSE port не открывается. Chromium работает headless и по умолчанию в isolated context. URL приложения открывается через `initPage`; artifacts сохраняются в `<configRoot>/browser/artifacts` с ограничением общего размера.

### Разрешения MCP

Tool-вызовы управляемого сервера `codex-element-browser` подтверждаются плагином автоматически и не создают approval modal. Авторазрешение действует только при одновременном выполнении всех условий:

- имя сервера точно равно `codex-element-browser`;
- app-server пометил elicitation как `mcp_tool_call`;
- запрос не содержит интерактивных полей;
- `threadId` и `turnId` совпадают с активным видимым turn незархивированного чата.

Сторонние MCP-серверы, интерактивные elicitation-формы, shell-команды и изменения файлов этой политикой не подтверждаются. При невозможности надежно связать запрос с активным turn действует fail-closed отказ.

## Сетевая модель

Браузер видит сеть сервера Element. Поэтому для удаленной IDE URL вида `http://public-host:9090/applications/...` можно заменить на внутренний адрес, если он доступен из контейнера или host namespace. Проверять нужно маршрут из процесса сервера, а не из пользовательского браузера.

Allowed origins ограничивают обычные запросы browser-сессии. По документации Playwright MCP это guardrail, а не security boundary и не защита от redirects. Реальной границей остаются сеть, учетная запись тестового приложения и права процесса Element.

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
