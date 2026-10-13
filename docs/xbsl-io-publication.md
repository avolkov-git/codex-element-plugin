# Публикация на XBSL.IO

Манифест расширения находится в корневом `package.json` репозитория. Упаковщик копирует его в `codex-plugins/package.json` каждого платформенного архива. Отдельный `manifest.json` не нужен.

## Поля манифеста

Техническое имя, версия и диапазон API сохранены из проекта. Издатель задан автором: `Alexandr Volkov`.

```json
{
  "name": "codex-element-v1",
  "publisher": "Alexandr Volkov",
  "version": "1.0.4",
  "engines": { "vscode": "^1.97.0" },
  "main": "./dist/extension.js",
  "displayName": "Codex for 1C: Element",
  "description": "Расширение Codex для Theia IDE (1С:Элемент)",
  "categories": ["Other"],
  "license": "MIT",
  "homepage": "https://xbsl.io/plugins/213de8b5-1edb-4336-9970-8bb6020b6ab6",
  "repository": {
    "type": "git",
    "url": "https://github.com/avolkov-git/codex-element-plugin.git"
  },
  "icon": "resources/icons/codex.svg"
}
```

Это только публикационные поля. Полный `package.json` также содержит неизмененные `scripts`, `activationEvents`, `contributes`, `devDependencies` и `private`. Поле `private` запрещает случайную публикацию в npm; оно не удаляет манифест из архивов.

Описание и homepage совпадают с настройками GitHub-репозитория. Repository соответствует `origin`, лицензия подтверждена файлом `LICENSE` с авторством Alexandr Volkov. Иконка уже используется в activity bar. `engines.vscode` задает диапазон VS Code API, а не версию Element.

## Платформы файлов

| Архив | Выбрать на XBSL.IO |
| --- | --- |
| `codex-plugins-1.0.4-win32-x64.zip` | `win32-x64` |
| `codex-plugins-1.0.4-linux-x64.tar.gz` | `linux-x64` |

Оба архива имеют одинаковые `publisher`, `name`, `version` и `engines.vscode`. `targetPlatforms` в манифесте нет. Не выбирайте `universal`, ARM64 или macOS: эти две поставки содержат runtime только указанной x64-платформы. Формат VSIX и `extension.vsixmanifest` в этой поставке не используются.

## Проверка и упаковка

```bash
npm run build
npm run check
npm run check:runtime-payload
node scripts/package-platform-releases.js \
  --browser-runtime-root ../local-codex-temp/browser-runtime \
  --output ../codex-plugin-release/1.0.4-xbsl
```

Путь `--browser-runtime-root` указывает на подготовленные Windows/Linux browser runtime. В исходниках или `--runtime-root` должны находиться настоящие бинарники Codex, а не Git LFS pointers.

Упаковщик распаковывает каждый готовый архив, сверяет четыре поля идентичности с исходным манифестом и запускает строгую проверку поставки. Она проверяет JSON, типы обязательных полей, наличие entry point и иконки внутри каталога расширения, комплектность бинарников и браузерного runtime. Путь `main` внутри архива: `codex-plugins/dist/extension.js`.

Изменения манифеста после выпуска не меняют уже опубликованные архивы GitHub. Для XBSL.IO используйте пересобранные архивы с новым описанием и метаданными, а не старые файлы релиза. Их SHA-256 записывается в соседний `SHA256SUMS.txt`.

Локальная проверка соответствует предоставленным требованиям XBSL.IO. Она не заменяет загрузку в валидатор портала, не подтверждает права издателя `Alexandr Volkov` на портале и не доказывает работоспособность плагина в конкретном бандле Element. Для последнего нужна отдельная проверка в IDE.

## Метаданные marketplace 1.0.4

Добавлены `extensionKind: ["workspace"]` и декларация `xbsl` schemaVersion 1.
Используется `element-dependent`: расширение обращается к внутренним API
Элемента. Ветки `8.x`, `9.x`, `10.x` указаны по решению автора 2026-09-22;
это декларация автора, а не результат новых испытаний на всех трёх ветках.
VS Code API должен удовлетворять `^1.97.0`.

Упаковщик дополняет `requiredFiles` списком dist/media/resources и runtime
конкретной платформы. Сохраняется ровно тот Chromium, который указан в
`browser/<platform>/runtime.json`; второй, неиспользуемый Chromium не включается.
ffmpeg, winldd, лицензии и notices выбранного runtime сохраняются. Удаляются
только из временной поставки npm `.bin`-обёртки (MCP запускается через прямой
`launcherPath`) и исходные сборочные каталоги. Исходные runtime не изменяются.
Проверяются лимиты портала: 512 MiB архива, 1 GiB файлов, 10 000 записей.
Архивы не содержат символьных ссылок и macOS AppleDouble-метаданных.

Историческая публикация 0.1.80 имела publisher `element-ai`; текущие исходники
имеют `Alexandr Volkov`. Это разные ID расширения, а не просто смена видимого
автора. Не считать переход автоматическим обновлением старого ID без отдельного
решения о сохранении технического publisher или миграции.
