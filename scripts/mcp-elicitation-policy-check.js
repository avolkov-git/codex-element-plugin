"use strict";

const assert = require("assert");
const { resolveManagedMcpElicitation } = require("../dist/mcpElicitationPolicy");

const baseRequest = {
  id: 17,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "codex-element-browser",
    mode: "form",
    _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "browser_navigate" },
    requestedSchema: { type: "object", properties: {} }
  }
};
const context = { threadId: "thread-1", turnId: "turn-1", activeVisibleTurn: true };

const approved = resolveManagedMcpElicitation(baseRequest, context);
assert.deepStrictEqual(approved.response, { action: "accept", content: null, _meta: null });
assert.strictEqual(approved.autoApproved, true);

const external = resolveManagedMcpElicitation({
  ...baseRequest,
  params: { ...baseRequest.params, serverName: "third-party-mcp" }
}, context);
assert.strictEqual(external.autoApproved, false);
assert.strictEqual(external.response.action, "decline");

const interactive = resolveManagedMcpElicitation({
  ...baseRequest,
  params: {
    ...baseRequest.params,
    requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
  }
}, context);
assert.strictEqual(interactive.autoApproved, false);

const wrongTurn = resolveManagedMcpElicitation(baseRequest, { ...context, turnId: "turn-2" });
assert.strictEqual(wrongTurn.autoApproved, false);

const unrelated = resolveManagedMcpElicitation({ id: 18, method: "item/fileChange/requestApproval", params: {} }, context);
assert.strictEqual(unrelated, undefined);

process.stdout.write("mcp elicitation policy checks passed\n");
