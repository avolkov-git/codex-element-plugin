# Реализуемость ревью в бандле 1С:Элемента

Дата: 2026-09-08. Плагин: `0.1.89`, текущее рабочее дерево обновления app-server до `0.153.4`.

## Цель и границы

Проверить предложения из [ревью плагина](2026-09-08-plugin-review.md) именно для поставки `/Users/aleksandrvolkov/Downloads/server-package-with-ide-9.2.4-6`, а не для произвольного VS Code, обычной Theia или Codex Desktop.

Наш продукт остается расширением внутри бандла 1С:Элемента. Extension host, app-server, MCP и файлы проекта находятся на сервере; webview исполняется в браузере пользователя. React не превращает плагин в отдельное приложение и не переносит серверные файлы/процессы на клиент.

Это анализ и изолированная проверка оболочки webview. Production-код, версия, бинарники, deploy и release не изменялись. Бандл не модифицировался. Полный сервер Element не запускался; его Linux-бинарники не запускались на macOS. Установленные у пользователя Windows-экземпляр, права, proxy и HTTP-заголовки не проверялись.

## Вывод

Основные исправления чата и переход на React выполнимы внутри плагина без пересборки бандла. Но перенос всех предложений Desktop без адаптации неверен:

- project actions нельзя безусловно реализовать через обычный терминал/Tasks;
- Worker и webview assets должны работать без обязательного Service Worker и CDN;
- Git-команды бандла имеют дополнительные побочные действия;
- отдельный Git worktree не становится полноценным workspace Element;
- надежную многопользовательскую изоляцию нельзя получить из имени каталога или произвольного имени профиля.

Исправление зависаний при scroll + streaming не заблокировано бандлом. Воспроизведенная замена scroll container происходит в нашем renderer. При этом подтормаживания самого браузера, канала связи и сервера требуют отдельных измерений.

## Фактическая платформа

| Компонент | Что установлено по файлам | Значение для проекта |
|---|---|---|
| Поставка | Каталог `server-package-with-ide-9.2.4-6`; внутренний `browser-app/package.json` имеет версию `9.2.4-1` | Номер внутреннего npm-пакета не подменяет версию всей поставки |
| Theia | Зависимости `@theia/*` закреплены на `1.59.110`, target `browser`; есть расширения `@g5rt-webide/*` | Нельзя переносить предположения о стандартной Theia без проверки |
| VS Code API | `plugin-vscode-init.js`: default supported API `1.97.2`, возможен env override | Наш `engines.vscode: ^1.97.0` укладывается в объявленную базу; это не гарантия реализации каждого API |
| Серверный Node | Заголовок поставляемого Node: `22.13.1` | Не путать с отдельно поставляемым Node для Playwright. Самостоятельно заменять Node бандла не требуется |
| Webview | `createWebviewPanel`, `postMessage`, `asWebviewUri`, `getState/setState`, retention/serializer реализованы | Можно сохранить существующую границу плагин/webview |
| Редактор | Monaco, `vscode.diff`, document content providers, comments API | Есть основа для просмотра изменений и комментариев без собственного Monaco в чате |
| Управление процессами | Собственный `ElementProcessManager` | Наличие terminal/task API в декларациях не означает разрешение его использования в данном режиме |

Собственный React нужно включить в наш browser bundle. Использовать React, Monaco или DI-контейнер из `globalThis.theia` как зависимость плагина не следует: это внутреннее устройство поставки, а не стабильный plugin API.

## Сопоставление F01-F11

Обозначения совпадают с исходным ревью. «Можно» означает отсутствие найденного архитектурного запрета, а не уже выполненное исправление.

| Пункт | Вердикт | Условия реализации в Element |
|---|---|---|
| F01: scroll/stream, замена DOM | Можно внутри плагина | Стабильный контейнер, обновление сущностей по ID, независимость live data и follow-bottom. Сначала исправить текущий renderer |
| F02: защита истории после ошибки load | Можно внутри плагина | Собственные backup/recovery и запрет перезаписи поврежденного файла; writable server storage; тест конкурирующих IDE |
| F03: чтение целых бинарников | Можно внутри плагина | Ограниченное async-чтение заголовка и cache; не создавать дополнительный процесс для каждой проверки UI |
| F04: чужой профиль | Частично локально, полная гарантия зависит от сервера | Удалить автоматический выбор единственного профиля можно сразу. Trusted identity и доступ к общему хранилищу требуют отдельного контракта |
| F05: snapshot на каждый delta | Можно внутри плагина | JSON patch protocol поверх существующего `postMessage`, batching, revisions, resync; не менять RPC самой Theia |
| F06: streaming-ссылки | Можно внутри плагина | Делегирование событий/React handlers; открытие остается через серверный IDE opener |
| F07: turn на границе страницы | Можно внутри плагина | Parent metadata отдельно от страницы, стабильные presentation IDs и отдельная загрузка children |
| F08: stop lifecycle | Можно внутри плагина, нужны OS-тесты | Ждать exit/close, учитывать поколение процесса; завершать только созданные нами процессы. Очистка дерева Windows/Linux проверяется отдельно |
| F09: подсветка на UI-потоке | Можно с адаптацией загрузки | Self-contained Worker из доверенного bundled-кода, узкий CSP, bounded fallback; не зависеть от загрузки worker-файла по `asWebviewUri` |
| F10: native runtime questions | Можно внутри плагина | Собственный typed UI и обработчик app-server request; не требует нового Theia AI/chat API |
| F11: approval/focus | Можно внутри плагина | Фокус и клавиатурная навигация в нашем iframe, недоступный фон, возврат фокуса; проверить переключение между webview и редактором |

