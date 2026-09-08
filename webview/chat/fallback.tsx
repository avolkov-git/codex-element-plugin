import { memo, useMemo, type ReactNode } from "react";

const declarations = new Set(["метод", "структура", "перечисление", "контракт", "исключение"]);
const modifiers = new Set(["пер", "знч", "обз", "исп", "конст", "статический"]);
const controls = new Set(["абстрактный", "импорт", "если", "иначе", "пока", "для", "по", "из", "до", "вниз", "шаг", "попытка", "поймать", "вконце", "прервать", "продолжить", "выбросить", "возврат", "не", "и", "или", "как", "это", "этот", "когда", "выбор", "новый"]);
const constants = new Set(["истина", "ложь", "неопределено", "ничто", "неизвестно", "никогда", "авто", "true", "false", "null"]);

export function normalizeLanguage(language: string): string {
  if (["xbsl", "bsl", "1c", "1c-element", "element"].includes(language.toLowerCase())) return "xbsl";
  return language === "yml" ? "yaml" : language.toLowerCase();
}

// Small bounded lexical fallback using the incumbent keyword groups. Semantic
// highlighting remains the worker's responsibility; React escapes every token.
function tokenize(code: string, language: string): ReactNode {
  if (!["xbsl", "yaml", "json"].includes(language) || code.length > 16000) return code;
  const pattern = /\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[\p{L}_][\p{L}\p{N}_]*|[\p{L}_][\p{L}\p{N}_]*|\d+(?:_\d+)*(?:\.\d+)?|[()[\]{},;]/gu;
  const tokens: ReactNode[] = [];
  let cursor = 0, previous = "";
  for (const match of code.matchAll(pattern)) {
    if (tokens.length >= 2000) break;
    const index = match.index!, word = match[0], normalized = word.toLowerCase();
    if (index > cursor) tokens.push(code.slice(cursor, index));
    let kind = "";
    if (word.startsWith("//") || (language === "yaml" && word.startsWith("#"))) kind = "comment";
    else if (/^["']/.test(word)) kind = "string";
    else if (/^\d/.test(word)) kind = "number";
    else if (constants.has(normalized)) kind = "constant";
    else if (language === "xbsl") {
      if (word.startsWith("@")) kind = "annotation";
      else if (declarations.has(normalized)) kind = "declaration";
      else if (modifiers.has(normalized)) kind = "modifier";
      else if (controls.has(normalized)) kind = "keyword";
      else if (/^[()[\]{},;]$/.test(word)) kind = "punctuation";
      else if (previous === "метод" || /^\s*\(/.test(code.slice(index + word.length))) kind = "function";
      else if (declarations.has(previous) || /:\s*$/.test(code.slice(Math.max(0, index - 8), index))) kind = "type";
    } else if (/^\s*:/.test(code.slice(index + word.length))) kind = "property";
    tokens.push(kind ? <span key={index} className={`syntax-token token-${kind}`}>{word}</span> : word);
    cursor = index + word.length; previous = normalized;
  }
  if (cursor < code.length) tokens.push(code.slice(cursor));
  return tokens;
}
export const FallbackCode = memo(function FallbackCode({ code, language }: { code: string; language: string }) {
  const tokens = useMemo(() => tokenize(code, language), [code, language]);
  return <code>{tokens}</code>;
});
