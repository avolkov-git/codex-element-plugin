export const VIEWER_MAX_FRAME = 512 * 1024;
export const VIEWER_MAX_MESSAGE = VIEWER_MAX_FRAME + 16 * 1024;
export interface BrowserViewerConnection { socketPath: string; token: string; sessionId: string }
export interface BrowserViewerPage { id: string; title: string; url: string }
export interface BrowserViewerState {
  type: "browser.viewer.state";
  sessionId: string;
  status: "idle" | "waiting" | "live" | "paused" | "error";
  message: string;
  pages: BrowserViewerPage[];
  selectedPageId: string;
  controlId: string;
  pageRevision: number;
  inputError?: string;
}
export type BrowserViewerInput =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number; button: "left" | "right" | "middle"; clickCount: 1 | 2; modifiers: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; modifiers: number }
  | { kind: "text"; text: string };
export interface BrowserViewerPointer {
  type: "browser.viewer.pointer";
  sessionId: string;
  pageId: string;
  kind: "move" | "click" | "focus" | "clear";
  x: number;
  y: number;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface BrowserViewerInputResult {
  type: "browser.viewer.inputResult";
  sessionId: string;
  pageId: string;
  controlId: string;
  inputId: number;
  ok: boolean;
  message?: string;
}

export function isViewerInput(value: unknown): value is BrowserViewerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const point = (): boolean => [v.x, v.y].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
  const modifiers = (): boolean => Number.isInteger(v.modifiers) && Number(v.modifiers) >= 0 && Number(v.modifiers) <= 15;
  if (v.kind === "move") return point();
  if (v.kind === "click") return point() && typeof v.button === "string" && ["left", "right", "middle"].includes(v.button) && (v.clickCount === 1 || v.clickCount === 2) && modifiers();
  if (v.kind === "wheel") return point() && [v.deltaX, v.deltaY].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 2000);
  if (v.kind === "text") return typeof v.text === "string" && v.text.length > 0 && v.text.length <= 1024 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.text);
  return v.kind === "key" && typeof v.key === "string" && /^(Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|[a-z])$/.test(v.key) && modifiers();
}
export interface BrowserViewerFrame {
  type: "browser.viewer.frame";
  sessionId: string;
  pageId: string;
  sequence: number;
  pageRevision: number;
  data: string;
  // CDP viewport dimensions; the JPEG may be scaled to the screencast limits.
  width: number;
  height: number;
}
