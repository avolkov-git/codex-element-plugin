import {
  ContextToolMode,
  ContextToolName,
  ContextToolSource
} from "./contextTools";
import { Logger, redact } from "./logger";

export type NativeContextToolLoopStatus = "available" | "unavailable" | "unknown";
export type NativeContextToolProbeStatus = "supported" | "unsupported" | "unstable" | "unknown" | "skipped";

export interface NativeContextToolDescriptor {
  readonly name: ContextToolName;
  readonly source: ContextToolSource;
  readonly description: string;
  readonly readOnly: true;
}

export interface NativeContextToolLoopSnapshot {
  readonly status: NativeContextToolLoopStatus;
  readonly mode: ContextToolMode;
  readonly reason: string;
  readonly checkedAt: string | null;
  readonly tools: readonly NativeContextToolDescriptor[];
}

export interface NativeContextToolLoopProbeInput {
  readonly listingStatus: NativeContextToolProbeStatus;
  readonly listingEvidence: string;
  readonly listingObservation: string;
  readonly resultTransportStatus: NativeContextToolProbeStatus;
  readonly resultTransportEvidence: string;
  readonly resultTransportObservation: string;
}

const NATIVE_CONTEXT_TOOLS: readonly NativeContextToolDescriptor[] = [
  {
    name: "docs.search",
    source: "docs",
    description: "Search allowed documentation corpora and return relevant fragment previews.",
    readOnly: true
  },
  {
    name: "docs.read",
    source: "docs",
    description: "Read selected documentation fragments from allowed documentation roots.",
    readOnly: true
  },
  {
    name: "docs.overview",
    source: "docs",
    description: "Build a compact overview of configured documentation corpora.",
    readOnly: true
  },
  {
    name: "project.search",
    source: "project",
    description: "Search project index chunks inside the current workspace.",
    readOnly: true
  },
  {
    name: "project.readFile",
    source: "project",
    description: "Read a safe workspace file range with denylist and size checks.",
    readOnly: true
  },
  {
    name: "project.listSymbols",
    source: "project",
    description: "List project symbols from the lazy project index.",
    readOnly: true
  },
  {
    name: "diagnostics.list",
    source: "diagnostics",
    description: "Read IDE error diagnostics for workspace files.",
    readOnly: true
  },
  {
    name: "editor.currentFile",
    source: "editorFile",
    description: "Read active editor file text, including unsaved text when allowed.",
    readOnly: true
  },
  {
    name: "editor.currentSelection",
    source: "editorSelection",
    description: "Read active editor selection text when allowed.",
    readOnly: true
  }
];

export class NativeContextToolLoopService {
  private snapshot: NativeContextToolLoopSnapshot = {
    status: "unknown",
    mode: "managed-fallback",
    reason: "Native context tool transport has not been probed in this session.",
    checkedAt: null,
    tools: NATIVE_CONTEXT_TOOLS
  };

  constructor(private readonly logger: Logger) {}

  getSnapshot(): NativeContextToolLoopSnapshot {
    return this.snapshot;
  }

  getToolDescriptors(): readonly NativeContextToolDescriptor[] {
    return NATIVE_CONTEXT_TOOLS;
  }

  recordProbe(input: NativeContextToolLoopProbeInput): NativeContextToolLoopSnapshot {
    const status = this.resolveStatus(input);
    const reason = this.buildReason(input, status);
    this.snapshot = {
      status,
      mode: status === "available" ? "native-tools" : "managed-fallback",
      reason,
      checkedAt: new Date().toISOString(),
      tools: NATIVE_CONTEXT_TOOLS
    };
    this.logger.info(
      `Native context tool-loop gate: status=${this.snapshot.status}; mode=${this.snapshot.mode}; ` +
      `listing=${input.listingStatus}; resultTransport=${input.resultTransportStatus}; reason=${redact(reason)}.`
    );
    return this.snapshot;
  }

  assertAvailable(): void {
    if (this.snapshot.status !== "available") {
      throw new Error(`Native context tool-loop is not available: ${this.snapshot.reason}`);
    }
  }

  private resolveStatus(input: NativeContextToolLoopProbeInput): NativeContextToolLoopStatus {
    if (input.listingStatus === "supported" && input.resultTransportStatus === "supported") {
      return "available";
    }
    if (input.listingStatus === "unknown" || input.listingStatus === "skipped" || input.resultTransportStatus === "unknown" || input.resultTransportStatus === "skipped") {
      return "unknown";
    }
    return "unavailable";
  }

  private buildReason(input: NativeContextToolLoopProbeInput, status: NativeContextToolLoopStatus): string {
    if (status === "available") {
      return "Native tool listing and tool request/result transport are both confirmed by probe.";
    }
    if (input.listingStatus !== "supported") {
      return `Native tool listing is not confirmed (${input.listingStatus}). Managed fallback remains active.`;
    }
    return `Native tool listing responded, but tool request/result transport is not confirmed (${input.resultTransportStatus}). Managed fallback remains active.`;
  }
}
