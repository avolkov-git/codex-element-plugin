"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveManagedMcpElicitation = resolveManagedMcpElicitation;
const codexIntegrationConstants_1 = require("./codexIntegrationConstants");
const ACCEPT_RESPONSE = {
    action: "accept",
    content: null,
    _meta: null
};
const DECLINE_RESPONSE = {
    action: "decline",
    content: null,
    _meta: null
};
function resolveManagedMcpElicitation(request, context) {
    if (request.method !== codexIntegrationConstants_1.MCP_SERVER_ELICITATION_REQUEST_METHOD) {
        return undefined;
    }
    const params = asRecord(request.params);
    const serverName = stringValue(params.serverName);
    if (serverName !== codexIntegrationConstants_1.MANAGED_BROWSER_MCP_NAME) {
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
    if (!context.activeVisibleTurn
        || !requestThreadId
        || !requestTurnId
        || requestThreadId !== context.threadId
        || requestTurnId !== context.turnId) {
        return declined(serverName, "turn-mismatch");
    }
    return {
        response: ACCEPT_RESPONSE,
        autoApproved: true,
        serverName,
        reason: "managed-browser-tool"
    };
}
function declined(serverName, reason) {
    return {
        response: DECLINE_RESPONSE,
        autoApproved: false,
        serverName: serverName || "unknown",
        reason
    };
}
function isApprovalOnlySchema(value) {
    const schema = asRecord(value);
    if (schema.type !== "object") {
        return false;
    }
    const properties = asRecord(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.keys(properties).length === 0 && required.length === 0;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
//# sourceMappingURL=mcpElicitationPolicy.js.map