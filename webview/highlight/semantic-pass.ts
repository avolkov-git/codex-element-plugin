type DecorationItem = {
  start: number;
  end: number;
  properties: {
    className: string[];
  };
};

type HighlightRenderMode = "block" | "inline";
type SupportedHighlightLanguage = "xbsl" | "yaml";
type HighlightSemanticOverlay = {
  source: "none" | "xbsl-heuristic-symbols";
  spanCount: number;
};

const XBSL_LANGUAGE_NAME = "xbsl";

const INLINE_ANNOTATION_PREFIX = String.raw`(?:@[\p{L}_][\p{L}\p{N}_]*(?:\([^)]*\))?\s+)*`;
const METHOD_DECL_RE = new RegExp(
  String.raw`^\s*${INLINE_ANNOTATION_PREFIX}(?:(абстрактный)\s+)?(?:(статический)\s+)?метод\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)`,
  "diu",
);
const TYPE_MEMBER_METHOD_RE = new RegExp(
  String.raw`^\s+${INLINE_ANNOTATION_PREFIX}(?:(абстрактный)\s+)?(?:(статический)\s+)?метод\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)`,
  "diu",
);
const TYPE_DECL_RE = new RegExp(
  String.raw`^\s*${INLINE_ANNOTATION_PREFIX}(структура|перечисление|контракт|исключение)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)`,
  "diu",
);
const TOP_LEVEL_CONST_DECL_RE = new RegExp(
  String.raw`^\s*${INLINE_ANNOTATION_PREFIX}конст\s+(?<name>[A-ZА-ЯЁ][A-ZА-ЯЁ0-9_]*)`,
  "diu",
);
const METHOD_LOCAL_DECL_RE = new RegExp(
  String.raw`^\s*(?<keyword>конст|знч|пер|исп)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)`,
  "diu",
);
const TYPE_MEMBER_FIELD_RE = new RegExp(
  String.raw`^\s+(?:(обз)\s+)?(?<keyword>конст|знч|пер|исп)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)`,
  "diu",
);
const TYPE_ENUM_MEMBER_RE = new RegExp(
  String.raw`^\s*(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*,?\s*$`,
  "diu",
);
const PARAM_DECL_RE = new RegExp(
  String.raw`(?:^|,)\s*(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*(?::|=|,|$)`,
  "dgu",
);
const FUNCTION_CALL_RE = /[\p{L}_][\p{L}\p{N}_]*(?=\s*\()/gu;
const IDENTIFIER_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;

type SemanticSpanKind =
  | "function"
  | "type"
  | "constant"
  | "variable"
  | "parameter";
type SemanticSpanRole = "declaration" | "reference";

interface LineWithOffset {
  text: string;
  startOffset: number;
}

interface SemanticSpan {
  start: number;
  end: number;
  kind: SemanticSpanKind;
  role: SemanticSpanRole;
}

interface TypeContext {
  kind: "type";
  indent: number;
  typeKeyword?: string;
  symbols: Map<string, SemanticSpanKind>;
}

interface MethodContext {
  kind: "method";
  indent: number;
  symbols: Map<string, SemanticSpanKind>;
  memberSymbols: Map<string, SemanticSpanKind>;
}

type SemanticContext = TypeContext | MethodContext;

interface SemanticPassResult {
  decorations: DecorationItem[];
  semantic: HighlightSemanticOverlay;
}

interface ProtectedRangeState {
  inBlockComment: boolean;
}

interface ProtectedRangeResult {
  ranges: Array<[start: number, end: number]>;
  state: ProtectedRangeState;
}

function splitLinesWithOffsets(text: string): LineWithOffset[] {
  const lines = text.split("\n");
  let offset = 0;

  return lines.map((line) => {
    const entry = {
      text: line,
      startOffset: offset,
    };

    offset += line.length + 1;

    return entry;
  });
}

function normalizeIdentifier(value: string) {
  return value.toLocaleLowerCase("ru-RU");
}

function createSpan(
  line: LineWithOffset,
  localStart: number,
  localEnd: number,
  kind: SemanticSpanKind,
  role: SemanticSpanRole,
): SemanticSpan {
  return {
    start: line.startOffset + localStart,
    end: line.startOffset + localEnd,
    kind,
    role,
  };
}

function getLineIndent(text: string) {
  return text.length - text.trimStart().length;
}

function peekContext<TContext extends SemanticContext["kind"]>(
  contexts: SemanticContext[],
  kind: TContext,
) {
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    if (contexts[index]?.kind === kind) {
      return contexts[index] as Extract<SemanticContext, { kind: TContext }>;
    }
  }

  return null;
}

