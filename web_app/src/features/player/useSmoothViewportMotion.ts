import { useLayoutEffect, useRef } from 'react';

/** Compensate fixed-bar jumps during keyboard viewport resizing without React renders. */
export function useSmoothViewportMotion(visible: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !visible || typeof element.animate !== 'function') return;
    let bottom = element.getBoundingClientRect().bottom;
    let animation: Animation | undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Retarget from the current visual position if another resize interrupts us.
      const transform = getComputedStyle(element).transform;
      const offset = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
      const previousBottom = bottom + offset;
      animation?.cancel();
      bottom = element.getBoundingClientRect().bottom;
      const delta = previousBottom - bottom;
      if (Math.abs(delta) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      animation = element.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      animation?.cancel();
    };
  }, [visible]);
  return ref;
}
