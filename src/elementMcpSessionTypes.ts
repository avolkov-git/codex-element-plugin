export interface ElementMcpTarget {
  name: string;
  url: string;
  enabled: boolean;
  sessionHeaderConfigured?: boolean;
  stdioServerNames?: string[];
  sessionTokenUsedElsewhere?: boolean;
}

export type ElementMcpSessionStatus = "disconnected" | "connecting" | "ready" | "renewing" | "expired" | "revoking" | "error";

/** Public state only: never include credentials or session capabilities. */
export interface ElementMcpSessionView {
  status: ElementMcpSessionStatus;
  message: string;
  serverName?: string;
  projectId?: string;
  applicationId?: string;
  canPrepare?: boolean;
  migrationRequired?: boolean;
}

export interface ElementMcpRuntimeLaunch {
  args: string[];
  env: Record<string, string>;
  serverName?: string;
  verify?: (callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>;
}
