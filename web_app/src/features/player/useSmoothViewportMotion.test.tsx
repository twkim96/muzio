import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useSmoothViewportMotion } from './useSmoothViewportMotion';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('coalesces keyboard resizes, compensates the jump and cancels on unmount', () => {
  let bottom = 800;
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ bottom } as DOMRect));
  vi.stubGlobal('getComputedStyle', () => ({ transform: 'none' }));
  const cancel = vi.fn();
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel }));
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  try {
    function Bar() { return <div ref={useSmoothViewportMotion(true)} />; }
    const view = render(<Bar />);
    bottom = 500;
    fireEvent.resize(window);
    fireEvent.resize(window);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    act(() => frame?.(0));
    expect(animate.mock.calls[0][0]).toEqual([{ transform: 'translateY(300px)' }, { transform: 'translateY(0)' }]);
    view.unmount();
    expect(cancel).toHaveBeenCalled();
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  }
});
