"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectAstReferences = collectAstReferences;
/** Syntax occurrences only; receivers, shadowing and definitions remain the caller's responsibility. */
function collectAstReferences(root, text, options = {}) {
    const found = [];
    const seen = new Set();
    const lineStarts = [0];
    for (const match of text.matchAll(/\r\n|\r|\n/g))
        lineStarts.push(match.index + match[0].length);
    const pending = [root];
    while (pending.length) {
        const node = pending.pop();
        if (options.skipNestedScopes && node !== root && isNestedScope(node.kind))
            continue;
        let nameNode;
        let kind;
        if (/MethodInvocation$/.test(node.kind)) {
            const prefix = node.children.find(child => child.role === "prefix");
            nameNode = prefix?.kind === "StaticVariableAccess" ? prefix
                : prefix?.kind === "DynamicVariableAccess" ? prefix.children.find(child => child.role === "name" && child.kind === "FeatureName")
                    : undefined;
            kind = "call";
        }
        else if (node.kind === "MethodRef") {
            // Native containment order is first, segments, genParams, methodParams, not source order.
            const segments = node.children.filter(child => child.role === "segments");
            nameNode = segments.length ? segments[segments.length - 1] : node.children.find(child => child.role === "first");
            if (nameNode?.kind !== "FeatureName" && nameNode?.kind !== "StaticVariableAccess")
                nameNode = undefined;
            // &Box.new has no method-name node; Box is the explicitly referenced constructor type.
            kind = node.attributes.ctor === true ? "type" : "method-reference";
        }
        else if (node.kind === "TypeName") {
            nameNode = node;
            kind = "type";
        }
        const name = nameNode?.attributes.name;
        if (nameNode && kind && typeof name === "string") {
            const offset = nameOffset(nameNode, name, text);
            if (offset !== undefined && !seen.has(offset)) {
                seen.add(offset);
                const position = positionAtOffset(lineStarts, offset);
                found.push({ offset, occurrence: { node, nameNode, name, kind, position, endCharacter: position.character + name.length } });
            }
        }
        for (let index = node.children.length - 1; index >= 0; index -= 1)
            pending.push(node.children[index]);
    }
    return found.sort((left, right) => left.offset - right.offset).map(item => item.occurrence);
}
function nameOffset(node, name, text) {
    if (!Number.isInteger(node.startOffset) || !Number.isInteger(node.endOffset)
        || node.startOffset < 0 || node.endOffset <= node.startOffset || node.endOffset > text.length)
        return undefined;
    // A native name node ends at its identifier, but may start at a namespace (even of the same name).
    const token = /[\p{L}_][\p{L}\p{N}_]*$/u.exec(text.slice(node.startOffset, node.endOffset));
    return token?.[0] === name ? node.startOffset + token.index : undefined;
}
function positionAtOffset(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (lineStarts[middle] <= offset)
            low = middle;
        else
            high = middle;
    }
    return { line: low, character: offset - lineStarts[low] };
}
function isNestedScope(kind) {
    return kind === "Lambda" || kind === "ObjectConstructor"
        || /^(?:Bsl)?(?:Method|AbstractMethod|Type|Object|Enum|Const|Constant|Structure|Class|Interface|Exception)(?:Declaration)?$/.test(kind);
}
//# sourceMappingURL=projectAstReferences.js.map