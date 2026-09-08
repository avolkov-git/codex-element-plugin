import { createHighlighterCore } from "@shikijs/core";
import type { LanguageRegistration } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import yamlLanguage from "@shikijs/langs/yaml";

import xbslGrammarJson from "./assets/xbsl.tmLanguage.json";
import xbslDarkThemeJson from "./assets/xbsl-dark-theme.json";
import xbslLightThemeJson from "./assets/xbsl-light-theme.json";
import { resolveSemanticPass } from "./semantic-pass";
import type { SupportedLanguage } from "./protocol";

const XBSL_LIGHT_THEME = "codex-xbsl-light";
const XBSL_DARK_THEME = "codex-xbsl-dark";
let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;

function getHighlighter(): ReturnType<typeof createHighlighterCore> {
  return highlighterPromise ??= createHighlighterCore({
    langs: [{
      ...makeXbslGrammarJavaScriptCompatible(xbslGrammarJson),
      displayName: "XBSL",
      name: "xbsl",
    } as unknown as LanguageRegistration, yamlLanguage],
    themes: [
      { ...xbslLightThemeJson, name: XBSL_LIGHT_THEME, type: "light" },
      { ...xbslDarkThemeJson, name: XBSL_DARK_THEME, type: "dark" },
    ],
    engine: createJavaScriptRegexEngine({ target: "ES2018", forgiving: true }),
  });
}

function makeXbslGrammarJavaScriptCompatible<T>(value: T, key = ""): T {
  if (Array.isArray(value)) {
    return value.map((item) => makeXbslGrammarJavaScriptCompatible(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        makeXbslGrammarJavaScriptCompatible(entryValue, entryKey),
      ])
    ) as T;
  }
  if (
    typeof value === "string"
    && ["match", "begin", "end", "while"].includes(key)
    && value.includes("\\b")
  ) {
    let firstBoundary = true;
    return value.replace(/\\b/g, () => {
      if (firstBoundary) {
        firstBoundary = false;
        return "(?<![\\p{L}\\p{N}_])";
      }
      return "(?![\\p{L}\\p{N}_])";
    }) as T;
  }
  return value;
}

export async function renderCodeInnerHtml(code: string, language: SupportedLanguage): Promise<string> {
  const highlighter = await getHighlighter();
  const semanticPass = resolveSemanticPass(code, {
    lang: language,
    mode: "block",
  });
  const html = highlighter.codeToHtml(code, {
    lang: language,
    themes: {
      light: XBSL_LIGHT_THEME,
      dark: XBSL_DARK_THEME,
    },
    defaultColor: false,
    decorations: semanticPass.decorations,
  });
  const codeStart = html.indexOf("<code>");
  const codeEnd = html.lastIndexOf("</code>");
  if (codeStart < 0 || codeEnd <= codeStart) {
    return "";
  }
  return html.slice(codeStart + "<code>".length, codeEnd);
}

export function disposeRenderer(): void {
  const pending = highlighterPromise;
  highlighterPromise = undefined;
  void pending?.then((highlighter) => highlighter.dispose(), () => {});
}
