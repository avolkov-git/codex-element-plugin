import { useEffect, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";

export function IconButton({ icon: Icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={17} aria-hidden="true" /></button>;
}

export function Popover({ anchor, label, children, onClose, className = "" }: { anchor: HTMLElement; label: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const element = ref.current!;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
      element.style.maxHeight = `${Math.max(40, rect.top - 16)}px`;
    };
    position();
    const resize = new ResizeObserver(position); resize.observe(element); resize.observe(anchor);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    (element.querySelector<HTMLElement>("[aria-selected=true]") ?? element.querySelector<HTMLElement>("input, button:not(:disabled)"))?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close.current(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); anchor.focus({ preventScroll: true }); }
      if (event.target instanceof HTMLInputElement || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const group = event.target instanceof Element ? event.target.closest("[role=listbox]") ?? element : element;
      const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0 || !buttons.length) return;
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    };
    const blur = () => { if (!element.contains(document.activeElement) && document.activeElement !== anchor) close.current(); };
    document.addEventListener("pointerdown", dismiss); element.addEventListener("keydown", keyboard); document.addEventListener("focusin", blur);
    return () => { resize.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", dismiss); element.removeEventListener("keydown", keyboard); document.removeEventListener("focusin", blur); };
  }, [anchor]);
  return createPortal(<div ref={ref} role="dialog" aria-label={label} className={`composer-popover ${className}`}>{children}</div>, document.body);
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
