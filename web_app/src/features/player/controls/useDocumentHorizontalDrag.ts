import { useCallback, useEffect, useRef } from 'react';

export interface HorizontalDragHandlers {
  onMove(clientX: number): void;
  onEnd(clientX?: number): void;
}

export function useDocumentHorizontalDrag() {
  const handlersRef = useRef<HorizontalDragHandlers | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cleanupRef.current?.();
  }, []);

  const start = useCallback(
    (handlers: HorizontalDragHandlers) => {
      handlersRef.current = handlers;
      if (cleanupRef.current !== null) return;

      const move = (clientX: number) => {
        handlersRef.current?.onMove(clientX);
      };
      const end = (clientX?: number) => {
        const activeHandlers = handlersRef.current;
        stop();
        activeHandlers?.onEnd(clientX);
      };
      const handleMouseMove = (event: MouseEvent) => move(event.clientX);
      const handleMouseUp = (event: MouseEvent) => end(event.clientX);
      const handlePointerMove = (event: PointerEvent) => move(event.clientX);
      const handlePointerUp = (event: PointerEvent) => end(event.clientX);
      const handlePointerCancel = (event: PointerEvent) => end(event.clientX);
      const handleTouchMove = (event: TouchEvent) => {
        const touch = event.touches[0] ?? event.changedTouches[0];
        if (touch === undefined) return;
        if (event.cancelable) event.preventDefault();
        move(touch.clientX);
      };
      const handleTouchEnd = (event: TouchEvent) => {
        const touch = event.changedTouches[0] ?? event.touches[0];
        end(touch?.clientX);
      };

      document.addEventListener('mousemove', handleMouseMove, true);
      document.addEventListener('mouseup', handleMouseUp, true);
      document.addEventListener('pointermove', handlePointerMove, true);
      document.addEventListener('pointerup', handlePointerUp, true);
      document.addEventListener('pointercancel', handlePointerCancel, true);
      document.addEventListener('touchmove', handleTouchMove, {
        capture: true,
        passive: false,
      });
      document.addEventListener('touchend', handleTouchEnd, true);
      document.addEventListener('touchcancel', handleTouchEnd, true);

      cleanupRef.current = () => {
        document.removeEventListener('mousemove', handleMouseMove, true);
        document.removeEventListener('mouseup', handleMouseUp, true);
        document.removeEventListener('pointermove', handlePointerMove, true);
        document.removeEventListener('pointerup', handlePointerUp, true);
        document.removeEventListener('pointercancel', handlePointerCancel, true);
        document.removeEventListener('touchmove', handleTouchMove, true);
        document.removeEventListener('touchend', handleTouchEnd, true);
        document.removeEventListener('touchcancel', handleTouchEnd, true);
        cleanupRef.current = null;
        handlersRef.current = null;
      };
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { start, stop };
}