## Поправки к архитектуре UI

### HTTP, ресурсы и Worker

Внешний iframe создается с sandbox `allow-scripts allow-forms allow-same-origin allow-downloads`. Внутренний iframe также поддерживает scripts и same-origin. Оболочка вставляет `acquireVsCodeApi`, передает theme variables и сообщения.

`asWebviewUri` для серверного плагина ведет к `/webview/theia-resource/...`. В поставленной реализации `host.js` регистрирует Service Worker, который перехватывает этот путь и запрашивает файл у Theia через сообщения. `WebviewWidget.loadResource()` проверяет `localResourceRoots`, читает ресурс и отправляет содержимое обратно. Это не обычная раздача файлов плагина с диска клиента.

В небезопасном HTTP-контексте браузера Service Worker недоступен. `host.js` явно сообщает об этом, но разрешает загрузить HTML. Поэтому наш inline fallback важен, а удаление его при React-миграции может оставить пустую панель. У текущего fallback есть отдельный пробел: он включает основной script/style, но не `preloadScriptPaths` highlighter.

Изолированный тест с настоящими `index.html`, `main.js`, `host.js`, `fake.html` бандла на HTTP-origin подтвердил:

| Проверка | Результат |
|---|---|
| `isSecureContext`, `navigator.serviceWorker` | `false`, недоступен |
| Inline script и сообщение через `acquireVsCodeApi` | Работают |
| External resource через `/webview/theia-resource/...` без SW | Не загружается в тестовой оболочке |
| Blob Worker при политике, эквивалентной нынешней CSP плагина | Блокируется |
| Тот же self-contained Blob Worker с `worker-src blob:` | Запускается и отвечает |

Это Dedicated Worker, не Service Worker. Тест доказывает возможность такого механизма в оболочке, но не проверяет полный Shiki/React bundle. Использован native Chrome `152.0.7977.76`, сетевые ответы оболочки предоставлены локальными Playwright routes; полноценный backend/proxy Element не эмулировался. Произвольные дополнительные заголовки сервера могут накладывать более строгую CSP.

Требования к React-срезу:

1. Локальная browser-сборка без SSR, дополнительного порта и CDN. Базовый entry point самодостаточен, без обязательных dynamic imports.
2. Одинаково полный набор зависимостей в external и inline путях, включая подсветку. Один bootstrap с защитой от двойного mount при позднем завершении external load.
3. Для Worker встроить доверенный код из поставки, без `eval`, сетевых `importScripts` и загрузки произвольного пользовательского JS. Blob URL освобождать, Worker завершать при dispose. CSP расширять только для нужного механизма.
4. Если Worker запрещен/упал, чат остается рабочим: throttling, byte-budget cache, ограничение размера подсвечиваемого блока. Отсутствие Worker не должно блокировать текст ответа.
5. HTTP и HTTPS, внешний reverse-proxy prefix, reconnect и fallback должны входить в acceptance. Не устанавливать HTTPS как внезапное обязательное условие уже работающего HTTP-плагина; при этом HTTPS предпочтителен для защищенной эксплуатации.

### Обмен данными и прокрутка

Штатный маршрут проходит через plugin RPC, frontend Theia, внешний iframe и внутренний iframe. Оптимизация количества/размера сообщений особенно полезна для удаленной IDE. `postMessage` сам по себе не является подтверждением применения patch нашим renderer или сохранения данных на диск.

Версии, `chatId`, `panelId`, epoch, sequence и ACK/resync реализуются нашим протоколом поверх Theia. Не следует полагаться на transfer lists, SharedArrayBuffer, zero-copy или доступ к родительскому DOM. Для управления потоком достаточно JSON и ограниченной очереди сообщений; body больших артефактов выдавать по запросу.

TanStack Virtual остается кандидатом, не обязательной зависимостью. Проверяем в реальном webview измерения высот, scroll anchoring, изменение ширины split-panel, streaming, раскрытие worklog/diff и возврат из скрытой панели. Пока пользователь выделяет текст, нельзя безусловно удалять выбранные узлы из виртуального окна. Измерять нужно viewport внутри iframe, а не окно всей IDE.

