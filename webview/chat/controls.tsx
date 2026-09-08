import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";

export function IconButton({ icon: Icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={17} aria-hidden="true" /></button>;
}

export function Modal({ title, children, onCancel }: { title: string; children: ReactNode; onCancel?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.querySelector<HTMLElement>(".app");
    if (background) background.inert = true;
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("input, textarea, button") ?? dialog).focus();
    const cancel = (event: Event) => { event.preventDefault(); cancelRef.current?.(); };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']"));
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("cancel", cancel); dialog.removeEventListener("keydown", trap);
      dialog.close();
      if (background) background.inert = !!document.querySelector("dialog[open]");
      if (previous?.isConnected && !background?.inert) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={ref} className="chat-dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <div className="dialog-heading"><h2>{title}</h2>{onCancel && <IconButton icon={X} label="Закрыть" onClick={onCancel} />}</div>
    {children}
  </dialog>, document.body);
}

export function BoundedText({ children }: { children: string }) {
  return <pre className="bounded-output">{children.slice(0, 64000)}{children.length > 64000 ? "\n[Превью ограничено]" : ""}</pre>;
}
