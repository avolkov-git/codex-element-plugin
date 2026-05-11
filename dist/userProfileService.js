"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserProfileService = void 0;
const crypto = __importStar(require("crypto"));
const vscode = __importStar(require("vscode"));
class UserProfileService {
    async requireProfileId() {
        if (this.currentProfileId) {
            return this.currentProfileId;
        }
        const resolved = resolveElementUserId();
        if (resolved) {
            this.currentProfileId = makeProfileId(resolved);
            return this.currentProfileId;
        }
        const input = await vscode.window.showInputBox({
            title: "Профиль Codex",
            prompt: "Введите имя профиля. Этот профиль будет использоваться для хранения авторизации Codex.",
            placeHolder: "Например: aleksandr",
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim() ? undefined : "Введите имя профиля Codex.";
            }
        });
        if (!input?.trim()) {
            throw new Error("Авторизация отменена: профиль Codex не выбран.");
        }
        this.currentProfileId = makeProfileId(input.trim());
        return this.currentProfileId;
    }
    getCurrentProfileLabel() {
        return this.currentProfileId ?? "-";
    }
}
exports.UserProfileService = UserProfileService;
function resolveElementUserId() {
    return (process.env.CODEX_ELEMENT_USER_ID?.trim() ||
        process.env.ELEMENT_USER_ID?.trim() ||
        process.env.THEIA_USER_ID?.trim() ||
        "");
}
function makeProfileId(raw) {
    const slug = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10);
    return `${slug || "user"}-${hash}`;
}
//# sourceMappingURL=userProfileService.js.map