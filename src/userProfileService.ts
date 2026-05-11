import * as crypto from "crypto";
import * as vscode from "vscode";

export class UserProfileService {
  private currentProfileId: string | undefined;

  async requireProfileId(): Promise<string> {
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

  getCurrentProfileLabel(): string {
    return this.currentProfileId ?? "-";
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
