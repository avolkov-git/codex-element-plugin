import { renderCodeInnerHtml } from "./engine";
import { checkCodeBudget, LIMITS, normalizeLanguage, PROTOCOL_VERSION } from "./protocol";
import type { HighlightRequest, HighlightResponse } from "./protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(message: HighlightResponse): void;
};

scope.onmessage = async ({ data }) => {
  if (!data || data.protocol !== PROTOCOL_VERSION || !Number.isSafeInteger(data.id)) {
    return;
  }
  try {
    const language = normalizeLanguage(data.language);
    if (!language || typeof data.code !== "string") {
      throw new Error("Invalid highlight request");
    }
    checkCodeBudget(data.code);
    const html = await renderCodeInnerHtml(data.code, language);
    if (html.length * 2 > LIMITS.outputBytes) {
      throw new RangeError("Highlight output budget exceeded");
    }
    scope.postMessage({ protocol: PROTOCOL_VERSION, id: data.id, html });
  } catch (error) {
    scope.postMessage({ protocol: PROTOCOL_VERSION, id: data.id, error: String(error).slice(0, 240) });
  }
};
scope.postMessage({ protocol: PROTOCOL_VERSION, ready: true });
