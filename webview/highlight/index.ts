import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import yamlLanguage from "@shikijs/langs/yaml";

import xbslGrammarJson from "./assets/xbsl.tmLanguage.json";
import xbslDarkThemeJson from "./assets/xbsl-dark-theme.json";
import xbslLightThemeJson from "./assets/xbsl-light-theme.json";
import { resolveSemanticPass } from "./semantic-pass";

type SupportedLanguage = "xbsl" | "yaml";
type GrammarValue = string | number | boolean | null | GrammarValue[] | { [key: string]: GrammarValue };

const XBSL_LIGHT_THEME = "codex-xbsl-light";
const XBSL_DARK_THEME = "codex-xbsl-dark";
const MAX_CACHE_ENTRIES = 160;

const xbslLanguage = {
  ...makeXbslGrammarJavaScriptCompatible(xbslGrammarJson as GrammarValue),
  displayName: "XBSL",
  name: "xbsl",
};

const xbslLightTheme = {
  ...xbslLightThemeJson,
  name: XBSL_LIGHT_THEME,
};

const xbslDarkTheme = {
  ...xbslDarkThemeJson,
  name: XBSL_DARK_THEME,
};

const highlighterPromise = createHighlighterCore({
  langs: [xbslLanguage, yamlLanguage],
  themes: [xbslLightTheme, xbslDarkTheme],
  // Element can embed an older Chromium build whose CSP/runtime blocks
  // Oniguruma WASM. The JS engine keeps TextMate fidelity without WASM.
  engine: createJavaScriptRegexEngine({
    target: "ES2018",
    forgiving: true,
  }),
});

const cache = new Map<string, Promise<string>>();

function makeXbslGrammarJavaScriptCompatible<T extends GrammarValue>(value: T, key = ""): T {
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

function normalizeLanguage(value: string): SupportedLanguage | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (["xbsl", "bsl", "1c", "1c-element", "element"].includes(normalized)) {
    return "xbsl";
  }
  if (normalized === "yaml" || normalized === "yml") {
    return "yaml";
  }
  return null;
}

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

async function renderCodeInnerHtml(code: string, language: SupportedLanguage): Promise<string> {
  const highlighter = await highlighterPromise;
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

function highlight(code: string, requestedLanguage: string): Promise<string> {
  const language = normalizeLanguage(requestedLanguage);
  if (!language) {
    return Promise.reject(new Error(`Unsupported highlight language: ${requestedLanguage}`));
  }
  const normalizedCode = String(code || "").replace(/\r\n/g, "\n");
  const cacheKey = `${language}\u0000${normalizedCode}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = renderCodeInnerHtml(normalizedCode, language).catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, pending);
  trimCache();
  return pending;
}

window.codexXbslHighlighter = {
  highlight,
  supports(language: string): boolean {
    return normalizeLanguage(language) !== null;
  },
};

if (typeof window.dispatchEvent === "function" && typeof window.Event === "function") {
  window.dispatchEvent(new window.Event("codex-xbsl-highlighter-ready"));
}

declare global {
  interface Window {
    codexXbslHighlighter: {
      highlight(code: string, language: string): Promise<string>;
      supports(language: string): boolean;
    };
  }
}
