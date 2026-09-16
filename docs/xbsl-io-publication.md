# Публикация на XBSL.IO

Манифест расширения находится в корневом `package.json` репозитория. Упаковщик копирует его в `codex-plugins/package.json` каждого платформенного архива. Отдельный `manifest.json` не нужен.

## Поля манифеста

Идентичность расширения и диапазон API сохранены из проекта:

```json
{
  "name": "codex-element-v1",
  "publisher": "element-ai",
  "version": "1.0.3",
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
| `codex-plugins-1.0.3-win32-x64.zip` | `win32-x64` |
| `codex-plugins-1.0.3-linux-x64.tar.gz` | `linux-x64` |

Оба архива имеют одинаковые `publisher`, `name`, `version` и `engines.vscode`. `targetPlatforms` в манифесте нет. Не выбирайте `universal`, ARM64 или macOS: эти две поставки содержат runtime только указанной x64-платформы. Формат VSIX и `extension.vsixmanifest` в этой поставке не используются.

## Проверка и упаковка

```bash
npm run build
npm run check
npm run check:runtime-payload
node scripts/package-platform-releases.js \
  --browser-runtime-root ../local-codex-temp/browser-runtime \
  --output ../codex-plugin-release/1.0.3-xbsl
```

Путь `--browser-runtime-root` указывает на подготовленные Windows/Linux browser runtime. В исходниках или `--runtime-root` должны находиться настоящие бинарники Codex, а не Git LFS pointers.

Упаковщик распаковывает каждый готовый архив, сверяет четыре поля идентичности с исходным манифестом и запускает строгую проверку поставки. Она проверяет JSON, типы обязательных полей, наличие entry point и иконки внутри каталога расширения, комплектность бинарников и браузерного runtime. Путь `main` внутри архива: `codex-plugins/dist/extension.js`.

Изменения манифеста после выпуска не меняют уже опубликованные архивы GitHub. Для XBSL.IO используйте пересобранные архивы с новым описанием и метаданными, а не старые файлы релиза. Их SHA-256 записывается в соседний `SHA256SUMS.txt`.

Локальная проверка соответствует предоставленным требованиям XBSL.IO. Она не заменяет загрузку в валидатор портала, не подтверждает права издателя `element-ai` на портале и не доказывает работоспособность плагина в конкретном бандле Element. Для последнего нужна отдельная проверка в IDE.
