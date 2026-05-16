export type AuthStatus = "notAuthenticated" | "authenticated" | "checking" | "error";

export type AuthAccountType = "none" | "apiKey" | "chatgpt" | "unknown";

export type AuthFlowStatus = "idle" | "starting" | "awaiting" | "success" | "error";

export type ProxyStatus = "notConfigured" | "configured" | "error";

export type DocsStatus = "notConfigured" | "configured" | "error";

export type ProjectContextStatus = "notIndexed" | "indexing" | "active" | "error" | "disabled";

export type RulesContextStatus = "missing" | "active" | "disabled" | "error";

export type RuntimeStatus = "notStarted" | "starting" | "running" | "error";

export type RateLimitsStatus = "unknown" | "ready" | "error";

export type ContextWindowStatus = "unknown" | "ready" | "compacting" | "error";

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

export interface RateLimitRow {
  kind: "primary" | "secondary";
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ContextWindowUsage {
  status: ContextWindowStatus;
  usedTokens: number | null;
  maxTokens: number | null;
  usedPercent: number | null;
  updatedAt?: string;
  message?: string;
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
  rateLimits: {
    status: RateLimitsStatus;
    rows: RateLimitRow[];
    updatedAt?: string;
    rateLimitReachedType?: string;
    message?: string;
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
  contextWindow: ContextWindowUsage;
  modelOptions: ModelOption[];
  modelOptionsStatus: "idle" | "loading" | "ready" | "error";
  transcriptWindow: ChatTranscriptWindow;
}

export interface ChatTranscriptWindow {
  items: ChatTranscriptItem[];
  offset: number;
  totalCount: number;
  hasBefore: boolean;
  hasAfter: boolean;
  firstItemId?: string;
  lastItemId?: string;
}

export interface ProjectContextDetails {
  kind: "project";
  status: ProjectContextStatus;
  label: string;
  workspaceRoot?: string;
  indexPath?: string;
  version?: number;
  updatedAt?: string;
  dirty?: boolean;
  chunkCount?: number;
  lastUsedChunks?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    symbols?: string[];
    score?: number;
  }>;
  files: string[];
  count: number;
  error?: string;
}

export interface DocsContextDetails {
  kind: "docs";
  status: DocsStatus;
  label: string;
  source: "normalized" | "multiple" | "none";
  normalizedPath?: string;
  sourcePath?: string;
  indexPath?: string;
  corpora?: DocsCorpusDetail[];
  allowedRoots?: DocsRootDetail[];
  fingerprint?: string;
  fingerprintFiles?: number;
  fingerprintLatestMtimeMs?: number;
  lastRetrievalMode?: "none" | "deterministic" | "model-assisted" | "fallback";
  lastQueryCount?: number;
  lastSelectedFragments?: number;
  lastRetrievalAt?: string;
  error?: string;
}

export interface DocsRootDetail {
  kind: "normalized" | "source" | "serverDocs";
  label: string;
  path: string;
  status: DocsStatus;
  corpora?: DocsCorpusDetail[];
  fingerprint?: string;
  fingerprintFiles?: number;
  fingerprintLatestMtimeMs?: number;
  error?: string;
}

export interface DocsCorpusDetail {
  corpus: string;
  label: string;
  format: string;
  indexPath: string;
  files: string[];
}

export type ContextDetails = ProjectContextDetails | DocsContextDetails;

export type ChatTranscriptItem =
  | ChatMessageTranscriptItem
  | ChatActivityTranscriptItem
  | ChatDiffTranscriptItem
  | ChatPlanTranscriptItem
  | ChatCompactionTranscriptItem
  | ChatConnectionTranscriptItem
  | ChatErrorTranscriptItem;

export interface ChatMessageTranscriptItem {
  kind: "message";
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  createdAt: string;
  status?: "streaming" | "complete";
  completedAt?: string;
  durationMs?: number;
}

export type ChatActivityKind = "turn" | "command" | "file" | "search" | "reasoning" | "context" | "tool" | "unknown";

export interface ChatActivityTranscriptItem {
  kind: "activity";
  id: string;
  activityKind: ChatActivityKind;
  label: string;
  status: "running" | "completed" | "error";
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  turnId?: string;
  itemId?: string;
  command?: string;
  path?: string;
  summary?: string;
  outputPreview?: string;
}

export interface ChatDiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
  diff?: string;
}

export interface ChatDiffTranscriptItem {
  kind: "diff";
  id: string;
  title: string;
  additions: number;
  deletions: number;
  files: ChatDiffFileSummary[];
  createdAt: string;
  updatedAt?: string;
  turnId?: string;
}

export interface ChatPlanTranscriptItem {
  kind: "plan";
  id: string;
  markdown: string;
  createdAt: string;
  updatedAt?: string;
  turnId?: string;
}

export interface ChatCompactionTranscriptItem {
  kind: "compaction";
  id: string;
  label: string;
  createdAt: string;
}

export interface ChatConnectionTranscriptItem {
  kind: "connection";
  id: string;
  message: string;
  status: "reconnecting" | "failed" | "recovered";
  createdAt: string;
  updatedAt?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface ChatErrorTranscriptItem {
  kind: "error";
  id: string;
  message: string;
  details?: string;
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
