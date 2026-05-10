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
exports.Logger = void 0;
exports.redact = redact;
const vscode = __importStar(require("vscode"));
class Logger {
    constructor() {
        this.output = vscode.window.createOutputChannel("Codex");
    }
    info(message) {
        this.append("info", message);
    }
    warn(message) {
        this.append("warn", message);
    }
    error(message) {
        this.append("error", message);
    }
    show() {
        this.output.show();
    }
    dispose() {
        this.output.dispose();
    }
    append(level, message) {
        this.output.appendLine(`[${new Date().toISOString()}] [${level}] ${redact(message)}`);
    }
}
exports.Logger = Logger;
function redact(value) {
    return value
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
        .replace(/(password|token|secret|api[_-]?key)=([^\s&]+)/gi, "$1=***")
        .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1***:***@");
}
//# sourceMappingURL=logger.js.map