function extractParenthesizedSection(
  lines: LineWithOffset[],
  startLineIndex: number,
  openParenIndex: number,
) {
  let depth = 0;
  let started = false;
  let content = "";
  const offsets: number[] = [];

  for (let lineIndex = startLineIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const startColumn = lineIndex === startLineIndex ? openParenIndex : 0;

    for (let column = startColumn; column < line.text.length; column += 1) {
      const character = line.text[column];

      if (!started) {
        if (character === "(") {
          started = true;
          depth = 1;
        }
        continue;
      }

      if (character === "(") {
        depth += 1;
        content += character;
        offsets.push(line.startOffset + column);
        continue;
      }

      if (character === ")") {
        depth -= 1;

        if (depth === 0) {
          return {
            content,
            offsets,
            endLineIndex: lineIndex,
          };
        }

        content += character;
        offsets.push(line.startOffset + column);
        continue;
      }

      content += character;
      offsets.push(line.startOffset + column);
    }

    if (started && lineIndex < lines.length - 1) {
      content += "\n";
      offsets.push(line.startOffset + line.text.length);
    }
  }

  return null;
}

function collectParameterDeclarations(
  lines: LineWithOffset[],
  startLineIndex: number,
  methodMatch: RegExpExecArray | null,
) {
  if (!methodMatch) {
    return {
      entries: [] as Array<{ span: SemanticSpan & { kind: "parameter" }; name: string }>,
      endLineIndex: startLineIndex,
    };
  }

  const line = lines[startLineIndex];
  const openParenIndex = line.text.indexOf("(", methodMatch[0].length - 1);

  if (openParenIndex < 0) {
    return {
      entries: [] as Array<{ span: SemanticSpan & { kind: "parameter" }; name: string }>,
      endLineIndex: startLineIndex,
    };
  }

  const paramsSection = extractParenthesizedSection(
    lines,
    startLineIndex,
    openParenIndex,
  );

  if (!paramsSection || paramsSection.content.trim().length === 0) {
    return {
      entries: [] as Array<{ span: SemanticSpan & { kind: "parameter" }; name: string }>,
      endLineIndex: paramsSection?.endLineIndex ?? startLineIndex,
    };
  }

  const entries: Array<{
    span: SemanticSpan & { kind: "parameter" };
    name: string;
  }> = [];

  for (const match of paramsSection.content.matchAll(PARAM_DECL_RE)) {
    const nameIndices = match.indices?.groups?.name;

    if (!nameIndices) {
      continue;
    }

    const startOffset = paramsSection.offsets[nameIndices[0]];
    const endOffset = paramsSection.offsets[nameIndices[1] - 1];

    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
      continue;
    }

    entries.push({
      name: match.groups?.name ?? match[0].trim(),
      span: {
        start: startOffset,
        end: endOffset + 1,
        kind: "parameter",
        role: "declaration",
      },
    });
  }

  return {
    entries,
    endLineIndex: paramsSection.endLineIndex,
  };
}

function resolveSymbolKindFromKeyword(keyword: string | undefined): SemanticSpanKind {
  return keyword?.toLowerCase() === "конст" ? "constant" : "variable";
}

function resolveTypeMemberSymbol(
  line: LineWithOffset,
  typeContext: TypeContext,
) {
  if (typeContext.typeKeyword === "перечисление") {
    const enumMatch = TYPE_ENUM_MEMBER_RE.exec(line.text);
    const nameIndices = enumMatch?.indices?.groups?.name;

    if (!enumMatch || !nameIndices) {
      return null;
    }

    return {
      name: enumMatch.groups?.name ?? line.text.trim(),
      span: createSpan(line, nameIndices[0], nameIndices[1], "constant", "declaration"),
    };
  }

  const fieldMatch = TYPE_MEMBER_FIELD_RE.exec(line.text);
  const nameIndices = fieldMatch?.indices?.groups?.name;

  if (!fieldMatch || !nameIndices) {
    return null;
  }

  const kind = resolveSymbolKindFromKeyword(fieldMatch.groups?.keyword);

  return {
    name: fieldMatch.groups?.name ?? line.text.trim(),
    span: createSpan(line, nameIndices[0], nameIndices[1], kind, "declaration"),
  };
}

