export interface ParsedMarkdownFileTarget {
  path: string;
  line?: number;
  column?: number;
}

export function parseMarkdownFileTarget(rawTarget: string): ParsedMarkdownFileTarget {
  let target = rawTarget.trim();
  let line: number | undefined;
  let column: number | undefined;

  const hashLocation = target.match(/#L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?$/i);
  if (hashLocation) {
    line = positiveInteger(hashLocation[1]);
    column = positiveInteger(hashLocation[2]);
    target = target.slice(0, hashLocation.index);
  } else {
    const queryLocation = target.match(/([?&])line=(\d+)(?:&column=(\d+))?$/i);
    if (queryLocation) {
      line = positiveInteger(queryLocation[2]);
      column = positiveInteger(queryLocation[3]);
      target = target.slice(0, queryLocation.index);
    } else {
      const suffixWithColumn = target.match(/^(.*):(\d+):(\d+)$/);
      const suffixWithLine = suffixWithColumn ? undefined : target.match(/^(.*):(\d+)$/);
      const suffixLocation = suffixWithColumn ?? suffixWithLine;
      if (suffixLocation && suffixLocation[1].length > 2) {
        target = suffixLocation[1];
        line = positiveInteger(suffixLocation[2]);
        column = suffixWithColumn ? positiveInteger(suffixLocation[3]) : undefined;
      }
    }
  }

  return {
    path: target,
    ...(line ? { line } : {}),
    ...(column ? { column } : {})
  };
}

export function workspaceRelativePathCandidates(filePath: string, workspaceName: string): string[] {
  const normalized = normalizeSeparators(filePath);
  const candidates = new Set<string>();
  const workspaceMarker = "/workspace/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(workspaceMarker);
  if (markerIndex >= 0) {
    addSafeRelativePath(candidates, normalized.slice(markerIndex + workspaceMarker.length));
  }

  const segments = normalized.split("/").filter(Boolean);
  const workspaceIndex = findLastSegment(segments, workspaceName);
  if (workspaceIndex >= 0 && workspaceIndex < segments.length - 1) {
    addSafeRelativePath(candidates, segments.slice(workspaceIndex + 1).join("/"));
  }

  if (!isAbsoluteLike(filePath)) {
    addSafeRelativePath(candidates, normalized);
  }
  return [...candidates];
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function findLastSegment(segments: readonly string[], expected: string): number {
  const normalizedExpected = expected.toLowerCase();
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].toLowerCase() === normalizedExpected) {
      return index;
    }
  }
  return -1;
}

function addSafeRelativePath(target: Set<string>, value: string): void {
  const segments = value.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    return;
  }
  target.add(segments.join("/"));
}

function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith("/")
    || value.startsWith("\\\\")
    || /^file:\/\//i.test(value);
}
