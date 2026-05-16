import { ContextBlock, ContextRoutingDecision } from "./contextRouterService";
import {
  ContextToolResult,
  ContextToolName,
  toContextBlock
} from "./contextTools";
import { DiagnosticsToolsService } from "./diagnosticsToolsService";
import { DocsToolsService } from "./docsToolsService";
import { Logger } from "./logger";
import { ProjectToolsService } from "./projectToolsService";
import { ChatKind } from "./types";

export type ManagedContextToolRoute = "skip" | "added" | "overview" | "empty" | "error";

export interface ManagedContextToolLoopRequest {
  readonly chatId: string;
  readonly prompt: string;
  readonly chatKind: ChatKind;
  readonly routing: ContextRoutingDecision;
  readonly hasExplicitDocs: boolean;
  readonly shouldUseDiagnostics: boolean;
  readonly diagnosticsPriority?: number;
}

export interface ManagedContextToolLoopResult {
  readonly blocks: ContextBlock[];
  readonly docsRoute: ManagedContextToolRoute;
  readonly projectRoute: ManagedContextToolRoute;
  readonly diagnosticsRoute: ManagedContextToolRoute;
  readonly tools: readonly string[];
  readonly worklog: readonly ManagedContextToolWorklogEntry[];
}

export interface ManagedContextToolWorklogEntry {
  readonly toolName: ContextToolName;
  readonly source: ContextToolResult["source"];
  readonly route: ManagedContextToolRoute;
  readonly status: "ok" | "error";
  readonly itemCount: number;
  readonly blockCount: number;
  readonly chars: number;
  readonly truncated: boolean;
}

interface ManagedContextToolLoopOptions {
  readonly docsTools: DocsToolsService;
  readonly projectTools: ProjectToolsService;
  readonly diagnosticsTools: DiagnosticsToolsService;
  readonly logger: Logger;
}

interface ToolOutcome {
  readonly name: ContextToolName;
  readonly route: ManagedContextToolRoute;
  readonly result: ContextToolResult;
}

const DOCS_CONTEXT_CHARS = 22_000;
const DOCS_CONTEXT_ITEMS = 8;
const DOCS_OVERVIEW_CHARS = 24_000;
const PROJECT_CONTEXT_CHARS = 22_000;
const PROJECT_CONTEXT_ITEMS = 8;
const PROJECT_SYMBOLS_CHARS = 8_000;
const PROJECT_SYMBOLS_ITEMS = 50;
const DIAGNOSTICS_CONTEXT_CHARS = 16_000;

export class ManagedContextToolLoopService {
  constructor(private readonly options: ManagedContextToolLoopOptions) {}

