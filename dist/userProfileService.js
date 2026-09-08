"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserProfileService = void 0;
const elementIdentityService_1 = require("./elementIdentityService");
class UserProfileService {
    constructor(_context, identity = new elementIdentityService_1.ElementIdentityService()) {
        this.identity = identity;
    }
    async getKnownProfileId(existingProfileIds = []) {
        // Existing directories and a saved arbitrary label do not prove IDE identity.
        try {
            return (await this.identity.resolve()).userKey;
        }
        catch {
            return undefined;
        }
    }
    async requireProfileId(existingProfileIds = []) {
        return (await this.identity.resolve()).userKey;
    }
    getCurrentProfileLabel() {
        return this.identity.getCurrent()?.userLabel ?? "Пользователь IDE не подтвержден";
    }
    getCurrentProfileId() {
        return this.identity.getCurrent()?.userKey;
    }
}
exports.UserProfileService = UserProfileService;
//# sourceMappingURL=userProfileService.js.map