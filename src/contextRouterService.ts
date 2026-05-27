import type { ChatKind } from "./types";

export interface ContextRoutingDecision {
  readonly isSmallTalk: boolean;
  readonly isProjectLike: boolean;
  readonly isDocsLike: boolean;
  readonly route: "smallTalk" | "generalChat" | "docsOverview" | "docsLookup" | "technicalProject" | "explicitProject" | "projectNoContext";
  readonly docsMode: "skip" | "overview" | "lookup";
  readonly projectMode: "skip" | "technical" | "explicit";
  readonly shouldUseProjectContext: boolean;
  readonly shouldUseDocsContext: boolean;
  readonly reason: string;
}

export interface ContextBlock {
  readonly source: "baseRules" | "project" | "docs" | "diagnostics" | "rules" | "editorFile" | "editorSelection";
  readonly text: string;
  readonly matchCount: number;
  readonly mode?: "matched" | "fallback" | "overview" | "skipped";
  readonly score?: number;
  readonly priority?: number;
  readonly tokensEstimate?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ServiceEnvelopeOptions {
  readonly userPrompt: string;
  readonly blocks: readonly ContextBlock[];
}

export interface PlanningEnvelopeOptions {
  readonly userPrompt: string;
  readonly blocks: readonly ContextBlock[];
}

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
  "структур",
  "справочник",
  "документ",
  "регистр",
  "перечислен",
  "реквизит",
  "табличн",
  "подсистем",
  "файл",
  "каталог",
  "папк",
  "путь",
  "существ",
  "проверить",
  "проверка",
  "класс",
  "функц",
  "процедур",
  "компонент",
  "модуль",
  "форма",
  "тема",
  "темаоформления",
  "пример",
  "код"
];

const EXPLICIT_PROJECT_TERMS = [
  "проект",
  "workspace",
  "воркспейс",
  "рабоч",
  "в коде",
  "в файлах",
  "в приложении",
  "в тестовом приложении",
  "где используется",
  "объясни файл",
  "выделенный фрагмент"
];

const TECHNICAL_PROJECT_TERMS = [
  "реализ",
  "исправ",
  "создай",
  "создать",
  "добавь",
  "добавить",
  "измени",
  "изменить",
  "удали",
  "удалить",
  "ошибк",
  "сборк",
  "тест"
];

export class ContextRouterService {
  public decide(prompt: string, chatKind: ChatKind): ContextRoutingDecision {
    const normalized = normalizePrompt(prompt);
    const docsOverview = isDocsOverviewPrompt(normalized);
    const docsLike = isDocsPrompt(prompt, normalized);
    const explicitProject = isExplicitProjectPrompt(normalized);
    const technicalProject = isTechnicalProjectPrompt(normalized);
    const projectLike = explicitProject || technicalProject;
    const smallTalk = !docsLike && !projectLike && isSmallTalk(normalized);

    if (chatKind === "general") {
      return {
        isSmallTalk: smallTalk,
        isProjectLike: projectLike,
        isDocsLike: docsLike,
        route: "generalChat",
        docsMode: "skip",
        projectMode: "skip",
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
        route: "smallTalk",
        docsMode: "skip",
        projectMode: "skip",
        shouldUseProjectContext: false,
        shouldUseDocsContext: false,
        reason: "small-talk"
      };
    }

    if (explicitProject) {
      return {
        isSmallTalk: false,
        isProjectLike: true,
        isDocsLike: docsLike,
        route: "explicitProject",
        docsMode: docsOverview ? "overview" : docsLike ? "lookup" : "skip",
        projectMode: "explicit",
        shouldUseProjectContext: true,
        shouldUseDocsContext: docsLike,
        reason: docsLike ? "explicit-project-docs-like" : "explicit-project"
      };
    }

    if (technicalProject) {
      return {
        isSmallTalk: false,
        isProjectLike: true,
        isDocsLike: docsLike,
        route: "technicalProject",
        docsMode: docsOverview ? "overview" : docsLike ? "lookup" : "skip",
        projectMode: "technical",
        shouldUseProjectContext: true,
        shouldUseDocsContext: docsLike,
        reason: docsLike ? "technical-project-docs-like" : "technical-project"
      };
    }

    if (docsLike) {
      return {
        isSmallTalk: false,
        isProjectLike: false,
        isDocsLike: true,
        route: docsOverview ? "docsOverview" : "docsLookup",
        docsMode: docsOverview ? "overview" : "lookup",
        projectMode: "skip",
        shouldUseProjectContext: false,
        shouldUseDocsContext: true,
        reason: docsOverview ? "docs-overview" : "docs-lookup"
      };
    }

    return {
      isSmallTalk: false,
      isProjectLike: false,
      isDocsLike: false,
      route: "projectNoContext",
      docsMode: "skip",
      projectMode: "skip",
      shouldUseProjectContext: false,
      shouldUseDocsContext: false,
      reason: "project-chat-no-context"
    };
  }

