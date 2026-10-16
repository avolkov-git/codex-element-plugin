"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIEWER_MAX_MESSAGE = exports.VIEWER_MAX_FRAME = void 0;
exports.isViewerInput = isViewerInput;
exports.VIEWER_MAX_FRAME = 512 * 1024;
exports.VIEWER_MAX_MESSAGE = exports.VIEWER_MAX_FRAME + 16 * 1024;
function isViewerInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const v = value;
    const point = () => [v.x, v.y].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
    const modifiers = () => Number.isInteger(v.modifiers) && Number(v.modifiers) >= 0 && Number(v.modifiers) <= 15;
    if (v.kind === "move")
        return point();
    if (v.kind === "click")
        return point() && typeof v.button === "string" && ["left", "right", "middle"].includes(v.button) && (v.clickCount === 1 || v.clickCount === 2) && modifiers();
    if (v.kind === "wheel")
        return point() && [v.deltaX, v.deltaY].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 2000);
    if (v.kind === "text")
        return typeof v.text === "string" && v.text.length > 0 && v.text.length <= 1024 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.text);
    return v.kind === "key" && typeof v.key === "string" && /^(Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|[a-z])$/.test(v.key) && modifiers();
}
//# sourceMappingURL=browserViewerProtocol.js.map