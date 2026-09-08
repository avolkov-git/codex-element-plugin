# Codex app-server 0.144.5

Исторический baseline. Текущая поставка и результаты проверки: [0.153.4](app-server-0.153.4.md).

## Цель

Зафиксировать protocol baseline поставки Codex for 1C: Element и исключить скрытое смешивание старых runtime/payload с новым app-server.

## Runtime matrix

Release должен содержать Codex CLI `0.144.5` для всех поддерживаемых целей:

- `win32-x64`;
- `win32-arm64`;
- `linux-x64`;
- `linux-arm64`;
- `darwin-x64`;
- `darwin-arm64`.

Windows runtime дополнительно содержит `codex-command-runner.exe` и `codex-windows-sandbox-setup.exe` соответствующей архитектуры. Strict preflight не допускает Git LFS pointer вместо executable.

## Protocol contract

| Возможность | Контракт 0.144.5 |
| --- | --- |
| Initialize | `initialize` с `clientInfo` и явными client capabilities |
| Models | paginated `model/list` с `data` и `nextCursor` |
| Model metadata | `isDefault`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `serviceTiers` |
| Input text | `{ type: "text", text, text_elements: [] }` |
| Thread sandbox | `read-only`, `workspace-write`, `danger-full-access` |
| Turn sandbox | tagged `readOnly`, `workspaceWrite`, `dangerFullAccess` object |
| Fast mode | `serviceTier`, выбранный из metadata текущей модели |
| Stop | `turn/interrupt` |
| Recommendation | `turn/steer` с обязательным `expectedTurnId` |
| Rate limits | `primary`, `secondary` и дополнительные snapshots из `rateLimitsByLimitId` |

## Model policy

Плагин не хранит продуктовый список GPT-моделей. Selector загружается лениво через `model/list`; доступность зависит от аккаунта, rollout и service tier. Synthetic option `Авто` означает runtime default и наследует его reasoning/service-tier metadata.

Если `model/list` временно недоступен, UI показывает только `Авто`. Это безопаснее, чем предлагать пользователю модель, которой нет в его Codex-подписке.

## Queue and steer

Во время активного turn пользователь может:

- поставить несколько сообщений в локальную FIFO-очередь;
- редактировать, переставлять и удалять еще не отправленные сообщения;
- отправить текущий draft как рекомендацию активному turn через `turn/steer`;
- остановить turn через `turn/interrupt`.

В composer действие по умолчанию во время активного turn — очередь. Пустой draft оставляет только отдельную кнопку остановки. После ввода текста появляется компактная кнопка follow-up с меню `В очередь` / `Как рекомендацию`; остановка остается доступной независимо от выбранного способа отправки.

После `turn/completed` плагин извлекает первое queued message и запускает следующий turn в том же чате. Hidden service context не добавляется в transcript как пользовательское сообщение.

## Verification

Обязательные проверки перед release:

```bash
npm run check
npm run build
npm run preflight:runtime:release
npm run preflight:deploy:release
```

Дополнительно запускается реальный app-server smoke-test: `initialize` должен вернуть user agent `0.144.5`, а `model/list` должен вернуть непустой `data` и runtime default.
