import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Send } from "lucide-react";
import type { ApprovalRequest, NativeUserInputRequest } from "../../src/types";
import { command, store } from "./bridge";
import { BoundedText, Modal } from "./controls";
import { Markdown } from "./Markdown";

interface QuestionDraft { text: string; busy: boolean; error: string; accepted: boolean }
const emptyQuestionDraft: QuestionDraft = { text: "", busy: false, error: "", accepted: false };
const questionKey = (messageId: string, questionId: string) => JSON.stringify([messageId, questionId]);
function createQuestionDrafts() {
  const drafts = new Map<string, QuestionDraft>();
  const listeners = new Set<() => void>();
  return {
    read: (key: string) => drafts.get(key) ?? emptyQuestionDraft,
    isSending: () => [...drafts.values()].some(draft => draft.busy),
    update(key: string, patch: Partial<QuestionDraft>) {
      drafts.set(key, { ...(drafts.get(key) ?? emptyQuestionDraft), ...patch });
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; }
  };
}
const QuestionDraftContext = createContext<ReturnType<typeof createQuestionDrafts> | null>(null);

export function QuestionDraftScope({ chatId, children }: { chatId: string; children: ReactNode }) {
  // Outlive virtual rows, but not this chat. Answers are never written to webview saved state.
  const [drafts] = useState(createQuestionDrafts);
  useEffect(() => store.onEvent(event => {
    if (event.event !== "chat.question.result" || event.chatId !== chatId) return;
    const { messageId, questionId, accepted, error } = event.payload ?? {};
    if (typeof messageId !== "string" || typeof questionId !== "string") return;
    drafts.update(questionKey(messageId, questionId), {
      busy: false, accepted: accepted === true,
      ...(accepted ? { text: "", error: "" } : { error: error || "Ответ не принят. Повторите отправку." })
    });
  }), [chatId, drafts]);
  return <QuestionDraftContext.Provider value={drafts}>{children}</QuestionDraftContext.Provider>;
}

interface QuestionOption { label: string; value: string; description?: string }
function Choices({ options, selected, choose }: { options: QuestionOption[]; selected?: string; choose: (value: string) => void }) {
  return <div className="question-options">{options.map(option => <button type="button" className="question-choice" key={option.value}
    aria-pressed={selected === option.value} onClick={() => choose(option.value)}>
    <span><span className="question-choice-label">{option.label}</span>{option.description && <small>{option.description}</small>}</span>
    {selected === option.value && <Check size={16} aria-hidden="true" />}
  </button>)}</div>;
}
function AnswerButton({ busy, disabled }: { busy: boolean; disabled?: boolean }) {
  return <button className="question-submit" type="submit" disabled={disabled}><Send size={14} aria-hidden="true" />{busy ? "Отправка…" : "Ответить"}</button>;
}