function maybeCloseContext(
  contexts: SemanticContext[],
  line: LineWithOffset,
  protectedRanges: Array<[number, number]>,
) {
  const trimmedLine = line.text.trim();
  const currentContext = contexts.at(-1);

  if (trimmedLine !== ";" || !currentContext) {
    return;
  }

  const semicolonIndex = line.text.indexOf(";");

  if (
    semicolonIndex >= 0 &&
    protectedRanges.some(
      ([start, end]) => semicolonIndex >= start && semicolonIndex < end,
    )
  ) {
    return;
  }

  const lineIndent = getLineIndent(line.text);

  if (lineIndent >= currentContext.indent) {
    contexts.pop();
  }
}

function collectProtectedRanges(
  text: string,
  state: ProtectedRangeState,
): ProtectedRangeResult {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  let inBlockComment = state.inBlockComment;

  while (index < text.length) {
    if (inBlockComment) {
      const commentEnd = text.indexOf("*/", index);

      if (commentEnd === -1) {
        ranges.push([index, text.length]);

        return {
          ranges,
          state: { inBlockComment: true },
        };
      }

      ranges.push([index, commentEnd + 2]);
      index = commentEnd + 2;
      inBlockComment = false;
      continue;
    }

    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === "/" && nextCharacter === "/") {
      ranges.push([index, text.length]);
      break;
    }

    if (character === "/" && nextCharacter === "*") {
      const commentEnd = text.indexOf("*/", index + 2);

      if (commentEnd === -1) {
        ranges.push([index, text.length]);

        return {
          ranges,
          state: { inBlockComment: true },
        };
      }

      ranges.push([index, commentEnd + 2]);
      index = commentEnd + 2;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;

      index += 1;

      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }

        if (text[index] === quote) {
          index += 1;
          break;
        }

        index += 1;
      }

      ranges.push([start, index]);
      continue;
    }

    index += 1;
  }

  return {
    ranges,
    state: { inBlockComment: inBlockComment },
  };
}

function isLineFullyProtected(
  text: string,
  ranges: Array<[number, number]>,
) {
  const trimmedStart = text.search(/\S/u);

  if (trimmedStart < 0) {
    return false;
  }

  return isRangeProtected(trimmedStart, text.length, ranges);
}

function isRangeProtected(
  start: number,
  end: number,
  ranges: Array<[number, number]>,
) {
  return ranges.some(
    ([rangeStart, rangeEnd]) =>
      start < rangeEnd && end > rangeStart,
  );
}

