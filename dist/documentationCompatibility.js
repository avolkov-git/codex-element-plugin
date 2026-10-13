"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePlatformVersion = normalizePlatformVersion;
exports.compareDocumentationVersion = compareDocumentationVersion;
exports.documentationVersionRank = documentationVersionRank;
exports.summarizeDocumentationVersions = summarizeDocumentationVersions;
exports.documentationVersionLabel = documentationVersionLabel;
exports.formatDocumentationVersion = formatDocumentationVersion;
function normalizePlatformVersion(value) {
    if (typeof value !== "string" || value.length > 40)
        return undefined;
    const version = value.trim();
    return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?)?$/.test(version)
        ? version : undefined;
}
function disagrees(left, right) {
    const a = left.split(/[.-]/);
    const b = right.split(/[.-]/);
    return a.some((part, index) => b[index] !== undefined && b[index] !== part);
}
function compareDocumentationVersion(fragmentId, expected, evidence) {
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
function documentationVersionRank(check) {
    if (check.status === "matched")
        return 3;
    if (check.reason === "same-release-line-only")
        return 2;
    return 1;
}
function summarizeDocumentationVersions(checks) {
    if (checks.some(check => check.status === "mismatch"))
        return "mismatch";
    return checks.length && checks.every(check => check.status === "matched") ? "matched" : "unverified";
}
function documentationVersionLabel(status) {
    return { matched: "метки версий совпадают", mismatch: "версии не совпадают", unverified: "не проверена" }[status];
}
function formatDocumentationVersion(check) {
    const evidence = check.evidence;
    const reasons = {
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
//# sourceMappingURL=documentationCompatibility.js.map