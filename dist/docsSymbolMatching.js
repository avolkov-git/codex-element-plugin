"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDocsSymbolName = normalizeDocsSymbolName;
exports.titleMatchesSymbol = titleMatchesSymbol;
const SYMBOL_IDENTIFIER = "[\\p{L}_][\\p{L}\\p{N}\\p{M}_]*";
const QUALIFIED_SYMBOL = `${SYMBOL_IDENTIFIER}(?:(?:::|\\.)${SYMBOL_IDENTIFIER})*`;
const SYMBOL_PATTERN = new RegExp(`^${QUALIFIED_SYMBOL}$`, "u");
const TITLE_SYMBOL_PATTERN = new RegExp('^["`«]?(' + QUALIFIED_SYMBOL + ')(?=$|[^\\p{L}\\p{N}\\p{M}_:.])', "u");
function normalizeDocsSymbolName(value) {
    if (typeof value !== "string")
        return undefined;
    const name = value.trim().normalize("NFC");
    return name.length <= 200 && SYMBOL_PATTERN.test(name) ? name : undefined;
}
function titleMatchesSymbol(title, symbol) {
    // Compare the declared heading identifier, not parameter names, generic arguments or prose mentions.
    const heading = title.trim().normalize("NFC").replace(/^#{1,6}\s+/u, "")
        .replace(/^(?:тип|класс|интерфейс|структура|перечисление|метод|свойство|пространство им[её]н|компонент интерфейса|type|class|interface component|interface|structure|enum|method|property|namespace)\s*:?\s+(?=[\p{L}_`"«])/iu, "");
    return TITLE_SYMBOL_PATTERN.exec(heading)?.[1].toLowerCase() === symbol.toLowerCase();
}
//# sourceMappingURL=docsSymbolMatching.js.map