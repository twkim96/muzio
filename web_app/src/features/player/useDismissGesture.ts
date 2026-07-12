import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';

const EXIT_MS = 180;
const SETTLE_MS = 200;
const DEFAULT_BLOCK_SELECTOR =
  'a,button,input,select,textarea,video,[role="button"],[data-no-dismiss-gesture]';

export interface DismissGestureHandlers {
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTouchCancel: () => void;
  onTouchEnd: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => void;
}

export function useDismissGesture({
  blockSelector = DEFAULT_BLOCK_SELECTOR,
  onDismiss,
}: {
  blockSelector?: string;
  onDismiss: () => void;
}): {
  bind: DismissGestureHandlers;
  motionClassName: string;
  motionStyle: CSSProperties;
} {
  const dismissGestureRef = useRef<{ x: number; y: number } | null>(null);
  const timerRefs = useRef<number[]>([]);
  const [dismissOffset, setDismissOffset] = useState(0);
  const [dismissSettling, setDismissSettling] = useState(false);
  const [dismissExiting, setDismissExiting] = useState(false);

  const schedule = useCallback((callback: () => void, ms: number) => {
    const id = window.setTimeout(callback, ms);
    timerRefs.current.push(id);
  }, []);

  useEffect(() => {
    return () => {
      for (const id of timerRefs.current) window.clearTimeout(id);
      timerRefs.current = [];
    };
  }, []);

  useEffect(() => {
    const htmlOverscroll = document.documentElement.style.overscrollBehaviorY;
    const bodyOverscroll = document.body.style.overscrollBehaviorY;

    document.documentElement.style.overscrollBehaviorY = 'contain';
    document.body.style.overscrollBehaviorY = 'contain';

    return () => {
      document.documentElement.style.overscrollBehaviorY = htmlOverscroll;
      document.body.style.overscrollBehaviorY = bodyOverscroll;
    };
  }, []);

  const startDismissGesture = useCallback(
    (target: EventTarget, x: number, y: number) => {
      if (isDismissGestureBlocked(target, blockSelector)) return;
      dismissGestureRef.current = { x, y };
      setDismissSettling(false);
      setDismissExiting(false);
    },
    [blockSelector],
  );

  const updateDismissGesture = useCallback((x: number, y: number) => {
    const start = dismissGestureRef.current;
    if (start === null) return;

    const deltaX = Math.abs(x - start.x);
    const deltaY = y - start.y;
    if (deltaY <= 0 || deltaY <= deltaX * 1.35) {
      setDismissOffset(0);
      return;
    }

    setDismissOffset(Math.min(deltaY, window.innerHeight || 720));
  }, []);

  const finishDismissGesture = useCallback(
    (x: number, y: number) => {
      const start = dismissGestureRef.current;
      dismissGestureRef.current = null;
      if (start === null) return;

      const deltaX = Math.abs(x - start.x);
      const deltaY = y - start.y;
      const threshold = Math.min(180, Math.max(110, window.innerHeight * 0.16));
      if (deltaY > threshold && deltaY > deltaX * 1.35) {
        setDismissExiting(true);
        setDismissOffset(window.innerHeight || 720);
        schedule(onDismiss, EXIT_MS);
        return;
      }

      setDismissSettling(true);
      setDismissOffset(0);
      schedule(() => setDismissSettling(false), SETTLE_MS);
    },
    [onDismiss, schedule],
  );

  const cancelDismissGesture = useCallback(() => {
    dismissGestureRef.current = null;
    setDismissSettling(true);
    setDismissOffset(0);
    schedule(() => setDismissSettling(false), SETTLE_MS);
  }, [schedule]);

  const bind = useMemo<DismissGestureHandlers>(
    () => ({
      onMouseDown(event) {
        startDismissGesture(event.target, event.clientX, event.clientY);
      },
      onMouseMove(event) {
        updateDismissGesture(event.clientX, event.clientY);
      },
      onMouseUp(event) {
        finishDismissGesture(event.clientX, event.clientY);
      },
      onPointerCancel: cancelDismissGesture,
      onPointerDown(event) {
        startDismissGesture(event.target, event.clientX, event.clientY);
      },
      onPointerMove(event) {
        updateDismissGesture(event.clientX, event.clientY);
      },
      onPointerUp(event) {
        finishDismissGesture(event.clientX, event.clientY);
      },
      onTouchCancel: cancelDismissGesture,
      onTouchEnd(event) {
        const touch = event.changedTouches[0];
        if (!touch) {
          dismissGestureRef.current = null;
          return;
        }
        finishDismissGesture(touch.clientX, touch.clientY);
      },
      onTouchMove(event) {
        const start = dismissGestureRef.current;
        const touch = event.touches[0];
        if (start === null || !touch) return;

        const deltaX = Math.abs(touch.clientX - start.x);
        const deltaY = touch.clientY - start.y;
        if (deltaY > 12 && deltaY > deltaX * 1.35 && event.cancelable) {
          event.preventDefault();
        }
        updateDismissGesture(touch.clientX, touch.clientY);
      },
      onTouchStart(event) {
        const touch = event.touches[0];
        if (!touch) return;
        startDismissGesture(event.target, touch.clientX, touch.clientY);
      },
    }),
    [
      cancelDismissGesture,
      finishDismissGesture,
      startDismissGesture,
      updateDismissGesture,
    ],
  );

  return {
    bind,
    motionClassName:
      dismissSettling || dismissExiting
        ? 'transition-transform duration-200 ease-out'
        : '',
    motionStyle: { transform: `translateY(${dismissOffset}px)` },
  };
}

function isDismissGestureBlocked(
  target: EventTarget,
  blockSelector: string,
): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(blockSelector) !== null;
}