React не исправляет автоматически лишние snapshots или повторную токенизацию. Переход на него обоснован сопровождением компонентов; F01/F05 нужно исправлять на уровне данных и жизненного цикла.

## Возможности Desktop с поправкой на Element

| Возможность | Решение |
|---|---|
| React chat, queue/steer, вопросы, поиск по истории | Реализовать внутри плагина. Не использовать отсутствующий либо более новый VS Code Chat API вместо собственного app-server bridge |
| Native diff и комментарии | Реализуемы. `vscode.diff` есть; штатный плагин 1С уже использует `vscode.comments.createCommentController`. Нужны полные before/after snapshots и привязка к ревизии; UI комментария сам по себе не отправляет его Codex |
| Stage/revert | Отдельный проектный контракт: индекс Git, несохраненные редакторы, ревизия/хеш, конкурентные изменения. Не опираться на patch fragments и не переиспользовать похожую команду без проверки побочных действий |
| Открыть приложение/проверить проект | Через capability-checked адаптер штатных команд Element и readiness LSP. Не любой shell task и не прямой вызов внутренних frontend-сервисов |
| Screenshot/console/network artifacts | Реализуемы через контролируемые серверные ID, ограниченные preview и загрузку по запросу. На HTTP предусмотреть небольшой data/blob preview; не рассчитывать только на `asWebviewUri` |
| Разветвление диалога | Возможно при поддержке app-server contract, но не изолирует файлы, LSP и приложение |
| Полноценные независимые worktrees/параллельные IDE | Пока исследовательский этап. Требует проверки provisioning/sync/LSP/публикации Element, а не только Git и UI |

### Терминал и project actions

В `ElementProcessManager.register()` normal mode не разрешает terminal-процессы, если executor не включен. Raw-процессы через этот менеджер ограничены каталогом webide. Advanced mode имеет другое поведение. В web-конфигурации executor по умолчанию выключен, если это не переопределено окружением/аргументами.

Поэтому мое общее предложение «project actions как в Desktop через встроенный терминал» нельзя считать готовым решением для этой поставки. Наличие `@theia/terminal` и `@theia/task` не отменяет ограничения 1С.

Наш уже работающий app-server запускается другим существующим путем, через Node extension host. Это не повод обходить ограничения режима IDE для любых новых команд. Новые действия должны соответствовать разрешенной модели запуска, правам системного пользователя и политике оператора. Не менять автоматически режим Element, не требовать sudo и не подменять серверный Node.

В штатном плагине найдены команды `com.e1c.g5rt.lsp.request`, `com.e1c.g5rt.lsp.notify`, `com.e1c.g5rt.lsp.clean`. `ApplicationLauncher` использует `g5rt.commands.applicationMenu.openApplication`. Проверять `commands.getCommands()`, параметры и состояние текущего проекта; наличие строки команды не доказывает успешность любого ее вызова.

Особенность `VSCodeLspServerDispatcher.isReady()`: ожидание через polling 200 мс без встроенного timeout. Наш адаптер должен ограничивать ожидание и отличать «LSP не готов» от «проверка успешна». Нельзя отменой нашего ожидания гарантировать отмену уже переданного запроса. Не перехватывать глобальные обработчики build/GLSP штатной IDE ради подписки плагина.

### Git и жизненный цикл workspace

`ElementDugiteGit.branch()` после создания ветки делает push с upstream. После переименования пушит новое имя и может удалить прежнее удаленное имя. `deleteBranch()` также охватывает удаленную ветку. Значит, кнопка «создать локальную ветку» не должна вслепую вызывать штатную обертку.

Рабочая область управляется сервером: есть `maintenance/workspace/initialize`, synchronize/deconfigure, настройки `ideId`, project/application, собственная архивация и восстановление. `WorkspaceUploadRule` включает каталоги `workspace` и `.settings`. LSP использует metadata-каталог; штатный `WorkspaceStateWatcher` опирается на первый workspace folder и смотрит `**/*`.

Следствия:

- Простой `git worktree add` не подтверждает поддержку второй независимой IDE, сборки или публикации. Нужны отдельная регистрация и жизненный цикл, если они предусмотрены сервером.
- Журналы, Chromium profiles, тяжелые артефакты и временные checkout нельзя бездумно размещать в отслеживаемом дереве проекта. Это добавляет события watcher и может попасть в синхронизацию соответствующего каталога.
- Автоматически переключать workspace или ветку активной IDE ради параллельной задачи нельзя. Fork диалога и изоляция файлов должны быть разными возможностями.

### Профили и надежность хранения