export function TranscriptQuestion({ chatId, messageId, questionId, title, options, answer, archived }: {
  chatId: string; messageId: string; questionId: string; title: string; options: QuestionOption[]; answer?: string; archived: boolean;
}) {
  const drafts = useContext(QuestionDraftContext)!;
  const key = questionKey(messageId, questionId);
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.read(key));
  const sending = useSyncExternalStore(drafts.subscribe, drafts.isSending);
  const titleId = useId();
  const resolved = answer !== undefined || draft.accepted;
  const send = (value: string) => {
    if (archived || resolved || drafts.isSending() || !value.trim()) return;
    if (new TextEncoder().encode(value.trim()).byteLength > 16 * 1024) {
      drafts.update(key, { error: "Ответ слишком длинный. Максимум: 16 КиБ UTF-8." });
      return;
    }
    drafts.update(key, { busy: true, error: "" });
    command(chatId, "chat.question.respond", { messageId, questionId, answer: value.trim() });
  };
  return <section className="inline-questions" data-question-id={questionId}>
    <div className="question-title" id={titleId}><Markdown text={title} chatId={chatId} /></div>
    {resolved ? <p className="question-answer" role="status"><Check size={16} aria-hidden="true" /><span>{answer ?? "Ответ отправлен"}</span></p> :
      <form aria-labelledby={titleId} aria-busy={draft.busy} onSubmit={event => { event.preventDefault(); send(draft.text); }} autoComplete="off">
        <fieldset aria-labelledby={titleId} disabled={archived || sending}>
          {options.length ? <Choices options={options} choose={send} /> : <div className="question-input-row">
            <input className="question-text" aria-label={`${title}: ответ`} placeholder="Ваш ответ" value={draft.text} maxLength={20000} autoComplete="off"
              onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
              onChange={event => drafts.update(key, { text: event.target.value, error: "" })} />
            <AnswerButton busy={draft.busy} disabled={!draft.text.trim() || sending || archived} />
          </div>}
        </fieldset>
        {draft.busy && !!options.length && <p className="question-status" role="status">Отправка…</p>}
        {draft.error && <p className="question-error" role="alert">{draft.error}</p>}
        {archived && <p className="question-status">Диалог в архиве.</p>}
      </form>}
  </section>;
}

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
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(() => Date.parse(request.expiresAt) <= Date.now());
  const single = request.questions.length === 1;
  const lastQuestion = request.questions[request.questions.length - 1];
  const lastHasInput = !lastQuestion.options?.length || other[lastQuestion.id];
  useEffect(() => {
    const remaining = Date.parse(request.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    if (remaining <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  useEffect(() => store.onEvent(event => {
    if (event.event !== "chat.userInput.result" || event.chatId !== request.chatId || event.payload?.id !== request.id) return;
    sending.current = false; setBusy(false);
    if (event.payload.accepted) { setSelected({}); setFreeText({}); setAccepted(true); }
    else setError(event.payload.error || "Ответ не принят. Обновите вопрос.");
  }), [request.id, request.chatId]);
  const answer = (id: string) => !other[id] && selected[id] ? selected[id] : freeText[id] ?? "";
  const valid = request.questions.every(question => !!answer(question.id).trim());
  const submit = (cancel = false, direct?: { id: string; value: string }) => {
    if (sending.current || accepted || (!cancel && (expired || (!direct && !valid)))) return;
    sending.current = true; setBusy(true); setError("");
    command(request.chatId, "chat.userInput.respond", {
      id: request.id,
      response: cancel ? null : { answers: Object.fromEntries(request.questions.map(question => [question.id, { answers: [direct?.id === question.id ? direct.value : answer(question.id)] }])) }
    });
    // Native answers, especially secrets, are kept only while the live request is mounted.
    if (cancel) { setSelected({}); setFreeText({}); }
  };
  return <section className="inline-questions native-questions" aria-label="Вопрос Codex" data-request-id={request.id}>
    <form onSubmit={event => { event.preventDefault(); submit(); }} autoComplete="off" aria-busy={busy}>
      <div className="question-fields">{request.questions.map((question, index) => <fieldset key={question.id} disabled={busy || expired || accepted} aria-label={question.header}>
        <div className="question-title"><Markdown text={question.question} chatId={request.chatId} /></div>
        {!!question.options?.length && <Choices options={question.options.map(option => ({ ...option, value: option.label }))}
          selected={other[question.id] ? undefined : selected[question.id]} choose={value => {
            setOther(previous => ({ ...previous, [question.id]: false }));
            setSelected(previous => ({ ...previous, [question.id]: value }));
            if (single) submit(false, { id: question.id, value });
          }} />}
        {question.isOther && !!question.options?.length && <button type="button" className="question-other" aria-expanded={!!other[question.id]}
          onClick={() => setOther(previous => ({ ...previous, [question.id]: !previous[question.id] }))}>Свой ответ</button>}
        {(!question.options?.length || other[question.id]) && <div className="question-input-row"><input className="question-text" type={question.isSecret ? "password" : "text"}
          aria-label={`${question.header}: ответ`} placeholder="Ваш ответ" autoComplete="off" spellCheck={!question.isSecret} value={freeText[question.id] ?? ""} maxLength={20000}
          onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
          onChange={event => setFreeText(value => ({ ...value, [question.id]: event.target.value }))} />
          {index === request.questions.length - 1 && <AnswerButton busy={busy} disabled={busy || !valid || expired || accepted} />}</div>}
      </fieldset>)}</div>
      {(error || expired) && <p className="question-error" role="alert">{expired ? "Время ответа истекло." : error}</p>}
      {accepted ? <p className="question-answer" role="status"><Check size={16} aria-hidden="true" />Ответ отправлен</p> : <div className="question-actions">
        {!single && !lastHasInput && <AnswerButton busy={busy} disabled={busy || !valid || expired} />}
        <button className="question-cancel" type="button" disabled={busy} onClick={() => submit(true)}>Отменить</button>
        {single && busy && !!request.questions[0].options?.length && !other[request.questions[0].id] && <span className="question-status" role="status">Отправка…</span>}
      </div>}
    </form>
  </section>;
}
