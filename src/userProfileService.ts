import * as vscode from "vscode";
import { ElementIdentityService } from "./elementIdentityService";

export class UserProfileService {
  constructor(_context: vscode.ExtensionContext, readonly identity: ElementIdentityService = new ElementIdentityService()) {}

  async getKnownProfileId(existingProfileIds: string[] = []): Promise<string | undefined> {
    // Existing directories and a saved arbitrary label do not prove IDE identity.
    try { return (await this.identity.resolve()).userKey; } catch { return undefined; }
  }

  async requireProfileId(existingProfileIds: string[] = []): Promise<string> {
    return (await this.identity.resolve()).userKey;
  }

  getCurrentProfileLabel(): string {
    return this.identity.getCurrent()?.userLabel ?? "Пользователь IDE не подтвержден";
  }

  getCurrentProfileId(): string | undefined {
    return this.identity.getCurrent()?.userKey;
  }
}
