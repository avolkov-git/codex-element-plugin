import * as vscode from "vscode";
import { ChatPanelManager } from "./chatPanelManager";
import { Logger } from "./logger";
import { PerfMarks } from "./performance";
import { RuntimeAuthController } from "./runtimeAuthController";
import { SettingsPanelManager } from "./settingsPanelManager";
import { SettingsService } from "./settingsService";
import { SidebarProvider } from "./sidebarProvider";
import { StateStore } from "./stateStore";
import { ChatKind } from "./types";
import { UserProfileService } from "./userProfileService";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const perf = new PerfMarks();
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info("Codex Element V1 activating.");
  perf.mark("logger");

  const settings = new SettingsService(context);
  const state = new StateStore();
  state.setProxy(await settings.getSidebarProxyStatus());
  const profiles = new UserProfileService();
  let sidebar: SidebarProvider | undefined;
  const runtime = new RuntimeAuthController({
    context,
    settings,
    profiles,
    state,
    logger,
    onDidChange: () => sidebar?.postSnapshot()
  });
  context.subscriptions.push(runtime);
  const chatPanels = new ChatPanelManager(context, state, logger);
  const settingsPanels = new SettingsPanelManager(context, settings, logger, async () => {
    state.setProxy(await settings.getSidebarProxyStatus());
    await runtime.stop();
    sidebar?.postSnapshot();
  });
  sidebar = new SidebarProvider(context, state, logger, {
    createChat: async (kind: ChatKind): Promise<void> => createChat(kind, state, sidebar, chatPanels, logger),
    openChat: async (chatId: string): Promise<void> => openChat(chatId, state, sidebar, chatPanels, logger),
    openSettings: async () => settingsPanels.open(),
    openLogs: () => logger.show(),
    startDeviceCodeLogin: async () => runtime.startDeviceCodeLogin(),
    loginWithApiKey: async (apiKey: string) => runtime.loginWithApiKey(apiKey),
    openDeviceCodeUrl: async () => runtime.openDeviceCodeUrl(),
    copyDeviceCode: async () => runtime.copyDeviceCode()
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

  context.subscriptions.push(chatPanels.registerSerializer(), settingsPanels.registerSerializer());
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
      settingsPanels.open();
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
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger
): Promise<void> {
  const chat = state.createChat(kind);
  logger.info(`Created ${kind} chat: ${chat.title}.`);
  sidebar?.postSnapshot();
  chatPanels.openChat(chat.id);
}

async function openChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger
): Promise<void> {
  state.setActiveChat(chatId);
  logger.info(`Opening chat: ${chatId}.`);
  sidebar?.postSnapshot();
  chatPanels.openChat(chatId);
}
