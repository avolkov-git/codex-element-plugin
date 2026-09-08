export type SupportedLanguage = "xbsl" | "yaml";

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  codeBytes: 256 * 1024,
  codeLines: 4000,
  lineLength: 8192,
  outputBytes: 2 * 1024 * 1024,
  cacheBytes: 2 * 1024 * 1024,
  cacheEntries: 128,
  pendingBytes: 2 * 1024 * 1024,
  pendingJobs: 32,
  trackedBlocks: 512,
  fallbackBytes: 8 * 1024,
  fallbackLines: 80,
  fallbackLineLength: 1024,
  fallbackIntervalMs: 100,
  workerIntervalMs: 32,
  workerTimeoutMs: 8000,
});

export function normalizeLanguage(value: string): SupportedLanguage | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (["xbsl", "bsl", "1c", "1c-element", "element"].includes(normalized)) {
    return "xbsl";
  }
  return normalized === "yaml" || normalized === "yml" ? "yaml" : null;
}

export function checkCodeBudget(code: string, fallback = false): void {
  const bytes = fallback ? LIMITS.fallbackBytes : LIMITS.codeBytes;
  const lines = fallback ? LIMITS.fallbackLines : LIMITS.codeLines;
  const lineLength = fallback ? LIMITS.fallbackLineLength : LIMITS.lineLength;
  if (code.length > bytes || new TextEncoder().encode(code).byteLength > bytes) {
    throw new RangeError("Highlight byte budget exceeded; keep the plain-text rendering.");
  }
  let count = 1;
  let length = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "\n") {
      count += 1;
      length = 0;
    } else {
      length += 1;
    }
    if (count > lines || length > lineLength) {
      throw new RangeError("Highlight line budget exceeded; keep the plain-text rendering.");
    }
  }
}

export interface HighlightRequest {
  protocol: number;
  id: number;
  code: string;
  language: SupportedLanguage;
}

export interface HighlightResponse {
  protocol: number;
  id?: number;
  ready?: boolean;
  html?: string;
  error?: string;
}
