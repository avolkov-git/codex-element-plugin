import { useEffect, useState } from "react";
import type { ApprovalRequest, NativeUserInputRequest } from "../../src/types";
import { command, store } from "./bridge";
import { BoundedText, Modal } from "./controls";

export function Approval({ approval, chatId }: { approval: ApprovalRequest; chatId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => store.onEvent(event => {
    if (event.event === "chat.error" && (!event.chatId || event.chatId === chatId)) { setBusy(false); setError(typeof event.payload === "string" ? event.payload : event.payload?.message); }
  }), [chatId]);
  const decide = (approved: boolean) => { setBusy(true); command(chatId, approved ? "approval.approve" : "approval.deny", { approvalId: approval.id }); };
  return <Modal title={approval.title || "Требуется разрешение"} onCancel={busy ? undefined : () => decide(false)}>
    <p>{approval.description}</p>{approval.path && <p className="file-path">{approval.path}</p>}
    <BoundedText>{approval.command || approval.diff || approval.payloadPreview}</BoundedText>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={() => decide(false)}>Отклонить</button><button disabled={busy} onClick={() => { setBusy(true); command(chatId, "chat.cancel"); }}>Остановить</button><button disabled={busy} className="primary" onClick={() => decide(true)}>Разрешить</button></div>
  </Modal>;
}

export function NativeQuestions({ request }: { request: NativeUserInputRequest }) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const expired = !!request.expiresAt && Date.parse(request.expiresAt) <= now;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => store.onEvent(event => {
    if (event.event !== "chat.userInput.result" || event.chatId !== request.chatId || event.payload?.id !== request.id) return;
    setBusy(false);
    if (event.payload.accepted) { setSelected({}); setFreeText({}); }
    else setError(event.payload.error || "Ответ не принят. Обновите вопрос.");
  }), [request.id, request.chatId]);
  const answer = (id: string) => selected[id] && selected[id] !== "__other__" ? selected[id] : freeText[id] ?? "";
  const valid = request.questions.every(question => !!answer(question.id).trim());
  const submit = (cancel = false) => {
    if (busy) return;
    setBusy(true); setError("");
    command(request.chatId, "chat.userInput.respond", {
      id: request.id,
      response: cancel ? null : { answers: Object.fromEntries(request.questions.map(question => [question.id, { answers: [answer(question.id)] }])) }
    });
    // Native answers, especially secret fields, live only in this dialog and are never setState'd to the host.
    if (cancel) { setSelected({}); setFreeText({}); }
  };
  return <Modal title="Вопрос Codex" onCancel={busy ? undefined : () => submit(true)}>
    <form onSubmit={event => { event.preventDefault(); if (valid && !expired) submit(); }} autoComplete="off">
      <div className="question-fields">{request.questions.map(question => <fieldset key={question.id} disabled={busy || expired}>
        <legend>{question.header}</legend><p>{question.question}</p>
        {question.options?.map(option => <label key={option.label} className="question-option"><input type="radio" name={question.id} value={option.label} checked={selected[question.id] === option.label} onChange={() => setSelected(value => ({ ...value, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}
        {question.isOther && !!question.options?.length && <label className="question-option"><input type="radio" name={question.id} checked={selected[question.id] === "__other__"} onChange={() => setSelected(value => ({ ...value, [question.id]: "__other__" }))} /><span>Свой ответ</span></label>}
        {(!question.options?.length || (question.isOther && selected[question.id] === "__other__")) && <input className="question-text" type={question.isSecret ? "password" : "text"} aria-label={`${question.header}: ответ`} autoComplete="off" spellCheck={!question.isSecret} value={freeText[question.id] ?? ""} maxLength={20000} onChange={event => setFreeText(value => ({ ...value, [question.id]: event.target.value }))} />}
      </fieldset>)}</div>
      {(error || expired) && <p className="error-text" role="alert">{expired ? "Время ответа истекло." : error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => submit(true)}>Отменить</button><button type="submit" className="primary" disabled={busy || !valid || expired}>{busy ? "Отправка…" : "Ответить"}</button></div>
    </form>
  </Modal>;
}
