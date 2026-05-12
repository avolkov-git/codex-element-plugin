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
exports.ApprovalAttentionService = void 0;
const vscode = __importStar(require("vscode"));
const APPROVAL_MESSAGE = "Для дальнейшей работы Codex необходимо ваше подтверждение";
const OPEN_CODEX_ACTION = "Открыть Codex";
class ApprovalAttentionService {
    constructor(state, logger, openPendingApproval) {
        this.state = state;
        this.logger = logger;
        this.openPendingApproval = openPendingApproval;
        this.previousPendingCount = 0;
    }
    sync() {
        const pendingCount = this.state.getPendingApprovalCount();
        const shouldNotify = this.previousPendingCount === 0 && pendingCount > 0;
        this.previousPendingCount = pendingCount;
        if (!shouldNotify) {
            return;
        }
        this.logger.info(`Pending approval notification requested: count=${pendingCount}.`);
        void vscode.window.showInformationMessage(APPROVAL_MESSAGE, OPEN_CODEX_ACTION).then((selection) => {
            if (selection !== OPEN_CODEX_ACTION) {
                return;
            }
            void this.openPendingApproval();
        });
    }
}
exports.ApprovalAttentionService = ApprovalAttentionService;
//# sourceMappingURL=approvalAttentionService.js.map