  public buildServiceEnvelope(options: ServiceEnvelopeOptions): string {
    const sections = options.blocks.map((block) => {
      const title = getBlockTitle(block.source);
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

  public buildPlanningEnvelope(options: PlanningEnvelopeOptions): string {
    const sections = options.blocks.map((block) => {
      const title = getBlockTitle(block.source);
      return `[${title}]\n${block.text.trim()}`;
    });

    return [
      "СЛУЖЕБНЫЙ РЕЖИМ ПЛАНИРОВАНИЯ CODEX ELEMENT",
      "Ты работаешь как планировщик, а не как исполнитель.",
      "Не изменяй файлы, не запускай команды, не проси approvals и не выполняй реализацию.",
      "Можно изучать предоставленный IDE контекст и задавать уточняющие вопросы пользователю только через строгий служебный блок.",
      "Если информации недостаточно, верни только блок <codex_clarification> с JSON и без текста до или после него.",
      "Формат уточнения строго такой:",
      "<codex_clarification>",
      "{\"question\":\"Короткий вопрос пользователю\",\"options\":[{\"title\":\"Вариант\",\"description\":\"Короткое пояснение\",\"answer\":\"Текст ответа, который нужно отправить в planning\"}]}",
      "</codex_clarification>",
      "В options должно быть 2-4 варианта, если их естественно предложить. Если вариантов нет, используй пустой массив.",
      "Не показывай внутренние рассуждения, retrieval-planning, служебные вопросы и черновики.",
      "Если информации достаточно, верни финальный план строго в таком формате:",
      "<codex_plan>",
      "# Короткое название плана",
      "",
      "## Summary",
      "Кратко опиши цель.",
      "",
      "## Key Changes",
      "- Конкретные изменения.",
      "",
      "## Test Plan",
      "- Проверки.",
      "",
      "## Assumptions",
      "- Явные допущения.",
      "</codex_plan>",
      "Не добавляй текст до или после блока <codex_plan>, если план финальный.",
      "Ответ должен содержать либо один <codex_clarification>, либо один <codex_plan>.",
      "",
      ...sections,
      "",
      "[ПОСЛЕДНИЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ]",
      options.userPrompt
    ].join("\n");
  }
}

function getBlockTitle(source: ContextBlock["source"]): string {
  switch (source) {
    case "baseRules":
      return "BASE CODEX ELEMENT RULES";
    case "project":
      return "PROJECT CONTEXT";
    case "rules":
      return "PROJECT RULES";
    case "docs":
      return "DOCS CONTEXT";
    case "diagnostics":
      return "IDE DIAGNOSTICS";
    case "editorFile":
      return "IDE FILE CONTEXT";
    case "editorSelection":
      return "IDE SELECTION CONTEXT";
  }
}

function normalizePrompt(prompt: string): string {
  return prompt.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isSmallTalk(prompt: string): boolean {
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

  return /^(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер|ок|окей|спасибо|благодарю|пока|hello|hi|hey|thanks|bye)\b/u.test(
    prompt
  );
}

function isDocsPrompt(originalPrompt: string, normalizedPrompt: string): boolean {
  if (isDocsOverviewPrompt(normalizedPrompt)) {
    return true;
  }

  if (DOCS_TERMS.some((term) => normalizedPrompt.includes(term))) {
    return true;
  }

  if (/(что такое|как использовать|как работает|покажи пример|напиши пример|объясни api|синтаксис)/u.test(normalizedPrompt)) {
    return true;
  }

  if (/(как|чем|где|можно ли|проверь|проверить|покажи|объясни|создай|создать|добавь|сгенерируй).{0,100}(api|тип|метод|свойств|структур|справочник|документ|форма|модуль|реквизит|поле|файл|каталог|путь|существ|синтаксис)/u.test(normalizedPrompt)) {
    return true;
  }

  if (/(api|тип|метод|свойств|структур|справочник|документ|форма|модуль|реквизит|поле|файл|каталог|путь).{0,100}(как|чем|где|можно ли|проверь|проверить|покажи|объясни|создай|создать|добавь|сгенерируй)/u.test(normalizedPrompt)) {
    return true;
  }

  const originalTerms = originalPrompt.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return originalTerms.some((term) => term.length >= 12 && /[\p{Lu}][\p{Ll}]+[\p{Lu}]/u.test(term));
}

function isDocsOverviewPrompt(prompt: string): boolean {
  return /(?:ознаком|изучи|прочитай|посмотри|разбери|проанализируй).{0,80}(?:документац|справк|корпус|каталог|папк|источник)/u.test(prompt)
    || /(?:всю|весь|целиком|полностью).{0,60}(?:документац|справк|корпус|каталог|папк|источник)/u.test(prompt)
    || /(?:документац|справк|корпус).{0,80}(?:ознаком|изучи|прочитай|посмотри|разбери|проанализируй)/u.test(prompt);
}

function isExplicitProjectPrompt(prompt: string): boolean {
  return EXPLICIT_PROJECT_TERMS.some((term) => prompt.includes(term));
}

function isTechnicalProjectPrompt(prompt: string): boolean {
  if (TECHNICAL_PROJECT_TERMS.some((term) => prompt.includes(term))) {
    return true;
  }

  return /(?:создай|создать|добавь|добавить|измени|изменить|исправь|исправить|удали|удалить|реализуй|реализовать).{0,120}(?:структур|справочник|документ|форм|модул|файл|код|метод|свойств|реквизит|подсистем)/u.test(prompt)
    || /(?:структур|справочник|документ|форм|модул|файл|код|метод|свойств|реквизит|подсистем).{0,120}(?:создай|создать|добавь|добавить|измени|изменить|исправь|исправить|удали|удалить|реализуй|реализовать)/u.test(prompt);
}
