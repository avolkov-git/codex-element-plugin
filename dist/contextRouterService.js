"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextRouterService = void 0;
const SMALL_TALK_EXACT = new Set([
    "привет",
    "привет!",
    "здравствуй",
    "здравствуйте",
    "добрый день",
    "доброе утро",
    "добрый вечер",
    "ок",
    "окей",
    "да",
    "нет",
    "спасибо",
    "благодарю",
    "пока",
    "до свидания",
    "как дела",
    "hello",
    "hi",
    "hey",
    "ok",
    "yes",
    "no",
    "thanks",
    "thank you",
    "bye"
]);
const DOCS_TERMS = [
    "1c",
    "1с",
    "element",
    "элемент",
    "xbsl",
    "bsl",
    "api",
    "документац",
    "справк",
    "платформ",
    "язык",
    "синтаксис",
    "метод",
    "свойств",
    "тип",
    "класс",
    "функц",
    "процедур",
    "компонент",
    "модуль",
    "форма",
    "тема",
    "пример",
    "код"
];
const PROJECT_TERMS = [
    "проект",
    "workspace",
    "воркспейс",
    "файл",
    "каталог",
    "папк",
    "модуль",
    "метод",
    "компонент",
    "класс",
    "функц",
    "процедур",
    "код",
    "реализ",
    "исправ",
    "ошибк",
    "сборк",
    "найди",
    "проверь",
    "объясни",
    "почему"
];
class ContextRouterService {
    decide(prompt, chatKind) {
        const normalized = normalizePrompt(prompt);
        const docsLike = isDocsPrompt(prompt, normalized);
        const projectLike = isProjectPrompt(normalized);
        const smallTalk = !docsLike && !projectLike && isSmallTalk(normalized);
        if (chatKind === "general") {
            return {
                isSmallTalk: smallTalk,
                isProjectLike: projectLike,
                isDocsLike: docsLike,
                shouldUseProjectContext: false,
                shouldUseDocsContext: false,
                reason: "general-chat"
            };
        }
        if (smallTalk) {
            return {
                isSmallTalk: true,
                isProjectLike: false,
                isDocsLike: false,
                shouldUseProjectContext: false,
                shouldUseDocsContext: false,
                reason: "small-talk"
            };
        }
        return {
            isSmallTalk: false,
            isProjectLike: true,
            isDocsLike: docsLike,
            shouldUseProjectContext: true,
            shouldUseDocsContext: docsLike,
            reason: docsLike ? "project-chat-docs-like" : "project-chat"
        };
    }
    buildServiceEnvelope(options) {
        const sections = options.blocks.map((block) => {
            const title = block.source === "project"
                ? "PROJECT CONTEXT"
                : block.source === "rules"
                    ? "PROJECT RULES"
                    : "DOCS CONTEXT";
            return `[${title}]\n${block.text.trim()}`;
        });
        return [
            "СЛУЖЕБНЫЙ КОНТЕКСТ CODEX ELEMENT",
            "Эти сведения добавлены IDE автоматически и не являются сообщением пользователя.",
            "Не сообщай пользователю, что ты получил, прочитал или используешь этот контекст.",
            "Не начинай ответ с фраз вроде \"Принял контекст\", \"В подключенном фрагменте\", \"На основе контекста\", если пользователь прямо не спрашивает об источниках.",
            "Главная задача - ответить на последний запрос пользователя. Если служебный контекст не относится к запросу, игнорируй его.",
            "Не цитируй служебный контекст без необходимости.",
            "",
            ...sections,
            "",
            "[ПОСЛЕДНИЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ]",
            options.userPrompt
        ].join("\n");
    }
}
exports.ContextRouterService = ContextRouterService;
function normalizePrompt(prompt) {
    return prompt.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function isSmallTalk(prompt) {
    if (!prompt) {
        return true;
    }
    if (SMALL_TALK_EXACT.has(prompt)) {
        return true;
    }
    const tokens = prompt.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (tokens.length > 4) {
        return false;
    }
    if (/(^|\b)(как\s+.*дела|ты тут|ты здесь|проверка|test)(\b|$)/u.test(prompt)) {
        return true;
    }
    return /^(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер|ок|окей|спасибо|благодарю|пока|hello|hi|hey|thanks|bye)\b/u.test(prompt);
}
function isDocsPrompt(originalPrompt, normalizedPrompt) {
    if (DOCS_TERMS.some((term) => normalizedPrompt.includes(term))) {
        return true;
    }
    if (/(что такое|как использовать|как работает|покажи пример|напиши пример|объясни api|синтаксис)/u.test(normalizedPrompt)) {
        return true;
    }
    const originalTerms = originalPrompt.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    return originalTerms.some((term) => term.length >= 12 && /[\p{Lu}][\p{Ll}]+[\p{Lu}]/u.test(term));
}
function isProjectPrompt(prompt) {
    return PROJECT_TERMS.some((term) => prompt.includes(term));
}
//# sourceMappingURL=contextRouterService.js.map