function collectReferenceSpans(
  line: LineWithOffset,
  symbols: Map<string, SemanticSpanKind>,
  protectedRanges: Array<[number, number]>,
  excludedRanges: Array<[number, number]> = [],
  options?: {
    allowQualified?: boolean;
  },
) {
  const spans: SemanticSpan[] = [];
  const allowQualified = options?.allowQualified ?? false;

  for (const match of line.text.matchAll(IDENTIFIER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (isRangeProtected(start, end, protectedRanges)) {
      continue;
    }

    if (isRangeProtected(start, end, excludedRanges)) {
      continue;
    }

    const previousCharacter = start > 0 ? line.text[start - 1] : "";

    if (previousCharacter === "@") {
      continue;
    }

    if (previousCharacter === "." && !allowQualified) {
      continue;
    }

    const symbolKind = symbols.get(normalizeIdentifier(match[0]));

    if (!symbolKind) {
      continue;
    }

    spans.push(createSpan(line, start, end, symbolKind, "reference"));
  }

  return spans;
}

function precollectTypeSymbols(
  lines: LineWithOffset[],
  startLineIndex: number,
  typeIndent: number,
  typeKeyword?: string,
) {
  const symbols = new Map<string, SemanticSpanKind>();
  let protectedState: ProtectedRangeState = {
    inBlockComment: false,
  };
  let skipMethodIndent: number | null = null;

  for (let lineIndex = startLineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const protectedResult = collectProtectedRanges(line.text, protectedState);

    protectedState = protectedResult.state;

    if (isLineFullyProtected(line.text, protectedResult.ranges)) {
      continue;
    }

    if (skipMethodIndent !== null) {
      if (
        line.text.trim() === ";" &&
        !isRangeProtected(
          line.text.indexOf(";"),
          line.text.indexOf(";") + 1,
          protectedResult.ranges,
        ) &&
        getLineIndent(line.text) >= skipMethodIndent
      ) {
        skipMethodIndent = null;
      }

      continue;
    }

    if (
      line.text.trim() === ";" &&
      !isRangeProtected(
        line.text.indexOf(";"),
        line.text.indexOf(";") + 1,
        protectedResult.ranges,
      ) &&
      getLineIndent(line.text) >= typeIndent
    ) {
      break;
    }

    const methodMatch = TYPE_MEMBER_METHOD_RE.exec(line.text);
    const methodName = methodMatch?.groups?.name;

    if (methodMatch && methodName) {
      symbols.set(normalizeIdentifier(methodName), "function");
      skipMethodIndent = getLineIndent(line.text);
      continue;
    }

    const member = resolveTypeMemberSymbol(
      line,
      {
        kind: "type",
        indent: typeIndent,
        typeKeyword,
        symbols: new Map(),
      },
    );

    if (member) {
      symbols.set(normalizeIdentifier(member.name), member.span.kind);
    }
  }

  return symbols;
}

function collectMethodReferenceSpans(
  line: LineWithOffset,
  methodContext: MethodContext,
  protectedRanges: Array<[number, number]>,
  excludedRanges: Array<[number, number]> = [],
) {
  const visibleSymbols = new Map(methodContext.memberSymbols);

  for (const [name, kind] of methodContext.symbols) {
    visibleSymbols.set(name, kind);
  }

  return [
    ...collectReferenceSpans(
      line,
      visibleSymbols,
      protectedRanges,
      excludedRanges,
    ),
    ...collectReferenceSpans(
      line,
      methodContext.memberSymbols,
      protectedRanges,
      excludedRanges,
      { allowQualified: true },
    ),
    ...collectKnownFunctionCallSpans(
      line,
      methodContext.memberSymbols,
      protectedRanges,
      excludedRanges,
    ),
  ];
}

function collectKnownFunctionCallSpans(
  line: LineWithOffset,
  symbols: Map<string, SemanticSpanKind>,
  protectedRanges: Array<[number, number]>,
  excludedRanges: Array<[number, number]> = [],
) {
  const spans: SemanticSpan[] = [];

  for (const match of line.text.matchAll(FUNCTION_CALL_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (isRangeProtected(start, end, protectedRanges)) {
      continue;
    }

    if (isRangeProtected(start, end, excludedRanges)) {
      continue;
    }

    const previousCharacter = start > 0 ? line.text[start - 1] : "";

    if (previousCharacter === "@") {
      continue;
    }

    if (symbols.get(normalizeIdentifier(match[0])) !== "function") {
      continue;
    }

    spans.push(createSpan(line, start, end, "function", "reference"));
  }

  return spans;
}

function dedupeSpans(spans: SemanticSpan[]) {
  const seen = new Set<string>();

  return spans.filter((span) => {
    const key = `${span.start}:${span.end}:${span.kind}:${span.role}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function toDecoration(span: SemanticSpan): DecorationItem {
  return {
    start: span.start,
    end: span.end,
    properties: {
      className: [
        "xbsl-semantic",
        `xbsl-semantic-${span.role}`,
        `xbsl-semantic-kind-${span.kind}`,
      ],
    },
  };
}

function collectHeuristicSemanticSpans(code: string) {
  const spans: SemanticSpan[] = [];
  const lines = splitLinesWithOffsets(code);
  const contexts: SemanticContext[] = [];
  let protectedState: ProtectedRangeState = {
    inBlockComment: false,
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const protectedResult = collectProtectedRanges(line.text, protectedState);

    protectedState = protectedResult.state;

    maybeCloseContext(contexts, line, protectedResult.ranges);

    const methodContext = peekContext(contexts, "method");
    const typeContext = peekContext(contexts, "type");

    if (
      line.text.trim() === ";" ||
      isRangeProtected(0, Math.max(line.text.length, 1), protectedResult.ranges)
    ) {
      continue;
    }

    if (methodContext) {
      const localMatch = METHOD_LOCAL_DECL_RE.exec(line.text);
      const localNameIndices = localMatch?.indices?.groups?.name;

      if (localMatch && localNameIndices) {
        const localKind = resolveSymbolKindFromKeyword(localMatch.groups?.keyword);
        const declarationSpan = createSpan(
          line,
          localNameIndices[0],
          localNameIndices[1],
          localKind,
          "declaration",
        );

        spans.push(declarationSpan);
        spans.push(
          ...collectMethodReferenceSpans(
            line,
            methodContext,
            protectedResult.ranges,
            [[localNameIndices[0], localNameIndices[1]]],
          ),
        );
        methodContext.symbols.set(
          normalizeIdentifier(localMatch.groups?.name ?? ""),
          localKind,
        );
        continue;
      }

      spans.push(
        ...collectMethodReferenceSpans(
          line,
          methodContext,
          protectedResult.ranges,
        ),
      );
      continue;
    }

    const methodMatch = (typeContext ? TYPE_MEMBER_METHOD_RE : METHOD_DECL_RE).exec(
      line.text,
    );
    const methodNameIndices = methodMatch?.indices?.groups?.name;

    if (methodMatch && methodNameIndices) {
      const methodName = methodMatch.groups?.name ?? "";

      spans.push(
        createSpan(
          line,
          methodNameIndices[0],
          methodNameIndices[1],
          "function",
          "declaration",
        ),
      );

      if (typeContext && methodName) {
        typeContext.symbols.set(normalizeIdentifier(methodName), "function");
      }

      const parameterInfo = collectParameterDeclarations(lines, lineIndex, methodMatch);
      const methodSymbols = new Map<string, SemanticSpanKind>();

      for (const entry of parameterInfo.entries) {
        spans.push(entry.span);
        methodSymbols.set(normalizeIdentifier(entry.name), entry.span.kind);
      }

      contexts.push({
        kind: "method",
        indent: getLineIndent(line.text),
        symbols: methodSymbols,
        memberSymbols: new Map(typeContext?.symbols ?? []),
      });
      lineIndex = parameterInfo.endLineIndex;
      continue;
    }

    if (typeContext) {
      const member = resolveTypeMemberSymbol(line, typeContext);

      if (member) {
        spans.push(member.span);
        typeContext.symbols.set(normalizeIdentifier(member.name), member.span.kind);
      }

      continue;
    }

    const typeMatch = TYPE_DECL_RE.exec(line.text);
    const typeNameIndices = typeMatch?.indices?.groups?.name;

    if (typeMatch && typeNameIndices) {
      spans.push(
        createSpan(
          line,
          typeNameIndices[0],
          typeNameIndices[1],
          "type",
          "declaration",
        ),
      );
      contexts.push({
        kind: "type",
        indent: getLineIndent(line.text),
        typeKeyword: typeMatch[1]?.toLowerCase(),
        symbols: precollectTypeSymbols(
          lines,
          lineIndex,
          getLineIndent(line.text),
          typeMatch[1]?.toLowerCase(),
        ),
      });
      continue;
    }

    const topLevelConstMatch = TOP_LEVEL_CONST_DECL_RE.exec(line.text);
    const topLevelConstIndices = topLevelConstMatch?.indices?.groups?.name;

    if (topLevelConstMatch && topLevelConstIndices) {
      spans.push(
        createSpan(
          line,
          topLevelConstIndices[0],
          topLevelConstIndices[1],
          "constant",
          "declaration",
        ),
      );
    }
  }

  return dedupeSpans(spans);
}

function createEmptySemanticResult(): SemanticPassResult {
  return {
    decorations: [],
    semantic: {
      source: "none",
      spanCount: 0,
    },
  };
}

export function resolveSemanticPass(
  code: string,
  options: {
    lang: SupportedHighlightLanguage;
    mode: HighlightRenderMode;
  },
): SemanticPassResult {
  if (options.lang !== XBSL_LANGUAGE_NAME || !code) {
    return createEmptySemanticResult();
  }

  try {
    const spans = collectHeuristicSemanticSpans(code);

    if (spans.length === 0) {
      return createEmptySemanticResult();
    }

    return {
      decorations: spans.map(toDecoration),
      semantic: {
        source: "xbsl-heuristic-symbols",
        spanCount: spans.length,
      },
    };
  } catch (error) {
    console.error("[xbsl-highlight] semantic pass skipped", error);
    return createEmptySemanticResult();
  }
}
