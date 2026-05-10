import * as vscode from "vscode";
import { ChatPanelManager } from "./chatPanelManager";
import { Logger } from "./logger";
import { PerfMarks } from "./performance";
import { SidebarProvider } from "./sidebarProvider";
import { StateStore } from "./stateStore";
import { ChatKind } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const perf = new PerfMarks();
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info("Codex Element V1 activating.");
  perf.mark("logger");

  const state = new StateStore();
  const chatPanels = new ChatPanelManager(context, state, logger);
  let sidebar: SidebarProvider;
  sidebar = new SidebarProvider(context, state, logger, {
    createChat: async (kind: ChatKind): Promise<void> => createChat(kind, state, sidebar, chatPanels, logger),
    openChat: async (chatId: string): Promise<void> => openChat(chatId, state, sidebar, chatPanels, logger),
    openSettings: async () => openSettings(logger),
    openLogs: () => logger.show()
  });
  perf.mark("services");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexElement.sidebar", sidebar, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  perf.mark("sidebarProvider");

  context.subscriptions.push(chatPanels.registerSerializer());
  perf.mark("panelSerializer");

  context.subscriptions.push(
    vscode.commands.registerCommand("codexElement.open", async () => {
      const existingChatId = state.getSidebarSnapshot().activeChatId;
      if (existingChatId) {
        await openChat(existingChatId, state, sidebar, chatPanels, logger);
        return;
      }
      await createChat("project", state, sidebar, chatPanels, logger);
    }),
    vscode.commands.registerCommand("codexElement.newProjectChat", async () => {
      await createChat("project", state, sidebar, chatPanels, logger);
    }),
    vscode.commands.registerCommand("codexElement.newGeneralChat", async () => {
      await createChat("general", state, sidebar, chatPanels, logger);
    }),
    vscode.commands.registerCommand("codexElement.openSettings", async () => {
      await openSettings(logger);
    }),
    vscode.commands.registerCommand("codexElement.openLogs", () => {
      logger.show();
    })
  );
  perf.mark("commands");

  perf.flush(logger, "Codex activation");
}

export function deactivate(): void {
  // All disposables are owned by the extension context.
}

async function createChat(
  kind: ChatKind,
  state: StateStore,
  sidebar: SidebarProvider,
  chatPanels: ChatPanelManager,
  logger: Logger
): Promise<void> {
  const chat = state.createChat(kind);
  logger.info(`Created ${kind} chat: ${chat.title}.`);
  sidebar.postSnapshot();
  chatPanels.openChat(chat.id);
}

async function openChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider,
  chatPanels: ChatPanelManager,
  logger: Logger
): Promise<void> {
  state.setActiveChat(chatId);
  logger.info(`Opening chat: ${chatId}.`);
  sidebar.postSnapshot();
  chatPanels.openChat(chatId);
}

async function openSettings(logger: Logger): Promise<void> {
  logger.info("Settings requested. Settings panel will be implemented in the next shell iteration.");
  vscode.window.showInformationMessage("Настройки Codex будут подключены в следующей итерации UI shell.");
}
