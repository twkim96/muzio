import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useDocumentHorizontalDrag } from './useDocumentHorizontalDrag';

describe('useDocumentHorizontalDrag', () => {
  test('owns document tracking until release', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const { result } = renderHook(() => useDocumentHorizontalDrag());

    act(() => {
      result.current.start({ onMove, onEnd });
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 42 }),
      );
      document.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, clientX: 84 }),
      );
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 126 }),
      );
    });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(42);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(84);
  });

  test('removes tracking on unmount', () => {
    const onMove = vi.fn();
    const { result, unmount } = renderHook(() => useDocumentHorizontalDrag());
    act(() => result.current.start({ onMove, onEnd: vi.fn() }));
    unmount();

    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 42 }),
    );
    expect(onMove).not.toHaveBeenCalled();
  });
});
