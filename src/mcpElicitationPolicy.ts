import { MCP_SERVER_ELICITATION_REQUEST_METHOD, MANAGED_BROWSER_MCP_NAME } from "./codexIntegrationConstants";
import { JsonRpcServerRequest } from "./jsonRpcClient";

export interface McpElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content: null;
  _meta: null;
}

export interface ManagedMcpElicitationContext {
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly activeVisibleTurn: boolean;
}

export interface ManagedMcpElicitationResolution {
  readonly response: McpElicitationResponse;
  readonly autoApproved: boolean;
  readonly serverName: string;
  readonly reason: string;
}

const ACCEPT_RESPONSE: McpElicitationResponse = {
  action: "accept",
  content: null,
  _meta: null
};

const DECLINE_RESPONSE: McpElicitationResponse = {
  action: "decline",
  content: null,
  _meta: null
};

export function resolveManagedMcpElicitation(
  request: JsonRpcServerRequest,
  context: ManagedMcpElicitationContext
): ManagedMcpElicitationResolution | undefined {
  if (request.method !== MCP_SERVER_ELICITATION_REQUEST_METHOD) {
    return undefined;
  }

  const params = asRecord(request.params);
  const serverName = stringValue(params.serverName);
  if (serverName !== MANAGED_BROWSER_MCP_NAME) {
    return declined(serverName, "unmanaged-server");
  }
  if (params.mode !== "form") {
    return declined(serverName, "unsupported-mode");
  }

  const metadata = asRecord(params._meta);
  if (metadata.codex_approval_kind !== "mcp_tool_call") {
    return declined(serverName, "not-tool-approval");
  }
  if (!isApprovalOnlySchema(params.requestedSchema)) {
    return declined(serverName, "interactive-form");
  }

  const requestThreadId = stringValue(params.threadId);
  const requestTurnId = stringValue(params.turnId);
  if (
    !context.activeVisibleTurn
    || !requestThreadId
    || !requestTurnId
    || requestThreadId !== context.threadId
    || requestTurnId !== context.turnId
  ) {
    return declined(serverName, "turn-mismatch");
  }

  return {
    response: ACCEPT_RESPONSE,
    autoApproved: true,
    serverName,
    reason: "managed-browser-tool"
  };
}

function declined(serverName: string, reason: string): ManagedMcpElicitationResolution {
  return {
    response: DECLINE_RESPONSE,
    autoApproved: false,
    serverName: serverName || "unknown",
    reason
  };
}

function isApprovalOnlySchema(value: unknown): boolean {
  const schema = asRecord(value);
  if (schema.type !== "object") {
    return false;
  }
  const properties = asRecord(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.keys(properties).length === 0 && required.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
