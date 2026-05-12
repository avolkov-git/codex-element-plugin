export type AuthStatus = "notAuthenticated" | "authenticated" | "checking" | "error";

export type AuthAccountType = "none" | "apiKey" | "chatgpt" | "unknown";

export type AuthFlowStatus = "idle" | "starting" | "awaiting" | "success" | "error";

export type ProxyStatus = "notConfigured" | "configured" | "error";

export type DocsStatus = "notConfigured" | "configured" | "error";

export type ProjectContextStatus = "notIndexed" | "indexing" | "active" | "error" | "disabled";

export type RulesContextStatus = "missing" | "active" | "disabled" | "error";

export type RuntimeStatus = "notStarted" | "starting" | "running" | "error";

export type ChatKind = "project" | "general";

export type ChatStatus = "idle" | "running" | "waitingApproval" | "cancelling" | "error";

export type ChatAccessMode = "read-only" | "workspace-write" | "danger-full-access";

export type ChatRunMode = "normal" | "planning" | "implementPlan";

export type ChatEffort = "low" | "medium" | "high" | "xhigh";

export type ChatSpeed = "standard" | "fast";

export type ChatHeaderMode = "collapsed" | "expanded";

export type ApprovalKind = "command" | "file" | "diff" | "network" | "unknown";

export interface ModelOption {
  id: string | null;
  label: string;
}

export interface ApprovalRequest {
  id: string;
  method: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  command?: string;
  path?: string;
  cwd?: string;
  diff?: string;
  payloadPreview: string;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastReadAt: string;
  hasUnread: boolean;
  status: ChatStatus;
  accessMode: ChatAccessMode;
  modelId: string | null;
  modelLabel: string;
  effort: ChatEffort;
  speed: ChatSpeed;
  rulesEnabled: boolean;
  pendingApproval: ApprovalRequest | null;
  backendThreadAccessMode: ChatAccessMode | null;
  backendThreadId: string | null;
  activeTurnId: string | null;
  activeRunMode: ChatRunMode | null;
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
  docs: {
    status: DocsStatus;
    label: string;
  };
  projectContext: {
    status: ProjectContextStatus;
    label: string;
  };
  rulesContext: {
    status: RulesContextStatus;
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
  chatHeaderMode: ChatHeaderMode;
  chat: ChatSummary;
  runtime: SidebarSnapshot["runtime"];
  auth: SidebarSnapshot["auth"];
  docs: SidebarSnapshot["docs"];
  projectContext: SidebarSnapshot["projectContext"];
  rulesContext: SidebarSnapshot["rulesContext"];
  modelOptions: ModelOption[];
  modelOptionsStatus: "idle" | "loading" | "ready" | "error";
  transcript: ChatTranscriptItem[];
}

export interface ProjectContextDetails {
  kind: "project";
  status: ProjectContextStatus;
  label: string;
  workspaceRoot?: string;
  indexPath?: string;
  updatedAt?: string;
  files: string[];
  count: number;
  error?: string;
}

export interface DocsContextDetails {
  kind: "docs";
  status: DocsStatus;
  label: string;
  source: "normalized" | "none";
  normalizedPath?: string;
  indexPath?: string;
  error?: string;
}

export type ContextDetails = ProjectContextDetails | DocsContextDetails;

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
