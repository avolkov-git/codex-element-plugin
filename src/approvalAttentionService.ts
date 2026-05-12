import * as vscode from "vscode";
import { Logger } from "./logger";
import { StateStore } from "./stateStore";

const APPROVAL_MESSAGE = "Для дальнейшей работы Codex необходимо ваше подтверждение";
const OPEN_CODEX_ACTION = "Открыть Codex";

export class ApprovalAttentionService {
  private previousPendingCount = 0;

  constructor(
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly openPendingApproval: () => Promise<void>
  ) {}

  sync(): void {
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
