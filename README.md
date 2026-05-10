# Codex for 1C: Element

Новый clean-room plugin project для 1C: Element.

Этот каталог является будущим deploy payload: его содержимое должно переноситься в `/plugins` серверного bundle Element.

На старте здесь нет кода старой версии. Разработка будет идти маленькими проверяемыми итерациями.

## Правила

- Не запускать `codex.exe` на activation.
- Использовать native sidebar.
- Сложные экраны открывать в workspace webview panels.
- Хранить пользовательские данные вне plugin directory.
- Перед каждой итерацией фиксировать пользовательский план проверки.

