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
}
export interface BrowserViewerFrame {
  type: "browser.viewer.frame";
  sessionId: string;
  pageId: string;
  sequence: number;
  data: string;
  width: number;
  height: number;
}
