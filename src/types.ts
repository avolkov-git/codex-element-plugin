export type AuthStatus = "notAuthenticated" | "authenticated" | "checking" | "error";

export type AuthAccountType = "none" | "apiKey" | "chatgpt" | "unknown";

export type AuthFlowStatus = "idle" | "starting" | "awaiting" | "success" | "error";

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
  lastReadAt: string;
  hasUnread: boolean;
  status: ChatStatus;
  backendThreadId: string | null;
  activeTurnId: string | null;
}

export interface SidebarSnapshot {
  kind: "sidebar";
  version: number;
  auth: {
    status: AuthStatus;
    accountLabel: string;
    accountType: AuthAccountType;
    message: string;
    profileLabel: string;
    deviceCode: {
      status: AuthFlowStatus;
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };
    apiKey: {
      status: AuthFlowStatus;
    };
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

export interface PersistedChatHistory {
  version: 1;
  activeChatId?: string;
  chats: ChatSummary[];
  transcripts: Record<string, ChatTranscriptItem[]>;
}

export interface ChatPanelState {
  activeChatId?: string;
  chatId?: string;
}

export type WebviewCommand =
  | { type: "ready"; assetMode?: "external" | "inline fallback" }
  | { type: "command"; command: string; payload?: unknown };
