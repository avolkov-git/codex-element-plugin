import { command, emptyDraft, saved, saveDraft, store } from "./bridge";
import type { ChatAttachment } from "../../src/types";

interface Upload { id: string; chatId: string; file: File; name: string; offset: number; index: number; reading: boolean; timer?: ReturnType<typeof setTimeout> }
const pending = new Map<string, Upload>();
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; for (const fn of listeners) fn(); };
export const uploadSubscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const uploadRevision = () => revision;
export const uploadsForChat = (chatId: string) => [...pending.values()].filter(upload => upload.chatId === chatId);

export function addAttachment(chatId: string, attachment: ChatAttachment): void {
  const draft = saved.drafts?.[chatId] ?? emptyDraft();
  if (!draft.attachments.some(value => value.id === attachment.id)) saveDraft(chatId, { ...draft, attachments: [...draft.attachments, attachment].slice(0, 10) });
  store.receive({ type: "event", event: "draft.changed", chatId });
}
function arm(upload: Upload) {
  clearTimeout(upload.timer);
  upload.timer = setTimeout(() => {
    cancelUpload(upload.id);
    store.receive({ type: "event", event: "chat.error", chatId: upload.chatId, payload: `Загрузка ${upload.name} прервана: нет ответа сервера.` });
  }, 30000);
}
export function cancelUpload(id: string): void {
  const upload = pending.get(id);
  if (!upload) return;
  clearTimeout(upload.timer); pending.delete(id);
  command(upload.chatId, "chat.attachment.upload.cancel", { uploadId: id }); notify();
}
export function uploadFiles(chatId: string, files: File[]): string {
  const count = (saved.drafts?.[chatId]?.attachments.length ?? 0) + uploadsForChat(chatId).length;
  const limit = Math.min(10 - count, 10 - pending.size);
  const errors: string[] = [];
  for (const file of files.slice(0, Math.max(0, limit))) {
    const image = /^image\//.test(file.type);
    const max = (image ? 20 : 50) * 1024 * 1024;
    if (file.size > max) { errors.push(`${file.name}: лимит ${image ? 20 : 50} МБ.`); continue; }
    const id = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const name = file.name || `clipboard-${Date.now()}.${image ? "png" : "bin"}`;
    const upload = { id, chatId, file, name, offset: 0, index: 0, reading: false };
    pending.set(id, upload); arm(upload);
    command(chatId, "chat.attachment.upload.start", { chatId, uploadId: id, name, sizeBytes: file.size, mimeType: file.type || "application/octet-stream" });
  }
  if (files.length > limit) errors.push("Не больше 10 вложений и 10 одновременных загрузок.");
  notify(); return errors.join(" ");
}
async function next(upload: Upload): Promise<void> {
  if (upload.reading || !pending.has(upload.id)) return;
  arm(upload);
  if (upload.offset >= upload.file.size) {
    command(upload.chatId, "chat.attachment.upload.complete", { uploadId: upload.id }); return;
  }
  upload.reading = true;
  try {
    const bytes = new Uint8Array(await upload.file.slice(upload.offset, upload.offset + 512 * 1024).arrayBuffer());
    if (!pending.has(upload.id)) return;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    command(upload.chatId, "chat.attachment.upload.chunk", { uploadId: upload.id, chunkIndex: upload.index, data: btoa(binary) });
  } catch {
    cancelUpload(upload.id);
    store.receive({ type: "event", event: "chat.error", chatId: upload.chatId, payload: `Не удалось прочитать ${upload.name}.` });
  } finally { upload.reading = false; }
}
store.onEvent(event => {
  const payload = event.payload;
  if (!event.event?.startsWith("chat.attachment.upload.") || !payload) return;
  const id = payload.uploadId ?? payload.attachment?.id;
  const upload = pending.get(id);
  if (!upload) return;
  if (event.event === "chat.attachment.upload.ready") void next(upload);
  if (event.event === "chat.attachment.upload.chunkAccepted" && payload.chunkIndex === upload.index && payload.receivedBytes > upload.offset) {
    upload.offset = payload.receivedBytes; upload.index++; notify(); void next(upload);
  }
  if (event.event === "chat.attachment.upload.completed") {
    clearTimeout(upload.timer); pending.delete(id); addAttachment(upload.chatId, payload.attachment); notify();
  }
  if (event.event === "chat.attachment.upload.error") { clearTimeout(upload.timer); pending.delete(id); notify(); }
});
export function disposeUploads(): void { for (const id of pending.keys()) cancelUpload(id); listeners.clear(); }
