import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SleepTimerPopover } from './SleepTimerPopover';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('anchors above the trigger outside transformed docks and follows scrolling', () => {
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('visualViewport', undefined);
  const anchor = document.createElement('button');
  document.body.append(anchor);
  let top = 700;
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ left: 700, top, bottom: top + 40, width: 40, height: 40, right: 740 } as DOMRect));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 180 } as DOMRect);
  const onClose = vi.fn(); const onStart = vi.fn();
  const view = render(<SleepTimerPopover anchorRef={{ current: anchor }} customMinutes="45" sleepTimer={{ kind: 'off' }}
    onCancel={vi.fn()} onClose={onClose} onCustomMinutes={vi.fn()} onStart={onStart} />);
  const panel = screen.getByTestId('player-timer-popover');
  expect(panel.parentElement).toBe(document.body);
  expect(panel).toHaveStyle({ left: '552px', top: '508px' });
  top = 500;
  fireEvent.scroll(window);
  expect(panel).toHaveStyle({ top: '308px' });
  fireEvent.pointerDown(screen.getByText('15m'));
  fireEvent.click(screen.getByText('15m'));
  expect(onStart).toHaveBeenCalledWith(15);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  expect(anchor).toHaveFocus();
  view.unmount(); anchor.remove();
});
