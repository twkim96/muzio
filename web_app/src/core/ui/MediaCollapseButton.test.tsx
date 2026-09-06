import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MediaCollapseButton } from './MediaCollapseButton';

test('hides during fullscreen and restores its collapse action on exit', () => {
  const onCollapse = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  let fullscreen: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  try {
    render(<MediaCollapseButton label="Collapse video player" onCollapse={onCollapse} />);
    expect(screen.getByRole('button', { name: 'Collapse video player' })).toBeInTheDocument();
    act(() => {
      fullscreen = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.queryByRole('button', { name: 'Collapse video player' })).not.toBeInTheDocument();
    act(() => {
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse video player' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  } finally {
    if (descriptor) Object.defineProperty(document, 'fullscreenElement', descriptor);
    else Reflect.deleteProperty(document, 'fullscreenElement');
  }
});