  async buildContext(request: ManagedContextToolLoopRequest): Promise<ManagedContextToolLoopResult> {
    const outcomes: ToolOutcome[] = [];
    const blocks: ContextBlock[] = [];

    if (!request.hasExplicitDocs && request.routing.shouldUseDocsContext) {
      const result = request.routing.docsMode === "overview"
        ? await this.options.docsTools.overview({
          chatId: request.chatId,
          query: request.prompt,
          reason: `managed fallback docs overview: ${request.routing.reason}`,
          limits: {
            maxItems: DOCS_CONTEXT_ITEMS,
            maxChars: DOCS_OVERVIEW_CHARS
          }
        })
        : await this.options.docsTools.read({
          chatId: request.chatId,
          query: request.prompt,
          reason: `managed fallback docs lookup: ${request.routing.reason}`,
          limits: {
            maxItems: DOCS_CONTEXT_ITEMS,
            maxChars: DOCS_CONTEXT_CHARS
          }
        });
      const route = routeFromResult(result, request.routing.docsMode === "overview" ? "overview" : "added");
      outcomes.push({ name: result.toolName, route, result });
      blocks.push(...blocksFromResult(result));
    }

    if (request.shouldUseDiagnostics) {
      const result = await this.options.diagnosticsTools.list({
        chatId: request.chatId,
        priority: request.diagnosticsPriority,
        reason: `managed fallback diagnostics: ${request.routing.reason}`,
        limits: {
          maxChars: DIAGNOSTICS_CONTEXT_CHARS
        }
      });
      const route = routeFromResult(result, "added");
      outcomes.push({ name: result.toolName, route, result });
      blocks.push(...blocksFromResult(result));
    }

    if (request.chatKind === "project" && request.routing.shouldUseProjectContext) {
      const search = await this.options.projectTools.search({
        chatId: request.chatId,
        query: request.prompt,
        reason: `managed fallback project search: ${request.routing.reason}`,
        limits: {
          maxItems: PROJECT_CONTEXT_ITEMS,
          maxChars: PROJECT_CONTEXT_CHARS
        }
      });
      outcomes.push({ name: search.toolName, route: routeFromResult(search, "added"), result: search });
      blocks.push(...blocksFromResult(search));

      const symbols = await this.options.projectTools.listSymbols({
        chatId: request.chatId,
        query: request.prompt,
        reason: `managed fallback project symbols: ${request.routing.reason}`,
        limits: {
          maxItems: PROJECT_SYMBOLS_ITEMS,
          maxChars: PROJECT_SYMBOLS_CHARS
        }
      });
      outcomes.push({ name: symbols.toolName, route: routeFromResult(symbols, "added"), result: symbols });
      blocks.push(...blocksFromResult(symbols));
    }

    const docsRoute = coalesceRoute(outcomes, "docs.", "skip");
    const diagnosticsRoute = coalesceRoute(outcomes, "diagnostics.", "skip");
    const projectRoute = coalesceRoute(outcomes, "project.", "skip");
    const chars = blocks.reduce((total, block) => total + block.text.length, 0);
    const toolSummary = outcomes.map((outcome) =>
      `${outcome.name}:${outcome.route}:${blockCount(outcome.result)}`
    );
    const worklog = outcomes.map(worklogEntryFromOutcome);

    this.options.logger.info(
      `Managed context fallback loop: route=${request.routing.route}; tools=${toolSummary.length ? toolSummary.join(",") : "none"}; ` +
      `blocks=${blocks.length}; chars=${chars}; docs=${docsRoute}; project=${projectRoute}; diagnostics=${diagnosticsRoute}.`
    );

    return {
      blocks,
      docsRoute,
      projectRoute,
      diagnosticsRoute,
      tools: toolSummary,
      worklog
    };
  }
}

function blocksFromResult(result: ContextToolResult): ContextBlock[] {
  const blocks = result.ok ? result.blocks : result.partialBlocks;
  return blocks.map(toContextBlock);
}

function blockCount(result: ContextToolResult): number {
  return result.ok ? result.blocks.length : result.partialBlocks.length;
}

function worklogEntryFromOutcome(outcome: ToolOutcome): ManagedContextToolWorklogEntry {
  const stats = statsFromResult(outcome.result);
  return {
    toolName: outcome.name,
    source: outcome.result.source,
    route: outcome.route,
    status: outcome.result.ok ? "ok" : "error",
    itemCount: stats.itemCount,
    blockCount: stats.blockCount,
    chars: stats.chars,
    truncated: stats.truncated
  };
}

function statsFromResult(result: ContextToolResult): {
  readonly itemCount: number;
  readonly blockCount: number;
  readonly chars: number;
  readonly truncated: boolean;
} {
  if (result.ok) {
    return result.stats;
  }
  return {
    itemCount: result.partialBlocks.reduce((total, block) => total + block.matchCount, 0),
    blockCount: result.partialBlocks.length,
    chars: result.partialBlocks.reduce((total, block) => total + block.text.length, 0),
    truncated: result.partialBlocks.some((block) => Boolean(block.metadata?.truncated))
  };
}

function routeFromResult(result: ContextToolResult, successRoute: ManagedContextToolRoute): ManagedContextToolRoute {
  if (blockCount(result) > 0) {
    return successRoute;
  }
  return result.ok ? "empty" : "error";
}

function coalesceRoute(
  outcomes: readonly ToolOutcome[],
  prefix: string,
  fallback: ManagedContextToolRoute
): ManagedContextToolRoute {
  const related = outcomes.filter((outcome) => outcome.name.startsWith(prefix));
  if (!related.length) {
    return fallback;
  }
  if (related.some((outcome) => outcome.route === "overview")) {
    return "overview";
  }
  if (related.some((outcome) => outcome.route === "added")) {
    return "added";
  }
  if (related.some((outcome) => outcome.route === "error")) {
    return "error";
  }
  return "empty";
}
