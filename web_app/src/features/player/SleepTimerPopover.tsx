import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CloseGlyph } from '../../core/ui/AppIcons';
import { formatTime } from './formatTime';
import type { SleepTimerState } from './playerStore';

export function SleepTimerPopover({ anchorRef, testId = 'player-timer-popover', customMinutes, sleepTimer, onCancel, onClose, onCustomMinutes, onStart }: {
  anchorRef: RefObject<HTMLButtonElement>;
  testId?: string;
  customMinutes: string;
  sleepTimer: SleepTimerState;
  onCancel: () => void;
  onClose: () => void;
  onCustomMinutes: (value: string) => void;
  onStart: (minutes: number) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const panel = panelRef.current!;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const viewport = window.visualViewport;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(336, viewportWidth - 24);
      const above = rect.top - viewportTop - 24;
      const below = viewportTop + viewportHeight - rect.bottom - 24;
      const useAbove = above >= 160 || above >= below;
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(80, useAbove ? above : below)}px`;
      panel.style.left = `${Math.max(viewportLeft + 12, Math.min(rect.left + rect.width / 2 - width / 2, viewportLeft + viewportWidth - width - 12))}px`;
      panel.style.top = `${useAbove ? Math.max(viewportTop + 12, rect.top - panel.getBoundingClientRect().height - 12) : rect.bottom + 12}px`;
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(panel);
    observer?.observe(anchor);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
      anchor.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [anchorRef]);
  const apply = () => {
    const minutes = Number(customMinutes);
    if (Number.isFinite(minutes) && minutes > 0) onStart(minutes);
  };
  return createPortal(<div ref={panelRef} data-testid={testId} data-glass data-allow-scroll data-no-dismiss-gesture
    role="dialog" aria-label="Sleep timer options"
    className="muzio-popover muzio-timer-popover fixed z-[75] overflow-y-auto overscroll-contain rounded-2xl p-3 text-foreground"
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <section data-testid="sleep-timer-control" aria-label="Sleep timer">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="flex-1 text-sm font-semibold">Sleep timer</h2>
        <span data-testid="sleep-timer-status" className="text-xs tabular-nums text-muted">{sleepTimer.kind === 'running' ? formatTime(sleepTimer.remainingSec) : sleepTimer.kind === 'expired' ? 'Paused' : 'Off'}</span>
        <button type="button" aria-label="Close sleep timer" className="muzio-modal-close" onClick={onClose}><CloseGlyph className="h-4 w-4" /></button>
      </div>
      <div className="flex flex-wrap gap-2">
        {[15, 30, 60].map((minutes) => <button key={minutes} type="button" className="muzio-glass-action muzio-glass-action-secondary" onClick={() => onStart(minutes)}>{minutes}m</button>)}
        <button type="button" className="muzio-glass-action muzio-glass-action-secondary" onClick={onCancel}>Cancel</button>
      </div>
      <form className="mt-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <input type="number" min={1} step={1} value={customMinutes} onChange={(event) => onCustomMinutes(event.target.value)} aria-label="Custom timer minutes" className="muzio-glass-input min-w-0 flex-1 rounded-xl" />
        <button type="submit" className="muzio-glass-action">Set</button>
      </form>
    </section>
  </div>, document.body);
}
