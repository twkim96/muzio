import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseGlyph } from './AppIcons';
import { useAndroidBack } from '../platform/androidShell';

const modalStack: HTMLElement[] = [];
let previousOverflow = '';
const focusableSelector = 'button, input, select, textarea, a[href], [tabindex]';

export function GlassModal({
  testId, title, onClose, children, footer, closeLabel = `Close ${title}`, alert = false,
}: {
  testId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  alert?: boolean;
}) {
  useAndroidBack(true, onClose, 100);
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const frame = frameRef.current!;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      if (!viewport) return;
      backdropRef.current?.style.setProperty('--modal-viewport-top', `${viewport.offsetTop}px`);
      backdropRef.current?.style.setProperty('--modal-viewport-height', `${viewport.height}px`);
    };
    updateViewport();
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modalStack.length === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    modalStack.push(frame);
    const isTopmost = () => modalStack[modalStack.length - 1] === frame;
    const focusable = () => Array.from(frame.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled')
        && !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
    const controls = focusable();
    const desktop = window.matchMedia?.('(min-width: 640px)').matches ?? window.innerWidth >= 640;
    const initial = desktop ? controls.find((element) => element.matches('input, textarea, select')) : null;
    (initial ?? frame).focus({ preventScroll: true });

    const handleKey = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const controls = focusable();
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (!first) {
          event.preventDefault();
          frame.focus();
        } else if (!frame.contains(active) || active === frame || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      document.removeEventListener('keydown', handleKey, true);
      const wasTopmost = isTopmost();
      modalStack.splice(modalStack.indexOf(frame), 1);
      if (modalStack.length === 0) document.body.style.overflow = previousOverflow;
      if (wasTopmost && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div ref={backdropRef} data-testid={testId} className="muzio-modal-backdrop" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget && modalStack[modalStack.length - 1] === frameRef.current) onClose();
    }}>
      <section ref={frameRef} data-glass role={alert ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} className="muzio-dialog muzio-modal-sheet"
        onClick={(event) => event.stopPropagation()}>
        <header className="muzio-modal-header">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg font-semibold">{title}</h2>
          <button type="button" aria-label={closeLabel} className="muzio-modal-close" onClick={onClose}>
            <CloseGlyph className="h-5 w-5" />
          </button>
        </header>
        <div data-allow-scroll className="muzio-modal-body">{children}</div>
        {footer != null && <footer className="muzio-modal-footer">{footer}</footer>}
      </section>
    </div>, document.body,
  );
}
