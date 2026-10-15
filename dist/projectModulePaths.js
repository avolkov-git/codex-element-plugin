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
exports.isCompanion = isCompanion;
exports.isElementModuleCompanion = isElementModuleCompanion;
const path = __importStar(require("path"));
function isCompanion(left, right) {
    if (left === right || path.posix.dirname(left) !== path.posix.dirname(right))
        return false;
    const yaml = /\.ya?ml$/i.test(left) ? left : /\.ya?ml$/i.test(right) ? right : undefined;
    const xbsl = /\.xbsl$/i.test(left) ? left : /\.xbsl$/i.test(right) ? right : undefined;
    if (!yaml || !xbsl)
        return false;
    const base = yaml.replace(/\.ya?ml$/i, "");
    const code = xbsl.replace(/\.xbsl$/i, "");
    return code === base || code.startsWith(`${base}.`);
}
/** Broad filename similarity is useful for retrieval, but cannot establish module ownership. */
function isElementModuleCompanion(left, right) {
    if (!isCompanion(left, right))
        return false;
    const yaml = /\.ya?ml$/i.test(left) ? left : right;
    const xbsl = /\.xbsl$/i.test(left) ? left : right;
    const suffix = xbsl.replace(/\.xbsl$/i, "").slice(yaml.replace(/\.ya?ml$/i, "").length);
    return /^(?:\.(?:\u041e\u0431\u044a\u0435\u043a\u0442|Object|\u041d\u0430\u0431\u043e\u0440\u0417\u0430\u043f\u0438\u0441\u0435\u0439|RecordSet|\u0417\u0430\u043f\u0438\u0441\u044c|Record))?$/.test(suffix);
}
//# sourceMappingURL=projectModulePaths.js.map