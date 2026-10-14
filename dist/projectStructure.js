"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeProjectStructure = analyzeProjectStructure;
const path = __importStar(require("path"));
const yaml = require(path.join(__dirname, "..", "resources", "context", "yaml.cjs"));
const IDENTIFIER = "[\\p{L}_][\\p{L}\\p{N}\\p{M}_]*";
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:(?:::|\\.)${IDENTIFIER})*`;
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const EXPRESSION_KEYWORDS = new Set([
    "true", "false", "undefined", "null", "and", "or", "not", "as", "is", "new", "this",
    "истина", "ложь", "неопределено", "и", "или", "не", "как", "есть", "новый", "этот",
]);
const NAME_KEYS = new Set(["name", "имя"]);
const ID_KEYS = new Set(["id", "ид"]);
const ELEMENT_KIND_KEYS = new Set(["elementkind", "видэлемента"]);
const IMPORT_KEYS = new Set(["import", "imports", "импорт", "импорты"]);
const TYPE_KEYS = new Set(["type", "тип", "inherits", "наследует"]);
const HANDLER_KEYS = new Set([
    "handler", "handlername", "procedure", "callback", "обработчик", "имяобработчика",
    "процедура", "обратныйвызов", "методобработчика",
]);
function analyzeProjectStructure(filePath, text) {
    const result = { symbols: [], references: [], errors: [] };
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".yaml" || extension === ".yml") {
        analyzeYaml(text, result);
    }
    else if (extension === ".xbsl") {
        analyzeXbsl(text, result);
    }
    return result;
}
function analyzeYaml(text, result) {
    const lineCounter = new yaml.LineCounter();
    try {
        const document = yaml.parseDocument(text, { keepSourceTokens: true, lineCounter, uniqueKeys: true });
        result.errors.push(...document.errors.map(error => error.message));
        const activeNodes = new Set();
        const rootFields = {};
        const rootFieldCounts = new Map();
        const rootSymbols = [];
        const referenceKeys = new Set();
        let visited = 0;
        let aliases = 0;
        function report(message) {
            if (!result.errors.includes(message))
                result.errors.push(message);
        }
        function location(node) {
            const start = node.range?.[0] ?? 0;
            let end = node.range?.[1] ?? start;
            // Collection and block scalar ranges may include a final newline, not another source line.
            while (end > start && /\s/u.test(text[end - 1]))
                end--;
            return {
                startLine: lineCounter.linePos(start).line,
                endLine: lineCounter.linePos(Math.max(start, end - 1)).line,
            };
        }
        function addReferences(value, kind, node, yamlPath, container) {
            const names = kind === "id" ? [value] : identifierNames(maskXbsl(value).text);
            for (const name of names) {
                const range = location(node);
                const key = JSON.stringify([kind, name, yamlPath, range.startLine, range.endLine]);
                if (!referenceKeys.has(key)) {
                    referenceKeys.add(key);
                    result.references.push({ name, kind, ...range, yamlPath,
                        ...(container ? { contextRange: location(container) } : {}) });
                }
            }
        }
        function visit(node, segments, key = "", container, occurrence) {
            if (!yaml.isNode(node))
                return;
            if (++visited > 20000 || segments.length > 64) {
                report("YAML: превышен лимит обхода структуры (20000 узлов или 64 уровня).");
                return;
            }
            if (activeNodes.has(node)) {
                report("YAML: циклическая ссылка на якорь пропущена.");
                return;
            }
            activeNodes.add(node);
            try {
                if (yaml.isAlias(node)) {
                    if (++aliases > 128) {
                        report("YAML: превышен лимит раскрытия ссылок на якоря (128).");
                        return;
                    }
                    const resolved = node.resolve(document);
                    if (resolved)
                        visit(resolved, segments, key, container, occurrence ?? node);
                    else
                        report(`YAML: не найден якорь ${node.source}.`);
                }
                else if (yaml.isMap(node)) {
                    for (const pair of node.items) {
                        if (yaml.isScalar(pair.key) && typeof pair.key.value === "string") {
                            visit(pair.value, [...segments, pair.key.value], pair.key.value, node, occurrence);
                        }
                    }
                }
                else if (yaml.isSeq(node)) {
                    node.items.forEach((item, index) => visit(item, [...segments, index], key, container, occurrence));
                }
                else if (yaml.isScalar(node) && typeof node.value === "string" && node.value.trim()) {
                    const value = node.value.trim();
                    const normalizedKey = key.toLowerCase();
                    const source = occurrence ?? node;
                    const yamlPath = formatYamlPath(segments);
                    const rootField = NAME_KEYS.has(normalizedKey) ? "name"
                        : ID_KEYS.has(normalizedKey) ? "id" : ELEMENT_KIND_KEYS.has(normalizedKey) ? "kind" : undefined;
                    if (segments.length === 1 && rootField) {
                        const count = (rootFieldCounts.get(rootField) ?? 0) + 1;
                        rootFieldCounts.set(rootField, count);
                        if (count === 1)
                            rootFields[rootField] = value;
                        else {
                            delete rootFields[rootField];
                            report(`YAML: неоднозначное корневое поле ${rootField}.`);
                        }
                    }
                    if (NAME_KEYS.has(normalizedKey) && !value.startsWith("=")) {
                        let selectionOffset = source.range?.[0] ?? 0;
                        if (!occurrence && (node.srcToken?.type === "double-quoted-scalar" || node.srcToken?.type === "single-quoted-scalar"))
                            selectionOffset++;
                        const selection = lineCounter.linePos(selectionOffset);
                        const symbol = {
                            name: value,
                            kind: "yaml-name",
                            ...location(occurrence ?? container ?? node),
                            selectionLine: selection.line,
                            selectionCharacter: selection.col - 1,
                        };
                        result.symbols.push(symbol);
                        if (segments.length === 1)
                            rootSymbols.push(symbol);
                    }
                    const context = container !== document.contents ? occurrence ?? container : undefined;
                    if (value.startsWith("="))
                        addReferences(value.slice(1), "expression", source, yamlPath, context);
                    else if (ID_KEYS.has(normalizedKey))
                        addReferences(value, "id", source, yamlPath, context);
                    else if (IMPORT_KEYS.has(normalizedKey))
                        addReferences(value, "import", source, yamlPath, context);
                    else if (TYPE_KEYS.has(normalizedKey))
                        addReferences(value, "type", source, yamlPath, context);
                    else if (isHandlerKey(key))
                        addReferences(value, "handler", source, yamlPath, context);
                }
            }
            finally {
                activeNodes.delete(node);
            }
        }
        visit(document.contents, []);
        // Name/Id also occur in ordinary configuration files. Only Element's explicit discriminator qualifies.
        if (rootFields.kind && rootFields.name && !rootFields.name.startsWith("=")) {
            result.element = rootFields;
            rootSymbols.forEach(symbol => { symbol.kind = "yaml-element"; });
        }
    }
    catch (error) {
        result.errors.push(`YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function formatYamlPath(segments) {
    return "$" + segments.map(segment => typeof segment === "number" ? `[${segment}]`
        : new RegExp(`^${IDENTIFIER}$`, "u").test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`).join("");
}
function isHandlerKey(key) {
    return HANDLER_KEYS.has(key.toLowerCase())
        || /^(?:On[A-Z]|При[А-ЯЁ]|Перед[А-ЯЁ]|После[А-ЯЁ])/u.test(key)
        || /(?:Handler|Callback|Обработчик)$/u.test(key);
}
function identifierNames(text) {
    const names = new Set();
    for (const match of text.matchAll(new RegExp(QUALIFIED_IDENTIFIER, "gu"))) {
        if (match.index > 0 && IDENTIFIER_CHARACTER.test(text[match.index - 1]))
            continue;
        if (!EXPRESSION_KEYWORDS.has(match[0].toLowerCase()))
            names.add(match[0]);
    }
    return [...names];
}
const DECLARATION_KINDS = {
    method: "method", метод: "method", structure: "structure", структура: "structure",
    object: "object", объект: "object", enum: "enum", перечисление: "enum", type: "type", тип: "type",
};
function analyzeXbsl(text, result) {
    const masked = maskXbsl(text);
    if (masked.unterminated)
        result.errors.push("XBSL: незавершённая строка или комментарий; лексический индекс частичный.");
    const lines = masked.text.split(/\r\n|\n|\r/u);
    const declarations = [];
    const declarationPattern = new RegExp(`^([\\uFEFF \\t]*)(?:(?:static|abstract|override|public|private|protected|export|async|статический|абстрактный|переопределяемый|публичный|приватный|асинхронный)[ \\t]+)*(${Object.keys(DECLARATION_KINDS).join("|")})[ \\t]+(${IDENTIFIER})(?=[ \\t]*(?:[(:=<]|$))`, "iu");
    const importPattern = new RegExp(`^[\\uFEFF \\t]*(?:import|импорт)[ \\t]+(${QUALIFIED_IDENTIFIER})(?=[ \\t]*$)`, "iu");
    lines.forEach((line, index) => {
        const declaration = declarationPattern.exec(line);
        if (declaration) {
            declarations.push({
                name: declaration[3], kind: DECLARATION_KINDS[declaration[2].toLowerCase()],
                line: index, indent: indentation(declaration[1]), character: declaration[0].lastIndexOf(declaration[3]),
                abstract: /(?:^|[ \t])(?:abstract|абстрактный)[ \t]/iu.test(declaration[0]),
            });
        }
        const imported = importPattern.exec(line);
        if (imported)
            result.references.push({ name: imported[1], kind: "import", startLine: index + 1, endLine: index + 1 });
    });
    const declarationLines = new Map(declarations.map(declaration => [declaration.line, declaration]));
    for (const declaration of declarations) {
        const range = lexicalRange(declaration, lines, declarationLines);
        result.symbols.push({
            name: declaration.name,
            kind: `lexical-${declaration.abstract ? "abstract-" : ""}${declaration.kind}${range.partial ? "-partial" : ""}`,
            startLine: declaration.line + 1,
            endLine: range.end + 1,
            selectionLine: declaration.line + 1,
            selectionCharacter: declaration.character,
        });
    }
}
/** Indentation is only a fallback boundary heuristic; even closed ranges remain tagged lexical. */
function lexicalRange(declaration, lines, declarations) {
    let end = declaration.line;
    let ambiguous = false;
    let parentheses = 0;
    for (let index = declaration.line; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const indent = indentation(line.match(/^[\uFEFF \t]*/u)[0]);
        if (index > declaration.line) {
            const nextDeclaration = declarations.get(index);
            if ((nextDeclaration && nextDeclaration.indent <= declaration.indent) || indent < declaration.indent)
                break;
            if (trimmed === ";" && indent === declaration.indent && !ambiguous && parentheses === 0)
                return { end: index, partial: false };
            if (indent <= declaration.indent && trimmed !== ";" && !trimmed.startsWith("@"))
                ambiguous = true;
        }
        for (const character of line) {
            if (character === "(")
                parentheses++;
            else if (character === ")")
                parentheses--;
        }
        if (parentheses < 0)
            ambiguous = true;
        if (!trimmed.startsWith("@"))
            end = index;
        if (declaration.abstract && parentheses === 0)
            return { end, partial: ambiguous };
        if (declaration.kind === "type" && index === declaration.line && line.includes("="))
            return { end, partial: false };
    }
    return { end, partial: true };
}
function indentation(text) {
    return [...text].reduce((column, character) => character === "\uFEFF" ? column
        : character === "\t" ? column + 4 - column % 4 : column + 1, 0);
}
/** Mask with spaces, retaining every UTF-16 offset and line break, including multiline strings. */
function maskXbsl(text) {
    const output = text.split("");
    let state = "code";
    let quote = "";
    const mask = (index) => { if (text[index] !== "\n" && text[index] !== "\r")
        output[index] = " "; };
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        const next = text[index + 1];
        if (state === "line-comment") {
            mask(index);
            if (character === "\n" || character === "\r")
                state = "code";
        }
        else if (state === "block-comment") {
            mask(index);
            if (character === "*" && next === "/") {
                mask(++index);
                state = "code";
            }
        }
        else if (state === "string") {
            mask(index);
            if (character === "\\" && next !== undefined)
                mask(++index);
            else if (character === quote) {
                if (next === quote)
                    mask(++index);
                else
                    state = "code";
            }
        }
        else if (character === "/" && (next === "/" || next === "*")) {
            state = next === "/" ? "line-comment" : "block-comment";
            mask(index);
            mask(++index);
        }
        else if (character === '"' || character === "'") {
            state = "string";
            quote = character;
            mask(index);
        }
    }
    return { text: output.join(""), unterminated: state === "string" || state === "block-comment" };
}
//# sourceMappingURL=projectStructure.js.map