import type { DocsDocumentationVersion } from "./docsCorpusService";

export type DocumentationVersionStatus = "matched" | "mismatch" | "unverified";

export interface DocumentationVersionCheck {
  readonly fragmentId: string;
  readonly expectedPlatformVersion?: string;
  readonly status: DocumentationVersionStatus;
  readonly reason: string;
  readonly evidence?: DocsDocumentationVersion;
}

export function normalizePlatformVersion(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const version = value.trim();
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?)?$/.test(version)
    ? version : undefined;
}

function disagrees(left: string, right: string): boolean {
  const a = left.split(/[.-]/);
  const b = right.split(/[.-]/);
  return a.some((part, index) => b[index] !== undefined && b[index] !== part);
}

export function compareDocumentationVersion(
  fragmentId: string, expected: unknown, evidence?: DocsDocumentationVersion
): DocumentationVersionCheck {
  const expectedPlatformVersion = normalizePlatformVersion(expected);
  const base = { fragmentId, expectedPlatformVersion, evidence };
  // The bundle snapshot product_version is evidence only, never a version to
  // compare with the installed parser. Only the actual docs source_version is.
  const source = normalizePlatformVersion(evidence?.sourceVersion);
  if (!source || evidence?.provenance !== "official-html") {
    return { ...base, status: "unverified", reason: "authoritative-source-version-unavailable" };
  }
  if (!expectedPlatformVersion) {
    return { ...base, status: "unverified", reason: "expected-platform-version-unknown" };
  }
  if (disagrees(source, expectedPlatformVersion)) {
    return { ...base, status: "mismatch", reason: "different-documentation-release" };
  }
  if (source !== expectedPlatformVersion) {
    return { ...base, status: "unverified", reason: "same-release-line-only" };
  }
  return { ...base, status: "matched", reason: "equal-source-version-tags" };
}

export function documentationVersionRank(check: DocumentationVersionCheck): number {
  if (check.status === "matched") return 3;
  if (check.reason === "same-release-line-only") return 2;
  return 1;
}

export function summarizeDocumentationVersions(checks: readonly DocumentationVersionCheck[]): DocumentationVersionStatus {
  if (checks.some(check => check.status === "mismatch")) return "mismatch";
  return checks.length && checks.every(check => check.status === "matched") ? "matched" : "unverified";
}

export function documentationVersionLabel(status: DocumentationVersionStatus): string {
  return { matched: "метки версий совпадают", mismatch: "версии не совпадают", unverified: "не проверена" }[status];
}

export function formatDocumentationVersion(check: DocumentationVersionCheck): string {
  const evidence = check.evidence;
  const reasons: Record<string, string> = {
    "authoritative-source-version-unavailable": "Для фрагмента нет достоверной метки версии источника.",
    "expected-platform-version-unknown": "Версия штатного парсера проекта неизвестна.",
    "different-documentation-release": "Источник документации относится к другой версии.",
    "same-release-line-only": "Совпадает только общая часть версии; точная совместимость не подтверждена.",
    "equal-source-version-tags": "Совпадают явные метки версии источника и парсера; совместимость API этим не доказана."
  };
  return [
    `Совместимость версии: ${documentationVersionLabel(check.status)}. ${reasons[check.reason] ?? "Недостаточно данных для проверки версии."}`,
    `Ожидаемая версия штатного парсера: ${check.expectedPlatformVersion ?? "неизвестна"}.`,
    evidence ? `Версия источника документации: ${evidence.sourceVersion ?? "неизвестна"}; версия комплекта: ${evidence.productVersion ?? "неизвестна"} (снимок поставки, не подтверждение совместимости API).` : "Нет подтверждённой версии для этого фрагмента документации.",
    evidence ? `Происхождение: ${evidence.provenance === "official-html" ? "официальная HTML-документация" : "не подтверждено"}. Основание: ${evidence.metadataPath}; запись: ${evidence.recordId}.` : ""
  ].filter(Boolean).join(" ");
}
