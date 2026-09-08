import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatAttachment, ChatAttachmentKind } from "./types";

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 512 * 1024;
const STALE_UPLOAD_MS = 10 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

interface PendingUpload {
  uploadId: string;
  chatId: string;
  name: string;
  mimeType: string;
  expectedBytes: number;
  receivedBytes: number;
  nextChunkIndex: number;
  directoryPath: string;
  temporaryPath: string;
  finalPath: string;
  updatedAt: number;
}

interface ManagedAttachmentPath {
  realPath: string;
  directoryPath: string;
}

export interface AttachmentUploadChunkResult {
  uploadId: string;
  chatId: string;
  chunkIndex: number;
  receivedBytes: number;
}

export class ChatAttachmentService implements vscode.Disposable {
  private readonly pendingUploads = new Map<string, PendingUpload>();

  constructor(
    private readonly logger: Logger,
    private readonly managedRootSource: string | (() => string | undefined)
  ) {}

  private get managedRoot(): string {
    const root = typeof this.managedRootSource === "function" ? this.managedRootSource() : this.managedRootSource;
    if (!root || !path.isAbsolute(root)) { throw new Error("Сначала подтвердите пользователя и проект IDE."); }
    return root;
  }

  async pick(existing: unknown): Promise<ChatAttachment[]> {
    const current = await this.resolve(existing);
    const remaining = Math.max(0, MAX_ATTACHMENTS - current.length);
    if (!remaining) {
      vscode.window.showInformationMessage(`К сообщению можно прикрепить не больше ${MAX_ATTACHMENTS} объектов.`);
      return current;
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: "Прикрепить"
    });
    if (!selected?.length) {
      return current;
    }

