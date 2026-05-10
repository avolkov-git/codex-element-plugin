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
