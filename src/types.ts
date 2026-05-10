export type AuthStatus = "notAuthenticated" | "authenticated";

export type ProxyStatus = "notConfigured" | "configured" | "error";

export type RuntimeStatus = "notStarted" | "starting" | "running" | "error";

export type ChatKind = "project" | "general";

export type ChatStatus = "idle" | "running" | "waitingApproval" | "error";

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ChatStatus;
}

export interface SidebarSnapshot {
  kind: "sidebar";
  version: number;
  auth: {
    status: AuthStatus;
    accountLabel: string;
  };
  proxy: {
    status: ProxyStatus;
    label: string;
  };
  runtime: {
    status: RuntimeStatus;
    label: string;
  };
  chats: ChatSummary[];
  activeChatId?: string;
}

export interface ChatPanelSnapshot {
  kind: "chat";
  version: number;
  chat: ChatSummary;
  runtime: SidebarSnapshot["runtime"];
  auth: SidebarSnapshot["auth"];
  transcript: ChatTranscriptItem[];
  shellNotice: string;
}

export interface ChatTranscriptItem {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface ChatPanelState {
  chatId: string;
}

export type WebviewCommand =
  | { type: "ready"; assetMode?: "external" | "inline fallback" }
  | { type: "command"; command: string; payload?: unknown };