    const candidates = await this.resolve(selected.slice(0, remaining).map((uri) => ({ path: uri.fsPath })));
    const merged = deduplicateAttachments([...current, ...candidates]).slice(0, MAX_ATTACHMENTS);
    if (selected.length > remaining) {
      vscode.window.showInformationMessage(`Добавлены первые ${remaining} объектов. Лимит вложений: ${MAX_ATTACHMENTS}.`);
    }
    return merged;
  }

  async resolve(value: unknown): Promise<ChatAttachment[]> {
    if (!Array.isArray(value)) {
      return [];
    }
    const output: ChatAttachment[] = [];
    for (const candidate of value.slice(0, MAX_ATTACHMENTS)) {
      const requestedPath = isObject(candidate) && typeof candidate.path === "string" ? candidate.path : "";
      if (!requestedPath) {
        continue;
      }
      try {
        const attachment = await this.resolvePath(requestedPath, isObject(candidate) && typeof candidate.id === "string" ? candidate.id : undefined);
        output.push(attachment);
      } catch (error) {
        this.logger.warn(`Attachment ignored: ${error instanceof Error ? error.message : "validation failed"}.`);
      }
    }
    return deduplicateAttachments(output);
  }

  async open(value: unknown): Promise<void> {
    const [attachment] = await this.resolve([value]);
    if (!attachment) {
      throw new Error("Вложение недоступно или находится вне разрешенного хранилища.");
    }
    const uri = vscode.Uri.file(attachment.path);
    if (attachment.kind === "folder") {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  }

  async beginUpload(chatIdValue: string, value: unknown): Promise<{ uploadId: string }> {
    await this.cleanupStaleUploads();
    const payload = isObject(value) ? value : {};
    const uploadId = requiredSafeId(payload.uploadId, "идентификатор загрузки");
    const chatId = requiredSafeId(chatIdValue, "идентификатор чата");
    if (this.pendingUploads.has(uploadId)) {
      throw new Error("Загрузка с таким идентификатором уже выполняется.");
    }

    const name = sanitizeFileName(typeof payload.name === "string" ? payload.name : "");
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType.slice(0, 160) : "";
    const expectedBytes = parseUploadSize(payload.sizeBytes);
    const kind = attachmentKind(name, false, mimeType);
    const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (expectedBytes > maxBytes) {
      throw new Error(`Файл «${name}» превышает лимит ${kind === "image" ? "20" : "50"} МБ.`);
    }

    const directoryPath = path.join(this.managedRoot, chatId, uploadId);
    const finalPath = path.join(directoryPath, name);
    const temporaryPath = `${finalPath}.part`;
    await fs.promises.mkdir(directoryPath, { recursive: true });
    await fs.promises.writeFile(temporaryPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });

    this.pendingUploads.set(uploadId, {
      uploadId,
      chatId,
      name,
      mimeType,
      expectedBytes,
      receivedBytes: 0,
      nextChunkIndex: 0,
      directoryPath,
      temporaryPath,
      finalPath,
      updatedAt: Date.now()
    });
    this.logger.info(`Client attachment upload started: chat=${chatId}; size=${expectedBytes}; kind=${kind}.`);
    return { uploadId };
  }

  async appendUploadChunk(value: unknown): Promise<AttachmentUploadChunkResult> {
    const payload = isObject(value) ? value : {};
    const uploadId = requiredSafeId(payload.uploadId, "идентификатор загрузки");
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) {
      throw new Error("Сессия загрузки не найдена или уже завершена.");
    }
    if (!isPathInside(this.managedRoot, upload.directoryPath)) { throw new Error("Пользователь или проект загрузки изменился."); }
    const chunkIndex = Number(payload.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex !== upload.nextChunkIndex) {
      throw new Error("Нарушен порядок частей загружаемого файла.");
    }
    if (typeof payload.data !== "string" || payload.data.length > Math.ceil(MAX_UPLOAD_CHUNK_BYTES * 4 / 3) + 8) {
      throw new Error("Часть загружаемого файла имеет недопустимый размер.");
    }
    const bytes = Buffer.from(payload.data, "base64");
    if (bytes.length > MAX_UPLOAD_CHUNK_BYTES || upload.receivedBytes + bytes.length > upload.expectedBytes) {
      throw new Error("Размер загружаемого файла не совпадает с заявленным.");
    }
    await fs.promises.appendFile(upload.temporaryPath, bytes);
    upload.receivedBytes += bytes.length;
    upload.nextChunkIndex += 1;
    upload.updatedAt = Date.now();
    return { uploadId, chatId: upload.chatId, chunkIndex, receivedBytes: upload.receivedBytes };
  }

  async completeUpload(value: unknown): Promise<{ chatId: string; attachment: ChatAttachment }> {
    const payload = isObject(value) ? value : {};
    const uploadId = requiredSafeId(payload.uploadId, "идентификатор загрузки");
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) {
      throw new Error("Сессия загрузки не найдена или уже завершена.");
    }
    if (!isPathInside(this.managedRoot, upload.directoryPath)) { throw new Error("Пользователь или проект загрузки изменился."); }
    if (upload.receivedBytes !== upload.expectedBytes) {
      throw new Error("Файл загружен не полностью.");
    }
    const stat = await fs.promises.stat(upload.temporaryPath);
    if (stat.size !== upload.expectedBytes) {
      throw new Error("Контроль размера загруженного файла не пройден.");
    }
    await fs.promises.rename(upload.temporaryPath, upload.finalPath);
    this.pendingUploads.delete(uploadId);
    const attachment = await this.resolvePath(upload.finalPath, uploadId);
    this.logger.info(`Client attachment upload completed: chat=${upload.chatId}; size=${upload.expectedBytes}; kind=${attachment.kind}.`);
    return { chatId: upload.chatId, attachment };
  }

  async cancelUpload(value: unknown): Promise<void> {
    const payload = isObject(value) ? value : {};
    const uploadId = requiredSafeId(payload.uploadId, "идентификатор загрузки");
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) {
      return;
    }
    this.pendingUploads.delete(uploadId);
    await fs.promises.rm(upload.directoryPath, { recursive: true, force: true });
    this.logger.info(`Client attachment upload cancelled: chat=${upload.chatId}.`);
  }

  async discard(value: unknown): Promise<void> {
    if (!isObject(value) || value.source !== "upload" || typeof value.path !== "string") {
      return;
    }
    const managed = await this.resolveManagedAttachmentPath(value.path);
    if (!managed) {
      return;
    }
    await fs.promises.rm(managed.directoryPath, { recursive: true, force: true });
  }

  async deleteChat(chatIdValue: string): Promise<void> {
    const chatId = requiredSafeId(chatIdValue, "идентификатор чата");
    for (const upload of [...this.pendingUploads.values()]) {
      if (upload.chatId === chatId) {
        this.pendingUploads.delete(upload.uploadId);
      }
    }
    await fs.promises.rm(path.join(this.managedRoot, chatId), { recursive: true, force: true });
  }

  dispose(): void {
    for (const upload of this.pendingUploads.values()) {
      void fs.promises.rm(upload.directoryPath, { recursive: true, force: true });
    }
    this.pendingUploads.clear();
  }

  private async resolvePath(requestedPath: string, requestedId?: string): Promise<ChatAttachment> {
    const roots = await workspaceRoots();
    const absolutePath = path.resolve(requestedPath);
    const realPath = await fs.promises.realpath(absolutePath);
    const managed = await this.resolveManagedAttachmentPath(realPath);
    const workspace = managed ? undefined : roots.find((root) => isPathInside(root.realPath, realPath));
    if (!workspace && !managed) {
      throw new Error("путь находится вне workspace и хранилища вложений");
    }
    const stat = await fs.promises.stat(realPath);
    const kind = attachmentKind(realPath, stat.isDirectory());
    if (!stat.isDirectory() && stat.size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) {
      throw new Error(`файл превышает лимит ${kind === "image" ? "20" : "50"} МБ`);
    }

    const displayPath = workspace
      ? formatWorkspaceDisplayPath(roots, workspace, realPath)
      : "С компьютера";
    return {
      id: sanitizeId(requestedId) || `attachment-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
      kind,
      name: path.basename(realPath),
      path: realPath,
      displayPath,
      sizeBytes: stat.isFile() ? stat.size : undefined,
      source: workspace ? "workspace" : "upload"
    };
  }

  private async resolveManagedAttachmentPath(candidatePath: string): Promise<ManagedAttachmentPath | undefined> {
    let root: string;
    let realPath: string;
    try {
      root = await fs.promises.realpath(this.managedRoot);
      realPath = await fs.promises.realpath(candidatePath);
    } catch {
      return undefined;
    }
    if (!isPathInside(root, realPath)) {
      return undefined;
    }
    const relative = path.relative(root, realPath);
    const segments = relative.split(path.sep);
    if (
      segments.length !== 3
      || !segments[2]
      || sanitizeId(segments[0]) !== segments[0]
      || sanitizeId(segments[1]) !== segments[1]
    ) {
      return undefined;
    }
    const stat = await fs.promises.stat(realPath).catch(() => undefined);
    if (!stat?.isFile()) {
      return undefined;
    }
    return { realPath, directoryPath: path.dirname(realPath) };
  }

  private async cleanupStaleUploads(): Promise<void> {
    const threshold = Date.now() - STALE_UPLOAD_MS;
    for (const upload of [...this.pendingUploads.values()]) {
      if (upload.updatedAt >= threshold) {
        continue;
      }
      this.pendingUploads.delete(upload.uploadId);
      await fs.promises.rm(upload.directoryPath, { recursive: true, force: true });
    }
  }
}

async function workspaceRoots(): Promise<Array<{ name: string; realPath: string }>> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return Promise.all(folders
    .filter((folder) => folder.uri.scheme === "file")
    .map(async (folder) => ({ name: folder.name, realPath: await fs.promises.realpath(folder.uri.fsPath) })));
}

function attachmentKind(filePath: string, directory: boolean, mimeType = ""): ChatAttachmentKind {
  if (directory) {
    return "folder";
  }
  return mimeType.toLowerCase().startsWith("image/") || IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "image" : "file";
}

function formatWorkspaceDisplayPath(
  roots: readonly { name: string; realPath: string }[],
  workspace: { name: string; realPath: string },
  realPath: string
): string {
  const relative = path.relative(workspace.realPath, realPath) || path.basename(realPath);
  return (roots.length > 1 ? `${workspace.name}/${relative}` : relative).split(path.sep).join("/");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseUploadSize(value: unknown): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Размер файла не определен.");
  }
  return size;
}

function sanitizeFileName(value: string): string {
  const basename = path.basename(value.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
  if (!basename || basename === "." || basename === "..") {
    throw new Error("Имя файла недопустимо.");
  }
  return basename;
}

function requiredSafeId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Не указан ${label}.`);
  }
  const normalized = sanitizeId(value);
  if (!normalized || normalized !== value) {
    throw new Error(`Недопустимый ${label}.`);
  }
  return normalized;
}

function sanitizeId(value: string | undefined): string {
  return value?.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) ?? "";
}

function deduplicateAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = process.platform === "win32" ? attachment.path.toLowerCase() : attachment.path;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