В исследованном JS plugin host/frontend не найдено штатного предоставления тех переменных `ELEMENT_USER_ID`/`THEIA_USER_ID`, на которые рассчитывает наш fallback. Это не доказывает, что внешний launcher пользователя их никогда не задает. У maintenance есть серверный `user-id`, у frontend есть devcol user model; ни то ни другое не является автоматически доступным trusted current-user API для нашего плагина. `1C.clientId`, `clientSecret`, project ID и Git author нельзя считать ID вошедшего человека.

Убрать опасный выбор единственного каталога можно без изменения бандла. При неизвестном пользователе нужен отдельный непротиворечивый namespace экземпляра IDE, без автоматического доступа к ранее найденному общему профилю. Для общего профиля между IDE нужен подтвержденный сервером пользователь. Имена профилей и hash пути не обеспечивают изоляцию от другого процесса с теми же OS-правами; это граница ответственности сервера/ACL, а не React.

`globalState` в поставленном `PluginsKeyValueStorage` записывается через очередь: `set()` меняет память, periodic sync имеет интервал 60-70 секунд. Это дополнительная причина не считать успешный `globalState.update()` гарантией немедленной записи критического выбора профиля/очереди. `getState/setState` webview тем более не заменяют долговременное хранилище истории.

Предложение по durability сохраняется: собственная политика загрузки/backup/сохранения в разрешенном server storage, bounded writes, защита от конкуренции. JSONL и переход на SQLite/native addon не нужны для исправления scroll. Формат хранения обсуждать отдельно, с учетом перезапуска IDE и системного пользователя.

## Пересмотренный порядок

1. Исправить F01-F04 и lifecycle процесса, сохранив текущую Theia-интеграцию. Добавить regression tests, включая scroll во время ответа, неизвестный профиль и поврежденную историю.
2. Ввести typed patch/ACK/resync bridge и стабильную модель turn/window. Проверять сообщения разных панелей и задержки, не переписывая транспорт Theia.
3. Проверить минимальный React entry point в реальной IDE Element: HTTP/HTTPS, external/inline, themes, reload/serializer. Затем переносить chat под feature flag; backend не заменять.
4. Подключить GFM parser, bounded highlighting и Worker/fallback; виртуализатор выбрать по результатам теста переменных высот, а не по популярности библиотеки.
5. Отдельно делать native questions, поиск истории, безопасный read-only review и артефакты браузера.
6. Project actions, stage/revert и worktrees оставить отдельными этапами с проверенными контрактами Element. Не включать их автоматически в обещание «паритет с Desktop».

## Источники и воспроизводимость

Все пути ниже относительно проверенного бандла:

| Файл | Проверенные места |
|---|---|
| `ide/theia/products/browser-app/package.json` | Theia versions, browser target, builtin modules, настройки workspace trust |
| `ide/nodejs/include/node/node_version.h` | `NODE_MAJOR_VERSION`, `NODE_MINOR_VERSION`, `NODE_PATCH_VERSION` |
| `ide/theia/products/browser-app/lib/backend/plugin-vscode-init.js` | `DEFAULT_SUPPORTED_API_VERSION`, env override |
| `ide/theia/products/browser-app/lib/frontend/bundle.js` | `WebviewWidget`, `WebviewEnvironment.resourceRoot`, `WebviewsMainImpl`, `vscode.diff`, регистрация `g5rt.team.status` |
| `ide/theia/products/browser-app/lib/webview/pre/{index.html,main.js,host.js,service-worker.js}` | Вложенные iframe, API injection, CSP, сообщения и SW resource delivery |
| `ide/theia/products/browser-app/lib/backend/main.js` | `ElementProcessManager`, `ElementDugiteGit`, `IdeMaintenanceService`, `WorkspaceUploadRule`, `ElementEnvVariablesServer` |
| `ide/theia/products/browser-app/lib/backend/357.js` | `PluginsKeyValueStorage`, webview backend contribution и пути хранения |
| `ide/theia/plugins/@1c-appengine-plugin/dist/extension.js.map` | Доступные `sourcesContent`: `VSCodeLspServerDispatcher.ts`, `ApplicationLauncher.ts`, `WorkspaceStateWatcher.ts`, `LanguageServerUtils.ts`, `CommentControllerManager.ts` |

Минифицированные JS исследовались поиском конкретных символов и ограниченных фрагментов, source maps разбирались как JSON. Не все исходные модули 1С включены в `sourcesContent`; отсутствие найденного публичного контракта не означает отсутствие внутренней возможности сервера.

Изолированный browser probe: `../local-codex-temp/review-bundle-webview.cjs`. Запуск `node review-bundle-webview.cjs` завершился успешно. Он проверяет оболочку и CSP, не React-миграцию, полный highlighter, реальный reverse proxy или работу серверных процессов. Заключение «готово к эксплуатации» потребует запуска в реальном Element под целевым системным пользователем.
