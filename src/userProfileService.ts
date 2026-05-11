import * as crypto from "crypto";
import * as vscode from "vscode";

const PROFILE_KEY = "codexElement.selectedProfileId";

export class UserProfileService {
  private currentProfileId: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getKnownProfileId(existingProfileIds: string[] = []): Promise<string | undefined> {
    if (this.currentProfileId) {
      return this.currentProfileId;
    }

    const resolved = resolveElementUserId();
    if (resolved) {
      this.currentProfileId = makeProfileId(resolved);
      await this.context.globalState.update(PROFILE_KEY, this.currentProfileId);
      return this.currentProfileId;
    }

    const stored = this.context.globalState.get<string>(PROFILE_KEY);
    if (stored?.trim()) {
      this.currentProfileId = stored.trim();
      return this.currentProfileId;
    }

    if (existingProfileIds.length === 1) {
      this.currentProfileId = existingProfileIds[0];
      await this.context.globalState.update(PROFILE_KEY, this.currentProfileId);
      return this.currentProfileId;
    }

    return undefined;
  }

  async requireProfileId(existingProfileIds: string[] = []): Promise<string> {
    const known = await this.getKnownProfileId(existingProfileIds);
    if (known) {
      return known;
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
    await this.context.globalState.update(PROFILE_KEY, this.currentProfileId);
    return this.currentProfileId;
  }

  getCurrentProfileLabel(): string {
    return this.currentProfileId ?? "-";
  }

  getCurrentProfileId(): string | undefined {
    return this.currentProfileId;
  }
}

function resolveElementUserId(): string {
  return (
    process.env.CODEX_ELEMENT_USER_ID?.trim() ||
    process.env.ELEMENT_USER_ID?.trim() ||
    process.env.THEIA_USER_ID?.trim() ||
    ""
  );
}

function makeProfileId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10);
  return `${slug || "user"}-${hash}`;
}
